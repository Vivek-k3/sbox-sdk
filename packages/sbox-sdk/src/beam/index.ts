/**
 * `sbox-sdk/beam` — adapter for Beam Cloud sandboxes (`@beamcloud/beam-js`).
 *
 * A sandbox is a Beam sandboxed container (real Linux + coreutils) with
 * first-class GPU. Exec, processes and the filesystem use the SDK's native
 * sandbox APIs (`exec`, `listProcesses`, `fs.*`). Output streams line by line
 * from Beam's per-process stdout/stderr buffers. Ports are public URLs.
 * `snapshot()` captures memory + filesystem (`snapshot-memory`) and `fork()`
 * boots N sandboxes from one. Templates build Beam images (`Image.fromDockerfile`
 * / `Image.fromRegistry`) in your workspace.
 *
 * Requires the optional peer dependency `@beamcloud/beam-js` (>= 1.1).
 */
import { AsyncQueue, defineProvider, SandboxError } from "../adapter/index.js";
import type {
  CapabilityFlags,
  CapabilityMap,
  CodeExecution,
  DirEntry,
  DriverExec,
  DriverHandle,
  DriverProcess,
  DriverTemplates,
  EgressPolicy,
  ExecOptions,
  FileBody,
  FileInfo,
  OutputEvent,
  Preview,
  ProcessInfo,
  ResolvedSandboxSpec,
  SandboxInfo,
  SandboxProvider,
  SandboxState,
  SnapshotRef,
  TemplateRef,
} from "../adapter/index.js";

const importBeam = () => import("@beamcloud/beam-js");
/**
 * The module as a dynamic import sees it. (beam-js ships CJS-style typings for
 * its ESM build, so `typeof import()` would mistype `default`; use the named
 * `BeamClient` export for the HTTP client.)
 */
type Mod = Awaited<ReturnType<typeof importBeam>>;
type GpuAlias = import("@beamcloud/beam-js").GpuTypeAlias;
type BeamInstance = import("@beamcloud/beam-js").SandboxInstance;
type BeamProcess = import("@beamcloud/beam-js").SandboxProcess;
type BeamImage = import("@beamcloud/beam-js").Image;
type BeamStubConfig = import("@beamcloud/beam-js").CreateStubConfig;

export interface BeamOptions {
  /** Beam API token. Defaults to `BEAM_TOKEN`. */
  token?: string;
  /** Beam workspace id. Defaults to `BEAM_WORKSPACE_ID`. */
  workspaceId?: string;
  /** Gateway URL override (self-hosted beta9). */
  gatewayUrl?: string;
  /**
   * Beam app name sandboxes are grouped under when a spec has no `name`.
   * Reusing one app name lets Beam reuse its prepared runtime. Default `"sbox"`.
   */
  app?: string;
  /** Default registry image when a spec has no `template`. */
  image?: string;
  /** Default vCPUs for new sandboxes. Default 1. */
  cpu?: number;
  /** Default memory (MiB, or a string like "1Gi"). Default "1Gi". */
  memory?: number | string;
  /**
   * Default sandbox lifetime in seconds when the spec sets no
   * `lifecycle.maxAgeMs`. `-1` means "until destroyed". Default 600.
   */
  keepWarmSeconds?: number;
}

export const BEAM_CAPS = {
  background: "native",
  codeInterpreter: "native",
  egressControl: "native",
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "unsupported",
  fork: "native",
  gpu: "native",
  killProcess: "native",
  list: "unsupported",
  metrics: "unsupported",
  pause: "unsupported",
  privatePreview: "unsupported",
  proxiedFetch: "unsupported",
  pty: "unsupported",
  region: "unsupported",
  secretsVault: "native",
  setTimeout: "native",
  snapshot: "native",
  ssh: "unsupported",
  statefulKernel: "unsupported",
  stdin: "unsupported",
  stop: "unsupported",
  streaming: "native",
  templateBuild: "native",
  volumes: "unsupported",
} as const satisfies CapabilityMap;

export type BeamCaps = typeof BEAM_CAPS;

const BEAM_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true, // exec takes { cwd, env }
  preservesDiskOnStop: false,
  preservesMemoryOnPause: false,
  previewBrowserAuth: false,
  previewModel: "subdomain",
  templateSources: ["dockerfile", "image"],
};

const PROVIDER = "beam";
const DEFAULT_KEEP_WARM_SECONDS = 600;
const MAX_ALLOW_LIST = 64;
/** Prefix marking a filesystem-only snapshot (a Beam image id). */
const IMAGE_SNAPSHOT_PREFIX = "image:";

// ---------------------------------------------------------------------------
// module loading + auth
// ---------------------------------------------------------------------------

let modPromise: Promise<Mod> | undefined;
let loadedMod: Mod | undefined;
/** beam-js binds ONE token per process (its axios client is created once). */
let boundToken: string | undefined;

async function loadBeam(): Promise<Mod> {
  modPromise ??= importBeam().then((m) => {
    loadedMod = m;
    return m;
  });
  return modPromise;
}

function envVar(name: string): string | undefined {
  return typeof process === "undefined" ? undefined : process.env[name];
}

// ---------------------------------------------------------------------------
// pure mapping helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Map a Beam container status string to `SandboxState`. */
export function mapBeamStatus(status: string | undefined): SandboxState {
  switch ((status ?? "").toUpperCase()) {
    case "PENDING":
    case "SCHEDULED":
    case "STARTING": {
      return "creating";
    }
    case "RUNNING": {
      return "running";
    }
    case "STOPPING": {
      return "stopped";
    }
    case "STOPPED":
    case "TERMINATED":
    case "COMPLETE":
    case "COMPLETED": {
      return "destroyed";
    }
    case "FAILED":
    case "ERROR": {
      return "error";
    }
    default: {
      return "unknown";
    }
  }
}

/** Translate an `EgressPolicy` into Beam's `blockNetwork` / `allowList`. */
export function beamNetwork(policy: EgressPolicy): {
  blockNetwork: boolean;
  allowList?: string[];
} {
  if (
    policy.deny &&
    (policy.deny.domains?.length || policy.deny.cidrs?.length)
  ) {
    throw new SandboxError(
      "Validation",
      "Beam egress has no deny rules; use mode 'allow-list' instead",
      { provider: PROVIDER }
    );
  }
  if (policy.inject?.length) {
    throw new SandboxError(
      "Validation",
      "Beam injects credentials through brokered secrets: create the secret with `beam secret create NAME VALUE --host <host>` and pass it in `secrets` with mode 'egress'",
      { provider: PROVIDER }
    );
  }
  if (policy.mode === "allow-all") {
    return { allowList: [], blockNetwork: false };
  }
  if (policy.mode === "block-all") {
    return { blockNetwork: true };
  }
  const allowList = [...(policy.domains ?? []), ...(policy.cidrs ?? [])];
  if (allowList.length === 0) {
    return { blockNetwork: true };
  }
  if (allowList.length > MAX_ALLOW_LIST) {
    throw new SandboxError(
      "Validation",
      `Beam allow-lists accept at most ${MAX_ALLOW_LIST} entries (got ${allowList.length})`,
      { provider: PROVIDER }
    );
  }
  return { allowList, blockNetwork: false };
}

/** Image ids this process built or saw (authoritative over the heuristic). */
const knownImageIds = new Set<string>();

/**
 * A template that names a Beam image id rather than a registry reference.
 * Beam image ids are hex digests (or UUIDs); registry refs never are.
 */
export function isBeamImageId(template: string): boolean {
  return (
    knownImageIds.has(template) ||
    /^[0-9a-f]{12,64}$/i.test(template) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      template
    )
  );
}

const BEAM_GPUS = [
  "any",
  "T4",
  "L4",
  "A10G",
  "A100-40",
  "A100-80",
  "H100",
  "A6000",
  "RTX4090",
  "L40S",
] as const satisfies readonly GpuAlias[];

function isBeamGpu(gpu: string): gpu is (typeof BEAM_GPUS)[number] {
  return (BEAM_GPUS as readonly string[]).includes(gpu);
}

function memoryOf(
  spec: ResolvedSandboxSpec,
  opts: BeamOptions
): number | string {
  return spec.resources?.memoryMB ?? opts.memory ?? "1Gi";
}

/** Normalize sandbox lifetime: `maxAgeMs` -> `keepWarmSeconds` (a TTL, not idle). */
function keepWarmOf(spec: ResolvedSandboxSpec, opts: BeamOptions): number {
  const maxAge = spec.lifecycle?.maxAgeMs ?? spec.ttlMs;
  if (maxAge !== undefined) {
    return Math.max(1, Math.ceil(maxAge / 1000));
  }
  return opts.keepWarmSeconds ?? DEFAULT_KEEP_WARM_SECONDS;
}

function unsupported(feature: string, hint = ""): never {
  throw new SandboxError(
    "Validation",
    `Beam sandboxes do not support ${feature}${hint ? `; ${hint}` : ""}`,
    { provider: PROVIDER }
  );
}

/**
 * Build the Beam stub config for a spec. Validates everything Beam cannot
 * honor up front so nothing is silently dropped.
 */
function beamStubConfig(
  mod: Mod,
  spec: ResolvedSandboxSpec,
  opts: BeamOptions
): BeamStubConfig {
  const lc = spec.lifecycle;
  if (lc?.idleTimeoutMs !== undefined) {
    unsupported(
      "idle timeouts",
      "a sandbox lives for `lifecycle.maxAgeMs` (Beam's keepWarmSeconds TTL)"
    );
  }
  const onIdle = lc?.onIdle ?? spec.onIdle;
  if (onIdle && onIdle !== "destroy") {
    unsupported(
      `onIdle: "${onIdle}"`,
      "a sandbox is deleted when its TTL ends"
    );
  }
  if (lc?.autoResume) {
    unsupported("autoResume");
  }
  if (spec.region) {
    unsupported("region selection");
  }

  const env: Record<string, string> = { ...spec.env };
  const secrets: { name: string }[] = [];
  for (const s of spec.secrets ?? []) {
    if (s.value !== undefined) {
      if (s.mode === "egress") {
        unsupported(
          "inline egress secrets",
          "create a brokered secret with `beam secret create NAME VALUE --host <host>` and pass it by name"
        );
      }
      env[s.envVar ?? s.name] = s.value;
      continue;
    }
    if (s.envVar && s.envVar !== s.name) {
      unsupported(
        `renaming secret '${s.name}' to '${s.envVar}'`,
        "Beam exposes a secret under its own name"
      );
    }
    secrets.push({ name: s.name });
  }

  const volumes = (spec.volumes ?? []).map((v) => {
    if (v.readOnly) {
      unsupported(`read-only volume mounts ('${v.id}')`);
    }
    return new mod.Volume(v.id, v.mountPath);
  });

  let image: BeamImage | undefined;
  const template = spec.template ?? opts.image;
  if (template) {
    image = isBeamImageId(template)
      ? mod.Image.fromId(template)
      : mod.Image.fromRegistry(template);
  }

  const res = spec.resources;
  const config: BeamStubConfig = {
    cpu: res?.vcpus ?? opts.cpu ?? 1,
    env,
    keepWarmSeconds: keepWarmOf(spec, opts),
    memory: memoryOf(spec, opts),
    name: spec.name ?? opts.app ?? "sbox",
  };
  if (res?.gpu) {
    if (!isBeamGpu(res.gpu)) {
      unsupported(`GPU '${res.gpu}'`, `use one of ${BEAM_GPUS.join(", ")}`);
    }
    config.gpu = res.gpu;
    config.gpuCount = res.gpuCount ?? 1;
  }
  if (image) {
    config.image = image;
  }
  if (spec.ports?.length) {
    config.ports = spec.ports;
  }
  if (volumes.length) {
    config.volumes = volumes;
  }
  if (secrets.length) {
    config.secrets = secrets;
  }
  if (spec.network) {
    const net = beamNetwork(spec.network);
    config.blockNetwork = net.blockNetwork;
    if (net.allowList?.length) {
      config.allowList = net.allowList;
    }
  }
  return config;
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

const NOT_FOUND_RE =
  /not found|no such file|does not exist|no rows in result set|unknown container/i;
const AUTH_RE =
  /unauthori[sz]ed|forbidden|invalid token|token is not set|workspace id is not set/i;
const QUOTA_RE =
  /quota|limit exceeded|rate limit|insufficient (capacity|balance|funds)/i;

interface HttpErrorShape {
  isAxiosError?: boolean;
  code?: string;
  message?: string;
  response?: { status?: number; data?: unknown };
}

export function mapBeamError(err: unknown): SandboxError | undefined {
  if (err instanceof SandboxError) {
    return err;
  }
  if (!(err instanceof Error)) {
    return undefined;
  }
  const e = err as Error & HttpErrorShape;
  const status = e.response?.status;
  const body =
    e.response?.data && typeof e.response.data === "object"
      ? JSON.stringify(e.response.data)
      : "";
  const msg = `${e.message} ${body}`;
  const init = { cause: err, provider: PROVIDER, status };
  if (status === 401 || status === 403 || AUTH_RE.test(msg)) {
    return new SandboxError("Unauthorized", e.message, init);
  }
  if (status === 429 || QUOTA_RE.test(msg)) {
    return new SandboxError("QuotaExceeded", e.message, {
      ...init,
      retryable: true,
    });
  }
  if (status === 404) {
    return new SandboxError("NotFound", e.message, init);
  }
  if (status === 409) {
    return new SandboxError("Conflict", e.message, init);
  }
  if (
    status === 408 ||
    status === 504 ||
    e.code === "ECONNABORTED" ||
    e.code === "ETIMEDOUT"
  ) {
    return new SandboxError("Timeout", e.message, init);
  }
  const mod = loadedMod;
  const isFsError = mod ? err instanceof mod.SandboxFileSystemError : false;
  const isConnError = mod ? err instanceof mod.SandboxConnectionError : false;
  const isProcError = mod ? err instanceof mod.SandboxProcessError : false;
  if ((isFsError || isConnError || isProcError) && NOT_FOUND_RE.test(msg)) {
    return new SandboxError("NotFound", e.message, init);
  }
  return new SandboxError("Provider", e.message, init);
}

// ---------------------------------------------------------------------------
// process streaming
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

/** Drive a Beam process into an `OutputEvent` queue (stdout/stderr separate). */
function pumpProcess(
  started: Promise<BeamProcess>,
  q: AsyncQueue<OutputEvent>
): void {
  void (async () => {
    try {
      const proc = await started;
      const drain = async (kind: "stdout" | "stderr"): Promise<void> => {
        // Each getter access builds a new stream; read it exactly once.
        const stream = kind === "stdout" ? proc.stdout : proc.stderr;
        for await (const chunk of stream) {
          if (chunk) {
            q.push({ data: chunk, type: kind });
          }
        }
      };
      await Promise.all([drain("stdout"), drain("stderr")]);
      const exitCode = await proc.wait();
      q.push({ exitCode, type: "exit" });
      q.close();
    } catch (error) {
      q.fail(mapBeamError(error) ?? SandboxError.wrap(error, PROVIDER));
    }
  })();
}

function processExec(started: Promise<BeamProcess>): DriverExec {
  const q = new AsyncQueue<OutputEvent>();
  pumpProcess(started, q);
  return {
    [Symbol.asyncIterator]: () => q.iterator(),
    async kill() {
      await (await started).kill();
    },
    pid: started.then((p) => String(p.pid)),
  };
}

// ---------------------------------------------------------------------------
// filesystem helpers
// ---------------------------------------------------------------------------

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

function parentDir(path: string): string {
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function toDate(modTime: number): Date | undefined {
  if (!Number.isFinite(modTime) || modTime <= 0) {
    return undefined;
  }
  // Beam reports Unix seconds; tolerate milliseconds.
  return new Date(modTime > 1e12 ? modTime : modTime * 1000);
}

async function bodyBytes(body: FileBody): Promise<Uint8Array> {
  if (typeof body === "string") {
    return enc.encode(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  return new Uint8Array(await new Response(body).arrayBuffer());
}

// ---------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------

interface ContainerRow {
  containerId?: string;
  status?: string;
  scheduledAt?: string;
  startedAt?: string;
}

export type BeamRaw = BeamInstance;

export const beam = defineProvider<BeamCaps, BeamRaw, BeamOptions>(
  (opts = {}) => {
    const configure = async (): Promise<Mod> => {
      const mod = await loadBeam();
      const token = opts.token ?? envVar("BEAM_TOKEN");
      const workspaceId = opts.workspaceId ?? envVar("BEAM_WORKSPACE_ID");
      if (token) {
        if (boundToken !== undefined && boundToken !== token) {
          throw new SandboxError(
            "Validation",
            "@beamcloud/beam-js supports one Beam token per process; a different token was already used",
            { provider: PROVIDER }
          );
        }
        boundToken = token;
        mod.beamOpts.token = token;
      }
      if (workspaceId) {
        mod.beamOpts.workspaceId = workspaceId;
      }
      if (opts.gatewayUrl) {
        mod.beamOpts.gatewayUrl = opts.gatewayUrl;
      }
      return mod;
    };

    /** Live container row from the gateway's container listing. */
    const fetchContainer = async (
      mod: Mod,
      id: string
    ): Promise<ContainerRow | undefined> => {
      const resp = await mod.BeamClient.request({
        method: "GET",
        url: "/api/v1/gateway/containers",
      });
      const data = resp.data as {
        ok?: boolean;
        errorMsg?: string;
        containers?: ContainerRow[];
      };
      if (data.ok === false) {
        throw new SandboxError(
          "Provider",
          data.errorMsg || "failed to list containers",
          { provider: PROVIDER }
        );
      }
      return (data.containers ?? []).find((c) => c.containerId === id);
    };

    const makeHandle = (
      mod: Mod,
      inst: BeamInstance,
      metadata: Record<string, string> = {},
      name?: string
    ): DriverHandle<BeamRaw> => {
      const id = inst.sandboxId;

      const findProcess = async (pid: string): Promise<BeamProcess> => {
        const procs = await inst.listProcesses();
        const found = procs.find((p) => String(p.pid) === pid);
        if (!found) {
          throw new SandboxError("NotFound", `no process ${pid}`, {
            provider: PROVIDER,
          });
        }
        return found;
      };

      const statPath = async (path: string): Promise<FileInfo> => {
        try {
          const info = await inst.fs.statFile(path);
          return {
            mtime: toDate(info.modTime),
            path,
            size: info.size,
            type: info.isDir ? "dir" : "file",
          };
        } catch (error) {
          if (error instanceof mod.SandboxFileSystemError) {
            throw new SandboxError("NotFound", `not found: '${path}'`, {
              cause: error,
              provider: PROVIDER,
            });
          }
          throw error;
        }
      };

      const exists = async (path: string): Promise<boolean> => {
        try {
          await statPath(path);
          return true;
        } catch (error) {
          if (error instanceof SandboxError && error.code === "NotFound") {
            return false;
          }
          throw error;
        }
      };

      const mkdirp = async (path: string): Promise<void> => {
        const parts = path.split("/").filter(Boolean);
        let cur = "";
        for (const part of parts) {
          cur += `/${part}`;
          if (!(await exists(cur))) {
            await inst.fs.createDirectory(cur);
          }
        }
      };

      const write = async (path: string, data: Uint8Array): Promise<void> => {
        try {
          await inst.fs.writeBytes(path, data);
        } catch (error) {
          // Most likely a missing parent directory: create it and retry once.
          if (!(error instanceof mod.SandboxFileSystemError)) {
            throw error;
          }
          const parent = parentDir(path);
          if (await exists(parent)) {
            throw error;
          }
          await mkdirp(parent);
          await inst.fs.writeBytes(path, data);
        }
      };

      return {
        id,
        name,
        raw: inst,

        async getInfo(): Promise<SandboxInfo> {
          const row = await fetchContainer(mod, id);
          return {
            createdAt: row?.scheduledAt
              ? new Date(row.scheduledAt)
              : row?.startedAt
                ? new Date(row.startedAt)
                : undefined,
            id,
            metadata,
            name,
            provider: PROVIDER,
            raw: row ?? inst,
            state: row ? mapBeamStatus(row.status) : "destroyed",
          };
        },
        async destroy(): Promise<void> {
          await inst.terminate();
        },
        async setTimeout(ttlMs: number): Promise<void> {
          await inst.updateTtl(Math.max(1, Math.ceil(ttlMs / 1000)));
        },

        // ---- exec ------------------------------------------------------
        exec(cmd: string, o: ExecOptions): DriverExec {
          return processExec(inst.exec(cmd, { cwd: o.cwd, env: o.env }));
        },
        async spawn(cmd: string, o: ExecOptions): Promise<DriverProcess> {
          const proc = await inst.exec(cmd, { cwd: o.cwd, env: o.env });
          return {
            ...processExec(Promise.resolve(proc)),
            id: String(proc.pid),
          };
        },
        async connectProcess(pid: string): Promise<DriverProcess> {
          const proc = await findProcess(pid);
          return { ...processExec(Promise.resolve(proc)), id: pid };
        },
        async killProcess(pid: string): Promise<void> {
          await (await findProcess(pid)).kill();
        },
        async listProcesses(): Promise<ProcessInfo[]> {
          const procs = await inst.listProcesses();
          return procs
            .filter((p) => p.running)
            .map((p) => ({ cmd: p.command, id: String(p.pid) }));
        },

        async runCode(
          code: string,
          o: {
            language?: string;
            onStdout?: (chunk: string) => void;
            onStderr?: (chunk: string) => void;
          }
        ): Promise<CodeExecution> {
          if (o.language && !/^py(thon)?3?$/i.test(o.language)) {
            unsupported(`runCode language '${o.language}'`, "only python");
          }
          const proc = await inst.runCode(code, false);
          if (!("kill" in proc)) {
            // Blocking response (not expected with blocking=false).
            return {
              error:
                proc.exitCode === 0
                  ? undefined
                  : {
                      name: "Error",
                      traceback: proc.stderr,
                      value: proc.stderr,
                    },
              logs: { stderr: [proc.stderr], stdout: [proc.stdout] },
              results: [],
            };
          }
          const stdout: string[] = [];
          const stderr: string[] = [];
          for await (const ev of processExec(Promise.resolve(proc))) {
            if (ev.type === "stdout") {
              stdout.push(ev.data);
              o.onStdout?.(ev.data);
            } else if (ev.type === "stderr") {
              stderr.push(ev.data);
              o.onStderr?.(ev.data);
            } else if (ev.exitCode !== 0) {
              const tb = stderr.join("");
              const last = tb.trim().split("\n").at(-1) ?? "";
              const m =
                /^(\w+(?:Error|Exception|Interrupt|Exit)):\s?(.*)$/.exec(last);
              return {
                error: {
                  name: m?.[1] ?? "Error",
                  traceback: tb,
                  value: m?.[2] ?? last,
                },
                logs: { stderr, stdout },
                results: [],
              };
            }
          }
          return { logs: { stderr, stdout }, results: [] };
        },

        // ---- files -----------------------------------------------------
        async readFile(path: string): Promise<Uint8Array> {
          try {
            return new Uint8Array(await inst.fs.readBytes(path));
          } catch (error) {
            if (error instanceof mod.SandboxFileSystemError) {
              throw new SandboxError("NotFound", `no such file: '${path}'`, {
                cause: error,
                provider: PROVIDER,
              });
            }
            throw error;
          }
        },
        async writeFile(path: string, data: Uint8Array): Promise<void> {
          await write(path, data);
        },
        async upload(path: string, body: FileBody): Promise<void> {
          await write(path, await bodyBytes(body));
        },
        async listDir(path: string): Promise<DirEntry[]> {
          let files;
          try {
            files = await inst.fs.listFiles(path);
          } catch (error) {
            if (error instanceof mod.SandboxFileSystemError) {
              throw new SandboxError("NotFound", `cannot list '${path}'`, {
                cause: error,
                provider: PROVIDER,
              });
            }
            throw error;
          }
          return files.map((f) => {
            const base = f.name.slice(f.name.lastIndexOf("/") + 1);
            return {
              name: base,
              path: joinPath(path, base),
              type: f.isDir ? "dir" : "file",
            };
          });
        },
        async mkdir(path: string, recursive: boolean): Promise<void> {
          await (recursive ? mkdirp(path) : inst.fs.createDirectory(path));
        },
        async remove(path: string, recursive: boolean): Promise<void> {
          let info: FileInfo;
          try {
            info = await statPath(path);
          } catch (error) {
            if (error instanceof SandboxError && error.code === "NotFound") {
              return; // rm -f semantics
            }
            throw error;
          }
          if (info.type === "dir") {
            if (!recursive) {
              throw new SandboxError(
                "Provider",
                `cannot remove '${path}': is a directory`,
                { provider: PROVIDER }
              );
            }
            await inst.fs.deleteDirectory(path);
          } else {
            await inst.fs.deleteFile(path);
          }
        },
        stat: (path: string) => statPath(path),

        // ---- network ---------------------------------------------------
        async exposePort(port: number): Promise<Preview> {
          return {
            auth: { type: "public" },
            port,
            url: await inst.exposePort(port),
          };
        },
        async listPorts(): Promise<Preview[]> {
          const urls = await inst.listUrls();
          return Object.entries(urls).map(([port, url]) => ({
            auth: { type: "public" },
            port: Number(port),
            url,
          }));
        },
        async setEgressPolicy(policy: EgressPolicy): Promise<void> {
          const net = beamNetwork(policy);
          await inst.updateNetworkPermissions(
            net.blockNetwork,
            net.blockNetwork ? undefined : net.allowList
          );
        },

        // ---- snapshots -------------------------------------------------
        async snapshot(s: {
          name?: string;
          mode?: "memory" | "filesystem";
        }): Promise<SnapshotRef> {
          if (s.mode === "filesystem") {
            const imageId = await inst.createImageFromFilesystem();
            knownImageIds.add(imageId);
            return {
              createdAt: new Date(),
              id: `${IMAGE_SNAPSHOT_PREFIX}${imageId}`,
              includesMemory: false,
              name: s.name,
              provider: PROVIDER,
              raw: { imageId },
            };
          }
          const checkpointId = await inst.snapshot();
          return {
            createdAt: new Date(),
            id: checkpointId,
            includesMemory: true,
            name: s.name,
            provider: PROVIDER,
            raw: { checkpointId },
          };
        },
        async fork(count: number): Promise<DriverHandle<BeamRaw>[]> {
          const checkpointId = await inst.snapshot();
          const forks = await Promise.all(
            Array.from({ length: count }, () =>
              mod.Sandbox.createFromSnapshot(checkpointId)
            )
          );
          return forks.map((f) => makeHandle(mod, f, { ...metadata }));
        },
      };
    };

    // ---- templates ---------------------------------------------------------
    /** cacheKey/name/id -> ref, for in-process lookups. */
    const builtTemplates = new Map<string, TemplateRef>();

    const templates: DriverTemplates = {
      async build(spec, b) {
        if (spec.startCmd || spec.readyCmd) {
          unsupported(
            "template startCmd/readyCmd",
            "Beam sandboxes always boot their own entrypoint"
          );
        }
        const mod = await configure();
        const { source } = spec;
        let image: BeamImage;
        let cleanup: (() => Promise<void>) | undefined;
        const extra: string[] = [];
        if (spec.workdir) {
          extra.push(`WORKDIR ${spec.workdir}`);
        }
        if (spec.user) {
          extra.push(`USER ${spec.user}`);
        }
        if ("dockerfile" in source && source.dockerfile !== undefined) {
          const written = await writeContext(
            `${source.dockerfile.trimEnd()}\n${extra.join("\n")}\n`,
            source.context
          );
          cleanup = written.cleanup;
          b.onEvent({ line: "syncing build context", type: "log" });
          image = await mod.Image.fromDockerfile(
            written.dockerfile,
            written.dir
          );
        } else if ("image" in source && source.image !== undefined) {
          if (extra.length) {
            const written = await writeContext(
              `FROM ${source.image}\n${extra.join("\n")}\n`,
              undefined
            );
            cleanup = written.cleanup;
            image = await mod.Image.fromDockerfile(
              written.dockerfile,
              written.dir
            );
          } else {
            image = mod.Image.fromRegistry(
              source.image,
              source.registryAuth
                ? {
                    DOCKERHUB_PASSWORD: source.registryAuth.password,
                    DOCKERHUB_USERNAME: source.registryAuth.username,
                  }
                : undefined
            );
          }
        } else {
          return unsupported("snapshot template sources");
        }
        try {
          if (spec.env && Object.keys(spec.env).length) {
            image = image.withEnvs(spec.env);
          }
          b.signal?.throwIfAborted();
          const { exists, result: existing } = await image.exists();
          let imageId = exists ? existing.imageId : undefined;
          if (imageId) {
            b.onEvent({ message: imageId, status: "cached", type: "status" });
          } else {
            b.onEvent({ status: "building", type: "status" });
            const result = await image.build();
            if (!result.success || !result.imageId) {
              throw new SandboxError(
                "Provider",
                "Beam image build failed (see build output)",
                { provider: PROVIDER }
              );
            }
            imageId = result.imageId;
          }
          const ref: TemplateRef = {
            cacheKey: spec.cacheKey,
            createdAt: new Date(),
            id: imageId,
            name: spec.name,
            provider: PROVIDER,
            raw: { imageId },
          };
          builtTemplates.set(spec.cacheKey, ref);
          builtTemplates.set(spec.name, ref);
          builtTemplates.set(imageId, ref);
          knownImageIds.add(imageId);
          return ref;
        } finally {
          await cleanup?.();
        }
      },
      async lookup(idOrKey) {
        const known = builtTemplates.get(idOrKey);
        if (known) {
          return known;
        }
        if (!isBeamImageId(idOrKey)) {
          return undefined;
        }
        // Beam images have no name/tag index: an unknown cache key misses
        // here, and build() then reuses the server-side image via exists().
        const mod = await configure();
        const { exists, result } = await mod.Image.fromId(idOrKey).exists();
        if (!exists) {
          return undefined;
        }
        return {
          id: result.imageId ?? idOrKey,
          provider: PROVIDER,
          raw: result,
        };
      },
    };

    const createFromSpec = async (
      spec: ResolvedSandboxSpec
    ): Promise<DriverHandle<BeamRaw>> => {
      const mod = await configure();
      const metadata = { ...spec.metadata };
      if (spec.fromSnapshot) {
        if (spec.fromSnapshot.startsWith(IMAGE_SNAPSHOT_PREFIX)) {
          const config = beamStubConfig(
            mod,
            {
              ...spec,
              template: spec.fromSnapshot.slice(IMAGE_SNAPSHOT_PREFIX.length),
            },
            opts
          );
          const sandbox = new mod.Sandbox(config);
          return makeHandle(mod, await sandbox.create(), metadata, spec.name);
        }
        // Memory checkpoints restore with their original configuration.
        const inst = await mod.Sandbox.createFromSnapshot(spec.fromSnapshot);
        return makeHandle(mod, inst, metadata, spec.name);
      }
      const config = beamStubConfig(mod, spec, opts);
      const inst = await new mod.Sandbox(config).create();
      return makeHandle(mod, inst, metadata, spec.name);
    };

    const provider: SandboxProvider<BeamCaps, BeamRaw> = {
      capabilities: BEAM_CAPS,
      async connect(id: string): Promise<DriverHandle<BeamRaw>> {
        const mod = await configure();
        return makeHandle(mod, await mod.Sandbox.connect(id));
      },
      create: (spec: ResolvedSandboxSpec) => createFromSpec(spec),
      flags: BEAM_FLAGS,
      mapError: mapBeamError,
      name: PROVIDER,
      templates,
      async verify() {
        const mod = await configure();
        const ws = (await mod.BeamClient._getWorkspace()) as {
          name?: string;
          externalId?: string;
        };
        return { account: ws?.name ?? ws?.externalId };
      },
    };
    return provider;
  }
);

/** Materialize a Dockerfile + context into a temp dir (Beam builds from paths). */
async function writeContext(
  dockerfile: string,
  context: import("../adapter/index.js").TemplateContext | undefined
): Promise<{ dir: string; dockerfile: string; cleanup: () => Promise<void> }> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { loadTemplateContext } = await import("../adapter/index.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbox-beam-"));
  const files = await loadTemplateContext(context);
  for (const [rel, bytes] of files) {
    const abs = path.join(dir, rel);
    if (!abs.startsWith(dir + path.sep)) {
      throw new SandboxError(
        "Validation",
        `context path escapes root: ${rel}`,
        {
          provider: PROVIDER,
        }
      );
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, bytes);
  }
  const dockerfilePath = path.join(dir, "Dockerfile.sbox");
  await fs.writeFile(dockerfilePath, dockerfile);
  return {
    cleanup: () => fs.rm(dir, { force: true, recursive: true }),
    dir,
    dockerfile: dockerfilePath,
  };
}
