import type {
  App,
  ContainerProcess,
  ExperimentalOutboundPolicy,
  FileWatchEvent,
  Image as ModalImage,
  ModalClient,
  Sandbox as ModalSandbox,
  SandboxCreateParams,
  SandboxUpdateNetworkPolicyParams,
  Secret as ModalSecret,
  Volume as ModalVolume,
} from "modal";

/**
 * `sbox-sdk/modal` — adapter for the Modal JS SDK (`modal` ≥ 0.11). Modal
 * sandboxes live in an App (created lazily, `appName`) and boot from an Image.
 *
 * - exec streams stdout/stderr natively. Modal has no per-process kill, so each
 *   command records its shell pid under `/tmp/.sbox-proc/` and `kill()` kills
 *   that process tree (needs `/proc`, `grep`, `cut` — any Linux image).
 * - files use the native `sandbox.filesystem` API (binary-safe), incl. watch.
 * - templates build a Modal Image (`fromRegistry(FROM)` + `dockerfileCommands`)
 *   and publish it privately to the workspace as `sbox-<cacheKey16>` so
 *   `lookup(cacheKey)` finds it. Dockerfiles that COPY/ADD local context are
 *   rejected (the JS SDK cannot upload build context).
 * - private previews use connect tokens (`?_modal_connect_token=`), which work
 *   from a browser WebSocket.
 *
 * Requires the optional peer dependency `modal`.
 */
import {
  AsyncQueue,
  defineProvider,
  parseDockerfile,
  SandboxError,
  shellQuote as sq,
} from "../adapter/index.js";
import type {
  CallContext,
  CapabilityFlags,
  CapabilityMap,
  DirEntry,
  DriverExec,
  DriverHandle,
  DriverProcess,
  DriverPty,
  DriverTemplates,
  DriverVolumes,
  EgressPolicy,
  ExecOptions,
  FileInfo,
  FsEvent,
  ListFilter,
  OutputEvent,
  Preview,
  ProcessInfo,
  PtyOptions,
  ResolvedSandboxSpec,
  SandboxInfo,
  SandboxProvider,
  SecretRef,
  SnapshotOptions,
  SnapshotRef,
  TemplateRef,
  TemplateSpec,
  VolumeInfo,
} from "../adapter/index.js";

export interface ModalOptions {
  tokenId?: string;
  tokenSecret?: string;
  environment?: string;
  /** Modal App that sandboxes (and template builds) attach to. Created if missing. */
  appName?: string;
  /** Default registry image when a spec sets neither `template` nor `fromSnapshot`. */
  image?: string;
}

export const MODAL_CAPS = {
  background: "native",
  codeInterpreter: "unsupported",
  egressControl: "native",
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "native",
  fork: "unsupported",
  gpu: "native",
  killProcess: "native",
  list: "native",
  metrics: "unsupported",
  pause: "unsupported",
  privatePreview: "native",
  proxiedFetch: "unsupported",
  pty: "native",
  region: "native",
  secretsVault: "native",
  setTimeout: "unsupported",
  snapshot: "native",
  ssh: "unsupported",
  statefulKernel: "unsupported",
  stdin: "native",
  stop: "unsupported",
  streaming: "native",
  volumes: "native",
  templateBuild: "native",
} as const satisfies CapabilityMap;

export type ModalCaps = typeof MODAL_CAPS;

const MODAL_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true,
  preservesDiskOnStop: false,
  preservesMemoryOnPause: false,
  previewBrowserAuth: true,
  previewModel: "tunnel",
  templateSources: ["dockerfile", "image", "snapshot"],
};

const PROVIDER = "modal";
const DEFAULT_APP = "sbox-sdk";
const DEFAULT_IMAGE = "python:3.13-slim";
/** Where each exec records its shell pid, so kill() can find the process tree. */
export const PROC_DIR = "/tmp/.sbox-proc";
/** Query param / cookie Modal's proxy reads a connect token from. */
export const CONNECT_TOKEN_PARAM = "_modal_connect_token";

type ModalModule = typeof import("modal");
type VolumeListRequest = Parameters<ModalClient["cpClient"]["volumeList"]>[0];

let cached: ModalModule | null = null;
async function loadModal(): Promise<ModalModule> {
  cached ??= await import("modal");
  return cached;
}

// ---------------------------------------------------------------------------
// pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** gRPC status codes Modal surfaces on raw `ClientError`s. */
const GRPC = {
  ALREADY_EXISTS: 6,
  DEADLINE_EXCEEDED: 4,
  INVALID_ARGUMENT: 3,
  NOT_FOUND: 5,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  UNAUTHENTICATED: 16,
} as const;

/** Normalize Modal SDK errors (class names first, then gRPC codes, then text). */
export function mapModalError(e: unknown): SandboxError | undefined {
  if (e instanceof SandboxError) {
    return e;
  }
  const name = e instanceof Error ? `${e.name} ${e.constructor.name}` : "";
  const msg = e instanceof Error ? e.message : String(e);
  const code =
    e && typeof e === "object" && "code" in e && typeof e.code === "number"
      ? e.code
      : undefined;
  const init = { cause: e, provider: PROVIDER };
  if (/ResourceExhausted/.test(name) || code === GRPC.RESOURCE_EXHAUSTED) {
    return new SandboxError("QuotaExceeded", msg, { ...init, retryable: true });
  }
  if (
    code === GRPC.UNAUTHENTICATED ||
    code === GRPC.PERMISSION_DENIED ||
    /unauthenticated|permission denied|invalid token|token .*(missing|invalid)/i.test(
      msg
    )
  ) {
    return new SandboxError("Unauthorized", msg, init);
  }
  if (
    /NotFound/.test(name) ||
    code === GRPC.NOT_FOUND ||
    /not ?found|no such file/i.test(msg)
  ) {
    return new SandboxError("NotFound", msg, init);
  }
  if (
    /AlreadyExists|ConflictError|PathAlreadyExists/.test(name) ||
    code === GRPC.ALREADY_EXISTS
  ) {
    return new SandboxError("Conflict", msg, init);
  }
  if (
    /Timeout/.test(name) ||
    code === GRPC.DEADLINE_EXCEEDED ||
    /timed? ?out/i.test(msg)
  ) {
    return new SandboxError("Timeout", msg, init);
  }
  if (/InvalidError/.test(name) || code === GRPC.INVALID_ARGUMENT) {
    return new SandboxError("Validation", msg, init);
  }
  return undefined;
}

const validation = (msg: string): SandboxError =>
  new SandboxError("Validation", msg, { provider: PROVIDER });
const notSupported = (feature: string): SandboxError =>
  new SandboxError(
    "NotSupported",
    `'${feature}' is not supported by provider 'modal'`,
    { provider: PROVIDER, retryable: false }
  );

/** Small deterministic string hash (djb2 mod a 32-bit prime), hex. */
function hash32(s: string): string {
  let h = 5381;
  for (const ch of s) {
    h = (h * 33 + (ch.codePointAt(0) ?? 0)) % 4_294_967_291;
  }
  return h.toString(16).padStart(8, "0");
}

/** Deterministic sandbox name from an idempotency key (unique per App). */
export function nameFromIdempotencyKey(key: string): string {
  const slug = key.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-");
  return slug.length <= 48
    ? `sbox-${slug}`
    : `sbox-${slug.slice(0, 32)}-${hash32(key)}`;
}

/** Published image name a template build is cached under. */
export function templateImageName(cacheKey: string): string {
  return `sbox-${cacheKey.slice(0, 16)}`;
}

const isImageId = (ref: string): boolean => /^im-[A-Za-z0-9]+$/.test(ref);

/**
 * Split a Dockerfile into a registry base (the single `FROM`) and the
 * remaining instructions for `Image.dockerfileCommands`. Rejects multi-stage
 * builds and anything that needs local build context.
 */
export function dockerfileToModal(text: string): {
  base: string;
  commands: string[];
} {
  let base: string | undefined;
  const commands: string[] = [];
  for (const ins of parseDockerfile(text)) {
    if (ins.op === "FROM") {
      if (base !== undefined) {
        throw validation(
          "multi-stage Dockerfiles are not supported by Modal templates"
        );
      }
      const [image] = ins.args.replace(/--platform=\S+\s*/, "").split(/\s+/);
      if (!image) {
        throw validation("FROM without an image");
      }
      base = image;
      continue;
    }
    if (base === undefined) {
      if (ins.op === "ARG") {
        throw validation(
          "ARG before FROM is not supported by Modal templates (inline the base image)"
        );
      }
      throw validation(`Dockerfile must start with FROM (got ${ins.op})`);
    }
    if (ins.op === "COPY" && !/^--from=/i.test(ins.args)) {
      throw validation(
        "COPY from build context is not supported by Modal's JS SDK; bake files into a registry image or write them after boot"
      );
    }
    if (ins.op === "ADD" && !/^(--\S+\s+)*https?:\/\//i.test(ins.args)) {
      throw validation(
        "ADD from build context is not supported by Modal's JS SDK"
      );
    }
    commands.push(ins.raw);
  }
  if (base === undefined) {
    throw validation("Dockerfile has no FROM");
  }
  return { base, commands };
}

/** TemplateSpec env/workdir/user → extra Dockerfile instructions. */
export function templateExtras(spec: TemplateSpec): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    out.push(`ENV ${k}=${JSON.stringify(v)}`);
  }
  if (spec.workdir) {
    out.push(`WORKDIR ${spec.workdir}`);
  }
  if (spec.user) {
    out.push(`USER ${spec.user}`);
  }
  return out;
}

/** `EgressPolicy` → Modal allowlists. Both dimensions are always set. */
export function egressToModal(
  policy: EgressPolicy
): SandboxUpdateNetworkPolicyParams {
  if (
    policy.deny &&
    (policy.deny.cidrs?.length || policy.deny.domains?.length)
  ) {
    throw notSupported("network.deny (Modal only supports allow lists)");
  }
  switch (policy.mode) {
    case "allow-all": {
      return {
        outboundCidrAllowlist: ["0.0.0.0/0"],
        outboundDomainAllowlist: ["*"],
      };
    }
    case "block-all": {
      return { outboundCidrAllowlist: [], outboundDomainAllowlist: [] };
    }
    case "allow-list": {
      return {
        outboundCidrAllowlist: [...(policy.cidrs ?? [])],
        outboundDomainAllowlist: [...(policy.domains ?? [])],
      };
    }
    default: {
      throw validation(`unknown egress mode '${String(policy.mode)}'`);
    }
  }
}

function gpuString(spec: ResolvedSandboxSpec): string | undefined {
  const r = spec.resources;
  if (!r?.gpu) {
    return undefined;
  }
  return r.gpuCount && r.gpuCount > 1 ? `${r.gpu}:${r.gpuCount}` : r.gpu;
}

/** Shell wrapper that records the shell pid, runs `$1`, and cleans up. */
function wrapArgv(id: string, cmd: string): string[] {
  const pidFile = `${PROC_DIR}/${id}`;
  return [
    "sh",
    "-c",
    `mkdir -p ${PROC_DIR} 2>/dev/null; echo $$ > ${pidFile} 2>/dev/null; sh -c "$1"; rc=$?; rm -f ${pidFile}; exit $rc`,
    "sbox-exec",
    cmd,
  ];
}

/** Kill the process tree recorded under `id` (children first, then the shell). */
function killScript(id: string): string {
  const pidFile = `${PROC_DIR}/${id}`;
  return `kt(){ for c in $(grep -l "^PPid:[[:space:]]*$1\\$" /proc/[0-9]*/status 2>/dev/null | cut -d/ -f3); do kt "$c"; done; kill -9 "$1" 2>/dev/null; }; p=$(cat ${pidFile} 2>/dev/null) && [ -n "$p" ] && kt "$p"; rm -f ${pidFile} ${pidFile}.tty; true`;
}

async function pumpText(
  stream: ReadableStream<string>,
  onChunk: (s: string) => void
): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      if (value) {
        onChunk(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function mapWatchEvent(ev: FileWatchEvent): FsEvent[] {
  const type =
    ev.eventType === "Create"
      ? "create"
      : ev.eventType === "Modify"
        ? "modify"
        : ev.eventType === "Remove"
          ? "delete"
          : undefined;
  return type ? ev.paths.map((path) => ({ path, type })) : [];
}

// ---------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------

/** Run a provider-level call, normalizing SDK errors (the core doesn't map these). */
async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapModalError(error) ?? SandboxError.wrap(error, PROVIDER);
  }
}

/** Modal sandboxes via the `modal` JS SDK. */
export const modal = defineProvider<ModalCaps, ModalSandbox, ModalOptions>(
  (opts) => {
    const appName = opts.appName ?? DEFAULT_APP;
    let client: ModalClient | null = null;
    let appP: Promise<App> | null = null;

    const getClient = async (): Promise<ModalClient> => {
      if (!client) {
        const mod = await loadModal();
        client = new mod.ModalClient({
          environment: opts.environment,
          tokenId: opts.tokenId,
          tokenSecret: opts.tokenSecret,
        });
      }
      return client;
    };
    const getApp = async (): Promise<App> => {
      const c = await getClient();
      appP ??= c.apps.fromName(appName, { createIfMissing: true });
      appP.catch(() => {
        appP = null;
      });
      return appP;
    };

    // ---- spec → SandboxCreateParams ----
    const secretFor = async (
      c: ModalClient,
      ref: SecretRef
    ): Promise<{ secret: ModalSecret; key: string }> => {
      const key = ref.envVar ?? ref.name;
      return ref.value === undefined
        ? { key, secret: await c.secrets.fromName(ref.name) }
        : { key, secret: await c.secrets.fromObject({ [key]: ref.value }) };
    };

    const outboundPolicy = async (
      c: ModalClient,
      policy: EgressPolicy
    ): Promise<ExperimentalOutboundPolicy | undefined> => {
      if (!policy.inject?.length) {
        return undefined;
      }
      const mod = await loadModal();
      let out = new mod.ExperimentalOutboundPolicy();
      for (const inj of policy.inject) {
        const plain: Record<string, string> = {};
        const bySecret = new Map<
          string,
          { secret: ModalSecret; headers: Record<string, string> }
        >();
        for (const [header, v] of Object.entries(inj.headers)) {
          if (typeof v === "string") {
            plain[header] = v.split("$").join("$$");
            continue;
          }
          const { key, secret } = await secretFor(c, v);
          const slot = bySecret.get(v.name) ?? { headers: {}, secret };
          slot.headers[header] = `$${key}`;
          bySecret.set(v.name, slot);
        }
        for (const domain of inj.domains) {
          if (Object.keys(plain).length > 0) {
            out = out.withHeaderReplacement({ domain, headers: plain });
          }
          for (const { secret, headers } of bySecret.values()) {
            out = out.withHeaderReplacement({ domain, headers, secret });
          }
        }
      }
      return out;
    };

    const resolveVolume = async (
      c: ModalClient,
      idOrName: string
    ): Promise<ModalVolume> => {
      if (idOrName.startsWith("vo-")) {
        for await (const v of listVolumes(c)) {
          if (v.id === idOrName && v.name) {
            return c.volumes.fromName(v.name);
          }
        }
        throw new SandboxError("NotFound", `no volume ${idOrName}`, {
          provider: PROVIDER,
        });
      }
      return c.volumes.fromName(idOrName);
    };

    const resolveImage = async (
      c: ModalClient,
      spec: ResolvedSandboxSpec
    ): Promise<ModalImage> => {
      const ref =
        spec.fromSnapshot ??
        spec.templateRef?.id ??
        spec.template ??
        opts.image ??
        DEFAULT_IMAGE;
      if (isImageId(ref)) {
        return c.images.fromId(ref);
      }
      if (spec.templateRef) {
        return c.images.fromName(ref);
      }
      return c.images.fromRegistry(ref);
    };

    const createParams = async (
      c: ModalClient,
      spec: ResolvedSandboxSpec,
      name: string
    ): Promise<SandboxCreateParams> => {
      const lc = spec.lifecycle;
      const params: SandboxCreateParams = {
        env: { ...spec.env },
        name,
        tags: { ...spec.metadata },
      };
      const r = spec.resources;
      if (r?.vcpus !== undefined) {
        params.cpu = r.vcpus;
      }
      if (r?.memoryMB !== undefined) {
        params.memoryMiB = r.memoryMB;
      }
      const gpu = gpuString(spec);
      if (gpu) {
        params.gpu = gpu;
      }
      if (lc?.maxAgeMs !== undefined) {
        params.timeoutMs = lc.maxAgeMs;
      }
      if (lc?.idleTimeoutMs !== undefined) {
        params.idleTimeoutMs = lc.idleTimeoutMs;
      }
      if (spec.region) {
        params.regions = [spec.region];
      }
      if (spec.ports?.length) {
        params.encryptedPorts = [...spec.ports];
      }
      const envSecrets = (spec.secrets ?? []).filter(
        (s) => s.mode !== "egress"
      );
      if (envSecrets.length > 0) {
        params.secrets = await Promise.all(
          envSecrets.map(async (s) => (await secretFor(c, s)).secret)
        );
      }
      if (spec.volumes?.length) {
        const vols: Record<string, ModalVolume> = {};
        for (const v of spec.volumes) {
          const vol = await resolveVolume(c, v.id);
          vols[v.mountPath] = v.readOnly
            ? vol.withMountOptions({ readOnly: true })
            : vol;
        }
        params.volumes = vols;
      }
      if (spec.network && spec.network.mode !== "allow-all") {
        if (spec.network.mode === "block-all") {
          params.blockNetwork = true;
        } else {
          const lists = egressToModal(spec.network);
          params.outboundCidrAllowlist = lists.outboundCidrAllowlist;
          params.outboundDomainAllowlist = lists.outboundDomainAllowlist;
        }
      } else if (spec.network) {
        egressToModal(spec.network); // validates deny
      }
      if (spec.network) {
        const policy = await outboundPolicy(c, spec.network);
        if (policy) {
          params.experimentalOutboundPolicy = policy;
        }
      }
      return params;
    };

    const createSandbox = async (
      spec: ResolvedSandboxSpec,
      ctx: CallContext,
      reuseExisting: boolean
    ): Promise<ModalSandbox> => {
      const c = await getClient();
      const app = await getApp();
      const derived = spec.name === undefined;
      const name =
        spec.name ??
        nameFromIdempotencyKey(
          ctx.idempotencyKey ?? globalThis.crypto.randomUUID()
        );
      const image = await resolveImage(c, spec);
      const params = await createParams(c, spec, name);
      try {
        // 0.11+: blocks until scheduled; throws ResourceExhaustedError on no capacity.
        return await c.sandboxes.create(app, image, params);
      } catch (error) {
        if (
          (derived || reuseExisting) &&
          mapModalError(error)?.code === "Conflict"
        ) {
          return c.sandboxes.fromName(appName, name);
        }
        throw error;
      }
    };

    const makeHandle = (sb: ModalSandbox): DriverHandle<ModalSandbox> => {
      const fsys = sb.filesystem;

      const runText = async (
        script: string
      ): Promise<{ stdout: string; exitCode: number }> => {
        const p = await sb.exec(["sh", "-c", script], {
          mode: "text",
          stderr: "ignore",
        });
        let stdout = "";
        await pumpText(p.stdout, (s) => {
          stdout += s;
        });
        return { exitCode: await p.wait(), stdout };
      };
      const killTree = async (id: string): Promise<void> => {
        await runText(killScript(id));
      };

      const runExec = (cmd: string, eopts: ExecOptions): DriverProcess => {
        const id = globalThis.crypto.randomUUID();
        const startedAt = Date.now();
        const queue = new AsyncQueue<OutputEvent>();
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let resolveProc!: (p: ContainerProcess<string>) => void;
        let rejectProc!: (e: unknown) => void;
        const procP = new Promise<ContainerProcess<string>>((res, rej) => {
          resolveProc = res;
          rejectProc = rej;
        });
        procP.catch(() => {});
        const finish = (ev: OutputEvent | Error) => {
          if (settled) {
            return;
          }
          settled = true;
          if (timer) {
            clearTimeout(timer);
          }
          if (ev instanceof Error) {
            queue.fail(ev);
          } else {
            queue.push(ev);
            queue.close();
          }
        };
        void (async () => {
          const proc = await sb.exec(wrapArgv(id, cmd), {
            env: eopts.env,
            mode: "text",
            stderr: "pipe",
            stdout: "pipe",
            timeoutMs: eopts.timeoutMs,
            workdir: eopts.cwd,
          });
          resolveProc(proc);
          await Promise.all([
            pumpText(proc.stdout, (data) => {
              if (!settled) {
                queue.push({ data, type: "stdout" });
              }
            }),
            pumpText(proc.stderr, (data) => {
              if (!settled) {
                queue.push({ data, type: "stderr" });
              }
            }),
          ]);
          const exitCode = await proc.wait();
          const limit = eopts.timeoutMs;
          // Modal enforced timeoutMs natively and killed the process.
          finish(
            limit !== undefined && limit > 0 && Date.now() - startedAt >= limit
              ? new SandboxError(
                  "Timeout",
                  `command timed out after ${limit}ms`,
                  {
                    provider: PROVIDER,
                    timedOut: true,
                  }
                )
              : { exitCode, type: "exit" }
          );
        })().catch((error: unknown) => {
          rejectProc(error);
          finish(mapModalError(error) ?? SandboxError.wrap(error, PROVIDER));
        });
        if (eopts.timeoutMs !== undefined && eopts.timeoutMs > 0) {
          const ms = eopts.timeoutMs;
          timer = setTimeout(() => {
            finish(
              new SandboxError("Timeout", `command timed out after ${ms}ms`, {
                provider: PROVIDER,
                timedOut: true,
              })
            );
            void killTree(id).catch(() => {});
          }, ms);
        }
        return {
          [Symbol.asyncIterator]: () => queue.iterator(),
          id,
          async kill() {
            finish({ exitCode: 137, signal: "SIGKILL", type: "exit" });
            await killTree(id);
          },
          pid: Promise.resolve(id),
          async writeStdin(data: Uint8Array) {
            const proc = await procP;
            const w = proc.stdin.getWriter();
            try {
              await w.write(new TextDecoder().decode(data));
            } finally {
              w.releaseLock();
            }
          },
        };
      };

      return {
        id: sb.sandboxId,
        raw: sb,

        // ---- lifecycle ----
        async getInfo(): Promise<SandboxInfo> {
          let exit: number | null;
          try {
            exit = await sb.poll();
          } catch (error) {
            if (mapModalError(error)?.code === "NotFound") {
              return {
                id: sb.sandboxId,
                metadata: {},
                provider: PROVIDER,
                raw: sb,
                state: "destroyed",
              };
            }
            throw error;
          }
          // Modal sandboxes can't be restarted: a finished one is gone for good.
          const metadata = exit === null ? await sb.getTags() : {};
          return {
            id: sb.sandboxId,
            metadata,
            provider: PROVIDER,
            raw: sb,
            state: exit === null ? "running" : "destroyed",
          };
        },
        async destroy() {
          await sb.terminate();
        },

        // ---- exec ----
        exec(cmd, eopts): DriverExec {
          return runExec(cmd, eopts);
        },
        spawn(cmd, eopts): DriverProcess {
          return runExec(cmd, eopts);
        },
        async killProcess(processId) {
          await killTree(processId);
        },
        async listProcesses(): Promise<ProcessInfo[]> {
          const r = await runText(`ls -1 ${PROC_DIR} 2>/dev/null; true`);
          return r.stdout
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l && !l.endsWith(".tty"))
            .map((id) => ({ cmd: "", id }));
        },

        // ---- files (native filesystem API) ----
        async readFile(path) {
          return fsys.readBytes(path);
        },
        async writeFile(path, data) {
          await fsys.writeBytes(data, path);
        },
        async listDir(path): Promise<DirEntry[]> {
          const entries = await fsys.listFiles(path);
          return entries.map((f) => ({
            name: f.name,
            path: f.path,
            type: f.type === "directory" ? "dir" : f.type,
          }));
        },
        async mkdir(path, recursive) {
          await fsys.makeDirectory(path, { createParents: recursive });
        },
        async remove(path, recursive) {
          await fsys.remove(path, { recursive });
        },
        async stat(path): Promise<FileInfo> {
          const f = await fsys.stat(path);
          return {
            mtime: f.modifiedTime ? new Date(f.modifiedTime * 1000) : undefined,
            path: f.path,
            size: f.size,
            type: f.type === "directory" ? "dir" : f.type,
          };
        },
        async watch(path, cb, recursive) {
          const it = fsys.watch(path, { recursive })[Symbol.asyncIterator]();
          const state = { closed: false };
          void (async () => {
            for (;;) {
              const r = await it.next();
              if (r.done || state.closed) {
                return;
              }
              for (const ev of mapWatchEvent(r.value)) {
                cb(ev);
              }
            }
          })().catch(() => {});
          return async () => {
            state.closed = true;
            // Don't await: an async iterator's return() queues behind a pending next().
            void it.return?.()?.catch(() => {});
          };
        },

        // ---- network ----
        async exposePort(port, eopts): Promise<Preview> {
          if (!eopts.private) {
            const tunnels = await sb.tunnels();
            const t = tunnels[port];
            if (t) {
              return { auth: { type: "public" }, port, url: t.url };
            }
            // Not declared in spec.ports: fall through to a connect token.
          }
          const creds = await sb.createConnectToken({ port });
          return {
            auth: {
              param: CONNECT_TOKEN_PARAM,
              token: creds.token,
              type: "query",
            },
            port,
            url: creds.url,
          };
        },
        async listPorts(): Promise<Preview[]> {
          const tunnels = await sb.tunnels();
          return Object.entries(tunnels).map(([port, t]) => ({
            auth: { type: "public" },
            port: Number(port),
            url: t.url,
          }));
        },
        async setEgressPolicy(policy) {
          const lists = egressToModal(policy);
          if (policy.inject?.length) {
            const policyObj = await outboundPolicy(await getClient(), policy);
            if (policyObj) {
              await sb.experimentalUpdateOutboundPolicy(policyObj);
            }
          }
          await sb.updateNetworkPolicy(lists);
        },

        // ---- pty ----
        async createPty(popts: PtyOptions): Promise<DriverPty> {
          const id = `pty-${globalThis.crypto.randomUUID()}`;
          const pidFile = `${PROC_DIR}/${id}`;
          const size =
            popts.cols && popts.rows
              ? `stty cols ${popts.cols} rows ${popts.rows} 2>/dev/null; `
              : "";
          const program =
            popts.cmd ??
            "if command -v bash >/dev/null; then exec bash -l; else exec sh -l; fi";
          const proc = await sb.exec(
            [
              "sh",
              "-c",
              `mkdir -p ${PROC_DIR} 2>/dev/null; echo $$ > ${pidFile}; tty > ${pidFile}.tty 2>/dev/null; ${size}exec sh -c ${sq(program)}`,
            ],
            { env: popts.env, mode: "binary", pty: true, workdir: popts.cwd }
          );
          const out = new AsyncQueue<Uint8Array>();
          void (async () => {
            const reader = proc.stdout.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              out.push(value);
            }
            out.close();
          })().catch((error: unknown) =>
            out.fail(mapModalError(error) ?? SandboxError.wrap(error, PROVIDER))
          );
          const exited = proc.wait();
          exited.catch(() => {});
          const writer = proc.stdin.getWriter();
          const enc = new TextEncoder();
          return {
            id,
            async kill() {
              await killTree(id);
            },
            output: { [Symbol.asyncIterator]: () => out.iterator() },
            async resize(cols, rows) {
              await runText(
                `t=$(cat ${pidFile}.tty 2>/dev/null) && [ -n "$t" ] && stty -F "$t" cols ${cols} rows ${rows}; true`
              );
            },
            wait: () => exited,
            async write(data) {
              await writer.write(
                typeof data === "string" ? enc.encode(data) : data
              );
            },
          };
        },

        // ---- snapshots ----
        async snapshot(sopts: SnapshotOptions): Promise<SnapshotRef> {
          if (sopts.mode === "memory") {
            throw notSupported("snapshots.create({ mode: 'memory' })");
          }
          const image = await sb.snapshotFilesystem();
          return {
            createdAt: new Date(),
            id: image.imageId,
            includesMemory: false,
            name: sopts.name,
            provider: PROVIDER,
            raw: image,
          };
        },
        async deleteSnapshot(ref) {
          const c = await getClient();
          await c.images.delete(ref);
        },
      };
    };

    // ---- volumes ----
    async function* listVolumes(c: ModalClient): AsyncIterable<VolumeInfo> {
      let createdBefore = 0;
      for (;;) {
        const req: VolumeListRequest = {
          environmentName: c.environmentName(opts.environment),
          pagination: { createdBefore, maxObjects: 100 },
        };
        const resp = await c.cpClient.volumeList(req);
        if (resp.items.length === 0) {
          return;
        }
        for (const it of resp.items) {
          const created = it.metadata?.creationInfo?.createdAt ?? it.createdAt;
          yield {
            createdAt: created ? new Date(created * 1000) : undefined,
            id: it.volumeId,
            name: it.metadata?.name || it.label,
            raw: it,
          };
        }
        const last = resp.items.at(-1)!;
        const next = last.metadata?.creationInfo?.createdAt ?? last.createdAt;
        if (resp.items.length < 100 || !next || next === createdBefore) {
          return;
        }
        createdBefore = next;
      }
    }

    const volumes: DriverVolumes = {
      async create(spec) {
        const c = await getClient();
        const v = await c.volumes.fromName(spec.name, {
          createIfMissing: true,
        });
        return { id: v.volumeId, name: v.name ?? spec.name, raw: v };
      },
      async get(idOrName) {
        const c = await getClient();
        if (idOrName.startsWith("vo-")) {
          for await (const v of listVolumes(c)) {
            if (v.id === idOrName) {
              return v;
            }
          }
          return undefined;
        }
        try {
          const v = await c.volumes.fromName(idOrName);
          return { id: v.volumeId, name: v.name ?? idOrName, raw: v };
        } catch (error) {
          if (mapModalError(error)?.code === "NotFound") {
            return undefined;
          }
          throw error;
        }
      },
      async *list() {
        yield* listVolumes(await getClient());
      },
      async delete(id) {
        const c = await getClient();
        let name = id;
        if (id.startsWith("vo-")) {
          let found: VolumeInfo | undefined;
          for await (const v of listVolumes(c)) {
            if (v.id === id) {
              found = v;
              break;
            }
          }
          if (!found?.name) {
            throw new SandboxError("NotFound", `no volume ${id}`, {
              provider: PROVIDER,
            });
          }
          ({ name } = found);
        }
        await c.volumes.delete(name);
      },
    };

    // ---- templates (published Modal Images) ----
    const imageRef = (
      image: ModalImage,
      name?: string,
      cacheKey?: string
    ): TemplateRef => ({
      cacheKey,
      id: image.imageId,
      name,
      provider: PROVIDER,
      raw: image,
    });

    const templates: DriverTemplates = {
      async build(spec, bopts) {
        const c = await getClient();
        const app = await getApp();
        const { source } = spec;
        let image: ModalImage;
        let commands: string[];
        if ("dockerfile" in source && source.dockerfile !== undefined) {
          const parsed = dockerfileToModal(source.dockerfile);
          image = c.images.fromRegistry(parsed.base);
          commands = parsed.commands;
        } else if ("image" in source && source.image !== undefined) {
          const auth = source.registryAuth
            ? await c.secrets.fromObject({
                REGISTRY_PASSWORD: source.registryAuth.password,
                REGISTRY_USERNAME: source.registryAuth.username,
              })
            : undefined;
          image = c.images.fromRegistry(source.image, auth);
          commands = [];
        } else if ("snapshot" in source && source.snapshot !== undefined) {
          image = await c.images.fromId(source.snapshot);
          commands = [];
        } else {
          throw validation(
            "template source needs one of dockerfile | image | snapshot"
          );
        }
        commands = [...commands, ...templateExtras(spec)];
        for (const [field, value] of [
          ["startCmd", spec.startCmd],
          ["readyCmd", spec.readyCmd],
        ] as const) {
          if (value) {
            bopts.onEvent({
              line: `${field} is not applied by Modal templates (sandboxes run their own command); ignored`,
              stream: "stderr",
              type: "log",
            });
          }
        }
        if (commands.length > 0) {
          image = image.dockerfileCommands(commands);
        }
        bopts.onEvent({ status: "building", type: "status" });
        for (const line of commands) {
          bopts.onEvent({ line, step: line.split(/\s/)[0], type: "log" });
        }
        const built = await image.build(app);
        // Published with allowPublic=false: visible only inside this workspace.
        const cacheName = templateImageName(spec.cacheKey);
        await built.publish(cacheName, { environment: opts.environment });
        if (spec.name !== cacheName) {
          await built.publish(spec.name, { environment: opts.environment });
        }
        return imageRef(built, spec.name, spec.cacheKey);
      },
      async lookup(idOrKey) {
        const c = await getClient();
        try {
          if (isImageId(idOrKey)) {
            return imageRef(await c.images.fromId(idOrKey));
          }
          if (/^[0-9a-f]{64}$/.test(idOrKey)) {
            const name = templateImageName(idOrKey);
            return imageRef(
              await c.images.fromName(name, { environment: opts.environment }),
              name,
              idOrKey
            );
          }
          return imageRef(
            await c.images.fromName(idOrKey, { environment: opts.environment }),
            idOrKey
          );
        } catch (error) {
          const mapped = mapModalError(error);
          if (mapped?.code === "NotFound" || mapped?.code === "Validation") {
            return undefined;
          }
          throw error;
        }
      },
      async delete(id) {
        const c = await getClient();
        const imageId = isImageId(id)
          ? id
          : (await c.images.fromName(id)).imageId;
        await c.images.delete(imageId);
      },
    };

    async function* listRaw(
      filter: ListFilter | undefined
    ): AsyncIterable<SandboxInfo> {
      // Modal only lists live sandboxes (includeFinished=false).
      if (filter?.state && filter.state !== "running") {
        return;
      }
      const c = await getClient();
      const app = await getApp();
      let n = 0;
      for await (const sb of c.sandboxes.list({
        appId: app.appId,
        ...(filter?.metadata ? { tags: filter.metadata } : {}),
      })) {
        if (filter?.limit !== undefined && n >= filter.limit) {
          return;
        }
        const metadata = await sb.getTags();
        if (
          filter?.metadata &&
          !Object.entries(filter.metadata).every(([k, v]) => metadata[k] === v)
        ) {
          continue;
        }
        n++;
        yield {
          id: sb.sandboxId,
          metadata,
          provider: PROVIDER,
          raw: sb,
          state: "running",
        };
      }
    }

    const provider: SandboxProvider<ModalCaps, ModalSandbox> = {
      capabilities: MODAL_CAPS,
      flags: MODAL_FLAGS,
      mapError: mapModalError,
      name: PROVIDER,
      templates,
      volumes,

      create: (spec, ctx) =>
        mapped(async () => makeHandle(await createSandbox(spec, ctx, false))),

      connect: (id) =>
        mapped(async () => {
          const c = await getClient();
          return makeHandle(await c.sandboxes.fromId(id));
        }),

      getOrCreate: (spec, ctx) =>
        mapped(async () => {
          const c = await getClient();
          try {
            const sb = await c.sandboxes.fromName(appName, spec.name);
            if ((await sb.poll()) === null) {
              return makeHandle(sb);
            }
          } catch (error) {
            if (mapModalError(error)?.code !== "NotFound") {
              throw error;
            }
          }
          return makeHandle(await createSandbox(spec, ctx, true));
        }),

      async *list(filter: ListFilter | undefined) {
        try {
          yield* listRaw(filter);
        } catch (error) {
          throw mapModalError(error) ?? SandboxError.wrap(error, PROVIDER);
        }
      },

      verify: () =>
        mapped(async () => {
          const c = await getClient();
          try {
            await c.apps.fromName(appName, { createIfMissing: false });
          } catch (error) {
            // An unknown App still proves the token works.
            if (mapModalError(error)?.code !== "NotFound") {
              throw error;
            }
          }
          return undefined;
        }),

      dispose() {
        client?.close();
        client = null;
        appP = null;
      },
    };
    return provider;
  }
);
