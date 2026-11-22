import type { DaytonaV0Client } from "@daytona/sdk";
import type {
  CreateSandboxBaseParams,
  CreateSandboxFromImageParams,
  CreateSandboxFromSnapshotParams,
  CreateSandboxResources,
  GpuType,
  Image as DaytonaImage,
  PtyHandle,
  Resources,
  Sandbox as DaytonaSandbox,
  SandboxState as DaytonaState,
  Snapshot as DaytonaSnapshot,
  VolumeMount as DaytonaVolumeMount,
} from "@daytona/sdk/v0";

/**
 * `sbox-sdk/daytona` — adapter for Daytona, through the stable **v0** surface
 * of `@daytona/sdk` (2.x; reached via `new Daytona().v0`). The v2 surface is
 * alpha and intentionally not used.
 *
 * - exec runs in a fresh Daytona *session* per command: real streaming with
 *   separate stdout/stderr, native exit codes, stdin, and a kill that works
 *   (deleting the session kills its process tree).
 * - templates build Daytona **snapshots** (`Image.fromDockerfile` / a registry
 *   image → `daytona.snapshot.create`), named after the template so `lookup`
 *   finds them again.
 * - Daytona APIs work in seconds/minutes; the adapter converts from ms.
 *
 * Node-only (uses `Buffer`, and a temp dir for Dockerfile builds). Requires the
 * optional peer dependency `@daytona/sdk`.
 */
import { AsyncQueue, defineProvider, SandboxError } from "../adapter/index.js";
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
  FileInfo,
  KernelContext,
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
  SnapshotOptions,
  SnapshotRef,
  SshCredentials,
  TemplateRef,
  TemplateSpec,
  VolumeInfo,
} from "../adapter/index.js";

export interface DaytonaOptions {
  apiKey?: string;
  /** JWT auth instead of an API key (pair with `organizationId`). */
  jwtToken?: string;
  organizationId?: string;
  /**
   * Custom v0 API URL (self-hosted / dev). SDK 2.x has no root-config field for
   * it, so when set the adapter builds the v0 client directly.
   */
  apiUrl?: string;
  /** Default region (Daytona "target"), e.g. "us" or "eu". `spec.region` wins. */
  target?: string;
  /** How long `create()` waits for the sandbox to start. SDK default: 60 s. */
  createTimeoutMs?: number;
  /** Minutes a stopped sandbox waits before it is archived (0 = Daytona max). */
  autoArchiveInterval?: number;
  /** Lifetime of signed (private) preview URLs. Default 3600 s, max 86 400. */
  previewTtlSeconds?: number;
}

export const DAYTONA_CAPS = {
  background: "native",
  codeInterpreter: "native",
  egressControl: "native",
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "unsupported",
  fork: "native",
  gpu: "native",
  killProcess: "native",
  list: "native",
  metrics: "native",
  pause: "native",
  privatePreview: "native",
  proxiedFetch: "unsupported",
  pty: "native",
  region: "native",
  secretsVault: "native",
  setTimeout: "native",
  snapshot: "native",
  ssh: "native",
  statefulKernel: "native",
  stdin: "native",
  stop: "native",
  streaming: "native",
  volumes: "native",
  templateBuild: "native",
} as const satisfies CapabilityMap;

export type DaytonaCaps = typeof DAYTONA_CAPS;

const DAYTONA_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  // Session commands take a single command string (no cwd/env fields).
  perCommandEnvCwd: false,
  preservesDiskOnStop: true,
  preservesMemoryOnPause: true,
  // Signed preview URLs carry the token in the hostname; WebSockets work.
  previewBrowserAuth: true,
  previewModel: "subdomain",
  templateSources: ["dockerfile", "image"],
};

const PROVIDER = "daytona";
const SESSION_PREFIX = "sbox-";

type RootModule = typeof import("@daytona/sdk");
type V0Module = typeof import("@daytona/sdk/v0");
type CodeRunResult = Awaited<ReturnType<DaytonaSandbox["process"]["codeRun"]>>;
type InterpreterContext = Awaited<
  ReturnType<DaytonaSandbox["codeInterpreter"]["createContext"]>
>;
type NetworkSettings = Parameters<DaytonaSandbox["updateNetworkSettings"]>[0];
type DaytonaVolume = Awaited<ReturnType<DaytonaV0Client["volume"]["create"]>>;

let rootCached: RootModule | null = null;
let v0Cached: V0Module | null = null;
async function loadRoot(): Promise<RootModule> {
  rootCached ??= await import("@daytona/sdk");
  return rootCached;
}
async function loadV0(): Promise<V0Module> {
  v0Cached ??= await import("@daytona/sdk/v0");
  return v0Cached;
}

// ---------------------------------------------------------------------------
// pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Every Daytona sandbox state → `SandboxState`. */
export function mapDaytonaState(state: DaytonaState | undefined): SandboxState {
  switch (state) {
    case "started":
    case "resizing":
    case "snapshotting":
    case "forking": {
      return "running";
    }
    case "creating":
    case "restoring":
    case "starting":
    case "resuming":
    case "pending_build":
    case "building_snapshot":
    case "pulling_snapshot": {
      return "creating";
    }
    case "stopping":
    case "pausing":
    case "archiving": {
      return "suspending";
    }
    case "stopped": {
      return "stopped";
    }
    case "paused": {
      return "paused";
    }
    case "archived": {
      return "archived";
    }
    case "destroying":
    case "destroyed": {
      return "destroyed";
    }
    case "error":
    case "build_failed": {
      return "error";
    }
    default: {
      return "unknown";
    }
  }
}

const STATE_FILTER: Partial<Record<SandboxState, DaytonaState[]>> = {
  archived: ["archived"],
  creating: [
    "creating",
    "restoring",
    "starting",
    "resuming",
    "pending_build",
    "building_snapshot",
    "pulling_snapshot",
  ],
  destroyed: ["destroying", "destroyed"],
  error: ["error", "build_failed"],
  paused: ["paused"],
  running: ["started", "resizing", "snapshotting", "forking"],
  stopped: ["stopped"],
  suspending: ["stopping", "pausing", "archiving"],
};

function statusOf(e: unknown): number | undefined {
  if (e && typeof e === "object" && "statusCode" in e) {
    const s = (e as { statusCode?: unknown }).statusCode;
    return typeof s === "number" ? s : undefined;
  }
  return undefined;
}

/** Normalize Daytona SDK errors (status code first, then class name/message). */
export function mapDaytonaError(e: unknown): SandboxError | undefined {
  if (e instanceof SandboxError) {
    return e;
  }
  const status = statusOf(e);
  const name = e instanceof Error ? `${e.constructor.name} ${e.name}` : "";
  const msg = e instanceof Error ? e.message : String(e);
  const init = { cause: e, provider: PROVIDER, status };
  if (
    status === 401 ||
    status === 403 ||
    /Authentication|Forbidden|Authorization/.test(name) ||
    /unauthori[sz]ed|forbidden|invalid api key/i.test(msg)
  ) {
    return new SandboxError("Unauthorized", msg, init);
  }
  if (
    status === 404 ||
    /NotFound/.test(name) ||
    /not ?found|no such file/i.test(msg)
  ) {
    return new SandboxError("NotFound", msg, init);
  }
  if (status === 409 || /Conflict/.test(name) || /already exists/i.test(msg)) {
    return new SandboxError("Conflict", msg, init);
  }
  if (
    status === 429 ||
    /RateLimit/.test(name) ||
    /quota|rate limit|limit exceeded|insufficient resources/i.test(msg)
  ) {
    return new SandboxError("QuotaExceeded", msg, { ...init, retryable: true });
  }
  if (status === 408 || /Timeout/.test(name) || /timed? ?out/i.test(msg)) {
    return new SandboxError("Timeout", msg, init);
  }
  if (status === 400 || status === 422 || /Validation|InvalidArg/.test(name)) {
    return new SandboxError("Validation", msg, init);
  }
  return undefined;
}

const minutes = (ms: number): number => Math.max(1, Math.ceil(ms / 60_000));
const secs = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));
const gib = (mb: number): number => Math.max(1, Math.ceil(mb / 1024));

/** Small deterministic string hash (djb2 mod a 32-bit prime), hex. */
function hash32(s: string): string {
  let h = 5381;
  for (const ch of s) {
    h = (h * 33 + (ch.codePointAt(0) ?? 0)) % 4_294_967_291;
  }
  return h.toString(16).padStart(8, "0");
}

/** Deterministic sandbox name from an idempotency key (safe for retries). */
export function nameFromIdempotencyKey(key: string): string {
  const slug = key.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-");
  return slug.length <= 48
    ? `sbox-${slug}`
    : `sbox-${slug.slice(0, 32)}-${hash32(key)}`;
}

/** Snapshot name for a template build: the alias, suffixed with the cache key. */
export function templateSnapshotName(name: string, cacheKey: string): string {
  const key16 = cacheKey.slice(0, 16);
  return name.includes(key16) ? name : `${name}-${key16}`;
}

const notSupported = (feature: string): SandboxError =>
  new SandboxError(
    "NotSupported",
    `'${feature}' is not supported by provider 'daytona'`,
    {
      provider: PROVIDER,
      retryable: false,
    }
  );

const validation = (msg: string): SandboxError =>
  new SandboxError("Validation", msg, { provider: PROVIDER });

/** `EgressPolicy` → Daytona network settings (CIDR + domain allow lists). */
export function egressToDaytona(policy: EgressPolicy): NetworkSettings {
  if (
    policy.deny &&
    (policy.deny.cidrs?.length || policy.deny.domains?.length)
  ) {
    throw notSupported("network.deny (Daytona only supports allow lists)");
  }
  if (policy.inject?.length) {
    throw notSupported("network.inject");
  }
  switch (policy.mode) {
    case "allow-all": {
      return { networkBlockAll: false };
    }
    case "block-all": {
      return { networkBlockAll: true };
    }
    case "allow-list": {
      return {
        domainAllowList: (policy.domains ?? []).join(","),
        networkAllowList: (policy.cidrs ?? []).join(","),
      };
    }
    default: {
      throw validation(`unknown egress mode '${String(policy.mode)}'`);
    }
  }
}

function lifecycleParams(
  spec: ResolvedSandboxSpec,
  opts: DaytonaOptions
): Partial<CreateSandboxBaseParams> {
  const out: Partial<CreateSandboxBaseParams> = {};
  const lc = spec.lifecycle;
  const idle = lc?.idleTimeoutMs;
  const onIdle = lc?.onIdle ?? "stop";
  if (idle !== undefined) {
    if (onIdle === "pause") {
      out.autoPauseInterval = minutes(idle);
      out.autoStopInterval = 0;
    } else {
      out.autoStopInterval = minutes(idle);
    }
  }
  if (onIdle === "destroy") {
    // Delete as soon as the idle auto-stop fires.
    out.autoDeleteInterval = 0;
  }
  if (lc?.maxAgeMs !== undefined) {
    out.ttlMinutes = minutes(lc.maxAgeMs);
  }
  if (opts.autoArchiveInterval !== undefined) {
    out.autoArchiveInterval = opts.autoArchiveInterval;
  }
  return out;
}

function resourceParams(
  spec: ResolvedSandboxSpec
): CreateSandboxResources | undefined {
  const r = spec.resources;
  if (!r) {
    return undefined;
  }
  const out: CreateSandboxResources = {};
  if (r.vcpus !== undefined) {
    out.cpu = Math.ceil(r.vcpus);
  }
  if (r.memoryMB !== undefined) {
    out.memory = gib(r.memoryMB);
  }
  if (r.diskMB !== undefined) {
    out.disk = gib(r.diskMB);
  }
  if (r.gpu !== undefined) {
    out.gpuType = r.gpu as GpuType;
    out.gpu = r.gpuCount ?? 1;
  } else if (r.gpuCount !== undefined) {
    out.gpu = r.gpuCount;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function secretParams(spec: ResolvedSandboxSpec): {
  envVars: Record<string, string>;
  secrets?: Record<string, string>;
} {
  const envVars: Record<string, string> = { ...spec.env };
  const secrets: Record<string, string> = {};
  for (const ref of spec.secrets ?? []) {
    const envVar = ref.envVar ?? ref.name;
    if (ref.value === undefined) {
      // Daytona vault Secret: the env var holds a placeholder; the real value
      // is substituted on egress to the Secret's allowed hosts.
      secrets[envVar] = ref.name;
    } else if (ref.mode === "egress") {
      throw validation(
        `inline egress secret '${ref.name}': create it in the Daytona vault and reference it by name`
      );
    } else {
      envVars[envVar] = ref.value;
    }
  }
  return Object.keys(secrets).length > 0 ? { envVars, secrets } : { envVars };
}

function networkParams(
  spec: ResolvedSandboxSpec
): Partial<CreateSandboxBaseParams> {
  if (!spec.network) {
    return {};
  }
  const s = egressToDaytona(spec.network);
  if (spec.network.mode === "allow-all") {
    return {};
  }
  const out: Partial<CreateSandboxBaseParams> = {};
  if (s.networkBlockAll !== undefined) {
    out.networkBlockAll = s.networkBlockAll;
  }
  if (s.networkAllowList) {
    out.networkAllowList = s.networkAllowList;
  }
  if (s.domainAllowList) {
    out.domainAllowList = s.domainAllowList;
  }
  return out;
}

function looksLikeImage(ref: string): boolean {
  return /[:/]/.test(ref);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function matchesMetadata(
  labels: Record<string, string> | undefined,
  want: Record<string, string> | undefined
): boolean {
  if (!want) {
    return true;
  }
  return Object.entries(want).every(([k, v]) => labels?.[k] === v);
}

function sandboxInfo(sb: DaytonaSandbox): SandboxInfo {
  return {
    createdAt: sb.createdAt ? new Date(sb.createdAt) : undefined,
    id: sb.id,
    metadata: { ...sb.labels },
    name: sb.name,
    provider: PROVIDER,
    raw: sb,
    state: mapDaytonaState(sb.state),
  };
}

function templateRef(
  snap: DaytonaSnapshot,
  cacheKey?: string,
  alias?: string
): TemplateRef {
  return {
    cacheKey,
    createdAt: snap.createdAt ? new Date(snap.createdAt) : undefined,
    id: snap.name,
    name: alias ?? snap.name.replace(/-[0-9a-f]{16}$/, ""),
    provider: PROVIDER,
    raw: snap,
  };
}

function volumeInfo(v: DaytonaVolume): VolumeInfo {
  return {
    createdAt: v.createdAt ? new Date(v.createdAt) : undefined,
    id: v.id,
    name: v.name,
    raw: v,
  };
}

/** Parse `ssh [-p N] <user>@<host>` from Daytona's `sshCommand`. */
export function parseSshCommand(
  cmd: string | undefined,
  token: string
): { host: string; port: number; user: string } {
  const at = cmd ? /(\S+)@([\w.-]+)/.exec(cmd) : null;
  const port = cmd ? /-p\s*(\d+)/.exec(cmd) : null;
  return {
    host: at?.[2] ?? "ssh.app.daytona.io",
    port: port?.[1] ? Number(port[1]) : 22,
    user: at?.[1] ?? token,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------

/** Run a provider-level call, normalizing SDK errors (the core doesn't map these). */
async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapDaytonaError(error) ?? SandboxError.wrap(error, PROVIDER);
  }
}

/** Daytona sandboxes via `@daytona/sdk` (v0 surface). */
export const daytona = defineProvider<
  DaytonaCaps,
  DaytonaSandbox,
  DaytonaOptions
>((opts) => {
  let root: InstanceType<RootModule["Daytona"]> | null = null;
  let client: DaytonaV0Client | null = null;
  const getClient = async (): Promise<DaytonaV0Client> => {
    if (client) {
      return client;
    }
    const auth = {
      apiKey: opts.apiKey,
      jwtToken: opts.jwtToken,
      organizationId: opts.organizationId,
    };
    if (opts.apiUrl) {
      const v0 = await loadV0();
      client = new v0.RootOnlyClientV0({ ...auth, apiUrl: opts.apiUrl });
    } else {
      const mod = await loadRoot();
      root = new mod.Daytona(auth);
      client = root.v0;
    }
    return client;
  };
  const createTimeout =
    opts.createTimeoutMs === undefined
      ? undefined
      : { timeout: secs(opts.createTimeoutMs) };
  const previewTtl = opts.previewTtlSeconds ?? 3600;

  const resolveVolumes = async (
    c: DaytonaV0Client,
    spec: ResolvedSandboxSpec
  ): Promise<DaytonaVolumeMount[] | undefined> => {
    if (!spec.volumes?.length) {
      return undefined;
    }
    const out: DaytonaVolumeMount[] = [];
    for (const v of spec.volumes) {
      if (v.readOnly) {
        throw validation("Daytona volumes cannot be mounted read-only");
      }
      const volumeId = UUID_RE.test(v.id)
        ? v.id
        : (await c.volume.get(v.id)).id;
      out.push({ mountPath: v.mountPath, volumeId });
    }
    return out;
  };

  const buildCreateParams = async (
    c: DaytonaV0Client,
    spec: ResolvedSandboxSpec,
    name: string
  ): Promise<
    | { kind: "image"; params: CreateSandboxFromImageParams }
    | { kind: "snapshot"; params: CreateSandboxFromSnapshotParams }
  > => {
    const { envVars, secrets } = secretParams(spec);
    const base: CreateSandboxBaseParams = {
      envVars,
      labels: { ...spec.metadata },
      name,
      ...lifecycleParams(spec, opts),
      ...networkParams(spec),
      ...(secrets ? { secrets } : {}),
    };
    const target = spec.region ?? opts.target;
    if (target) {
      base.target = target;
    }
    const volumes = await resolveVolumes(c, spec);
    if (volumes) {
      base.volumes = volumes;
    }
    const resources = resourceParams(spec);
    const snapshot =
      spec.fromSnapshot ??
      spec.templateRef?.id ??
      (spec.template && !looksLikeImage(spec.template)
        ? spec.template
        : undefined);
    if (snapshot === undefined && spec.template) {
      return {
        kind: "image",
        params: {
          ...base,
          image: spec.template,
          ...(resources ? { resources } : {}),
        },
      };
    }
    if (resources) {
      throw validation(
        "Daytona applies `resources` only to image-based creates; set them on the template (templates.build({ resources })) or pass an image ref as `template`"
      );
    }
    return {
      kind: "snapshot",
      params: snapshot === undefined ? base : { ...base, snapshot },
    };
  };

  const createSandbox = async (
    spec: ResolvedSandboxSpec,
    ctx: CallContext,
    reuseExisting: boolean
  ): Promise<DaytonaSandbox> => {
    const c = await getClient();
    const derived = spec.name === undefined;
    const name =
      spec.name ??
      nameFromIdempotencyKey(
        ctx.idempotencyKey ?? globalThis.crypto.randomUUID()
      );
    const built = await buildCreateParams(c, spec, name);
    try {
      return built.kind === "image"
        ? await c.create(built.params, createTimeout)
        : await c.create(built.params, createTimeout);
    } catch (error) {
      // A retried create (same idempotency key) or a getOrCreate race: the
      // sandbox already exists under this name, so hand it back.
      if ((derived || reuseExisting) && statusOf(error) === 409) {
        return c.get(name);
      }
      throw error;
    }
  };

  const makeHandle = (sb: DaytonaSandbox): DriverHandle<DaytonaSandbox> => {
    const proc = sb.process;
    const { fs } = sb;
    const contexts = new Map<string, InterpreterContext>();

    /** Run `cmd` in its own session; streams logs, then reports the exit code. */
    const runInSession = (
      cmd: string,
      execOpts: ExecOptions,
      existing?: { sessionId: string; cmdId: string }
    ): DriverProcess => {
      const sessionId =
        existing?.sessionId ??
        `${SESSION_PREFIX}${globalThis.crypto.randomUUID()}`;
      const queue = new AsyncQueue<OutputEvent>();
      let settled = false;
      let killed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let resolveCmd!: (id: string) => void;
      let rejectCmd!: (e: unknown) => void;
      const cmdIdP = new Promise<string>((res, rej) => {
        resolveCmd = res;
        rejectCmd = rej;
      });
      cmdIdP.catch(() => {});
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
      const dropSession = () => proc.deleteSession(sessionId).catch(() => {});
      const exitCodeOf = async (cmdId: string): Promise<number> => {
        for (let i = 0; i < 20; i++) {
          let c: Awaited<ReturnType<typeof proc.getSessionCommand>>;
          try {
            c = await proc.getSessionCommand(sessionId, cmdId);
          } catch (error) {
            // Session deleted underneath us (killProcess): report a kill.
            if (mapDaytonaError(error)?.code === "NotFound") {
              return 137;
            }
            throw error;
          }
          if (typeof c.exitCode === "number") {
            return c.exitCode;
          }
          await sleep(Math.min(50 * 2 ** i, 1000));
        }
        return -1;
      };

      void (async () => {
        let cmdId: string;
        if (existing) {
          cmdId = existing.cmdId;
        } else {
          await proc.createSession(sessionId);
          const res = await proc.executeSessionCommand(sessionId, {
            command: cmd,
            runAsync: true,
          });
          cmdId = res.cmdId;
        }
        resolveCmd(cmdId);
        await proc.getSessionCommandLogs(
          sessionId,
          cmdId,
          (chunk) => {
            if (!settled && chunk) {
              queue.push({ data: chunk, type: "stdout" });
            }
          },
          (chunk) => {
            if (!settled && chunk) {
              queue.push({ data: chunk, type: "stderr" });
            }
          }
        );
        if (killed) {
          finish({ exitCode: 137, signal: "SIGKILL", type: "exit" });
          return;
        }
        finish({ exitCode: await exitCodeOf(cmdId), type: "exit" });
        if (!existing) {
          await dropSession();
        }
      })().catch((error: unknown) => {
        rejectCmd(error);
        if (killed) {
          finish({ exitCode: 137, signal: "SIGKILL", type: "exit" });
        } else {
          finish(mapDaytonaError(error) ?? SandboxError.wrap(error, PROVIDER));
        }
        void dropSession();
      });

      if (execOpts.timeoutMs !== undefined && execOpts.timeoutMs > 0) {
        const ms = execOpts.timeoutMs;
        timer = setTimeout(() => {
          killed = true;
          finish(
            new SandboxError("Timeout", `command timed out after ${ms}ms`, {
              provider: PROVIDER,
              timedOut: true,
            })
          );
          void dropSession();
        }, ms);
      }

      return {
        [Symbol.asyncIterator]: () => queue.iterator(),
        id: sessionId,
        async kill() {
          killed = true;
          await dropSession();
          finish({ exitCode: 137, signal: "SIGKILL", type: "exit" });
        },
        pid: Promise.resolve(sessionId),
        async writeStdin(data: Uint8Array) {
          const cmdId = await cmdIdP;
          await proc.sendSessionCommandInput(
            sessionId,
            cmdId,
            dec.decode(data)
          );
        },
      };
    };

    const wrapPty = (
      handle: PtyHandle,
      out: AsyncQueue<Uint8Array>
    ): DriverPty => {
      const exited = handle.wait().then(
        (r) => {
          out.close();
          return r.exitCode ?? -1;
        },
        (error: unknown) => {
          out.close();
          throw mapDaytonaError(error) ?? SandboxError.wrap(error, PROVIDER);
        }
      );
      exited.catch(() => {});
      return {
        id: handle.sessionId,
        async kill() {
          await handle.kill();
        },
        output: { [Symbol.asyncIterator]: () => out.iterator() },
        async resize(cols, rows) {
          await handle.resize(cols, rows);
        },
        wait: () => exited,
        async write(data) {
          await handle.sendInput(data);
        },
      };
    };

    return {
      id: sb.id,
      name: sb.name,
      raw: sb,

      // ---- lifecycle ----
      async getInfo() {
        await sb.refreshData();
        return sandboxInfo(sb);
      },
      async destroy() {
        await sb.delete();
      },
      async stop() {
        await sb.stop();
      },
      async pause() {
        await sb.pause();
      },
      async resume() {
        await sb.start();
      },
      /** Wall-clock TTL from now (`setTtl`); the sandbox is destroyed when it elapses. */
      async setTimeout(ttlMs) {
        await sb.setTtl(minutes(ttlMs));
      },

      // ---- exec ----
      exec(cmd, execOpts): DriverExec {
        return runInSession(cmd, execOpts);
      },
      spawn(cmd, execOpts): DriverProcess {
        return runInSession(cmd, execOpts);
      },
      async connectProcess(processId): Promise<DriverProcess> {
        const session = await proc.getSession(processId);
        const last = session.commands.at(-1);
        if (!last) {
          throw new SandboxError("NotFound", `no command in ${processId}`, {
            provider: PROVIDER,
          });
        }
        return runInSession(
          last.command,
          {},
          {
            cmdId: last.id,
            sessionId: processId,
          }
        );
      },
      async killProcess(processId) {
        await proc.deleteSession(processId);
      },
      async listProcesses(): Promise<ProcessInfo[]> {
        const sessions = await proc.listSessions();
        return sessions
          .filter((s) => s.sessionId.startsWith(SESSION_PREFIX))
          .map((s) => ({
            cmd: s.commands.at(-1)?.command ?? "",
            id: s.sessionId,
          }));
      },

      // ---- files ----
      async readFile(path) {
        return new Uint8Array(await fs.downloadFile(path));
      },
      async writeFile(path, data) {
        await fs.uploadFile(
          Buffer.from(data.buffer, data.byteOffset, data.byteLength),
          path
        );
      },
      async upload(path, data) {
        await fs.uploadFileStream(
          typeof data === "string" ? enc.encode(data) : data,
          path
        );
      },
      async listDir(path): Promise<DirEntry[]> {
        const files = await fs.listFiles(path);
        const base = path.replace(/\/$/, "");
        return files.map((f) => ({
          name: f.name,
          path: `${base}/${f.name}`,
          type: f.isDir ? "dir" : "file",
        }));
      },
      async mkdir(path) {
        await fs.createFolder(path, "755");
      },
      async remove(path, recursive) {
        await fs.deleteFile(path, recursive);
      },
      async rename(from, to) {
        await fs.moveFiles(from, to);
      },
      async stat(path): Promise<FileInfo> {
        const d = await fs.getFileDetails(path);
        return {
          mtime: d.modTime ? new Date(d.modTime) : undefined,
          path,
          size: d.size ?? 0,
          type: d.isDir ? "dir" : "file",
        };
      },

      // ---- network ----
      async exposePort(port, eopts): Promise<Preview> {
        if (eopts.private) {
          const signed = await sb.getSignedPreviewUrl(port, previewTtl);
          return {
            auth: { type: "signed-url" },
            expiresAt: new Date(Date.now() + previewTtl * 1000),
            port,
            url: signed.url,
          };
        }
        const link = await sb.getPreviewLink(port);
        return sb.public
          ? { auth: { type: "public" }, port, url: link.url }
          : {
              auth: {
                headers: { "X-Daytona-Preview-Token": link.token },
                type: "header",
              },
              port,
              token: link.token,
              url: link.url,
            };
      },
      async setEgressPolicy(policy) {
        await sb.updateNetworkSettings(egressToDaytona(policy));
      },
      async createSsh(): Promise<SshCredentials> {
        const access = await sb.createSshAccess(60);
        return {
          ...parseSshCommand(access.sshCommand, access.token),
          // Daytona authenticates by token (the SSH user); there is no key.
          privateKey: "",
        };
      },

      // ---- pty ----
      async createPty(popts: PtyOptions): Promise<DriverPty> {
        const out = new AsyncQueue<Uint8Array>();
        const handle = await proc.createPty({
          cols: popts.cols,
          cwd: popts.cwd,
          envs: popts.env,
          id: `${SESSION_PREFIX}pty-${globalThis.crypto.randomUUID()}`,
          onData: (d) => out.push(d),
          rows: popts.rows,
        });
        await handle.waitForConnection();
        if (popts.cmd) {
          await handle.sendInput(`exec ${popts.cmd}\n`);
        }
        return wrapPty(handle, out);
      },
      async connectPty(id): Promise<DriverPty> {
        const out = new AsyncQueue<Uint8Array>();
        const handle = await proc.connectPty(id, {
          onData: (d) => out.push(d),
        });
        await handle.waitForConnection();
        return wrapPty(handle, out);
      },

      async getMetrics(): Promise<SandboxMetrics> {
        const m = await sb.getMetricsLatest();
        const mb = (b: number) => b / 1_048_576;
        return {
          cpuPercent: m.cpuUsedPct,
          diskTotalMB: mb(m.diskTotal),
          diskUsedMB: mb(m.diskUsed),
          memoryTotalMB: mb(m.memTotal),
          memoryUsedMB: mb(m.memUsed),
          raw: m,
          timestamp: m.timestamp instanceof Date ? m.timestamp : new Date(),
        };
      },

      // ---- code ----
      async runCode(code, ropts): Promise<CodeExecution> {
        const ictx = ropts.context ? contexts.get(ropts.context.id) : undefined;
        if (ropts.context && !ictx) {
          throw new SandboxError(
            "NotFound",
            `no kernel context ${ropts.context.id}`,
            {
              provider: PROVIDER,
            }
          );
        }
        if (ictx) {
          // Stateful Python kernel (codeInterpreter), streamed.
          const res = await sb.codeInterpreter.runCode(code, {
            context: ictx,
            onStderr: (m) => ropts.onStderr?.(m.output),
            onStdout: (m) => ropts.onStdout?.(m.output),
          });
          return {
            error: res.error,
            logs: {
              stderr: res.stderr ? [res.stderr] : [],
              stdout: res.stdout ? [res.stdout] : [],
            },
            results: [],
          };
        }
        // Stateless run in the sandbox's language; returns matplotlib charts.
        const res: CodeRunResult = await proc.codeRun(code);
        const charts = res.artifacts?.charts ?? [];
        return {
          error:
            res.exitCode === 0
              ? undefined
              : { name: "Error", value: res.result ?? "" },
          logs: { stderr: [], stdout: res.result ? [res.result] : [] },
          results: charts.map((c) => {
            const mime: Record<string, string> = {};
            if (c.png) {
              mime["image/png"] = c.png;
            }
            return c.title === undefined ? { mime } : { mime, text: c.title };
          }),
        };
      },
      async createContext(copts): Promise<KernelContext> {
        const language = copts.language ?? "python";
        if (language !== "python") {
          throw validation(
            "Daytona's stateful interpreter only supports Python contexts"
          );
        }
        const ictx = await sb.codeInterpreter.createContext(copts.cwd);
        contexts.set(ictx.id, ictx);
        return { id: ictx.id, language };
      },

      // ---- snapshots / fork ----
      async snapshot(sopts: SnapshotOptions): Promise<SnapshotRef> {
        if (sopts.mode === "memory") {
          throw notSupported("snapshots.create({ mode: 'memory' })");
        }
        const name =
          sopts.name ?? `sbox-snap-${sb.id}-${Date.now().toString(36)}`;
        await sb.createSnapshot(name);
        return {
          createdAt: new Date(),
          id: name,
          includesMemory: false,
          name,
          provider: PROVIDER,
          raw: { name, sandboxId: sb.id },
        };
      },
      async listSnapshots(): Promise<SnapshotRef[]> {
        const c = await getClient();
        const out: SnapshotRef[] = [];
        for (let page = 1; ; page++) {
          const res = await c.snapshot.list({
            limit: 100,
            page,
            sourceSandboxId: sb.id,
          });
          for (const s of res.items) {
            out.push({
              createdAt: s.createdAt ? new Date(s.createdAt) : undefined,
              id: s.name,
              includesMemory: false,
              name: s.name,
              provider: PROVIDER,
              raw: s,
            });
          }
          if (page >= res.totalPages || res.items.length === 0) {
            return out;
          }
        }
      },
      async deleteSnapshot(ref) {
        const c = await getClient();
        await c.snapshot.delete(ref);
      },
      async fork(count): Promise<DriverHandle<DaytonaSandbox>[]> {
        const out: DriverHandle<DaytonaSandbox>[] = [];
        for (let i = 0; i < count; i++) {
          out.push(makeHandle(await sb.fork()));
        }
        return out;
      },
    };
  };

  // ---- templates (Daytona snapshots) ----
  const getSnapshot = async (
    c: DaytonaV0Client,
    idOrName: string
  ): Promise<DaytonaSnapshot | undefined> => {
    try {
      return await c.snapshot.get(idOrName);
    } catch (error) {
      if (mapDaytonaError(error)?.code === "NotFound") {
        return undefined;
      }
      throw error;
    }
  };

  async function* allSnapshots(
    c: DaytonaV0Client
  ): AsyncIterable<DaytonaSnapshot> {
    for (let page = 1; ; page++) {
      const res = await c.snapshot.list({ limit: 100, page });
      yield* res.items;
      if (page >= res.totalPages || res.items.length === 0) {
        return;
      }
    }
  }

  const findSnapshot = async (
    c: DaytonaV0Client,
    match: (name: string) => boolean
  ): Promise<DaytonaSnapshot | undefined> => {
    let best: DaytonaSnapshot | undefined;
    for await (const s of allSnapshots(c)) {
      if (
        s.state === "active" &&
        match(s.name) &&
        (!best || new Date(s.createdAt) > new Date(best.createdAt))
      ) {
        best = s;
      }
    }
    return best;
  };

  const buildImage = async (
    spec: TemplateSpec,
    tmpDirs: string[]
  ): Promise<string | DaytonaImage> => {
    const { Image } = await loadV0();
    const extras = (img: DaytonaImage): DaytonaImage => {
      let out = img;
      if (spec.env && Object.keys(spec.env).length > 0) {
        out = out.env(spec.env);
      }
      if (spec.workdir) {
        out = out.workdir(spec.workdir);
      }
      if (spec.user) {
        out = out.dockerfileCommands([`USER ${spec.user}`]);
      }
      return out;
    };
    const hasExtras = !!(
      (spec.env && Object.keys(spec.env).length > 0) ||
      spec.workdir ||
      spec.user
    );
    const { source } = spec;
    if ("image" in source && source.image !== undefined) {
      if (source.registryAuth) {
        throw validation(
          "Daytona reads registry credentials from the dashboard (Registries); `registryAuth` is not accepted"
        );
      }
      return hasExtras ? extras(Image.base(source.image)) : source.image;
    }
    if ("dockerfile" in source && source.dockerfile !== undefined) {
      const [{ mkdtemp, mkdir, writeFile }, os, path, { loadTemplateContext }] =
        await Promise.all([
          import("node:fs/promises"),
          import("node:os"),
          import("node:path"),
          import("../adapter/index.js"),
        ]);
      const dir = await mkdtemp(path.join(os.tmpdir(), "sbox-daytona-"));
      tmpDirs.push(dir);
      const files = await loadTemplateContext(source.context);
      for (const [rel, bytes] of files) {
        const dest = path.join(dir, rel);
        if (!dest.startsWith(dir + path.sep)) {
          throw validation(`context path escapes the build dir: ${rel}`);
        }
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, bytes);
      }
      const dockerfile = path.join(dir, ".sbox.Dockerfile");
      await writeFile(dockerfile, source.dockerfile);
      return extras(Image.fromDockerfile(dockerfile));
    }
    throw notSupported("templates.build({ snapshot })");
  };

  const templates: DriverTemplates = {
    async build(spec, bopts) {
      const c = await getClient();
      const name = templateSnapshotName(spec.name, spec.cacheKey);
      const existing = await getSnapshot(c, name);
      if (existing?.state === "active") {
        return templateRef(existing, spec.cacheKey, spec.name);
      }
      if (existing) {
        // A failed/stale build under our name: clear it so we can rebuild.
        await c.snapshot.delete(existing);
      }
      if (spec.readyCmd) {
        bopts.onEvent({
          line: "readyCmd is not supported by Daytona snapshots; ignored",
          stream: "stderr",
          type: "log",
        });
      }
      if (bopts.signal?.aborted) {
        throw new SandboxError("Timeout", "template build aborted", {
          aborted: true,
          provider: PROVIDER,
        });
      }
      const tmpDirs: string[] = [];
      try {
        const image = await buildImage(spec, tmpDirs);
        const r = spec.resources;
        const resources: Resources | undefined = r
          ? {
              ...(r.vcpus === undefined ? {} : { cpu: Math.ceil(r.vcpus) }),
              ...(r.memoryMB === undefined ? {} : { memory: gib(r.memoryMB) }),
              ...(r.diskMB === undefined ? {} : { disk: gib(r.diskMB) }),
              ...(r.gpuCount === undefined && r.gpu === undefined
                ? {}
                : { gpu: r.gpuCount ?? 1 }),
            }
          : undefined;
        bopts.onEvent({ status: "building", type: "status" });
        const snap = await c.snapshot.create(
          {
            image,
            name,
            ...(resources ? { resources } : {}),
            ...(spec.startCmd
              ? { entrypoint: ["sh", "-c", spec.startCmd] }
              : {}),
            ...(opts.target ? { regionId: opts.target } : {}),
          },
          {
            onLogs: (chunk) => {
              for (const line of chunk.split(/\r?\n/)) {
                if (line) {
                  bopts.onEvent({ line, type: "log" });
                }
              }
            },
          }
        );
        return templateRef(snap, spec.cacheKey, spec.name);
      } finally {
        if (tmpDirs.length > 0) {
          const { rm } = await import("node:fs/promises");
          await Promise.all(
            tmpDirs.map((d) => rm(d, { force: true, recursive: true }))
          );
        }
      }
    },
    async lookup(idOrKey) {
      const c = await getClient();
      if (/^[0-9a-f]{64}$/.test(idOrKey)) {
        const key16 = idOrKey.slice(0, 16);
        const direct = await getSnapshot(c, `sbox-${key16}`);
        const snap =
          direct?.state === "active"
            ? direct
            : await findSnapshot(c, (n) => n.endsWith(`-${key16}`));
        return snap ? templateRef(snap, idOrKey) : undefined;
      }
      const direct = await getSnapshot(c, idOrKey);
      if (direct?.state === "active") {
        return templateRef(direct);
      }
      const prefix = `${idOrKey}-`;
      const snap = await findSnapshot(
        c,
        (n) =>
          n.startsWith(prefix) && /^[0-9a-f]{16}$/.test(n.slice(prefix.length))
      );
      return snap ? templateRef(snap, undefined, idOrKey) : undefined;
    },
    async *list() {
      const c = await getClient();
      for await (const s of allSnapshots(c)) {
        yield templateRef(s);
      }
    },
    async delete(id) {
      const c = await getClient();
      await c.snapshot.delete(id);
    },
  };

  // ---- volumes ----
  const findVolume = async (
    c: DaytonaV0Client,
    idOrName: string
  ): Promise<DaytonaVolume | undefined> => {
    const all = await c.volume.list();
    return all.find((v) => v.id === idOrName || v.name === idOrName);
  };
  const volumes: DriverVolumes = {
    async create(spec) {
      const c = await getClient();
      return volumeInfo(await c.volume.create(spec.name));
    },
    async get(idOrName) {
      const c = await getClient();
      const v = await findVolume(c, idOrName);
      return v ? volumeInfo(v) : undefined;
    },
    async *list() {
      const c = await getClient();
      for (const v of await c.volume.list()) {
        yield volumeInfo(v);
      }
    },
    async delete(id) {
      const c = await getClient();
      const v = await findVolume(c, id);
      if (!v) {
        throw new SandboxError("NotFound", `no volume ${id}`, {
          provider: PROVIDER,
        });
      }
      await c.volume.delete(v);
    },
  };

  async function* listRaw(
    filter: ListFilter | undefined
  ): AsyncIterable<SandboxInfo> {
    const c = await getClient();
    const states = filter?.state ? STATE_FILTER[filter.state] : undefined;
    let n = 0;
    for await (const sb of c.list({
      ...(filter?.metadata ? { labels: filter.metadata } : {}),
      ...(states ? { states } : {}),
      ...(filter?.limit === undefined ? {} : { limit: filter.limit }),
    })) {
      const info = sandboxInfo(sb);
      if (filter?.state && info.state !== filter.state) {
        continue;
      }
      if (!matchesMetadata(sb.labels, filter?.metadata)) {
        continue;
      }
      if (filter?.limit !== undefined && n >= filter.limit) {
        return;
      }
      n++;
      yield info;
    }
  }

  const provider: SandboxProvider<DaytonaCaps, DaytonaSandbox> = {
    capabilities: DAYTONA_CAPS,
    flags: DAYTONA_FLAGS,
    mapError: mapDaytonaError,
    name: PROVIDER,
    templates,
    volumes,

    create: (spec, ctx) =>
      mapped(async () => makeHandle(await createSandbox(spec, ctx, false))),

    connect: (id) =>
      mapped(async () => {
        const c = await getClient();
        return makeHandle(await c.get(id));
      }),

    getOrCreate: (spec, ctx) =>
      mapped(async () => {
        const c = await getClient();
        try {
          const sb = await c.get(spec.name);
          const state = mapDaytonaState(sb.state);
          if (state !== "destroyed" && state !== "error") {
            if (
              state === "stopped" ||
              state === "paused" ||
              state === "archived"
            ) {
              await sb.start();
            }
            return makeHandle(sb);
          }
        } catch (error) {
          if (mapDaytonaError(error)?.code !== "NotFound") {
            throw error;
          }
        }
        return makeHandle(await createSandbox(spec, ctx, true));
      }),

    async *list(filter: ListFilter | undefined) {
      try {
        yield* listRaw(filter);
      } catch (error) {
        throw mapDaytonaError(error) ?? SandboxError.wrap(error, PROVIDER);
      }
    },

    verify: () =>
      mapped(async () => {
        const c = await getClient();
        for await (const _sb of c.list({ limit: 1 })) {
          break;
        }
        return undefined;
      }),

    async dispose() {
      const r = root;
      const c = client;
      root = null;
      client = null;
      if (r) {
        await r.close();
      } else if (c) {
        await c[Symbol.asyncDispose]();
      }
    },
  };
  return provider;
});
