/**
 * `sbox-sdk/sprites` — adapter for Fly.io Sprites (`@fly/sprites`).
 *
 * Sprites are named, persistent Firecracker VMs that pause on their own when
 * idle (warm = memory kept, cold = disk only) and wake on the next exec, file
 * call or URL request. The adapter addresses a sprite by its NAME, so
 * `sandbox.id` is the sprite name and `getOrCreate` is native.
 *
 * The SDK needs Node >= 24, so it is imported lazily inside create/connect.
 * Requires the optional peer dependency `@fly/sprites`.
 */
import type { Readable } from "node:stream";

import type {
  Checkpoint,
  FilesystemWatchEvent,
  NetworkPolicy,
  PolicyRule,
  Sprite,
  SpriteCommand,
  SpriteConfig,
  SpriteInfo,
  SpritesClient,
} from "@fly/sprites";

import { AsyncQueue, defineProvider, SandboxError } from "../adapter/index.js";
import type {
  CallContext,
  CapabilityFlags,
  CapabilityMap,
  DirEntry,
  DriverExec,
  DriverHandle,
  DriverProcess,
  DriverPty,
  EgressPolicy,
  ExecOptions,
  FileBody,
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
  SandboxState,
  SnapshotOptions,
  SnapshotRef,
} from "../adapter/index.js";

export interface SpritesOptions {
  /** Sprites API token (`SPRITES_TOKEN`). */
  token: string;
  /** API base URL. Defaults to `https://api.sprites.dev`. */
  baseURL?: string;
  /** Default runtime image for new sprites. `spec.template` overrides it. */
  runtime?: "default" | "dev";
  /** Wait for capacity instead of failing fast when the org is at its limit. */
  waitForCapacity?: boolean;
  /** HTTP request timeout for API calls, in ms. SDK default: 30000. */
  timeoutMs?: number;
}

export const SPRITES_CAPS = {
  background: "native",
  codeInterpreter: "unsupported",
  egressControl: "native",
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "native",
  fork: "unsupported",
  gpu: "unsupported",
  killProcess: "native",
  list: "native",
  metrics: "unsupported",
  pause: "unsupported",
  privatePreview: "native",
  proxiedFetch: "unsupported",
  pty: "native",
  region: "native",
  secretsVault: "unsupported",
  setTimeout: "unsupported",
  snapshot: "native",
  ssh: "unsupported",
  statefulKernel: "unsupported",
  stdin: "native",
  stop: "unsupported",
  streaming: "native",
  templateBuild: "unsupported",
  volumes: "unsupported",
} as const satisfies CapabilityMap;

export type SpritesCaps = typeof SPRITES_CAPS;

const SPRITES_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true,
  preservesDiskOnStop: true,
  preservesMemoryOnPause: true,
  previewBrowserAuth: false,
  previewModel: "subdomain",
  resumeChangesId: false,
  templateSources: [],
};

export type SpritesRaw = Sprite;

const PROVIDER = "sprites";
/** Metadata key the core uses for named sandboxes. */
const NAME_KEY = "sbox-name";
/** Port the sprite URL routes to unless something else opened first. */
const DEFAULT_HTTP_PORT = 8080;

// --------------------------------------------------------------------------
// lazy module loader (memoized; @fly/sprites needs Node >= 24)
// --------------------------------------------------------------------------

type Mod = typeof import("@fly/sprites");
let cachedMod: Promise<Mod> | undefined;
function loadSprites(): Promise<Mod> {
  cachedMod ??= import("@fly/sprites");
  return cachedMod;
}

// --------------------------------------------------------------------------
// errors
// --------------------------------------------------------------------------

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === "object" && "statusCode" in err) {
    const s = (err as { statusCode?: unknown }).statusCode;
    if (typeof s === "number") {
      return s;
    }
  }
  if (err instanceof Error) {
    const m = /status (\d{3})/.exec(err.message);
    if (m) {
      return Number(m[1]);
    }
  }
  return undefined;
}

/** Normalize `@fly/sprites` errors (APIError, FilesystemError, plain Error). */
export function mapSpritesError(err: unknown): SandboxError | undefined {
  if (err instanceof SandboxError) {
    return err;
  }
  if (!(err instanceof Error)) {
    return undefined;
  }
  const opts = { cause: err, provider: PROVIDER };
  if (err.name === "AbortError" || err.name === "TimeoutError") {
    return new SandboxError("Timeout", err.message, opts);
  }
  // FilesystemError: errno-style code + path.
  const fsCode =
    err.name === "FilesystemError" && "code" in err
      ? String((err as { code: unknown }).code)
      : undefined;
  if (fsCode === "ENOENT") {
    return new SandboxError("NotFound", err.message, opts);
  }
  if (fsCode === "EEXIST") {
    return new SandboxError("Conflict", err.message, opts);
  }
  const apiCode =
    "errorCode" in err ? (err as { errorCode?: unknown }).errorCode : undefined;
  if (
    apiCode === "concurrent_sprite_limit_exceeded" ||
    apiCode === "sprite_creation_rate_limited"
  ) {
    return new SandboxError("QuotaExceeded", err.message, {
      ...opts,
      retryable: true,
      status: statusOf(err),
    });
  }
  const status = statusOf(err);
  if (status === undefined) {
    if (fsCode) {
      return new SandboxError("Provider", err.message, opts);
    }
    return undefined;
  }
  const withStatus = { ...opts, status };
  if (status === 401 || status === 403) {
    return new SandboxError("Unauthorized", err.message, withStatus);
  }
  if (status === 404) {
    return new SandboxError("NotFound", err.message, withStatus);
  }
  if (status === 409) {
    return new SandboxError("Conflict", err.message, withStatus);
  }
  if (status === 429) {
    return new SandboxError("QuotaExceeded", err.message, {
      ...withStatus,
      retryable: true,
    });
  }
  if (status === 408 || status === 504) {
    return new SandboxError("Timeout", err.message, withStatus);
  }
  if (status === 400 || status === 422) {
    return new SandboxError("Validation", err.message, withStatus);
  }
  return new SandboxError("Provider", err.message, {
    ...withStatus,
    retryable: status >= 500,
  });
}

function wrap(err: unknown): SandboxError {
  return mapSpritesError(err) ?? SandboxError.wrap(err, PROVIDER);
}

function validation(message: string): SandboxError {
  return new SandboxError("Validation", message, { provider: PROVIDER });
}

// --------------------------------------------------------------------------
// pure mappers (exported for tests)
// --------------------------------------------------------------------------

/** Sprite status → SandboxState. warm keeps memory, cold keeps only disk. */
export function mapSpriteStatus(status: string | undefined): SandboxState {
  switch (status) {
    case "running": {
      return "running";
    }
    case "warm": {
      return "paused";
    }
    case "cold": {
      return "stopped";
    }
    default: {
      return "unknown";
    }
  }
}

/** Metadata → sprite labels (`key=value`, both percent-encoded). */
export function encodeLabels(metadata: Record<string, string>): string[] {
  return Object.entries(metadata).map(
    ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
  );
}

/** Sprite labels → metadata. Labels without `=` map to an empty value. */
export function decodeLabels(
  labels: readonly string[] | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const label of labels ?? []) {
    const i = label.indexOf("=");
    const k = i === -1 ? label : label.slice(0, i);
    const v = i === -1 ? "" : label.slice(i + 1);
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** EgressPolicy → Sprites DNS-based network policy. */
export function toNetworkPolicy(policy: EgressPolicy): NetworkPolicy {
  if (policy.inject && policy.inject.length > 0) {
    throw validation(
      "egress credential injection is not supported; use Sprites Connectors directly"
    );
  }
  const cidrs = [...(policy.cidrs ?? []), ...(policy.deny?.cidrs ?? [])];
  if (cidrs.length > 0) {
    throw validation(
      "Sprites network policy is DNS-based and cannot match CIDRs"
    );
  }
  const deny: PolicyRule[] = (policy.deny?.domains ?? []).map((domain) => ({
    action: "deny",
    domain,
  }));
  switch (policy.mode) {
    case "allow-all": {
      return deny.length > 0
        ? { rules: [...deny, { action: "allow", domain: "*" }] }
        : { rules: [] };
    }
    case "block-all": {
      return { rules: [{ action: "deny", domain: "*" }] };
    }
    case "allow-list": {
      const allow: PolicyRule[] = (policy.domains ?? []).map((domain) => ({
        action: "allow",
        domain,
      }));
      return { rules: [...deny, ...allow, { action: "deny", domain: "*" }] };
    }
    default: {
      throw validation(`unknown egress mode ${String(policy.mode)}`);
    }
  }
}

export interface CreateArgs {
  name: string;
  options: {
    config?: SpriteConfig;
    environment?: Record<string, string>;
    labels?: string[];
    runtime?: "default" | "dev";
    waitForCapacity?: boolean;
  };
}

/** ResolvedSandboxSpec → `createSprite(name, options)` arguments. */
export function toCreateArgs(
  spec: ResolvedSandboxSpec,
  name: string,
  opts: Pick<SpritesOptions, "runtime" | "waitForCapacity">
): CreateArgs {
  if (spec.fromSnapshot) {
    throw validation(
      "a Sprites checkpoint cannot seed a new sprite; restore it in place with snapshots.restore()"
    );
  }
  if (spec.volumes && spec.volumes.length > 0) {
    throw validation("Sprites has no attachable volumes");
  }
  if (spec.resources?.gpu || spec.resources?.gpuCount) {
    throw validation("Sprites has no GPUs");
  }
  let runtime = opts.runtime;
  if (spec.template !== undefined) {
    if (spec.template !== "default" && spec.template !== "dev") {
      throw validation(
        `Sprites has no custom images; template must be "default" or "dev" (got ${JSON.stringify(spec.template)})`
      );
    }
    runtime = spec.template;
  }
  const environment: Record<string, string> = { ...spec.env };
  for (const secret of spec.secrets ?? []) {
    if (secret.mode === "egress") {
      throw validation(
        "egress-injected secrets are not supported; use Sprites Connectors"
      );
    }
    if (secret.value === undefined) {
      throw validation(
        `Sprites has no secret store; pass secret '${secret.name}' with an inline value`
      );
    }
    environment[secret.envVar ?? secret.name] = secret.value;
  }
  const config: SpriteConfig = {};
  const r = spec.resources;
  if (r?.vcpus !== undefined) {
    config.cpus = r.vcpus;
  }
  if (r?.memoryMB !== undefined) {
    config.ramMB = r.memoryMB;
  }
  if (r?.diskMB !== undefined) {
    config.storageGB = Math.ceil(r.diskMB / 1024);
  }
  if (spec.region) {
    config.region = spec.region;
  }
  const metadata: Record<string, string> = { ...spec.metadata };
  if (spec.name) {
    metadata[NAME_KEY] = spec.name;
  }
  const labels = encodeLabels(metadata);
  return {
    name,
    options: {
      ...(Object.keys(config).length > 0 ? { config } : {}),
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
      ...(labels.length > 0 ? { labels } : {}),
      ...(runtime ? { runtime } : {}),
      ...(opts.waitForCapacity === undefined
        ? {}
        : { waitForCapacity: opts.waitForCapacity }),
    },
  };
}

/** Deterministic sprite name from an idempotency key (retries reuse it). */
export async function nameFromKey(key: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key)
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sbox-${hex.slice(0, 16)}`;
}

function toInfo(s: SpriteInfo | Sprite): SandboxInfo {
  const metadata = decodeLabels(s.labels);
  return {
    createdAt: s.createdAt,
    id: s.name,
    metadata,
    name: metadata[NAME_KEY] ?? s.name,
    provider: PROVIDER,
    raw: s,
    state: mapSpriteStatus(s.status),
  };
}

async function toBytes(body: FileBody): Promise<Uint8Array> {
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function mapWatchEvent(e: FilesystemWatchEvent): FsEvent | undefined {
  if (e.type !== "event" || !e.path) {
    return undefined;
  }
  switch (e.event) {
    case "create": {
      return { path: e.path, type: "create" };
    }
    case "remove": {
      return { path: e.path, type: "delete" };
    }
    case "write":
    case "chmod":
    case "rename": {
      return { path: e.path, type: "modify" };
    }
    default: {
      return undefined;
    }
  }
}

/** Wait until a SpriteCommand's WebSocket is open (or fails to open). */
function whenSpawned(cmd: SpriteCommand): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => {
      cmd.off("error", onError);
      resolve();
    };
    const onError = (err: unknown): void => {
      cmd.off("spawn", onSpawn);
      reject(err);
    };
    cmd.once("spawn", onSpawn);
    cmd.once("error", onError);
  });
}

function ended(stream: Readable): Promise<void> {
  return new Promise<void>((resolve) => {
    if (stream.readableEnded) {
      resolve();
      return;
    }
    stream.once("end", () => resolve());
    stream.once("close", () => resolve());
  });
}

/** Bridge a SpriteCommand into the core's DriverExec event stream. */
function bridgeCommand(
  cmd: SpriteCommand,
  id: string,
  onDone?: () => void
): DriverExec & { ready: Promise<void> } {
  const q = new AsyncQueue<OutputEvent>();
  const ready = whenSpawned(cmd);
  const outDec = new TextDecoder();
  const errDec = new TextDecoder();
  cmd.stdout.on("data", (chunk: Uint8Array) => {
    const data = outDec.decode(chunk, { stream: true });
    if (data) {
      q.push({ data, type: "stdout" });
    }
  });
  cmd.stderr.on("data", (chunk: Uint8Array) => {
    const data = errDec.decode(chunk, { stream: true });
    if (data) {
      q.push({ data, type: "stderr" });
    }
  });
  let settled = false;
  const finish = (exitCode: number): void => {
    if (settled) {
      return;
    }
    settled = true;
    const tailOut = outDec.decode();
    const tailErr = errDec.decode();
    if (tailOut) {
      q.push({ data: tailOut, type: "stdout" });
    }
    if (tailErr) {
      q.push({ data: tailErr, type: "stderr" });
    }
    q.push({ exitCode, type: "exit" });
    q.close();
    onDone?.();
  };
  cmd.on("error", (err: unknown) => {
    if (!settled) {
      settled = true;
      q.fail(wrap(err));
      onDone?.();
    }
  });
  // Output can still be draining when `exit` fires: wait for both streams.
  void Promise.all([cmd.wait(), ended(cmd.stdout), ended(cmd.stderr)]).then(
    ([code]) => finish(code)
  );
  ready.catch(() => {
    /* surfaced through the queue via the 'error' listener */
  });
  return {
    [Symbol.asyncIterator]: () => q.iterator(),
    async kill(signal?: string) {
      await ready.catch(() => undefined);
      if (settled) {
        return;
      }
      cmd.kill(signal ?? "SIGKILL");
      // If the remote never reports an exit, close the socket ourselves.
      const timer = setTimeout(() => {
        if (!settled) {
          cmd.close();
          finish(137);
        }
      }, 5000);
      timer.unref?.();
    },
    pid: Promise.resolve(id),
    ready,
    async writeStdin(data: Uint8Array) {
      await ready;
      cmd.stdin.write(data);
    },
  };
}

// --------------------------------------------------------------------------
// provider
// --------------------------------------------------------------------------

export const sprites = defineProvider(
  (opts: SpritesOptions): SandboxProvider<SpritesCaps, SpritesRaw> => {
    let clientP: Promise<SpritesClient> | undefined;
    const getClient = (): Promise<SpritesClient> => {
      clientP ??= loadSprites().then(
        (m) =>
          new m.SpritesClient(opts.token, {
            ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
            ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
          })
      );
      return clientP;
    };

    const makeHandle = (
      client: SpritesClient,
      sprite: Sprite
    ): DriverHandle<SpritesRaw> => {
      const { name } = sprite;
      const fs = (): ReturnType<Sprite["filesystem"]> => sprite.filesystem("/");
      let counter = 0;
      const procs = new Map<string, { cmd: SpriteCommand; line: string }>();
      const ptys = new Map<string, DriverPty>();
      let exposedPort = DEFAULT_HTTP_PORT;

      const startCommand = (
        line: string,
        execOpts: ExecOptions,
        id: string,
        track: boolean
      ): DriverProcess => {
        const cmd = sprite.spawn("sh", ["-c", line], {
          ...(execOpts.cwd ? { cwd: execOpts.cwd } : {}),
          ...(execOpts.env && Object.keys(execOpts.env).length > 0
            ? { env: execOpts.env }
            : {}),
        });
        if (track) {
          procs.set(id, { cmd, line });
        }
        const bridge = bridgeCommand(cmd, id, () => procs.delete(id));
        if (execOpts.signal) {
          const onAbort = (): void => void bridge.kill("SIGKILL");
          if (execOpts.signal.aborted) {
            onAbort();
          } else {
            execOpts.signal.addEventListener("abort", onAbort, { once: true });
          }
        }
        return { ...bridge, id };
      };

      const wrapPty = (
        cmd: SpriteCommand,
        initialId: string
      ): {
        pty: DriverPty;
        setId: (id: string) => void;
        ready: Promise<void>;
      } => {
        let id = initialId;
        const out = new AsyncQueue<Uint8Array>();
        const ready = whenSpawned(cmd);
        cmd.stdout.on("data", (chunk: Uint8Array) =>
          out.push(new Uint8Array(chunk))
        );
        cmd.on("error", (err: unknown) => out.fail(wrap(err)));
        const exited = cmd.wait().then((code) => {
          out.close();
          ptys.delete(id);
          return code;
        });
        const pty: DriverPty = {
          get id() {
            return id;
          },
          async kill() {
            await ready.catch(() => undefined);
            if (!id.startsWith("local-")) {
              try {
                const stream = await sprite.killSession(id, "SIGKILL");
                for await (const _ev of stream) {
                  // drain progress events
                }
              } catch {
                // fall through to closing the socket
              }
            }
            cmd.kill("SIGKILL");
            cmd.close();
          },
          output: { [Symbol.asyncIterator]: () => out.iterator() },
          async resize(cols: number, rows: number) {
            await ready;
            cmd.resize(cols, rows);
          },
          wait: () => exited,
          async write(data: Uint8Array) {
            await ready;
            cmd.stdin.write(data);
          },
        };
        return {
          pty,
          ready,
          setId: (next: string) => {
            ptys.delete(id);
            id = next;
            ptys.set(id, pty);
          },
        };
      };

      const handle: DriverHandle<SpritesRaw> = {
        async connectPty(id: string): Promise<DriverPty> {
          const live = ptys.get(id);
          if (live) {
            return live;
          }
          const cmd = sprite.attachSession(id);
          const w = wrapPty(cmd, id);
          ptys.set(id, w.pty);
          await w.ready;
          return w.pty;
        },
        async createPty(popts: PtyOptions): Promise<DriverPty> {
          const before = new Set(
            (await sprite.listSessions()).map((s) => s.id)
          );
          const program = popts.cmd ?? "bash";
          const args = popts.cmd ? [] : ["-l"];
          const cmd = sprite.createSession(
            popts.cmd ? "sh" : program,
            popts.cmd ? ["-c", program] : args,
            {
              ...(popts.cols ? { cols: popts.cols } : {}),
              ...(popts.rows ? { rows: popts.rows } : {}),
              ...(popts.cwd ? { cwd: popts.cwd } : {}),
              ...(popts.env ? { env: popts.env } : {}),
            }
          );
          const local = `local-${++counter}`;
          const w = wrapPty(cmd, local);
          ptys.set(local, w.pty);
          let serverId: string | undefined;
          cmd.on("message", (msg: unknown) => {
            if (
              msg &&
              typeof msg === "object" &&
              (msg as { type?: unknown }).type === "session_info"
            ) {
              const m = msg as {
                session_id?: unknown;
                id?: unknown;
                sessionId?: unknown;
              };
              const sid = m.session_id ?? m.sessionId ?? m.id;
              if (sid !== undefined && serverId === undefined) {
                serverId = String(sid);
              }
            }
          });
          await w.ready;
          // Prefer the server's session_info; otherwise diff the session list.
          for (let i = 0; i < 6 && serverId === undefined; i++) {
            const added = (await sprite.listSessions()).find(
              (s) => !before.has(s.id)
            );
            if (added) {
              serverId = added.id;
              break;
            }
            await new Promise((r) => setTimeout(r, 250));
          }
          if (serverId !== undefined) {
            w.setId(serverId);
          }
          return w.pty;
        },
        async destroy() {
          for (const { cmd } of procs.values()) {
            cmd.close();
          }
          try {
            await client.deleteSprite(name);
          } catch (error) {
            const mapped = wrap(error);
            if (mapped.code !== "NotFound") {
              throw mapped;
            }
          }
        },
        exec: (cmd: string, execOpts: ExecOptions): DriverExec =>
          startCommand(cmd, execOpts, `exec-${++counter}`, false),
        async exposePort(
          port: number,
          eopts: { private?: boolean }
        ): Promise<Preview> {
          const auth = eopts.private ? "sprite" : "public";
          await sprite.updateURLSettings({ auth });
          const fresh = await client.getSprite(name);
          if (!fresh.url) {
            throw new SandboxError(
              "Provider",
              `sprite ${name} has no URL yet`,
              { provider: PROVIDER }
            );
          }
          exposedPort = port;
          return {
            auth: eopts.private
              ? {
                  headers: { Authorization: `Bearer ${client.token}` },
                  type: "header",
                }
              : { type: "public" },
            port,
            url: fresh.url,
          };
        },
        async getInfo() {
          return toInfo(await client.getSprite(name));
        },
        id: name,
        async killProcess(processId: string, signal: string | undefined) {
          const local = procs.get(processId);
          if (local) {
            local.cmd.kill(signal ?? "SIGKILL");
            return;
          }
          const stream = await sprite.killSession(
            processId,
            signal ?? "SIGKILL"
          );
          for await (const ev of stream) {
            if (ev.type === "error") {
              throw new SandboxError(
                "Provider",
                ev.message ?? `failed to kill session ${processId}`,
                { provider: PROVIDER }
              );
            }
          }
        },
        async listDir(path: string): Promise<DirEntry[]> {
          const entries = await fs().readdir(path, { withFileTypes: true });
          return entries.map((e) => ({
            name: e.name,
            path: joinPath(path, e.name),
            type: e.isDirectory()
              ? "dir"
              : e.isSymbolicLink()
                ? "symlink"
                : "file",
          }));
        },
        async listPorts(): Promise<Preview[]> {
          const fresh = await client.getSprite(name);
          if (!fresh.url) {
            return [];
          }
          const isPublic = fresh.urlSettings?.auth === "public";
          return [
            {
              auth: isPublic
                ? { type: "public" }
                : {
                    headers: { Authorization: `Bearer ${client.token}` },
                    type: "header",
                  },
              port: exposedPort,
              url: fresh.url,
            },
          ];
        },
        async listProcesses(): Promise<ProcessInfo[]> {
          const sessions = await sprite.listSessions();
          return [
            ...[...procs.entries()].map(([id, p]) => ({ cmd: p.line, id })),
            ...sessions.map((s) => ({ cmd: s.command, id: s.id })),
          ];
        },
        async listSnapshots(): Promise<SnapshotRef[]> {
          const list = await sprite.listCheckpoints();
          return list
            .filter((c) => c.id !== "Current")
            .map((c) => toSnapshotRef(c));
        },
        async mkdir(path: string, recursive: boolean) {
          await fs().mkdir(path, { recursive });
        },
        name,
        raw: sprite,
        async readFile(path: string): Promise<Uint8Array> {
          const buf = await fs().readFile(path, null);
          return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        },
        async remove(path: string, recursive: boolean) {
          await fs().rm(path, { force: true, recursive });
        },
        async rename(from: string, to: string) {
          await fs().rename(from, to);
        },
        async restoreSnapshot(ref: string) {
          const stream = await sprite.restoreCheckpoint(ref);
          for await (const msg of stream) {
            if (msg.type === "error") {
              throw new SandboxError(
                "Provider",
                msg.error ?? msg.data ?? `restore of ${ref} failed`,
                { provider: PROVIDER }
              );
            }
          }
        },
        async setEgressPolicy(policy: EgressPolicy) {
          await sprite.updateNetworkPolicy(toNetworkPolicy(policy));
        },
        async snapshot(sopts: SnapshotOptions): Promise<SnapshotRef> {
          if (sopts.mode === "memory") {
            throw validation(
              "Sprites checkpoints capture the filesystem only (mode 'memory' is unsupported)"
            );
          }
          const comment =
            sopts.name ??
            `sbox-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
          const stream = await sprite.createCheckpoint(comment);
          for await (const msg of stream) {
            if (msg.type === "error") {
              throw new SandboxError(
                "Provider",
                msg.error ?? msg.data ?? "checkpoint failed",
                { provider: PROVIDER }
              );
            }
          }
          const match = (await sprite.listCheckpoints())
            .filter((c) => c.comment === comment && c.id !== "Current")
            .toSorted((a, b) => b.createTime.getTime() - a.createTime.getTime())
            .at(0);
          if (!match) {
            throw new SandboxError(
              "Provider",
              `checkpoint '${comment}' was created but is not listed`,
              { provider: PROVIDER }
            );
          }
          return toSnapshotRef(match, sopts.name);
        },
        spawn: (cmd: string, execOpts: ExecOptions): DriverProcess =>
          startCommand(cmd, execOpts, `proc-${++counter}`, true),
        async stat(path: string): Promise<FileInfo> {
          const s = await fs().stat(path);
          return {
            mtime: s.mtime,
            path,
            size: s.size,
            type: s.isDirectory()
              ? "dir"
              : s.isSymbolicLink()
                ? "symlink"
                : "file",
          };
        },
        async upload(path: string, data: FileBody) {
          await fs().writeFile(path, Buffer.from(await toBytes(data)));
        },
        async watch(
          path: string,
          cb: (e: FsEvent) => void,
          recursive: boolean
        ): Promise<() => Promise<void>> {
          const watcher = await fs().watch(path, { recursive });
          void (async () => {
            try {
              for await (const ev of watcher) {
                const mapped = mapWatchEvent(ev);
                if (mapped) {
                  cb(mapped);
                }
              }
            } catch {
              // watcher closed or failed; nothing to report to the callback
            }
          })();
          return async () => watcher.close();
        },
        async writeFile(path: string, data: Uint8Array) {
          await fs().writeFile(path, Buffer.from(data));
        },
      };
      return handle;
    };

    const toSnapshotRef = (c: Checkpoint, name?: string): SnapshotRef => ({
      createdAt: c.createTime,
      id: c.id,
      includesMemory: false,
      name: name ?? c.comment,
      provider: PROVIDER,
      raw: c,
    });

    const createNamed = async (
      client: SpritesClient,
      spec: ResolvedSandboxSpec,
      name: string,
      derived: boolean
    ): Promise<Sprite> => {
      const args = toCreateArgs(spec, name, opts);
      const policy = spec.network ? toNetworkPolicy(spec.network) : undefined;
      let sprite: Sprite;
      try {
        sprite = await client.createSprite(args.name, args.options);
      } catch (error) {
        // A derived name means this is a retry of the same create: reuse it.
        if (derived && wrap(error).code === "Conflict") {
          sprite = await client.getSprite(name);
        } else {
          throw error;
        }
      }
      if (policy) {
        await sprite.updateNetworkPolicy(policy);
      }
      return sprite;
    };

    const provider: SandboxProvider<SpritesCaps, SpritesRaw> = {
      capabilities: SPRITES_CAPS,
      async connect(id: string, _ctx: CallContext) {
        const client = await getClient();
        return makeHandle(client, await client.getSprite(id));
      },
      async create(spec: ResolvedSandboxSpec, ctx: CallContext) {
        const client = await getClient();
        const derived = !spec.name;
        const name =
          spec.name ??
          (await nameFromKey(
            ctx.idempotencyKey ?? globalThis.crypto.randomUUID()
          ));
        return makeHandle(
          client,
          await createNamed(client, spec, name, derived)
        );
      },
      flags: SPRITES_FLAGS,
      async getOrCreate(spec, _ctx) {
        const client = await getClient();
        try {
          return makeHandle(client, await client.getSprite(spec.name));
        } catch (error) {
          if (wrap(error).code !== "NotFound") {
            throw error;
          }
        }
        try {
          return makeHandle(
            client,
            await createNamed(client, spec, spec.name, false)
          );
        } catch (error) {
          // Lost a create race: the other caller's sprite is ours too.
          if (wrap(error).code === "Conflict") {
            return makeHandle(client, await client.getSprite(spec.name));
          }
          throw error;
        }
      },
      async *list(filter: ListFilter | undefined, _ctx: CallContext) {
        const client = await getClient();
        let token: string | undefined;
        let n = 0;
        do {
          const page = await client.listSprites({
            maxResults: 100,
            ...(token ? { continuationToken: token } : {}),
          });
          for (const s of page.sprites) {
            const info = toInfo(s);
            if (filter?.state && info.state !== filter.state) {
              continue;
            }
            if (
              filter?.metadata &&
              !Object.entries(filter.metadata).every(
                ([k, v]) => info.metadata[k] === v
              )
            ) {
              continue;
            }
            if (filter?.limit !== undefined && n >= filter.limit) {
              return;
            }
            n++;
            yield info;
          }
          token = page.hasMore ? page.nextContinuationToken : undefined;
        } while (token);
      },
      mapError: mapSpritesError,
      name: PROVIDER,
      async verify(_ctx: CallContext) {
        const client = await getClient();
        const page = await client.listSprites({ maxResults: 1 });
        return page.organizationName
          ? { account: page.organizationName }
          : undefined;
      },
    };
    return provider;
  }
);
