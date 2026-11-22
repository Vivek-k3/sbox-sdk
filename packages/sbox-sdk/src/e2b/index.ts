/**
 * `sbox-sdk/e2b` — adapter for E2B (`@e2b/code-interpreter`, which re-exports
 * the whole `e2b` SDK). The reference cloud adapter: code interpreter, memory
 * pause/resume, snapshots (memory or filesystem), fork, PTY, egress rules with
 * secret injection, volumes, and Dockerfile/image template builds.
 *
 * The SDK is lazy-imported on first use, so importing this subpath stays cheap.
 * Every SDK call goes through one `new E2B({ apiKey, domain })` client, so a
 * self-hosted `domain` reaches every call (sandboxes, templates, volumes,
 * secrets).
 */
import type {
  CommandHandle,
  Context,
  E2B as E2BClient,
  EntryInfo,
  Execution,
  FilesystemEvent,
  LogEntry,
  Result,
  Sandbox as E2BSandbox,
  SandboxInfo as E2BSandboxInfo,
  SandboxLifecycle,
  SandboxNetworkOpts,
  SandboxNetworkRule,
  SandboxOpts,
  SnapshotInfo,
  TemplateBuilder,
  TemplateClass,
  TemplateInfo,
  VolumeInfo as E2BVolumeInfo,
} from "@e2b/code-interpreter";

import {
  AsyncQueue,
  assertEnvKeys,
  defineProvider,
  loadTemplateContext,
  numExit,
  SandboxError,
} from "../adapter/index.js";
import type {
  CallContext,
  CapabilityFlags,
  CapabilityMap,
  CodeExecution,
  DirEntry,
  DriverExec,
  DriverHandle,
  DriverProcess,
  DriverPty,
  DriverTemplates,
  DriverVolumes,
  EgressPolicy,
  ExecOptions,
  FileBody,
  FileInfo,
  FsEvent,
  KernelContext,
  LifecyclePolicy,
  ListFilter,
  OutputEvent,
  Preview,
  ProcessInfo,
  PtyOptions,
  ResolvedSandboxSpec,
  SandboxInfo,
  SandboxMetrics,
  SandboxProvider,
  SandboxState,
  SecretRef,
  SnapshotOptions,
  SnapshotRef,
  TemplateContext,
  TemplateRef,
  VolumeInfo,
  VolumeMount,
} from "../adapter/index.js";

export interface E2BOptions {
  /** E2B API key. Defaults to the `E2B_API_KEY` environment variable. */
  apiKey?: string;
  /** Self-hosted / BYOC E2B domain. Defaults to `E2B_DOMAIN` or `e2b.app`. */
  domain?: string;
  /**
   * Whether sandbox URLs accept traffic without the per-sandbox traffic
   * access token. `false` makes every preview private (header auth, see
   * `ports.expose`). Omit it to use the project's default.
   */
  allowPublicTraffic?: boolean;
  /** Timeout for each E2B API request, ms. SDK default: 60 000. */
  requestTimeoutMs?: number;
}

export const E2B_CAPS = {
  background: "native",
  codeInterpreter: "native",
  egressControl: "native",
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "native",
  fork: "native",
  gpu: "unsupported",
  killProcess: "native",
  list: "native",
  metrics: "native",
  pause: "native",
  privatePreview: "native",
  proxiedFetch: "native",
  pty: "native",
  region: "unsupported",
  secretsVault: "native",
  setTimeout: "native",
  snapshot: "native",
  ssh: "unsupported",
  statefulKernel: "native",
  stdin: "native",
  stop: "unsupported",
  streaming: "native",
  templateBuild: "native",
  volumes: "native",
} as const satisfies CapabilityMap;

export type E2BCaps = typeof E2B_CAPS;

const E2B_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true,
  preservesDiskOnStop: false,
  preservesMemoryOnPause: true,
  // Private previews need the `e2b-traffic-access-token` HEADER (the E2B
  // proxy reads no query param or cookie), so a browser WebSocket can't open
  // one directly.
  previewBrowserAuth: false,
  previewModel: "subdomain",
  resumeChangesId: false,
  templateSources: ["dockerfile", "image", "snapshot"],
};

/** Header the E2B edge proxy checks on private sandbox URLs. */
export const E2B_TRAFFIC_TOKEN_HEADER = "e2b-traffic-access-token";

/** Mirrors the core's `SBOX_NAME_KEY` (named sandboxes live in metadata). */
const NAME_KEY = "sbox-name";
const ALL_TRAFFIC = "0.0.0.0/0";
const MIB = 1024 * 1024;
/** Ready check used when a template sets `startCmd` without `readyCmd`. */
const DEFAULT_READY_WAIT_MS = 20_000;

// --------------------------------------------------------------------------
// lazy module loader (memoized)
// --------------------------------------------------------------------------

const importE2B = () => import("@e2b/code-interpreter");
/** The module as the dynamic import yields it (CJS/ESM interop included). */
type E2BModule = Awaited<ReturnType<typeof importE2B>>;
let cached: E2BModule | null = null;
async function loadE2B(): Promise<E2BModule> {
  cached ??= await importE2B();
  return cached;
}

// --------------------------------------------------------------------------
// pure mapping helpers (exported for tests)
// --------------------------------------------------------------------------

function fail(code: SandboxError["code"], message: string): SandboxError {
  return new SandboxError(code, message, { provider: "e2b" });
}

/** Map an E2B sandbox state (API strings included) to `SandboxState`. */
export function mapE2BState(state: string | undefined): SandboxState {
  switch (state) {
    case "running": {
      return "running";
    }
    case "paused": {
      return "paused";
    }
    case "pausing":
    case "snapshotting": {
      return "suspending";
    }
    case "creating":
    case "starting":
    case "resuming": {
      return "creating";
    }
    case "killing":
    case "killed": {
      return "destroyed";
    }
    case "error":
    case "failed": {
      return "error";
    }
    default: {
      return "unknown";
    }
  }
}

function toInfo(i: E2BSandboxInfo): SandboxInfo {
  const metadata = i.metadata ?? {};
  return {
    createdAt: i.startedAt,
    id: i.sandboxId,
    metadata,
    // E2B's `info.name` is the TEMPLATE name; sandbox names live in metadata.
    name: metadata[NAME_KEY],
    provider: "e2b",
    raw: i,
    state: mapE2BState(i.state),
  };
}

const IDEMPOTENCY_RE = /^[a-z0-9-]{1,255}$/;

/**
 * E2B keys allow only `[a-z0-9-]{1,255}`. Valid keys pass through; anything
 * else is replaced by its SHA-256 hex (deterministic, so retries match).
 */
export async function e2bIdempotencyKey(key: string): Promise<string> {
  if (IDEMPOTENCY_RE.test(key)) {
    return key;
  }
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** `LifecyclePolicy` -> E2B `lifecycle` (`undefined` = API default: kill). */
export function mapLifecycle(
  l: LifecyclePolicy | undefined
): SandboxLifecycle | undefined {
  if (!l || (l.onIdle === undefined && l.autoResume === undefined)) {
    return undefined;
  }
  const onIdle = l.onIdle ?? (l.autoResume ? "pause" : "destroy");
  const auto = l.autoResume === undefined ? {} : { autoResume: l.autoResume };
  if (onIdle === "pause") {
    return { onTimeout: "pause", ...auto };
  }
  if (l.autoResume) {
    throw fail(
      "Validation",
      `lifecycle.autoResume needs onIdle "pause" on E2B (got "${onIdle}"): only a memory snapshot can be woken by traffic`
    );
  }
  // "stop" = keep the disk, drop memory: a filesystem-only auto-pause.
  return onIdle === "stop"
    ? { onTimeout: { action: "pause", mode: "filesystem" }, ...auto }
    : { onTimeout: "kill", ...auto };
}

type EgressFields = Pick<SandboxNetworkOpts, "allowOut" | "denyOut" | "rules">;

/**
 * `EgressPolicy` -> E2B `allowOut` / `denyOut` / `rules`. `fill(name)` turns a
 * stored-secret name into E2B's placeholder (`Secret.fill`), which the egress
 * proxy resolves outside the sandbox.
 */
export function mapEgress(
  policy: EgressPolicy,
  fill: (secretName: string) => string
): EgressFields {
  if (policy.deny?.domains?.length) {
    throw fail(
      "Validation",
      "E2B deny rules take CIDR blocks or IPs only, not domains; use mode 'allow-list' to restrict by domain"
    );
  }
  const denyCidrs = policy.deny?.cidrs ?? [];
  const out: EgressFields = {};
  if (policy.mode === "block-all") {
    out.denyOut = [ALL_TRAFFIC];
  } else if (policy.mode === "allow-list") {
    const allow = [...(policy.domains ?? []), ...(policy.cidrs ?? [])];
    if (allow.length > 0) {
      out.allowOut = allow;
    }
    // Allowed entries take precedence over denied ones on E2B.
    out.denyOut = [ALL_TRAFFIC];
  } else if (denyCidrs.length > 0) {
    out.denyOut = denyCidrs;
  }
  if (policy.inject?.length) {
    const rules: Record<string, SandboxNetworkRule[]> = {};
    for (const inj of policy.inject) {
      const headers: Record<string, string> = {};
      for (const [header, ref] of Object.entries(inj.headers)) {
        headers[header] = fill(typeof ref === "string" ? ref : ref.name);
      }
      for (const domain of inj.domains) {
        (rules[domain] ??= []).push({ transform: { headers } });
      }
    }
    out.rules = rules;
  }
  return out;
}

/** Template name: `<name>-<cacheKey[0:16]>`, so `lookup(cacheKey)` can find it. */
export function e2bTemplateName(name: string, cacheKey: string): string {
  const key = cacheKey.slice(0, 16);
  const base =
    name
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9_-]+/g, "-") || "sbox";
  if (base.includes(key)) {
    return base.slice(0, 128);
  }
  return `${base.slice(0, 128 - key.length - 1)}-${key}`;
}

/** "proj/name:tag" -> "name". */
function bareTemplateName(n: string): string {
  return (n.slice(n.lastIndexOf("/") + 1).split(":")[0] ?? "").toLowerCase();
}

function errorStatus(e: unknown): number | undefined {
  if (e && typeof e === "object" && "statusCode" in e) {
    const s = (e as { statusCode?: unknown }).statusCode;
    return typeof s === "number" ? s : undefined;
  }
  return undefined;
}

/** Normalize E2B SDK errors (by HTTP status, then class name, then message). */
export function mapE2BError(e: unknown): SandboxError | undefined {
  if (e instanceof SandboxError) {
    return e;
  }
  const name =
    e && typeof e === "object" && "name" in e
      ? String((e as { name?: unknown }).name)
      : "";
  const msg = e instanceof Error ? e.message : String(e);
  const status = errorStatus(e);
  const make = (
    code: SandboxError["code"],
    retryable?: boolean
  ): SandboxError =>
    new SandboxError(code, msg, {
      cause: e,
      provider: "e2b",
      status,
      ...(retryable === undefined ? {} : { retryable }),
    });
  if (status === 401 || status === 403 || name === "AuthenticationError") {
    return make("Unauthorized");
  }
  if (status === 404 || name.endsWith("NotFoundError")) {
    return make("NotFound");
  }
  if (status === 429 || name === "RateLimitError") {
    return make("QuotaExceeded", true);
  }
  if (status === 409 || name === "GuestUnresponsiveError") {
    return make("Conflict");
  }
  if (name === "SandboxNotRunningError") {
    return make("Conflict");
  }
  if (name === "ServiceBusyError" || status === 503) {
    return make("Provider", true);
  }
  if (name === "TimeoutError" || name === "SandboxUnreachableError") {
    return make("Timeout");
  }
  if (name === "InvalidArgumentError" || name === "DockerfileSyntaxError") {
    return make("Validation");
  }
  if (name === "NotEnoughSpaceError") {
    return make("QuotaExceeded", false);
  }
  if (
    name === "BuildError" ||
    name === "FileUploadError" ||
    name === "TemplateError"
  ) {
    return make("Provider", false);
  }
  if (status === 400 || status === 422) {
    return make("Validation");
  }
  const hay = `${name} ${msg}`;
  if (/not ?found/i.test(hay)) {
    return make("NotFound");
  }
  if (/unauthori[sz]ed|invalid api key|forbidden/i.test(hay)) {
    return make("Unauthorized");
  }
  if (/rate ?limit|quota|too many requests/i.test(hay)) {
    return make("QuotaExceeded", true);
  }
  if (/timeout|timed out|deadline/i.test(hay)) {
    return make("Timeout");
  }
  if (status !== undefined && status >= 500) {
    return make("Provider", true);
  }
  return undefined;
}

function wrap(e: unknown): SandboxError {
  return mapE2BError(e) ?? SandboxError.wrap(e, "e2b");
}

function isCommandExit(e: unknown): boolean {
  return (
    (cached !== null && e instanceof cached.CommandExitError) ||
    (e instanceof Error && e.name === "CommandExitError")
  );
}

function mapResult(r: Result): { mime: Record<string, string>; text?: string } {
  const mime: Record<string, string> = {};
  const put = (v: string | undefined, type: string): void => {
    if (typeof v === "string") {
      mime[type] = v;
    }
  };
  put(r.text, "text/plain");
  put(r.html, "text/html");
  put(r.markdown, "text/markdown");
  put(r.svg, "image/svg+xml");
  put(r.png, "image/png");
  put(r.jpeg, "image/jpeg");
  put(r.pdf, "application/pdf");
  put(r.latex, "text/latex");
  put(r.javascript, "application/javascript");
  if (r.json !== undefined) {
    mime["application/json"] =
      typeof r.json === "string" ? r.json : JSON.stringify(r.json);
  }
  return { mime, text: r.text };
}

function mapExecution(exec: Execution): CodeExecution {
  return {
    error: exec.error
      ? {
          name: exec.error.name,
          traceback: exec.error.traceback,
          value: exec.error.value,
        }
      : undefined,
    logs: { stderr: exec.logs.stderr, stdout: exec.logs.stdout },
    results: exec.results.map(mapResult),
  };
}

function mapFsEvent(type: FilesystemEvent["type"]): FsEvent["type"] {
  switch (type) {
    case "create": {
      return "create";
    }
    case "remove":
    case "rename": {
      return "delete";
    }
    default: {
      return "modify";
    }
  }
}

function entryType(t: EntryInfo["type"]): DirEntry["type"] {
  return t === "dir" ? "dir" : t === "symlink" ? "symlink" : "file";
}

/** Write an in-memory/dir build context to a temp dir (Node only). */
async function writeContextDir(
  context: TemplateContext | undefined
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const files = await loadTemplateContext(context);
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbox-e2b-"));
  const cleanup = () => fs.rm(dir, { force: true, recursive: true });
  try {
    for (const [rel, bytes] of files) {
      const abs = path.resolve(dir, rel);
      if (!abs.startsWith(`${dir}${path.sep}`)) {
        throw fail("Validation", `template context path escapes root: ${rel}`);
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, bytes);
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { cleanup, dir };
}

// --------------------------------------------------------------------------
// provider
// --------------------------------------------------------------------------

export const e2b = defineProvider<E2BCaps, E2BSandbox, E2BOptions>(
  (opts = {}) => {
    let clientP: Promise<E2BClient> | undefined;
    const getClient = (): Promise<E2BClient> => {
      clientP ??= loadE2B()
        .then(
          (mod) =>
            new mod.E2B({
              ...(opts.apiKey === undefined ? {} : { apiKey: opts.apiKey }),
              ...(opts.domain === undefined ? {} : { domain: opts.domain }),
              ...(opts.requestTimeoutMs === undefined
                ? {}
                : { requestTimeoutMs: opts.requestTimeoutMs }),
            })
        )
        .catch((error: unknown) => {
          clientP = undefined;
          throw error;
        });
      return clientP;
    };

    // ---- secrets -----------------------------------------------------------

    const upsertSecret = async (
      client: E2BClient,
      name: string,
      value: string
    ): Promise<void> => {
      await ((await client.Secret.exists(name))
        ? client.Secret.update(name, value)
        : client.Secret.create(name, value));
    };

    /** Store inline values of egress secrets so `Secret.fill` resolves them. */
    const storeEgressSecrets = async (
      client: E2BClient,
      refs: Iterable<SecretRef | string>
    ): Promise<void> => {
      for (const ref of refs) {
        if (typeof ref !== "string" && ref.value !== undefined) {
          await upsertSecret(client, ref.name, ref.value);
        }
      }
    };

    const networkFor = async (
      client: E2BClient,
      policy: EgressPolicy
    ): Promise<EgressFields> => {
      const fields = mapEgress(policy, (n) => client.Secret.fill(n));
      await storeEgressSecrets(
        client,
        (policy.inject ?? []).flatMap((i) => Object.values(i.headers))
      );
      return fields;
    };

    // ---- create options ------------------------------------------------------

    const volumeMounts = async (
      client: E2BClient,
      mounts: VolumeMount[] | undefined
    ): Promise<Record<string, string> | undefined> => {
      if (!mounts?.length) {
        return undefined;
      }
      const known = await client.Volume.list();
      const out: Record<string, string> = {};
      for (const m of mounts) {
        if (m.readOnly) {
          throw fail("Validation", "E2B volume mounts cannot be read-only");
        }
        // E2B mounts by volume NAME; accept an id too.
        out[m.mountPath] = known.find((v) => v.volumeId === m.id)?.name ?? m.id;
      }
      return out;
    };

    const createOptions = async (
      client: E2BClient,
      spec: ResolvedSandboxSpec,
      ctx: CallContext
    ): Promise<SandboxOpts> => {
      if (spec.resources?.gpu || spec.resources?.gpuCount) {
        throw fail("Validation", "E2B sandboxes have no GPUs");
      }
      const envs: Record<string, string> = { ...spec.env };
      const egressSecrets: SecretRef[] = [];
      for (const s of spec.secrets ?? []) {
        if ((s.mode ?? "env") === "env") {
          if (s.value === undefined) {
            throw fail(
              "Validation",
              `secret '${s.name}': E2B stored secrets are write-only and can't become env vars; pass \`value\`, or use mode "egress" with network.inject`
            );
          }
          envs[s.envVar ?? s.name] = s.value;
        } else {
          egressSecrets.push(s);
        }
      }
      assertEnvKeys(envs);
      await storeEgressSecrets(client, egressSecrets);
      const network: SandboxNetworkOpts = {
        ...(spec.network ? await networkFor(client, spec.network) : {}),
        ...(opts.allowPublicTraffic === undefined
          ? {}
          : { allowPublicTraffic: opts.allowPublicTraffic }),
      };
      const lc = spec.lifecycle;
      const timeoutMs = lc?.maxAgeMs ?? lc?.idleTimeoutMs ?? spec.ttlMs;
      const lifecycle = mapLifecycle(lc);
      const mounts = await volumeMounts(client, spec.volumes);
      const metadata = {
        ...spec.metadata,
        ...(spec.name ? { [NAME_KEY]: spec.name } : {}),
      };
      return {
        envs,
        metadata,
        ...(Object.keys(network).length > 0 ? { network } : {}),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(lifecycle ? { lifecycle } : {}),
        ...(mounts ? { volumeMounts: mounts } : {}),
        ...(spec.resources?.vcpus === undefined
          ? {}
          : { cpuCount: spec.resources.vcpus }),
        ...(ctx.idempotencyKey
          ? { idempotencyKey: await e2bIdempotencyKey(ctx.idempotencyKey) }
          : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      };
    };

    /** Resize /dev/shm (Chromium wants ~1 GB). Kills the sandbox on failure. */
    const applyShm = async (
      sb: E2BSandbox,
      shmMB: number | undefined
    ): Promise<void> => {
      if (shmMB === undefined) {
        return;
      }
      const size = Math.max(1, Math.floor(shmMB));
      try {
        await sb.commands.run(`mount -o remount,size=${size}m /dev/shm`, {
          user: "root",
        });
      } catch (error) {
        await sb.kill().catch(() => false);
        throw new SandboxError(
          "Provider",
          `could not resize /dev/shm to ${size} MB`,
          { cause: error, provider: "e2b", retryable: false }
        );
      }
    };

    // ---- handle ---------------------------------------------------------------

    const makeHandle = (initial: E2BSandbox): DriverHandle<E2BSandbox> => {
      let current = initial;
      const contexts = new Map<string, Context>();

      /** Pump a started command into an OutputEvent queue. */
      const pump = (
        h: CommandHandle<string | undefined>,
        queue: AsyncQueue<OutputEvent>
      ): void => {
        void (async () => {
          try {
            const res = await h.wait();
            queue.push({ exitCode: res.exitCode, type: "exit" });
            queue.close();
          } catch (error) {
            if (isCommandExit(error)) {
              queue.push({ exitCode: numExit(error), type: "exit" });
              queue.close();
              return;
            }
            // Stream ended without an exit (deadline, lost sandbox): make
            // sure the process doesn't outlive us, then surface the error.
            await h.kill().catch(() => false);
            queue.fail(wrap(error));
          }
        })();
      };

      const start = (
        cmd: string,
        o: ExecOptions,
        keepStdin: boolean
      ): {
        queue: AsyncQueue<OutputEvent>;
        handle: Promise<CommandHandle<undefined>>;
        started: Promise<CommandHandle<undefined> | null>;
      } => {
        const queue = new AsyncQueue<OutputEvent>();
        const handle = current.commands.run(cmd, {
          background: true,
          cwd: o.cwd,
          envs: o.env,
          onStderr: (data) => queue.push({ data, type: "stderr" }),
          onStdout: (data) => queue.push({ data, type: "stdout" }),
          retainOutput: false,
          // `stdin: false` throws on old envd; leave it unset when closed.
          ...(keepStdin ? { stdin: true } : {}),
          // E2B's own default is 60 s, which would kill long-running
          // servers; 0 = no limit (the core enforces `timeoutMs` too).
          timeoutMs: o.timeoutMs ?? 0,
          user: o.user,
        });
        // `started` resolves null when the start failed (the queue carries
        // the error), so exec's eager `pid` never rejects unhandled.
        const started = handle
          .catch((error: unknown) => {
            queue.fail(wrap(error));
            return null;
          })
          .then((h) => {
            if (h) {
              pump(h, queue);
            }
            return h;
          });
        return { handle, queue, started };
      };

      const openPty = async (
        connect: (
          onData: (d: Uint8Array) => void
        ) => Promise<CommandHandle<string | undefined>>
      ): Promise<DriverPty> => {
        const out = new AsyncQueue<Uint8Array>();
        const h = await connect((d) => out.push(d));
        const { pid } = h;
        const exited = h
          .wait()
          .then(
            (r) => r.exitCode,
            (error: unknown) => {
              if (isCommandExit(error)) {
                return numExit(error);
              }
              throw wrap(error);
            }
          )
          .finally(() => out.close());
        exited.catch(() => {
          /* surfaced via wait() */
        });
        return {
          id: String(pid),
          async kill() {
            await current.pty.kill(pid);
          },
          output: { [Symbol.asyncIterator]: () => out.iterator() },
          async resize(cols, rows) {
            await current.pty.resize(pid, { cols, rows });
          },
          wait: () => exited,
          async write(data) {
            await current.pty.sendInput(pid, data);
          },
        };
      };

      const snapshotRef = (s: SnapshotInfo, extra: Partial<SnapshotRef> = {}) =>
        ({
          id: s.snapshotId,
          name: s.names[0],
          provider: "e2b",
          raw: s,
          ...extra,
        }) satisfies SnapshotRef;

      const handle: DriverHandle<E2BSandbox> = {
        async connectProcess(processId: string): Promise<DriverProcess> {
          const queue = new AsyncQueue<OutputEvent>();
          const h = await current.commands.connect(Number(processId), {
            onStderr: (data) => queue.push({ data, type: "stderr" }),
            onStdout: (data) => queue.push({ data, type: "stdout" }),
            retainOutput: false,
            timeoutMs: 0,
          });
          pump(h, queue);
          return {
            id: processId,
            async kill() {
              await h.kill();
            },
            pid: Promise.resolve(processId),
            [Symbol.asyncIterator]: () => queue.iterator(),
            async writeStdin(data: Uint8Array) {
              await h.sendStdin(data);
            },
          };
        },
        connectPty(id: string): Promise<DriverPty> {
          return openPty((onData) =>
            current.pty.connect(Number(id), { onData, timeoutMs: 0 })
          );
        },
        async createContext(o: {
          language?: string;
          cwd?: string;
        }): Promise<KernelContext> {
          const c = await current.createCodeContext({
            cwd: o.cwd,
            language: o.language,
          });
          contexts.set(c.id, c);
          return { id: c.id, language: c.language ?? o.language ?? "python" };
        },
        async createPty(o: PtyOptions): Promise<DriverPty> {
          const pty = await openPty((onData) =>
            current.pty.create({
              cols: o.cols ?? 80,
              cwd: o.cwd,
              envs: o.env,
              onData,
              rows: o.rows ?? 24,
              // E2B's default 60 s would close an interactive session.
              timeoutMs: 0,
              user: o.user,
            })
          );
          if (o.cmd) {
            await pty.write(new TextEncoder().encode(`exec ${o.cmd}\n`));
          }
          return pty;
        },
        async deleteSnapshot(ref: string): Promise<void> {
          const client = await getClient();
          await client.Sandbox.deleteSnapshot(ref);
        },
        async destroy(): Promise<void> {
          await current.kill();
        },
        exec(cmd: string, o: ExecOptions): DriverExec {
          // Stdin stays closed for run(): a command that reads stdin would
          // otherwise block forever. Interactive stdin is on spawn().
          const { queue, started } = start(cmd, o, false);
          return {
            async kill() {
              await (await started)?.kill();
            },
            pid: started.then((x) => (x ? String(x.pid) : "")),
            [Symbol.asyncIterator]: () => queue.iterator(),
          };
        },
        exposePort(port: number, eo: { private?: boolean }): Preview {
          const url = `https://${current.getHost(port)}`;
          const token = current.trafficAccessToken;
          if (token) {
            return {
              auth: {
                headers: { [E2B_TRAFFIC_TOKEN_HEADER]: token },
                type: "header",
              },
              port,
              url,
            };
          }
          if (eo.private) {
            throw fail(
              "Validation",
              `sandbox ${current.sandboxId} accepts public traffic, so port ${port} can't be private; create sandboxes with e2b({ allowPublicTraffic: false })`
            );
          }
          return { auth: { type: "public" }, port, url };
        },
        async fork(count: number): Promise<DriverHandle<E2BSandbox>[]> {
          const results = await current.fork({ count });
          const ok = results.filter(
            (r): r is E2BSandbox => !(r instanceof Error)
          );
          const failed = results.find((r) => r instanceof Error);
          if (failed) {
            await Promise.allSettled(ok.map((s) => s.kill()));
            throw failed;
          }
          return ok.map(makeHandle);
        },
        async getInfo(): Promise<SandboxInfo> {
          return toInfo(await current.getInfo());
        },
        async getMetrics(): Promise<SandboxMetrics> {
          const series = await current.getMetrics();
          const m = series.at(-1);
          if (!m) {
            // E2B samples every few seconds; a brand-new sandbox has none.
            return { raw: series, timestamp: new Date() };
          }
          return {
            cpuPercent: m.cpuUsedPct,
            diskTotalMB: m.diskTotal / MIB,
            diskUsedMB: m.diskUsed / MIB,
            memoryTotalMB: m.memTotal / MIB,
            memoryUsedMB: m.memUsed / MIB,
            raw: m,
            timestamp: m.timestamp,
          };
        },
        get id() {
          return current.sandboxId;
        },
        async killProcess(processId: string): Promise<void> {
          if (!(await current.commands.kill(Number(processId)))) {
            throw fail("NotFound", `no process ${processId}`);
          }
        },
        async listDir(path: string): Promise<DirEntry[]> {
          const entries = await current.files.list(path);
          return entries.map((e) => ({
            name: e.name,
            path: e.path,
            type: entryType(e.type),
          }));
        },
        async listProcesses(): Promise<ProcessInfo[]> {
          const ps = await current.commands.list();
          return ps.map((p) => ({
            cmd: [p.cmd, ...p.args].join(" ").trim(),
            id: String(p.pid),
          }));
        },
        async listSnapshots(): Promise<SnapshotRef[]> {
          const pager = current.listSnapshots();
          const out: SnapshotRef[] = [];
          while (pager.hasNext) {
            for (const s of await pager.nextItems()) {
              out.push(snapshotRef(s));
            }
          }
          return out;
        },
        async mkdir(path: string): Promise<void> {
          // E2B creates missing parents.
          await current.files.makeDir(path);
        },
        async pause(): Promise<void> {
          await current.pause();
        },
        async proxyFetch(
          port: number,
          path: string | undefined,
          init: RequestInit | undefined,
          ctx: CallContext
        ): Promise<Response> {
          // Goes through E2B's edge proxy with the traffic token (if any);
          // nothing is made public.
          const url = new URL(path ?? "/", `https://${current.getHost(port)}`);
          const headers = new Headers(init?.headers);
          const token = current.trafficAccessToken;
          if (token) {
            headers.set(E2B_TRAFFIC_TOKEN_HEADER, token);
          }
          return ctx.fetch(url.toString(), { ...init, headers });
        },
        get raw() {
          return current;
        },
        readFile(path: string): Promise<Uint8Array> {
          return current.files.read(path, { format: "bytes" });
        },
        async download(path: string): Promise<ReadableStream<Uint8Array>> {
          return current.files.read(path, { format: "stream" });
        },
        async remove(path: string): Promise<void> {
          await current.files.remove(path);
        },
        async rename(from: string, to: string): Promise<void> {
          await current.files.rename(from, to);
        },
        async resume(): Promise<void> {
          const client = await getClient();
          current = await client.Sandbox.connect(current.sandboxId);
        },
        async runCode(
          code: string,
          o: {
            context?: KernelContext;
            language?: string;
            onStdout?: (chunk: string) => void;
            onStderr?: (chunk: string) => void;
          }
        ): Promise<CodeExecution> {
          const common = {
            onStderr: o.onStderr
              ? (m: { line: string }) => o.onStderr?.(m.line)
              : undefined,
            onStdout: o.onStdout
              ? (m: { line: string }) => o.onStdout?.(m.line)
              : undefined,
          };
          const context = o.context ? contexts.get(o.context.id) : undefined;
          const exec = context
            ? await current.runCode(code, { ...common, context })
            : await current.runCode(code, { ...common, language: o.language });
          return mapExecution(exec);
        },
        async setEgressPolicy(policy: EgressPolicy): Promise<void> {
          const client = await getClient();
          await current.updateNetwork(await networkFor(client, policy));
        },
        async setTimeout(ttlMs: number): Promise<void> {
          await current.setTimeout(ttlMs);
        },
        async snapshot(o: SnapshotOptions): Promise<SnapshotRef> {
          const filesystem = o.mode === "filesystem";
          const snap = await current.createSnapshot({
            ...(o.name === undefined ? {} : { name: o.name }),
            ...(filesystem ? { mode: "filesystem" } : {}),
          });
          return snapshotRef(snap, {
            createdAt: new Date(),
            includesMemory: !filesystem,
            ...(o.name === undefined ? {} : { name: o.name }),
          });
        },
        async spawn(cmd: string, o: ExecOptions): Promise<DriverProcess> {
          const { handle: hp, queue } = start(cmd, o, true);
          const h = await hp;
          const pid = String(h.pid);
          return {
            id: pid,
            async kill() {
              await h.kill();
            },
            pid: Promise.resolve(pid),
            [Symbol.asyncIterator]: () => queue.iterator(),
            async writeStdin(data: Uint8Array) {
              await h.sendStdin(data);
            },
          };
        },
        async stat(path: string): Promise<FileInfo> {
          const e = await current.files.getInfo(path);
          return {
            mtime: e.modifiedTime,
            path: e.path,
            size: e.size,
            type: entryType(e.type),
          };
        },
        async upload(path: string, data: FileBody): Promise<void> {
          await current.files.write(path, data);
        },
        async watch(
          path: string,
          cb: (e: FsEvent) => void,
          recursive: boolean
        ): Promise<() => Promise<void>> {
          const base = path.replace(/\/$/, "");
          const wh = await current.files.watchDir(
            path,
            (ev) => {
              cb({
                path: ev.name.startsWith("/") ? ev.name : `${base}/${ev.name}`,
                type: mapFsEvent(ev.type),
              });
            },
            { recursive, timeoutMs: 0 }
          );
          return async () => {
            await wh.stop();
          };
        },
        async writeFile(path: string, data: Uint8Array): Promise<void> {
          await current.files.write(path, data);
        },
      };

      return handle;
    };

    // ---- templates -------------------------------------------------------------

    async function* listTemplates(
      client: E2BClient
    ): AsyncGenerator<TemplateInfo> {
      const pager = client.Template.list();
      while (pager.hasNext) {
        yield* await pager.nextItems();
      }
    }

    const templateRef = (
      t: TemplateInfo,
      id: string,
      cacheKey?: string
    ): TemplateRef => ({
      ...(cacheKey === undefined ? {} : { cacheKey }),
      createdAt: t.createdAt,
      id,
      name: id,
      provider: "e2b",
      raw: t,
    });

    const templates: DriverTemplates = {
      async build(spec, bopts, ctx) {
        const mod = await loadE2B();
        const client = await getClient();
        const r = spec.resources;
        if (r?.gpu || r?.gpuCount) {
          throw fail("Validation", "E2B templates have no GPUs");
        }
        const name = e2bTemplateName(spec.name, spec.cacheKey);
        const { source } = spec;
        let cleanup: (() => Promise<void>) | undefined;
        try {
          let builder: TemplateBuilder;
          if ("dockerfile" in source && source.dockerfile !== undefined) {
            // COPY/ADD resolve against `fileContextPath`, uploaded at build.
            const ctxDir = await writeContextDir(source.context);
            ({ cleanup } = ctxDir);
            builder = client
              .Template({ fileContextPath: ctxDir.dir })
              .fromDockerfile(source.dockerfile);
          } else if ("image" in source && source.image !== undefined) {
            builder = client
              .Template()
              .fromImage(source.image, source.registryAuth);
          } else if ("snapshot" in source && source.snapshot !== undefined) {
            // E2B snapshots are templates: build on top of one.
            builder = client.Template().fromTemplate(source.snapshot);
          } else {
            throw fail("Validation", "template source is empty");
          }
          if (spec.user) {
            builder = builder.setUser(spec.user);
          }
          if (spec.workdir) {
            builder = builder.setWorkdir(spec.workdir);
          }
          if (spec.env && Object.keys(spec.env).length > 0) {
            builder = builder.setEnvs(spec.env);
          }
          let tpl: TemplateClass = builder;
          if (spec.startCmd) {
            tpl = builder.setStartCmd(
              spec.startCmd,
              spec.readyCmd ?? mod.waitForTimeout(DEFAULT_READY_WAIT_MS)
            );
          } else if (spec.readyCmd) {
            tpl = builder.setReadyCmd(spec.readyCmd);
          }
          bopts.onEvent({ status: "building", type: "status" });
          const info = await client.Template.build(tpl, name, {
            ...(r?.vcpus === undefined ? {} : { cpuCount: r.vcpus }),
            ...(r?.memoryMB === undefined ? {} : { memoryMB: r.memoryMB }),
            ...(r?.diskMB === undefined ? {} : { minFreeDiskMb: r.diskMB }),
            onBuildLogs: (e: LogEntry) =>
              bopts.onEvent({
                line: e.message,
                stream: e.level === "error" ? "stderr" : "stdout",
                type: "log",
              }),
            ...((bopts.signal ?? ctx.signal)
              ? { signal: bopts.signal ?? ctx.signal }
              : {}),
          });
          return {
            cacheKey: spec.cacheKey,
            createdAt: new Date(),
            id: name,
            name,
            provider: "e2b",
            raw: info,
          };
        } finally {
          await cleanup?.();
        }
      },
      async delete(id) {
        const client = await getClient();
        await client.Template.delete(id);
      },
      async *list() {
        const client = await getClient();
        for await (const t of listTemplates(client)) {
          if (!t.isDefault) {
            yield templateRef(t, bareTemplateName(t.names[0] ?? t.templateId));
          }
        }
      },
      async lookup(idOrKey) {
        const client = await getClient();
        const isKey = /^[0-9a-f]{64}$/.test(idOrKey);
        const suffix = `-${idOrKey.slice(0, 16)}`;
        const want = bareTemplateName(idOrKey);
        for await (const t of listTemplates(client)) {
          const names = t.names.map(bareTemplateName);
          const hit = isKey
            ? names.find((n) => n.endsWith(suffix))
            : t.templateId === idOrKey
              ? (names[0] ?? t.templateId)
              : names.find((n) => n === want);
          // Only finished builds count as a cache hit.
          if (hit && t.buildStatus === "ready") {
            return templateRef(t, hit, isKey ? idOrKey : undefined);
          }
        }
        return undefined;
      },
    };

    // ---- volumes ---------------------------------------------------------------

    const toVolume = (v: E2BVolumeInfo): VolumeInfo => ({
      id: v.volumeId,
      name: v.name,
      raw: { name: v.name, volumeId: v.volumeId },
    });

    const volumes: DriverVolumes = {
      async create(spec) {
        const client = await getClient();
        // E2B volumes have no size or region options.
        return toVolume(await client.Volume.create(spec.name));
      },
      async delete(id) {
        const client = await getClient();
        if (await client.Volume.destroy(id)) {
          return;
        }
        const byName = (await client.Volume.list()).find((v) => v.name === id);
        if (!byName || !(await client.Volume.destroy(byName.volumeId))) {
          throw fail("NotFound", `no volume ${id}`);
        }
      },
      async get(idOrName) {
        const client = await getClient();
        const v = (await client.Volume.list()).find(
          (x) => x.volumeId === idOrName || x.name === idOrName
        );
        return v ? toVolume(v) : undefined;
      },
      async *list() {
        const client = await getClient();
        for (const v of await client.Volume.list()) {
          yield toVolume(v);
        }
      },
    };

    // ---- provider --------------------------------------------------------------

    const provider: SandboxProvider<E2BCaps, E2BSandbox> = {
      capabilities: E2B_CAPS,
      async connect(id: string, ctx: CallContext) {
        const client = await getClient();
        const native = await client.Sandbox.connect(
          id,
          ctx.signal ? { signal: ctx.signal } : undefined
        );
        return makeHandle(native);
      },
      async create(spec: ResolvedSandboxSpec, ctx: CallContext) {
        if (spec.template && spec.fromSnapshot) {
          throw fail("Validation", "pass either template or fromSnapshot");
        }
        const client = await getClient();
        const sandboxOpts = await createOptions(client, spec, ctx);
        // A snapshot id is a template reference on E2B.
        const base = spec.fromSnapshot ?? spec.template;
        const native = base
          ? await client.Sandbox.create(base, sandboxOpts)
          : await client.Sandbox.create(sandboxOpts);
        await applyShm(native, spec.resources?.shmMB);
        return makeHandle(native);
      },
      flags: E2B_FLAGS,
      async *list(filter: ListFilter | undefined) {
        const client = await getClient();
        let states: ("running" | "paused")[] | undefined;
        if (filter?.state === "running" || filter?.state === "paused") {
          states = [filter.state];
        } else if (filter?.state !== undefined) {
          return; // E2B only lists running and paused sandboxes
        }
        const limit = filter?.limit;
        if (limit !== undefined && limit <= 0) {
          return;
        }
        const pager = client.Sandbox.list({
          limit: Math.min(limit ?? 100, 100),
          query: {
            ...(filter?.metadata ? { metadata: filter.metadata } : {}),
            ...(states ? { state: states } : {}),
          },
        });
        let count = 0;
        while (pager.hasNext) {
          for (const it of await pager.nextItems()) {
            const info = toInfo(it);
            const md = filter?.metadata ?? {};
            if (Object.entries(md).some(([k, v]) => info.metadata[k] !== v)) {
              continue;
            }
            if (filter?.state && info.state !== filter.state) {
              continue;
            }
            yield info;
            count++;
            if (limit !== undefined && count >= limit) {
              return;
            }
          }
        }
      },
      mapError: mapE2BError,
      name: "e2b",
      templates,
      async verify() {
        const client = await getClient();
        await client.Sandbox.list({ limit: 1 }).nextItems();
        return undefined;
      },
      volumes,
    };

    return provider;
  }
);
