/**
 * `sbox-sdk/together` — adapter for Together Sandbox (`together-sandbox`), the
 * successor to CodeSandbox. Firecracker VMs booted from snapshots; a sandbox
 * lives `create → running → terminate`. Pausing terminates it with a memory
 * snapshot and resuming boots a NEW sandbox (new id) from that snapshot, so
 * `flags.resumeChangesId` is true. The SDK is lazy-imported inside
 * create()/connect() so importing this subpath stays cheap. Requires the
 * optional peer dependency `together-sandbox`.
 */
import {
  AsyncQueue,
  SandboxError,
  base64ToBytes,
  defineProvider,
  loadTemplateContext,
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
  ExecOptions,
  FileInfo,
  FsEvent,
  ListFilter,
  OutputEvent,
  ProcessInfo,
  PtyOptions,
  ResolvedSandboxSpec,
  SandboxInfo,
  SandboxProvider,
  SandboxState,
  TemplateRef,
  TemplateSpec,
} from "../adapter/index.js";

// --------------------------------------------------------------------------
// SDK types (derived from the installed package, never hand-written)
// --------------------------------------------------------------------------

type Mod = typeof import("together-sandbox");
type TClient = InstanceType<Mod["TogetherSandbox"]>;
type TSandbox = InstanceType<Mod["Sandbox"]>;
type TInfo = import("together-sandbox").SandboxInfo;
type TStatus = import("together-sandbox").SandboxStatus;
type TSnapshot = import("together-sandbox").Snapshot;
type TCreateParams = import("together-sandbox").CreateSandboxParams;
type TRetryContext = import("together-sandbox").RetryContext;
type ExecItem = Awaited<ReturnType<TSandbox["execs"]["create"]>>;
type ExecBody = Parameters<TSandbox["execs"]["create"]>[0];

export interface TogetherOptions {
  /** Together AI API key (`TOGETHER_API_KEY`). */
  apiKey: string;
  /** Management API host (`TOGETHER_BASE_URL`), without `/v1`. */
  baseUrl?: string;
  /**
   * Snapshot alias or id used when `create()` gets no `template` or
   * `fromSnapshot`. Together has no default image, so without this (or a
   * template) `create()` throws a Validation error.
   */
  defaultTemplate?: string;
}

/** The handle's `raw()`: the live SDK sandbox (undefined while paused). */
export interface TogetherRaw {
  readonly id: string;
  readonly info: TInfo;
  readonly sandbox: TSandbox | undefined;
  readonly sdk: TClient;
}

export const TOGETHER_CAPS = {
  background: "native",
  codeInterpreter: "unsupported",
  egressControl: "unsupported",
  exposePort: "unsupported",
  filesUpload: "native",
  filesWatch: "native",
  fork: "unsupported",
  gpu: "unsupported",
  killProcess: "native",
  list: "native",
  metrics: "unsupported",
  pause: "native",
  privatePreview: "unsupported",
  proxiedFetch: "unsupported",
  pty: "native",
  region: "unsupported",
  secretsVault: "unsupported",
  setTimeout: "unsupported",
  snapshot: "unsupported",
  ssh: "unsupported",
  statefulKernel: "unsupported",
  stdin: "native",
  stop: "native",
  streaming: "native",
  templateBuild: "native",
  volumes: "unsupported",
} as const satisfies CapabilityMap;

export type TogetherCaps = typeof TOGETHER_CAPS;

const TOGETHER_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true,
  preservesDiskOnStop: true,
  preservesMemoryOnPause: true,
  previewBrowserAuth: false,
  previewModel: "none",
  resumeChangesId: true,
  templateSources: ["dockerfile", "image", "snapshot"],
};

const PROVIDER = "together";
/** Tag holding a hash of the idempotency key (Together has no native one). */
const IDEM_TAG = "sbox-idem";
const NAME_TAG = "sbox-name";
const TEMPLATE_TAG = "sbox-template";
const TEMPLATE_KEY_TAG = "sbox-template-key";
/** Where `spec.env` is persisted so reconnected handles can reload it. */
const ENV_DIR = "/var/tmp/.sbox";
const ENV_FILE = `${ENV_DIR}/env.json`;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE_KEY_RE = /^[0-9a-f]{64}$/;
const TAG_KEY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,57}[A-Za-z0-9])?$/;
/** Status codes the SDK's own retry treats as transient. */
const RETRYABLE = new Set([0, 408, 429, 500, 502, 503, 504]);
/** Non-idempotent operations: never let the SDK retry these blindly. */
const NO_RETRY_OPS = new Set([
  "api.createSandbox",
  "api.snapshots.create",
  "snapshots.create",
]);

const enc = new TextEncoder();
const dec = new TextDecoder();

// --------------------------------------------------------------------------
// errors + state mapping
// --------------------------------------------------------------------------

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status?: unknown }).status;
    return typeof s === "number" ? s : undefined;
  }
  return undefined;
}

/** Map a `together-sandbox` failure onto the sbox error taxonomy. */
export function mapTogetherError(err: unknown): SandboxError | undefined {
  if (err instanceof SandboxError) {
    return err;
  }
  if (!(err instanceof Error)) {
    return undefined;
  }
  const msg = err.message;
  const init = { cause: err, provider: PROVIDER };
  const status = statusOf(err);
  if (status !== undefined && err.name === "HttpError") {
    if (status === 0) {
      return /timeout|timed out/i.test(msg)
        ? new SandboxError("Timeout", msg, { ...init, status })
        : new SandboxError("Provider", msg, {
            ...init,
            retryable: true,
            status,
          });
    }
    if (status === 401 || status === 403) {
      return new SandboxError("Unauthorized", msg, { ...init, status });
    }
    if (status === 404) {
      return new SandboxError("NotFound", msg, { ...init, status });
    }
    if (status === 409) {
      return new SandboxError("Conflict", msg, { ...init, status });
    }
    if (status === 429) {
      return new SandboxError("QuotaExceeded", msg, {
        ...init,
        retryable: true,
        status,
      });
    }
    if (status === 408 || status === 504) {
      return new SandboxError("Timeout", msg, { ...init, status });
    }
    if (status === 400 || status === 422) {
      return new SandboxError("Validation", msg, { ...init, status });
    }
    return new SandboxError("Provider", msg, { ...init, status });
  }
  // Lifecycle failures are plain Errors (e.g. "failed_to_start: out_of_capacity").
  if (/out_of_capacity/i.test(msg)) {
    return new SandboxError("QuotaExceeded", msg, { ...init, retryable: true });
  }
  if (/timed? ?out/i.test(msg)) {
    return new SandboxError("Timeout", msg, init);
  }
  return undefined;
}

function wrap(err: unknown): SandboxError {
  return mapTogetherError(err) ?? SandboxError.wrap(err, PROVIDER);
}

function isNotFound(err: unknown): boolean {
  return statusOf(err) === 404;
}

/**
 * Live sandbox status → `SandboxState`. `terminated` needs the produced
 * snapshot to tell paused/stopped/destroyed apart, see {@link resolveState}.
 * - `terminating` is a teardown in flight; it usually ends in a snapshot
 *   (pause/stop), so it reads as `suspending`.
 * - `recovering` is a crashed VM being re-placed: not usable yet, so
 *   `creating` (it returns to `running` on success).
 */
export function mapTogetherStatus(status: TStatus | string): SandboxState {
  switch (status) {
    case "starting":
    case "recovering": {
      return "creating";
    }
    case "running": {
      return "running";
    }
    case "terminating": {
      return "suspending";
    }
    case "failed_to_start":
    case "unrecovered": {
      return "error";
    }
    case "terminated": {
      return "destroyed";
    }
    default: {
      return "unknown";
    }
  }
}

/** A terminated sandbox's state, from the snapshot aliased `sandbox:<id>`. */
export function terminatedState(snap: TSnapshot | undefined): SandboxState {
  if (!snap || snap.retired_at) {
    return "destroyed";
  }
  return snap.memory ? "paused" : "stopped";
}

function statusesFor(state: SandboxState): TStatus[] | undefined {
  switch (state) {
    case "creating": {
      return ["starting", "recovering"];
    }
    case "running": {
      return ["running"];
    }
    case "suspending": {
      return ["terminating"];
    }
    case "error": {
      return ["failed_to_start", "unrecovered"];
    }
    case "paused":
    case "stopped":
    case "destroyed": {
      return ["terminated"];
    }
    default: {
      return undefined;
    }
  }
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

async function sha256Hex(s: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function validateTags(tags: Record<string, string>): void {
  for (const key of Object.keys(tags)) {
    if (!TAG_KEY_RE.test(key)) {
      throw new SandboxError(
        "Validation",
        `invalid metadata key ${JSON.stringify(key)}: Together tag keys are at most 59 letters, digits, '-', '_' or '.', starting and ending with a letter or digit`,
        { provider: PROVIDER }
      );
    }
  }
}

function snapshotRef(
  ref: string
): Pick<TCreateParams, "snapshotId" | "snapshotAlias"> {
  return UUID_RE.test(ref) ? { snapshotId: ref } : { snapshotAlias: ref };
}

function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 40);
  return out || "sbox";
}

function infoOf(i: TInfo, state: SandboxState): SandboxInfo {
  const metadata = Object.fromEntries(
    Object.entries(i.tags).filter(([k]) => k !== IDEM_TAG)
  );
  return {
    createdAt: i.createdAt ? new Date(i.createdAt) : undefined,
    id: i.id,
    metadata,
    name: i.tags[NAME_TAG],
    provider: PROVIDER,
    raw: i,
    state,
  };
}

function bad(message: string): SandboxError {
  return new SandboxError("Validation", message, { provider: PROVIDER });
}

/** Everything in the spec Together cannot honor fails loudly, not silently. */
function assertSupportedSpec(spec: ResolvedSandboxSpec): void {
  if (spec.network && spec.network.mode !== "allow-all") {
    throw bad("egress control is not supported by Together Sandbox");
  }
  if (spec.ports && spec.ports.length > 0) {
    throw bad("preview ports are not available on Together Sandbox yet");
  }
  if (spec.volumes && spec.volumes.length > 0) {
    throw bad("volumes are not supported by Together Sandbox");
  }
  if (spec.region) {
    throw bad("region selection is not supported by Together Sandbox");
  }
  if (spec.resources?.gpu || spec.resources?.gpuCount) {
    throw bad("GPUs are not supported by Together Sandbox");
  }
  for (const s of spec.secrets ?? []) {
    if (s.mode === "egress" || s.value === undefined) {
      throw bad(
        `secret '${s.name}': Together has no secret vault or egress injection; pass an inline value (exposed as an env var)`
      );
    }
  }
}

function lifecyclePolicy(
  spec: ResolvedSandboxSpec
): TCreateParams["terminationPolicy"] {
  const onIdle = spec.lifecycle?.onIdle;
  if (onIdle === "pause") {
    return { snapshot: { memory: true } };
  }
  if (onIdle === "stop") {
    return { snapshot: { memory: false } };
  }
  return undefined;
}

/** Map a resolved spec onto `sdk.sandboxes.create()` params. */
export function toCreateParams(
  spec: ResolvedSandboxSpec,
  tags: Record<string, string>,
  defaultTemplate?: string
): TCreateParams {
  const ref = spec.fromSnapshot ?? spec.template ?? defaultTemplate;
  if (!ref) {
    throw bad(
      "Together sandboxes boot from a snapshot: pass `template` (a snapshot alias/id or a TemplateSpec), `fromSnapshot`, or `defaultTemplate` in together({...})"
    );
  }
  const maxAge = spec.lifecycle?.maxAgeMs;
  const policy = lifecyclePolicy(spec);
  return {
    ...snapshotRef(ref),
    ...(spec.resources?.vcpus === undefined
      ? {}
      : { cpu: spec.resources.vcpus }),
    ...(spec.resources?.memoryMB === undefined
      ? {}
      : { memoryBytes: spec.resources.memoryMB * 1024 * 1024 }),
    ...(maxAge === undefined
      ? {}
      : { ttl: Math.max(1, Math.ceil(maxAge / 1000)) }),
    ...(Object.keys(tags).length > 0 ? { tags } : {}),
    ...(policy ? { terminationPolicy: policy } : {}),
  };
}

// --------------------------------------------------------------------------
// exec plumbing
// --------------------------------------------------------------------------

interface Started {
  sb: TSandbox;
  item: ExecItem;
}

/** Turn an exec (by id) into a DriverProcess streaming stdout/stderr apart. */
function execStream(start: Promise<Started>): DriverExec & {
  done: Promise<void>;
} {
  const q = new AsyncQueue<OutputEvent>();
  let killed = false;
  const done = (async () => {
    const { sb, item } = await start;
    const stream = await sb.execs.streamOutput(item.id);
    let exit: number | undefined;
    for await (const ev of stream) {
      if (ev.output) {
        q.push({
          data: ev.output,
          type: ev.type === "stderr" ? "stderr" : "stdout",
        });
      }
      if (typeof ev.exitCode === "number") {
        exit = ev.exitCode;
        break;
      }
    }
    if (exit === undefined) {
      try {
        const final = await sb.execs.get(item.id);
        if (final.status !== "running") {
          exit = final.exitCode;
        }
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
        // The exec record is gone: it was deleted (killed), here or elsewhere.
        killed = true;
      }
    }
    if (exit === undefined) {
      if (!killed) {
        throw new SandboxError(
          "Provider",
          `exec ${item.id} output ended without an exit code`,
          { provider: PROVIDER }
        );
      }
      exit = 137;
    }
    q.push({ exitCode: exit, type: "exit" });
    q.close();
  })().catch((error: unknown) => q.fail(wrap(error)));
  const pid = start.then((s) => s.item.id);
  // An unawaited rejection here would surface twice; the queue carries it.
  pid.catch(() => {});
  return {
    [Symbol.asyncIterator]: () => q.iterator(),
    done,
    async kill() {
      killed = true;
      const { sb, item } = await start;
      try {
        await sb.execs.delete(item.id);
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
    },
    pid,
    async writeStdin(data: Uint8Array) {
      const { sb, item } = await start;
      await sb.execs.sendStdin(item.id, {
        input: dec.decode(data),
        type: "stdin",
      });
    },
  };
}

/** Run a command to completion and buffer its output (adapter-internal). */
async function collect(
  sb: TSandbox,
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = execStream(
    sb.execs.create({ args, autostart: true, command }).then((item) => ({
      item,
      sb,
    }))
  );
  let stdout = "";
  let stderr = "";
  let exitCode = 1;
  for await (const ev of proc) {
    if (ev.type === "stdout") {
      stdout += ev.data;
    } else if (ev.type === "stderr") {
      stderr += ev.data;
    } else {
      exitCode = ev.exitCode;
    }
  }
  return { exitCode, stderr, stdout };
}

function ptyFrom(sb: TSandbox, execId: string): DriverPty {
  const out = new AsyncQueue<Uint8Array>();
  let killed = false;
  const exited = (async (): Promise<number> => {
    const stream = await sb.execs.streamOutput(execId);
    for await (const ev of stream) {
      if (ev.output) {
        out.push(enc.encode(ev.output));
      }
      if (typeof ev.exitCode === "number") {
        return ev.exitCode;
      }
    }
    try {
      const final = await sb.execs.get(execId);
      if (final.status !== "running") {
        return final.exitCode;
      }
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
      return 137;
    }
    return killed ? 137 : 1;
  })().finally(() => out.close());
  exited.catch(() => {});
  return {
    id: execId,
    async kill() {
      killed = true;
      try {
        await sb.execs.delete(execId);
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
    },
    output: { [Symbol.asyncIterator]: () => out.iterator() },
    async resize(cols: number, rows: number) {
      await sb.execs.sendStdin(execId, {
        input: `${cols}x${rows}`,
        type: "resize",
      });
    },
    wait: () => exited,
    async write(data: Uint8Array) {
      await sb.execs.sendStdin(execId, {
        input: dec.decode(data),
        type: "stdin",
      });
    },
  };
}

function fsEventType(t: string): FsEvent["type"] | undefined {
  if (t === "ADD") {
    return "create";
  }
  if (t === "REMOVE") {
    return "delete";
  }
  if (t === "CHANGE") {
    return "modify";
  }
  return undefined;
}

// --------------------------------------------------------------------------
// provider
// --------------------------------------------------------------------------

export const together = defineProvider<
  TogetherCaps,
  TogetherRaw,
  TogetherOptions
>((opts) => {
  let sdkPromise: Promise<TClient> | undefined;
  const getSdk = (): Promise<TClient> => {
    sdkPromise ??= import("together-sandbox").then(
      (mod: Mod) =>
        new mod.TogetherSandbox({
          apiKey: opts.apiKey,
          ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
          retry: {
            shouldRetry: (ctx: TRetryContext) =>
              !NO_RETRY_OPS.has(ctx.operation) &&
              RETRYABLE.has(ctx.status ?? -1),
          },
        })
    );
    sdkPromise.catch(() => {
      sdkPromise = undefined;
    });
    return sdkPromise;
  };

  const snapshotFor = async (
    sdk: TClient,
    sandboxId: string
  ): Promise<TSnapshot | undefined> => {
    try {
      return await sdk.snapshots.getByAlias(`sandbox:${sandboxId}`);
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  };

  const resolveState = async (sdk: TClient, i: TInfo): Promise<SandboxState> =>
    i.status === "terminated"
      ? terminatedState(await snapshotFor(sdk, i.id))
      : mapTogetherStatus(i.status);

  const makeHandle = (
    sdk: TClient,
    initial: TInfo,
    initialLive: TSandbox | undefined,
    knownEnv: Record<string, string> | undefined
  ): DriverHandle<TogetherRaw> => {
    let info = initial;
    let live = initialLive;
    let env = knownEnv;

    const ensureLive = async (): Promise<TSandbox> => {
      if (live && live.id === info.id) {
        return live;
      }
      try {
        live = await sdk.sandboxes.connect(info.id);
      } catch (error) {
        if (statusOf(error) !== undefined) {
          throw error;
        }
        throw new SandboxError(
          "Conflict",
          `sandbox ${info.id} is not running (${error instanceof Error ? error.message : String(error)}); call resume() first`,
          { cause: error, provider: PROVIDER }
        );
      }
      info = live.vmInfo;
      return live;
    };

    /** spec.env, reloaded from the sandbox for reconnected handles. */
    const baseEnv = async (sb: TSandbox): Promise<Record<string, string>> => {
      if (env) {
        return env;
      }
      try {
        const parsed: unknown = JSON.parse(await sb.files.read(ENV_FILE));
        env =
          parsed && typeof parsed === "object"
            ? Object.fromEntries(
                Object.entries(parsed).filter(
                  (e): e is [string, string] => typeof e[1] === "string"
                )
              )
            : {};
      } catch {
        env = {};
      }
      return env;
    };

    const execBody = async (
      sb: TSandbox,
      command: string,
      args: string[],
      o: { cwd?: string; env?: Record<string, string>; user?: string },
      pty = false
    ): Promise<ExecBody> => {
      const merged = { ...(await baseEnv(sb)), ...o.env };
      return {
        args,
        autostart: true,
        command,
        ...(o.cwd ? { cwd: o.cwd } : {}),
        ...(Object.keys(merged).length > 0 ? { env: merged } : {}),
        ...(o.user ? { user: o.user } : {}),
        ...(pty ? { pty: true } : {}),
      };
    };

    const startExec = (cmd: string, o: ExecOptions): Promise<Started> =>
      (async () => {
        const sb = await ensureLive();
        const item = await sb.execs.create(
          await execBody(sb, "sh", ["-c", cmd], o)
        );
        return { item, sb };
      })();

    const handle: DriverHandle<TogetherRaw> = {
      async connectProcess(processId: string): Promise<DriverProcess> {
        const sb = await ensureLive();
        const item = await sb.execs.get(processId);
        const proc = execStream(Promise.resolve({ item, sb }));
        return Object.assign(proc, { id: processId });
      },
      async connectPty(id: string): Promise<DriverPty> {
        const sb = await ensureLive();
        await sb.execs.get(id);
        return ptyFrom(sb, id);
      },
      async createPty(p: PtyOptions): Promise<DriverPty> {
        const sb = await ensureLive();
        const [command, args] = p.cmd
          ? ["sh", ["-c", `exec ${p.cmd}`]]
          : ["bash", ["-l"]];
        const item = await sb.execs.create(
          await execBody(sb, command, args, p, true)
        );
        const pty = ptyFrom(sb, item.id);
        if (p.cols && p.rows) {
          await pty.resize(p.cols, p.rows);
        }
        return pty;
      },
      async destroy() {
        let current: TInfo;
        try {
          current = await sdk.sandboxes.get(info.id);
        } catch (error) {
          if (isNotFound(error)) {
            return;
          }
          throw error;
        }
        if (current.status === "terminated") {
          // Paused/stopped: the snapshot IS the sandbox now; retire it.
          const snap = await snapshotFor(sdk, current.id);
          if (snap && !snap.retired_at) {
            await sdk.snapshots.retire(snap.id);
          }
        } else {
          await sdk.sandboxes.terminate(current.id, { snapshot: null });
        }
        live = undefined;
      },
      exec(cmd: string, o: ExecOptions): DriverExec {
        return execStream(startExec(cmd, o));
      },
      async getInfo() {
        info = await sdk.sandboxes.get(info.id);
        return infoOf(info, await resolveState(sdk, info));
      },
      get id(): string {
        return info.id;
      },
      async killProcess(processId: string) {
        const sb = await ensureLive();
        await sb.execs.delete(processId);
      },
      async listDir(path: string): Promise<DirEntry[]> {
        const sb = await ensureLive();
        const files = await sb.directories.list(path);
        return files.map((f) => ({
          name: f.name,
          path: f.path,
          type: f.isDir ? "dir" : "file",
        }));
      },
      async listProcesses(): Promise<ProcessInfo[]> {
        const sb = await ensureLive();
        const execs = await sb.execs.list();
        return execs
          .filter((e) => e.status === "running")
          .map((e) => ({ cmd: [e.command, ...e.args].join(" "), id: e.id }));
      },
      async mkdir(path: string) {
        const sb = await ensureLive();
        await sb.directories.create(path);
      },
      get name(): string | undefined {
        return info.tags[NAME_TAG];
      },
      async pause() {
        await sdk.sandboxes.terminate(info.id, { snapshot: { memory: true } });
        live = undefined;
      },
      get raw(): TogetherRaw {
        return { id: info.id, info, sandbox: live, sdk };
      },
      async readFile(path: string): Promise<Uint8Array> {
        // files.read returns a string (base64 for binary, with no marker), so
        // read through base64 in the VM, as Together's migration guide advises.
        const sb = await ensureLive();
        const r = await collect(sb, "base64", ["-w0", path]);
        if (r.exitCode !== 0) {
          const code = /permission denied/i.test(r.stderr)
            ? "Provider"
            : "NotFound";
          throw new SandboxError(
            code,
            `cannot read '${path}': ${r.stderr.trim() || `exit ${r.exitCode}`}`,
            { provider: PROVIDER }
          );
        }
        return base64ToBytes(r.stdout.replaceAll(/\s/g, ""));
      },
      async remove(path: string, recursive: boolean) {
        const sb = await ensureLive();
        let isDir: boolean;
        try {
          isDir = (await sb.files.stat(path)).isDir;
        } catch (error) {
          if (isNotFound(error)) {
            return;
          }
          throw error;
        }
        if (!isDir) {
          await sb.files.delete(path);
          return;
        }
        if (!recursive && (await sb.directories.list(path)).length > 0) {
          throw new SandboxError(
            "Validation",
            `cannot remove '${path}': directory not empty (pass recursive)`,
            { provider: PROVIDER }
          );
        }
        await sb.directories.delete(path);
      },
      async rename(from: string, to: string) {
        const sb = await ensureLive();
        await sb.files.move(from, to);
      },
      async resume() {
        const current = await sdk.sandboxes.get(info.id);
        if (current.status !== "terminated") {
          info = current;
          return;
        }
        const snap = await snapshotFor(sdk, current.id);
        if (!snap || snap.retired_at) {
          throw new SandboxError(
            "NotFound",
            `sandbox ${current.id} was destroyed; there is no snapshot to resume from`,
            { provider: PROVIDER }
          );
        }
        const next = await sdk.sandboxes.create({
          cpu: current.cpu,
          memoryBytes: current.memoryBytes,
          snapshotAlias: `sandbox:${current.id}`,
          tags: current.tags,
          ...(current.ttl === null ? {} : { ttl: current.ttl }),
          ...(current.terminationPolicy
            ? { terminationPolicy: current.terminationPolicy }
            : {}),
        });
        // The new sandbox references the snapshot, so retiring only stops
        // further boots from it and marks the old id as destroyed (keeps
        // get-or-create by tag from resuming the same parent twice).
        await sdk.snapshots.retire(snap.id);
        live = next;
        info = next.vmInfo;
      },
      async stat(path: string): Promise<FileInfo> {
        const sb = await ensureLive();
        const s = await sb.files.stat(path);
        const mtime = s.modTime ? new Date(s.modTime) : undefined;
        return {
          path: s.path || path,
          size: s.size,
          type: s.isDir ? "dir" : "file",
          ...(mtime && !Number.isNaN(mtime.getTime()) ? { mtime } : {}),
        };
      },
      async stop() {
        await sdk.sandboxes.terminate(info.id, {
          snapshot: { memory: false },
        });
        live = undefined;
      },
      async spawn(cmd: string, o: ExecOptions): Promise<DriverProcess> {
        const proc = execStream(startExec(cmd, o));
        const id = await proc.pid;
        return Object.assign(proc, { id });
      },
      async watch(path: string, cb: (e: FsEvent) => void, recursive: boolean) {
        const sb = await ensureLive();
        const events = await sb.files.watch(path, { recursive });
        let closed = false;
        void (async () => {
          try {
            for await (const ev of events) {
              if (closed) {
                break;
              }
              const type = fsEventType(ev.type);
              if (type) {
                for (const p of ev.paths) {
                  cb({ path: p, type });
                }
              }
            }
          } catch {
            // stream closed
          }
        })();
        return async () => {
          closed = true;
          await events.throw(new Error("watch closed")).catch(() => {});
        };
      },
      async writeFile(path: string, data: Uint8Array) {
        const sb = await ensureLive();
        await sb.files.create(path, new Blob([new Uint8Array(data)]));
      },
    };
    return handle;
  };

  const persistEnv = async (
    sb: TSandbox,
    env: Record<string, string>
  ): Promise<void> => {
    await sb.directories.create(ENV_DIR);
    await sb.files.create(ENV_FILE, JSON.stringify(env));
  };

  const findByIdem = async (
    sdk: TClient,
    hash: string
  ): Promise<TInfo | undefined> => {
    const page = await sdk.sandboxes.list({
      limit: 1,
      statuses: ["starting", "running"],
      tags: { [IDEM_TAG]: hash },
    });
    return page.data[0];
  };

  const templates: DriverTemplates = {
    async build(spec, bopts) {
      const sdk = await getSdk();
      if (bopts.signal?.aborted) {
        throw new SandboxError("Timeout", "template build aborted", {
          aborted: true,
          provider: PROVIDER,
        });
      }
      const alias = `${slug(spec.name)}@${spec.cacheKey.slice(0, 12)}`;
      const tags = { [TEMPLATE_KEY_TAG]: spec.cacheKey, [TEMPLATE_TAG]: "1" };
      const onProgress = (e: { step: string; output: string }): void => {
        for (const line of e.output.split(/\r?\n/)) {
          if (line) {
            bopts.onEvent({ line, step: e.step, type: "log" });
          }
        }
      };
      const { source } = spec;
      bopts.onEvent({ status: "building", type: "status" });
      let snapshotId: string;
      if ("snapshot" in source && source.snapshot !== undefined) {
        await sdk.snapshots.alias(source.snapshot, alias);
        snapshotId = source.snapshot;
      } else if (
        "image" in source &&
        source.image !== undefined &&
        !needsDockerfile(spec)
      ) {
        if (source.registryAuth) {
          throw bad(
            "Together pulls images anonymously: registryAuth is not supported (the image must be publicly pullable)"
          );
        }
        snapshotId = (
          await sdk.snapshots.create({
            alias,
            image: source.image,
            onProgress,
            tags,
          })
        ).snapshotId;
      } else {
        if (
          "image" in source &&
          source.image !== undefined &&
          source.registryAuth
        ) {
          throw bad(
            "Together pulls images anonymously: registryAuth is not supported"
          );
        }
        snapshotId = await buildFromContext(sdk, spec, {
          alias,
          onProgress,
          tags,
        });
      }
      const snap = await sdk.snapshots.getById(snapshotId);
      return templateRef(snap, alias, spec.cacheKey);
    },
    async delete(id) {
      const sdk = await getSdk();
      await sdk.snapshots.retire(id);
    },
    async *list() {
      const sdk = await getSdk();
      for await (const s of await sdk.snapshots.list({
        excludeRetired: true,
        tags: { [TEMPLATE_TAG]: "1" },
      })) {
        yield templateRef(s, undefined, s.tags[TEMPLATE_KEY_TAG]);
      }
    },
    async lookup(idOrKey) {
      const sdk = await getSdk();
      const live = (s: TSnapshot | undefined): TSnapshot | undefined =>
        s && !s.retired_at ? s : undefined;
      try {
        if (UUID_RE.test(idOrKey)) {
          const s = live(await sdk.snapshots.getById(idOrKey));
          return s
            ? templateRef(s, undefined, s.tags[TEMPLATE_KEY_TAG])
            : undefined;
        }
        if (!CACHE_KEY_RE.test(idOrKey)) {
          const s = live(await sdk.snapshots.getByAlias(idOrKey));
          return s
            ? templateRef(s, idOrKey, s.tags[TEMPLATE_KEY_TAG])
            : undefined;
        }
      } catch (error) {
        if (isNotFound(error)) {
          return undefined;
        }
        throw error;
      }
      const page = await sdk.snapshots.list({
        excludeRetired: true,
        limit: 1,
        tags: { [TEMPLATE_KEY_TAG]: idOrKey },
      });
      const hit = page.data[0];
      return hit ? templateRef(hit, undefined, idOrKey) : undefined;
    },
  };

  const provider: SandboxProvider<TogetherCaps, TogetherRaw> = {
    capabilities: TOGETHER_CAPS,
    async connect(id: string, _ctx: CallContext) {
      const sdk = await getSdk();
      const info = await sdk.sandboxes.get(id);
      return makeHandle(sdk, info, undefined, undefined);
    },
    async create(spec: ResolvedSandboxSpec, ctx: CallContext) {
      assertSupportedSpec(spec);
      const sdk = await getSdk();
      const tags: Record<string, string> = { ...spec.metadata };
      if (spec.name) {
        tags[NAME_TAG] = spec.name;
      }
      validateTags(tags);
      const idem = ctx.idempotencyKey
        ? (await sha256Hex(ctx.idempotencyKey)).slice(0, 32)
        : undefined;
      if (idem) {
        tags[IDEM_TAG] = idem;
      }
      const params = toCreateParams(spec, tags, opts.defaultTemplate);
      const env: Record<string, string> = { ...spec.env };
      for (const s of spec.secrets ?? []) {
        if (s.value !== undefined) {
          env[s.envVar ?? s.name] = s.value;
        }
      }
      if (idem && ctx.attempt > 1) {
        const existing = await findByIdem(sdk, idem);
        if (existing) {
          return makeHandle(sdk, existing, undefined, env);
        }
      }
      const sb = await sdk.sandboxes.create(params);
      if (Object.keys(env).length > 0) {
        await persistEnv(sb, env);
      }
      return makeHandle(sdk, sb.vmInfo, sb, env);
    },
    flags: TOGETHER_FLAGS,
    async *list(filter: ListFilter | undefined) {
      const sdk = await getSdk();
      const statuses = filter?.state ? statusesFor(filter.state) : undefined;
      if (filter?.state && !statuses) {
        return;
      }
      const tags =
        filter?.metadata && Object.keys(filter.metadata).length > 0
          ? filter.metadata
          : undefined;
      const page = await sdk.sandboxes.list({
        limit: Math.min(100, Math.max(1, filter?.limit ?? 100)),
        ...(statuses ? { statuses } : {}),
        ...(tags ? { tags } : {}),
      });
      let n = 0;
      for await (const item of page) {
        if (filter?.limit !== undefined && n >= filter.limit) {
          return;
        }
        if (
          tags &&
          !Object.entries(tags).every(([k, v]) => item.tags[k] === v)
        ) {
          continue;
        }
        const state = await resolveState(sdk, item);
        if (filter?.state && state !== filter.state) {
          continue;
        }
        n++;
        yield infoOf(item, state);
      }
    },
    mapError: mapTogetherError,
    name: PROVIDER,
    templates,
    async verify() {
      const sdk = await getSdk();
      await sdk.sandboxes.list({ limit: 1 });
      return undefined;
    },
  };
  return provider;
});

// --------------------------------------------------------------------------
// templates
// --------------------------------------------------------------------------

function needsDockerfile(spec: TemplateSpec): boolean {
  return (
    (spec.env !== undefined && Object.keys(spec.env).length > 0) ||
    spec.workdir !== undefined ||
    spec.user !== undefined
  );
}

function templateRef(
  s: TSnapshot,
  alias: string | undefined,
  cacheKey: string | undefined
): TemplateRef {
  return {
    createdAt: new Date(s.created_at),
    id: s.id,
    provider: PROVIDER,
    raw: s,
    ...(alias ? { name: alias } : {}),
    ...(cacheKey ? { cacheKey } : {}),
  };
}

/** Dockerfile text plus the TemplateSpec env/workdir/user appended. */
export function renderDockerfile(spec: TemplateSpec): string {
  const { source } = spec;
  let text =
    "dockerfile" in source && source.dockerfile !== undefined
      ? source.dockerfile
      : `FROM ${"image" in source ? source.image : ""}`;
  if (!text.endsWith("\n")) {
    text += "\n";
  }
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    text += `ENV ${k}=${JSON.stringify(v)}\n`;
  }
  if (spec.workdir) {
    text += `WORKDIR ${spec.workdir}\n`;
  }
  if (spec.user) {
    text += `USER ${spec.user}\n`;
  }
  return text;
}

/** Remote build: materialize the context in a temp dir (Node only). */
async function buildFromContext(
  sdk: TClient,
  spec: TemplateSpec & { cacheKey: string; name: string },
  o: {
    alias: string;
    tags: Record<string, string>;
    onProgress: (e: { step: string; output: string }) => void;
  }
): Promise<string> {
  const [{ mkdtemp, mkdir, rm, writeFile }, { tmpdir }, { dirname, join }] =
    await Promise.all([
      import("node:fs/promises"),
      import("node:os"),
      import("node:path"),
    ]);
  const files = await loadTemplateContext(
    "context" in spec.source ? spec.source.context : undefined
  );
  const dir = await mkdtemp(join(tmpdir(), `${slug(spec.name)}-`));
  try {
    for (const [rel, data] of files) {
      const target = join(dir, rel);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    }
    const dockerfile = join(dir, ".sbox.Dockerfile");
    await writeFile(dockerfile, renderDockerfile(spec));
    const res = await sdk.snapshots.create({
      alias: o.alias,
      cacheKey: `sbox/${slug(spec.name)}`,
      context: dir,
      dockerfile,
      onProgress: o.onProgress,
      tags: o.tags,
    });
    return res.snapshotId;
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}
