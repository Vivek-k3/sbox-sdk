/**
 * `sbox-sdk/cloudflare` — adapter for `@cloudflare/sandbox` **0.12.x**.
 *
 * @deprecated Cloudflare Sandbox SDK 0.x gets bug and security fixes only
 * until 2026-12-31, and 1.0 removed this API. This adapter stays on 0.12.x;
 * a separate 1.0 adapter is planned. See
 * https://developers.cloudflare.com/sandbox/sdk/migrate/api-map/
 *
 * Cloudflare sandboxes run INSIDE a Worker against a Durable Object /
 * Container binding, so the factory takes the binding, and `create()` is
 * get-or-create by name (ids are names). The core stays fetch-only, no
 * `node:` imports.
 *
 * Usage (inside a Worker):
 * ```ts
 * import { createSandboxClient } from "sbox-sdk";
 * import { cloudflare } from "sbox-sdk/cloudflare";
 * const client = createSandboxClient({
 *   provider: cloudflare({ binding: env.Sandbox, sandboxOptions: { transport: "rpc" } }),
 * });
 * ```
 * Requires the optional peer dependency `@cloudflare/sandbox@0.12`, and you
 * must `export { Sandbox } from "@cloudflare/sandbox"` from your Worker entry.
 */
import type {
  CodeContext,
  DirectoryBackup,
  ExecutionSession,
  FileWatchSSEEvent,
  LogEvent,
  Sandbox as CFSandbox,
  SandboxOptions,
  TunnelInfo,
} from "@cloudflare/sandbox";

import {
  AsyncQueue,
  base64ToBytes,
  bytesToBase64,
  defineProvider,
  NotSupportedError,
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
  EgressPolicy,
  ExecOptions,
  FileInfo,
  FsEvent,
  KernelContext,
  OutputEvent,
  Preview,
  ProcessInfo,
  PtyOptions,
  ResolvedSandboxSpec,
  SandboxInfo,
  SandboxProvider,
  SandboxState,
  SnapshotOptions,
  SnapshotRef,
} from "../adapter/index.js";

type CFModule = typeof import("@cloudflare/sandbox");
/** Your `env.Sandbox` Durable Object namespace binding. */
type SandboxBinding = Parameters<CFModule["getSandbox"]>[0];
type ContainerStatus = Awaited<ReturnType<CFSandbox["getState"]>>;

export interface CloudflareOptions {
  /** The Durable Object namespace binding for your exported Sandbox class. */
  binding: SandboxBinding;
  /**
   * Options passed to every `getSandbox()` call (`transport`, `keepAlive`,
   * `normalizeId`, `containerTimeouts`, ...). Previews need
   * `transport: "rpc"` (or `SANDBOX_TRANSPORT=rpc`).
   */
  sandboxOptions?: SandboxOptions;
  /**
   * Previews use `sandbox.tunnels`. `false` (default) opens zero-config quick
   * tunnels on `*.trycloudflare.com`; `true` opens named tunnels on your zone
   * (needs `CLOUDFLARE_API_TOKEN` in the Worker env).
   */
  namedTunnels?: boolean;
  /** Directory `snapshot()` backs up to R2. Default `/workspace`. */
  snapshotDir?: string;
  /** Seconds before a snapshot (backup) is garbage-collected. SDK default 3 days. */
  snapshotTtlSeconds?: number;
  /** Store backups via the local R2 binding (for `wrangler dev`). */
  localBackups?: boolean;
  /**
   * @deprecated `exposePort()` was deprecated by Cloudflare on 2026-06-09;
   * previews now use `sandbox.tunnels` and ignore this option.
   */
  hostname?: string;
}

export const CLOUDFLARE_CAPS = {
  background: "native",
  codeInterpreter: "native",
  egressControl: "native",
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "native",
  fork: "unsupported",
  gpu: "unsupported",
  killProcess: "native",
  // Durable Objects are not enumerable.
  list: "unsupported",
  metrics: "unsupported",
  pause: "unsupported",
  privatePreview: "unsupported",
  proxiedFetch: "native",
  pty: "native",
  region: "unsupported",
  secretsVault: "unsupported",
  setTimeout: "native",
  snapshot: "native",
  ssh: "unsupported",
  statefulKernel: "native",
  stdin: "unsupported",
  stop: "native",
  streaming: "native",
  templateBuild: "unsupported",
  // `mountBucket` mounts an existing bucket; there is no create/list/delete.
  volumes: "unsupported",
} as const satisfies CapabilityMap;

export type CloudflareCaps = typeof CLOUDFLARE_CAPS;

const CLOUDFLARE_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true,
  preservesDiskOnStop: false,
  preservesMemoryOnPause: false,
  previewBrowserAuth: false,
  previewModel: "tunnel",
};

const PROVIDER = "cloudflare";
const DEFAULT_SNAPSHOT_DIR = "/workspace";

let cached: CFModule | null = null;
async function loadCF(): Promise<CFModule> {
  cached ??= await import("@cloudflare/sandbox");
  return cached;
}

let warned = false;
function warnDeprecated(): void {
  if (!warned) {
    warned = true;
    console.warn(
      "[sbox] sbox-sdk/cloudflare targets @cloudflare/sandbox 0.12.x, which gets fixes only until 2026-12-31. " +
        "See https://developers.cloudflare.com/sandbox/sdk/migrate/api-map/"
    );
  }
}

function cfErr(
  code: ConstructorParameters<typeof SandboxError>[0],
  message: string,
  cause?: unknown
): SandboxError {
  return new SandboxError(code, message, { cause, provider: PROVIDER });
}

// --------------------------------------------------------------------------
// status + errors
// --------------------------------------------------------------------------

/** Map the Container state onto `SandboxState`. */
export function mapCloudflareState(
  state: ContainerStatus | undefined
): SandboxState {
  switch (state?.status) {
    case "running":
    case "healthy": {
      return "running";
    }
    // The container's disk is discarded on stop; nothing is preserved.
    case "stopping":
    case "stopped": {
      return "stopped";
    }
    case "stopped_with_code": {
      return state.exitCode ? "error" : "stopped";
    }
    default: {
      return "unknown";
    }
  }
}

const NOT_FOUND_CODES = new Set([
  "FILE_NOT_FOUND",
  "PROCESS_NOT_FOUND",
  "TUNNEL_NOT_FOUND",
  "BACKUP_NOT_FOUND",
  "BACKUP_EXPIRED",
  "CONTEXT_NOT_FOUND",
  "WATCH_NOT_FOUND",
  "GIT_REPOSITORY_NOT_FOUND",
  "GIT_BRANCH_NOT_FOUND",
]);
const CONFLICT_CODES = new Set([
  "FILE_EXISTS",
  "SESSION_ALREADY_EXISTS",
  "PORT_ALREADY_EXPOSED",
  "PORT_IN_USE",
  "TUNNEL_ALREADY_RUNNING",
  "TUNNEL_RUN_CONFLICT",
  "RESOURCE_BUSY",
]);
const UNAUTHORIZED_CODES = new Set([
  "PERMISSION_DENIED",
  "COMMAND_PERMISSION_DENIED",
  "PROCESS_PERMISSION_DENIED",
  "GIT_AUTH_FAILED",
  "MISSING_CREDENTIALS",
]);
const VALIDATION_CODES = new Set([
  "VALIDATION_FAILED",
  "INVALID_COMMAND",
  "INVALID_PORT",
  "INVALID_PORT_NUMBER",
  "INVALID_BACKUP_CONFIG",
  "INVALID_MOUNT_CONFIG",
  "INVALID_GIT_URL",
]);

function prop<T>(e: unknown, key: string, type: string): T | undefined {
  if (e && typeof e === "object" && key in e) {
    const v = (e as Record<string, unknown>)[key];
    return typeof v === type ? (v as T) : undefined;
  }
  return undefined;
}

/**
 * Normalize `@cloudflare/sandbox` errors. Errors crossing the Durable Object
 * RPC boundary can lose their class and fields, so this falls back to the
 * message when `code` / `httpStatus` are gone.
 */
export function mapCloudflareError(e: unknown): SandboxError | undefined {
  if (e instanceof SandboxError) {
    return e;
  }
  const msg = e instanceof Error ? e.message : String(e);
  const status = prop<number>(e, "httpStatus", "number");
  const code = prop<string>(e, "code", "string");
  const init = (retryable?: boolean) => ({
    cause: e,
    provider: PROVIDER,
    retryable,
    status,
  });
  if (code && NOT_FOUND_CODES.has(code)) {
    return new SandboxError("NotFound", msg, init());
  }
  if (code && CONFLICT_CODES.has(code)) {
    return new SandboxError("Conflict", msg, init());
  }
  if (code && UNAUTHORIZED_CODES.has(code)) {
    return new SandboxError("Unauthorized", msg, init());
  }
  if (code && VALIDATION_CODES.has(code)) {
    return new SandboxError("Validation", msg, init());
  }
  if (code === "PROCESS_READY_TIMEOUT") {
    return new SandboxError("Timeout", msg, init());
  }
  if (
    code === "CONTAINER_UNAVAILABLE" ||
    code === "RPC_TRANSPORT_ERROR" ||
    code === "OPERATION_INTERRUPTED"
  ) {
    return new SandboxError("Provider", msg, init(true));
  }
  if (status === 401 || status === 403) {
    return new SandboxError("Unauthorized", msg, init());
  }
  if (status === 404) {
    return new SandboxError("NotFound", msg, init());
  }
  if (status === 409) {
    return new SandboxError("Conflict", msg, init());
  }
  if (status === 429) {
    return new SandboxError("QuotaExceeded", msg, init(true));
  }
  if (status === 408 || status === 504) {
    return new SandboxError("Timeout", msg, init());
  }
  if (/not ?found|no such file/i.test(msg)) {
    return new SandboxError("NotFound", msg, init());
  }
  if (/unauthori[sz]ed|forbidden|permission denied/i.test(msg)) {
    return new SandboxError("Unauthorized", msg, init());
  }
  if (/timed? ?out/i.test(msg)) {
    return new SandboxError("Timeout", msg, init());
  }
  return undefined;
}

const wrap = (e: unknown): SandboxError =>
  mapCloudflareError(e) ?? SandboxError.wrap(e, PROVIDER);

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

/** Seconds string for `sleepAfter`, which takes seconds (or "10m"). */
function toSleepAfter(ms: number): string {
  return `${Math.max(1, Math.ceil(ms / 1000))}s`;
}

/** `<backup id>:<dir>`, so a snapshot id alone is enough to restore. */
export function encodeBackupRef(b: DirectoryBackup): string {
  return `${b.id}:${b.dir}`;
}

export function decodeBackupRef(
  ref: string,
  fallbackDir: string,
  localBucket?: boolean
): DirectoryBackup {
  const i = ref.indexOf(":");
  const id = i === -1 ? ref : ref.slice(0, i);
  const dir = i === -1 ? fallbackDir : ref.slice(i + 1);
  return { dir, id, ...(localBucket ? { localBucket } : {}) };
}

/**
 * Apply an `EgressPolicy` through the Containers outbound proxy's runtime
 * host lists. Hostname-based only: CIDRs and credential injection are not
 * available on 0.12.
 */
export async function applyEgress(
  s: CFSandbox,
  policy: EgressPolicy
): Promise<void> {
  if (policy.inject?.length) {
    throw new NotSupportedError(PROVIDER, "network.inject");
  }
  if (policy.cidrs?.length || policy.deny?.cidrs?.length) {
    throw cfErr(
      "Validation",
      "Cloudflare egress filters by hostname; CIDR rules are not supported"
    );
  }
  const denied = policy.deny?.domains ?? [];
  const blockAll =
    policy.mode === "block-all" ||
    (policy.mode === "allow-list" && !policy.domains?.length);
  if (blockAll) {
    await s.setAllowedHosts([]);
    // A `*` deny overrides everything else in the outbound handler chain.
    await s.setDeniedHosts(["*"]);
    return;
  }
  await s.setAllowedHosts(
    policy.mode === "allow-all" ? ["*"] : (policy.domains ?? [])
  );
  await s.setDeniedHosts(denied);
}

function fsEventOf(ev: FileWatchSSEEvent): FsEvent | undefined {
  if (ev.type !== "event") {
    return undefined;
  }
  switch (ev.eventType) {
    case "create":
    case "move_to": {
      return { path: ev.path, type: "create" };
    }
    case "delete":
    case "move_from": {
      return { path: ev.path, type: "delete" };
    }
    case "modify":
    case "attrib": {
      return { path: ev.path, type: "modify" };
    }
    default: {
      return undefined;
    }
  }
}

function mapResult(r: CodeExecutionResult): {
  mime: Record<string, string>;
  text?: string;
} {
  const mime: Record<string, string> = {};
  const put = (v: string | undefined, mt: string): void => {
    if (typeof v === "string") {
      mime[mt] = v;
    }
  };
  put(r.text, "text/plain");
  put(r.html, "text/html");
  put(r.png, "image/png");
  put(r.jpeg, "image/jpeg");
  put(r.svg, "image/svg+xml");
  put(r.markdown, "text/markdown");
  put(r.latex, "text/latex");
  return { mime, ...(r.text === undefined ? {} : { text: r.text }) };
}
type CodeExecutionResult = Awaited<
  ReturnType<CFSandbox["runCode"]>
>["results"][number];

/** A Workers-runtime WebSocket from a `101 Switching Protocols` response. */
interface WorkersWebSocket extends WebSocket {
  accept(): void;
}
type UpgradeResponse = Response & { webSocket?: WorkersWebSocket | null };

const enc = new TextEncoder();

/** Drive the container PTY WebSocket (binary data, JSON control frames). */
async function openPty(
  session: ExecutionSession,
  o: PtyOptions
): Promise<DriverPty> {
  const res: UpgradeResponse = await session.terminal(
    new Request("http://localhost/ws/pty", {
      headers: { Upgrade: "websocket" },
    }),
    {
      ...(o.cols ? { cols: o.cols } : {}),
      ...(o.rows ? { rows: o.rows } : {}),
    }
  );
  const ws = res.webSocket;
  if (!ws) {
    throw cfErr(
      "Provider",
      `terminal() did not upgrade to a WebSocket (HTTP ${res.status})`
    );
  }
  ws.accept();
  const out = new AsyncQueue<Uint8Array>();
  let exitCode: number | undefined;
  let killed = false;
  let resolveExit!: (n: number) => void;
  const exited = new Promise<number>((r) => {
    resolveExit = r;
  });
  const finish = (code: number) => {
    if (exitCode === undefined) {
      exitCode = code;
      out.close();
      resolveExit(code);
    }
  };
  ws.addEventListener("message", (ev: MessageEvent) => {
    const { data } = ev;
    if (data instanceof ArrayBuffer) {
      out.push(new Uint8Array(data));
      return;
    }
    if (ArrayBuffer.isView(data)) {
      out.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      return;
    }
    if (typeof data === "string") {
      try {
        const msg = JSON.parse(data) as { type?: string; code?: unknown };
        if (msg.type === "exit") {
          finish(typeof msg.code === "number" ? msg.code : 1);
        }
        // "ready" / "error" are control frames, not terminal output
      } catch {
        out.push(enc.encode(data));
      }
    }
  });
  ws.addEventListener("close", () => finish(killed ? 130 : 1));
  if (o.cmd) {
    ws.send(enc.encode(`exec ${o.cmd}\n`));
  }
  return {
    id: session.id,
    async kill() {
      killed = true;
      ws.close();
      finish(130);
    },
    output: { [Symbol.asyncIterator]: () => out.iterator() },
    async resize(cols: number, rows: number) {
      ws.send(JSON.stringify({ cols, rows, type: "resize" }));
    },
    wait: () => exited,
    async write(data: Uint8Array) {
      ws.send(new Uint8Array(data));
    },
  };
}

// --------------------------------------------------------------------------
// provider
// --------------------------------------------------------------------------

/**
 * @deprecated Targets `@cloudflare/sandbox` 0.12.x, which gets fixes only
 * until 2026-12-31. A 1.0 adapter is planned. See
 * https://developers.cloudflare.com/sandbox/sdk/migrate/api-map/
 */
export const cloudflare = defineProvider<
  CloudflareCaps,
  CFSandbox,
  CloudflareOptions
>((opts) => {
  warnDeprecated();
  const snapshotDir = opts.snapshotDir ?? DEFAULT_SNAPSHOT_DIR;

  const getStub = async (
    id: string,
    extra?: SandboxOptions
  ): Promise<{ mod: CFModule; stub: CFSandbox }> => {
    const mod = await loadCF();
    const options = { ...opts.sandboxOptions, ...extra };
    const stub =
      Object.keys(options).length > 0
        ? mod.getSandbox(opts.binding, id, options)
        : mod.getSandbox(opts.binding, id);
    return { mod, stub };
  };

  const makeHandle = (
    mod: CFModule,
    stub: CFSandbox,
    id: string,
    metadata: Record<string, string> = {}
  ): DriverHandle<CFSandbox> => {
    const s = stub;
    const contexts = new Map<string, CodeContext>();

    /** Start a background process and stream its logs. */
    const startProcess = async (
      cmd: string,
      o: ExecOptions
    ): Promise<{ processId: string; queue: AsyncQueue<OutputEvent> }> => {
      const proc = await s.startProcess(cmd, {
        ...(o.cwd ? { cwd: o.cwd } : {}),
        ...(o.env ? { env: o.env } : {}),
        ...(o.timeoutMs ? { timeout: o.timeoutMs } : {}),
      });
      const queue = new AsyncQueue<OutputEvent>();
      const startedAt = Date.now();
      void (async () => {
        try {
          const stream = await s.streamProcessLogs(proc.id);
          for await (const ev of mod.parseSSEStream<LogEvent>(stream)) {
            if (ev.type === "stdout" || ev.type === "stderr") {
              if (ev.data) {
                queue.push({ data: ev.data, type: ev.type });
              }
            } else if (ev.type === "exit") {
              const code = ev.exitCode ?? 0;
              if (
                o.timeoutMs &&
                code !== 0 &&
                Date.now() - startedAt >= o.timeoutMs
              ) {
                queue.fail(
                  new SandboxError(
                    "Timeout",
                    `command timed out after ${o.timeoutMs}ms`,
                    { provider: PROVIDER, timedOut: true }
                  )
                );
                return;
              }
              queue.push({ exitCode: code, type: "exit" });
              queue.close();
              return;
            } else if (ev.type === "error") {
              throw cfErr("Provider", ev.data || "process failed");
            }
          }
          throw cfErr("Provider", "log stream ended without an exit event");
        } catch (error) {
          queue.fail(wrap(error));
        }
      })();
      return { processId: proc.id, queue };
    };

    const asProcess = (
      processId: string,
      queue: AsyncQueue<OutputEvent>
    ): DriverProcess => ({
      id: processId,
      async kill(signal?: string) {
        await s.killProcess(processId, signal);
      },
      pid: Promise.resolve(processId),
      [Symbol.asyncIterator]: () => queue.iterator(),
    });

    const tunnelOptions = (port: number) =>
      opts.namedTunnels
        ? {
            name: `p${port}-${id}`
              .toLowerCase()
              .replaceAll(/[^a-z0-9-]+/g, "-")
              .slice(0, 63)
              .replace(/-+$/, ""),
          }
        : undefined;
    const tunnelPreview = (t: TunnelInfo): Preview => ({
      auth: { type: "public" },
      port: t.port,
      url: t.url,
    });

    return {
      async connectProcess(processId: string): Promise<DriverProcess> {
        const proc = await s.getProcess(processId);
        if (!proc) {
          throw cfErr("NotFound", `no process ${processId}`);
        }
        const queue = new AsyncQueue<OutputEvent>();
        void (async () => {
          try {
            const stream = await s.streamProcessLogs(processId);
            for await (const ev of mod.parseSSEStream<LogEvent>(stream)) {
              if (ev.type === "stdout" || ev.type === "stderr") {
                queue.push({ data: ev.data, type: ev.type });
              } else if (ev.type === "exit") {
                queue.push({ exitCode: ev.exitCode ?? 0, type: "exit" });
                break;
              }
            }
            queue.close();
          } catch (error) {
            queue.fail(wrap(error));
          }
        })();
        return asProcess(processId, queue);
      },

      async connectPty(ptyId: string): Promise<DriverPty> {
        return openPty(await s.getSession(ptyId), {});
      },

      async createContext(o: {
        language?: string;
        cwd?: string;
      }): Promise<KernelContext> {
        const language = o.language ?? "python";
        if (
          language !== "python" &&
          language !== "javascript" &&
          language !== "typescript"
        ) {
          throw cfErr(
            "Validation",
            `unsupported kernel language '${language}'`
          );
        }
        const c = await s.createCodeContext({
          language,
          ...(o.cwd ? { cwd: o.cwd } : {}),
        });
        contexts.set(c.id, c);
        return { id: c.id, language: c.language };
      },

      async createPty(o: PtyOptions): Promise<DriverPty> {
        const session = await s.createSession({
          ...(o.cwd ? { cwd: o.cwd } : {}),
          ...(o.env ? { env: o.env } : {}),
        });
        return openPty(session, o);
      },

      async destroy(): Promise<void> {
        await s.destroy();
      },

      exec(cmd: string, o: ExecOptions): DriverExec {
        // A background process (not the buffered exec) so kill() really kills.
        const started = startProcess(cmd, o);
        started.catch(() => {
          /* surfaced through the iterator */
        });
        o.signal?.addEventListener(
          "abort",
          () => {
            void started
              .then((p) => s.killProcess(p.processId))
              .catch(() => {});
          },
          { once: true }
        );
        return {
          async kill(signal?: string) {
            const { processId } = await started;
            await s.killProcess(processId, signal);
          },
          pid: started.then((p) => p.processId).catch(() => ""),
          async *[Symbol.asyncIterator]() {
            let queue: AsyncQueue<OutputEvent>;
            try {
              ({ queue } = await started);
            } catch (error) {
              throw wrap(error);
            }
            yield* queue.iterator();
          },
        };
      },

      async exposePort(port: number): Promise<Preview> {
        const options = tunnelOptions(port);
        const t = options
          ? await s.tunnels.get(port, options)
          : await s.tunnels.get(port);
        return tunnelPreview(t);
      },

      async getInfo(): Promise<SandboxInfo> {
        const state = await s.getState();
        return {
          id,
          metadata,
          name: id,
          provider: PROVIDER,
          raw: state,
          state: mapCloudflareState(state),
        };
      },

      id,

      async killProcess(processId: string, signal: string | undefined) {
        await s.killProcess(processId, signal);
      },

      async listDir(path: string): Promise<DirEntry[]> {
        const r = await s.listFiles(path, { includeHidden: true });
        return r.files.map((f) => ({
          name: f.name,
          path: f.absolutePath,
          type:
            f.type === "directory"
              ? "dir"
              : f.type === "symlink"
                ? "symlink"
                : "file",
        }));
      },

      async listPorts(): Promise<Preview[]> {
        return (await s.tunnels.list()).map(tunnelPreview);
      },

      async listProcesses(): Promise<ProcessInfo[]> {
        return (await s.listProcesses())
          .filter((p) => p.status === "running" || p.status === "starting")
          .map((p) => ({ cmd: p.command, id: p.id }));
      },

      async mkdir(path: string, recursive: boolean): Promise<void> {
        await s.mkdir(path, { recursive });
      },

      name: id,

      proxyFetch(
        port: number,
        path: string | undefined,
        init: RequestInit | undefined
      ): Promise<Response> {
        const url = `http://localhost:${port}${path ?? "/"}`;
        return s.containerFetch(url, init ?? {}, port);
      },

      raw: stub,

      async readFile(path: string): Promise<Uint8Array> {
        // base64 is byte-exact for text and binary alike.
        const r = await s.readFile(path, { encoding: "base64" });
        return r.encoding === "utf-8"
          ? enc.encode(r.content)
          : base64ToBytes(r.content);
      },

      async rename(from: string, to: string): Promise<void> {
        await s.renameFile(from, to);
      },

      async restoreSnapshot(ref: string): Promise<void> {
        await s.restoreBackup(
          decodeBackupRef(ref, snapshotDir, opts.localBackups)
        );
      },

      async runCode(
        code: string,
        o: { context?: KernelContext; language?: string }
      ): Promise<CodeExecution> {
        const context = o.context ? contexts.get(o.context.id) : undefined;
        if (o.context && !context) {
          throw cfErr("NotFound", `no code context ${o.context.id}`);
        }
        const language = o.language;
        if (
          language !== undefined &&
          language !== "python" &&
          language !== "javascript" &&
          language !== "typescript"
        ) {
          throw cfErr("Validation", `unsupported language '${language}'`);
        }
        const exec = await s.runCode(code, {
          ...(context ? { context } : {}),
          ...(language ? { language } : {}),
        });
        return {
          ...(exec.error
            ? {
                error: {
                  name: exec.error.name,
                  value: exec.error.message,
                  ...(exec.error.traceback
                    ? { traceback: exec.error.traceback.join("\n") }
                    : {}),
                },
              }
            : {}),
          logs: { stderr: exec.logs.stderr, stdout: exec.logs.stdout },
          results: exec.results.map(mapResult),
        };
      },

      async setEgressPolicy(policy: EgressPolicy): Promise<void> {
        await applyEgress(s, policy);
      },

      async setTimeout(ttlMs: number): Promise<void> {
        // `sleepAfter` is an idle timeout, in seconds.
        await s.setSleepAfter(toSleepAfter(ttlMs));
      },

      async snapshot(o: SnapshotOptions): Promise<SnapshotRef> {
        const backup = await s.createBackup({
          dir: snapshotDir,
          ...(o.name ? { name: o.name } : {}),
          ...(opts.snapshotTtlSeconds ? { ttl: opts.snapshotTtlSeconds } : {}),
          ...(opts.localBackups ? { localBucket: true } : {}),
        });
        return {
          createdAt: new Date(),
          id: encodeBackupRef(backup),
          includesMemory: false,
          provider: PROVIDER,
          raw: backup,
          ...(o.name ? { name: o.name } : {}),
        };
      },

      async spawn(cmd: string, o: ExecOptions): Promise<DriverProcess> {
        const { processId, queue } = await startProcess(cmd, o);
        return asProcess(processId, queue);
      },

      async stat(path: string): Promise<FileInfo> {
        const trimmed = path.replace(/\/+$/, "") || "/";
        if (trimmed === "/") {
          return { path: "/", size: 0, type: "dir" };
        }
        const i = trimmed.lastIndexOf("/");
        const parent = i <= 0 ? "/" : trimmed.slice(0, i);
        const base = trimmed.slice(i + 1);
        const r = await s.listFiles(parent, { includeHidden: true });
        const f = r.files.find((x) => x.name === base);
        if (!f) {
          throw cfErr("NotFound", `not found: '${path}'`);
        }
        return {
          mtime: new Date(f.modifiedAt),
          path: f.absolutePath,
          size: f.size,
          type:
            f.type === "directory"
              ? "dir"
              : f.type === "symlink"
                ? "symlink"
                : "file",
        };
      },

      async stop(): Promise<void> {
        await s.stop();
      },

      async resume(): Promise<void> {
        // Cloudflare containers start on their next request; a trivial exec
        // wakes a stopped container so resume() returns once it is running.
        await s.exec("true");
      },

      async unexposePort(port: number): Promise<void> {
        await s.tunnels.destroy(port);
      },

      async watch(path: string, cb: (e: FsEvent) => void, recursive: boolean) {
        const stream = await s.watch(path, { recursive });
        const ac = new AbortController();
        void (async () => {
          try {
            for await (const ev of mod.parseSSEStream<FileWatchSSEEvent>(
              stream,
              ac.signal
            )) {
              const e = fsEventOf(ev);
              if (e) {
                cb(e);
              }
              if (ev.type === "stopped") {
                return;
              }
            }
          } catch {
            /* stream closed */
          }
        })();
        return async () => {
          ac.abort();
          await stream.cancel().catch(() => {});
        };
      },

      async writeFile(path: string, data: Uint8Array): Promise<void> {
        await s.writeFile(path, bytesToBase64(data), { encoding: "base64" });
      },
    };
  };

  /** Configure a freshly obtained stub from the spec, and boot it. */
  const prepare = async (
    spec: ResolvedSandboxSpec,
    id: string,
    restore: boolean
  ): Promise<DriverHandle<CFSandbox>> => {
    if (spec.template) {
      throw cfErr(
        "Validation",
        "Cloudflare sandboxes take their image from wrangler config; `template` is not supported"
      );
    }
    if (spec.region) {
      throw cfErr(
        "Validation",
        "Cloudflare places containers itself; `region` is not supported"
      );
    }
    if (spec.volumes?.length) {
      throw cfErr(
        "Validation",
        "Cloudflare 0.12 has no volumes; mount a bucket with raw().mountBucket()"
      );
    }
    if (spec.resources?.gpu || spec.resources?.gpuCount) {
      throw cfErr("Validation", "Cloudflare containers have no GPUs");
    }
    const lc = spec.lifecycle;
    const idle = lc?.idleTimeoutMs ?? lc?.maxAgeMs ?? spec.ttlMs;
    const metadata = spec.metadata ?? {};
    const { mod, stub } = await getStub(id, {
      ...(Object.keys(metadata).length > 0 ? { labels: metadata } : {}),
      ...(idle === undefined ? {} : { sleepAfter: toSleepAfter(idle) }),
    });
    const env: Record<string, string> = { ...spec.env };
    for (const sec of spec.secrets ?? []) {
      if ((sec.mode ?? "env") === "egress") {
        throw new NotSupportedError(PROVIDER, "secrets (mode: egress)");
      }
      if (sec.value === undefined) {
        throw cfErr(
          "Validation",
          `secret '${sec.name}' needs a value: Cloudflare has no secret vault`
        );
      }
      env[sec.envVar ?? sec.name] = sec.value;
    }
    if (Object.keys(env).length > 0) {
      await stub.setEnvVars(env);
    }
    if (spec.network) {
      await applyEgress(stub, spec.network);
    }
    // Boot the container now so create() reports a running sandbox.
    await stub.exec("true");
    if (restore && spec.fromSnapshot) {
      await stub.restoreBackup(
        decodeBackupRef(spec.fromSnapshot, snapshotDir, opts.localBackups)
      );
    }
    return makeHandle(mod, stub, id, metadata);
  };

  const provider: SandboxProvider<CloudflareCaps, CFSandbox> = {
    capabilities: CLOUDFLARE_CAPS,

    async connect(id: string): Promise<DriverHandle<CFSandbox>> {
      const { mod, stub } = await getStub(id);
      return makeHandle(mod, stub, id);
    },

    async create(
      spec: ResolvedSandboxSpec,
      ctx: CallContext
    ): Promise<DriverHandle<CFSandbox>> {
      // get-or-create: the id IS the name. Use idempotencyKey so retries hit
      // the same Durable Object instead of orphaning a new one.
      const id =
        spec.name ?? ctx.idempotencyKey ?? globalThis.crypto.randomUUID();
      return prepare(spec, id, true);
    },

    flags: CLOUDFLARE_FLAGS,

    async getOrCreate(spec): Promise<DriverHandle<CFSandbox>> {
      const { stub } = await getStub(spec.name);
      const state = await stub.getState();
      // Only restore a snapshot into a sandbox that wasn't already running.
      return prepare(spec, spec.name, mapCloudflareState(state) !== "running");
    },

    mapError: mapCloudflareError,
    name: PROVIDER,

    /**
     * There is no account API to call: the Durable Object binding is the
     * credential, and touching a stub would instantiate a sandbox. This
     * checks the SDK loads and the binding is a Durable Object namespace.
     */
    async verify(): Promise<{ account?: string } | undefined> {
      await loadCF();
      const ns: unknown = opts.binding;
      if (
        !ns ||
        typeof ns !== "object" ||
        typeof (ns as { idFromName?: unknown }).idFromName !== "function"
      ) {
        throw cfErr(
          "Unauthorized",
          "`binding` is not a Durable Object namespace (pass env.Sandbox)"
        );
      }
      return undefined;
    },
  };
  return provider;
});
