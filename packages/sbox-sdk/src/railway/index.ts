import type {
  CheckpointOptions,
  CreateOptions,
  ExecHandle,
  ExecOptions as RailwayExecOptions,
  ExecSignal,
  RailwayClientConfig,
  Sandbox as RailwaySandbox,
  SandboxCheckpointInfo,
  SandboxDomain,
  SandboxInfo as RailwaySandboxInfo,
  SandboxNetworkIsolation,
  SandboxStatus,
  SandboxTemplate,
} from "railway";

/**
 * `sbox-sdk/railway` — adapter for Railway Sandboxes (the official `railway`
 * SDK, >= 3.4; 3.17 recommended). A sandbox is an isolated Debian Linux VM.
 *
 * - exec streams natively (`onStdout`/`onStderr`), reports a real exit code,
 *   and `kill()` delivers a real signal to the process group.
 * - background processes are durable exec sessions: the process id is the
 *   session name, so `commands.connect(id)` reattaches and replays output.
 * - files use the native streaming file API (`files.read/write/list/stat`).
 * - `snapshots.create()` is a named checkpoint; boot one with
 *   `client.create({ fromSnapshot })`. `fork()` clones the filesystem.
 * - previews are Railway domains declared at create time (`spec.ports`), which
 *   requires `networkIsolation: "PRIVATE"`.
 * - Railway sandboxes have no labels, so `metadata`/`name` are persisted in a
 *   small JSON file inside the sandbox (see `METADATA_PATH`).
 *
 * Requires the optional peer dependency `railway`.
 */
import { AsyncQueue, defineProvider, SandboxError } from "../adapter/index.js";
import type {
  CallContext,
  CapabilityFlags,
  CapabilityMap,
  DirEntry,
  DriverExec,
  DriverHandle,
  DriverProcess,
  ExecOptions,
  FileBody,
  FileInfo,
  ListFilter,
  OutputEvent,
  Preview,
  ProcessInfo,
  ResolvedSandboxSpec,
  SandboxInfo,
  SandboxProvider,
  SandboxState,
  SnapshotRef,
} from "../adapter/index.js";

type Mod = typeof import("railway");

export interface RailwayOptions {
  /**
   * Railway token. Falls back to `RAILWAY_TOKEN` (project token) or
   * `RAILWAY_API_TOKEN` (account/workspace token) in the environment.
   */
  token?: string;
  /** `"project-token"` or `"bearer"`. Inferred by the SDK when omitted. */
  authType?: RailwayClientConfig["authType"];
  /**
   * Target environment id. Falls back to `RAILWAY_ENVIRONMENT_ID`, then to the
   * project token's environment. Required with an account/workspace token.
   */
  environmentId?: string;
  /** Override the GraphQL endpoint (non-standard deployments only). */
  endpoint?: string;
  /** Custom fetch for the SDK's GraphQL calls. */
  fetch?: typeof fetch;
  /** WebSocket constructor where no global `WebSocket` exists. */
  webSocketImpl?: RailwayClientConfig["webSocketImpl"];
  /**
   * `"ISOLATED"` (default): public NAT egress only. `"PRIVATE"`: joins the
   * environment's private network; required for preview domains (`ports`).
   */
  networkIsolation?: SandboxNetworkIsolation;
  /**
   * A native recipe from `Sandbox.template()` (packages, run steps, env,
   * workdir). Used for every create that doesn't name a `template` or
   * `fromSnapshot`. Railway builds it once and caches it by recipe hash.
   */
  template?: SandboxTemplate;
}

export const RAILWAY_CAPS = {
  background: "native",
  codeInterpreter: "unsupported",
  egressControl: "unsupported",
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "unsupported",
  fork: "native",
  gpu: "unsupported",
  killProcess: "native",
  list: "native",
  metrics: "unsupported",
  pause: "unsupported",
  privatePreview: "unsupported",
  proxiedFetch: "unsupported",
  pty: "unsupported",
  region: "native",
  secretsVault: "native",
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

export type RailwayCaps = typeof RAILWAY_CAPS;

const RAILWAY_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true, // exec takes { cwd, env }
  preservesDiskOnStop: false,
  preservesMemoryOnPause: false,
  previewBrowserAuth: false, // domains are public; there are no private previews
  previewModel: "declaredPorts", // `domains` are fixed at create time
  templateSources: [],
};

const PROVIDER = "railway";

/** Where sbox keeps `metadata`/`name` inside the sandbox (no native labels). */
export const METADATA_PATH = "/etc/sbox/metadata.json";

/** Matches the core's getOrCreate key; forks drop it so they don't alias. */
const NAME_KEY = "sbox-name";

interface SboxRecord {
  name?: string;
  metadata: Record<string, string>;
  idempotencyKey?: string;
}

const EMPTY_RECORD: SboxRecord = { metadata: {} };

// --------------------------------------------------------------------------
// mapping helpers
// --------------------------------------------------------------------------

/** Map every Railway sandbox status onto `SandboxState`. */
export function mapRailwayStatus(
  status: SandboxStatus | string | undefined
): SandboxState {
  switch (status) {
    case "CREATING": {
      return "creating";
    }
    case "RUNNING": {
      return "running";
    }
    case "DESTROYING":
    case "DESTROYED": {
      return "destroyed";
    }
    case "FAILED": {
      return "error";
    }
    default: {
      return "unknown";
    }
  }
}

const SIGNALS: Record<string, ExecSignal> = {
  "1": "HUP",
  "15": "TERM",
  "2": "INT",
  "3": "QUIT",
  "9": "KILL",
  HUP: "HUP",
  INT: "INT",
  KILL: "KILL",
  QUIT: "QUIT",
  TERM: "TERM",
};

function toExecSignal(signal: string | undefined): ExecSignal {
  if (!signal) {
    return "TERM";
  }
  return SIGNALS[signal.toUpperCase().replace(/^SIG/, "")] ?? "TERM";
}

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

function domainUrl(d: SandboxDomain): string {
  return /^https?:\/\//.test(d.domain) ? d.domain : `https://${d.domain}`;
}

function invalid(message: string): SandboxError {
  return new SandboxError("Validation", message, { provider: PROVIDER });
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "";
}

/** Normalize Railway SDK errors into the sbox taxonomy. */
export function mapRailwayError(err: unknown): SandboxError | undefined {
  if (err instanceof SandboxError) {
    return err;
  }
  if (!(err instanceof Error)) {
    return undefined;
  }
  const name = errName(err);
  const msg = err.message;
  const init = { cause: err, provider: PROVIDER };
  switch (name) {
    case "RailwayAuthError": {
      return new SandboxError("Unauthorized", msg, init);
    }
    case "SandboxNotFoundError":
    case "SandboxFileNotFoundError": {
      return new SandboxError("NotFound", msg, init);
    }
    case "SandboxTimeoutError": {
      return new SandboxError("Timeout", msg, init);
    }
    case "ExecNotStartedError": {
      return new SandboxError("Provider", msg, { ...init, retryable: true });
    }
    case "TypeError": {
      return new SandboxError("Validation", msg, init);
    }
    default: {
      break;
    }
  }
  const status = (err as { status?: unknown }).status;
  const code = typeof status === "number" ? status : undefined;
  if (
    code === 401 ||
    code === 403 ||
    /not authori[sz]ed|unauthori[sz]ed|forbidden|invalid token/i.test(msg)
  ) {
    return new SandboxError("Unauthorized", msg, { ...init, status: code });
  }
  if (code === 404 || /not found|no such file|does not exist/i.test(msg)) {
    return new SandboxError("NotFound", msg, { ...init, status: code });
  }
  if (
    code === 429 ||
    /rate limit|too many requests|quota|limit reached|exceeded/i.test(msg)
  ) {
    return new SandboxError("QuotaExceeded", msg, {
      ...init,
      retryable: true,
      status: code,
    });
  }
  if (code === 409 || /already exists|conflict/i.test(msg)) {
    return new SandboxError("Conflict", msg, { ...init, status: code });
  }
  if (/timed? ?out/i.test(msg)) {
    return new SandboxError("Timeout", msg, { ...init, status: code });
  }
  return new SandboxError("Provider", msg, { ...init, status: code });
}

const wrap = (err: unknown): SandboxError =>
  mapRailwayError(err) ?? SandboxError.wrap(err, PROVIDER);

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }
  );
  await Promise.all(workers);
  return out;
}

// --------------------------------------------------------------------------
// provider
// --------------------------------------------------------------------------

export const railway = defineProvider<
  RailwayCaps,
  RailwaySandbox,
  RailwayOptions
>((opts = {}) => {
  let modPromise: Promise<Mod> | undefined;
  const load = (): Promise<Mod> => (modPromise ??= import("railway"));

  /** Connection + environment options shared by every SDK static. */
  const clientCfg = (): CheckpointOptions => {
    const cfg: CheckpointOptions = {};
    if (opts.token !== undefined) {
      cfg.token = opts.token;
    }
    if (opts.authType !== undefined) {
      cfg.authType = opts.authType;
    }
    if (opts.environmentId !== undefined) {
      cfg.environmentId = opts.environmentId;
    }
    if (opts.endpoint !== undefined) {
      cfg.endpoint = opts.endpoint;
    }
    if (opts.fetch !== undefined) {
      cfg.fetch = opts.fetch;
    }
    if (opts.webSocketImpl !== undefined) {
      cfg.webSocketImpl = opts.webSocketImpl;
    }
    return cfg;
  };

  /** Metadata records keyed by sandbox id (immutable once written). */
  const records = new Map<string, SboxRecord>();

  const readRecord = async (sb: RailwaySandbox): Promise<SboxRecord> => {
    const hit = records.get(sb.id);
    if (hit) {
      return hit;
    }
    try {
      const text = await sb.files.read(METADATA_PATH, { format: "text" });
      const parsed = JSON.parse(text) as Partial<SboxRecord>;
      const rec: SboxRecord = {
        idempotencyKey: parsed.idempotencyKey,
        metadata: { ...parsed.metadata },
        name: parsed.name,
      };
      records.set(sb.id, rec);
      return rec;
    } catch (error) {
      if (wrap(error).code === "NotFound") {
        records.set(sb.id, EMPTY_RECORD);
      }
      return EMPTY_RECORD;
    }
  };

  const writeRecord = async (
    sb: RailwaySandbox,
    rec: SboxRecord
  ): Promise<void> => {
    await sb.files.write(METADATA_PATH, JSON.stringify(rec));
    records.set(sb.id, rec);
  };

  const toInfo = (i: RailwaySandboxInfo, rec: SboxRecord): SandboxInfo => ({
    createdAt: i.createdAt ? new Date(i.createdAt) : undefined,
    id: i.id,
    metadata: rec.metadata,
    name: rec.name ?? rec.metadata[NAME_KEY],
    provider: PROVIDER,
    raw: i,
    state: mapRailwayStatus(i.status),
  });

  /** Translate the portable spec into the SDK's create options. */
  const creationOptions = (spec: ResolvedSandboxSpec): CreateOptions => {
    const out: CreateOptions = { ...clientCfg() };
    const networkIsolation = opts.networkIsolation;
    if (networkIsolation) {
      out.networkIsolation = networkIsolation;
    }

    const env: Record<string, string> = { ...spec.env };
    for (const s of spec.secrets ?? []) {
      if (s.mode === "egress") {
        throw invalid(
          `secret '${s.name}': egress credential injection is not supported`
        );
      }
      // No inline value => resolve from the environment's shared variables.
      env[s.envVar ?? s.name] = s.value ?? `\${{shared.${s.name}}}`;
    }
    if (Object.keys(env).length > 0) {
      out.env = env;
    }

    const lc = spec.lifecycle;
    if (lc?.maxAgeMs !== undefined) {
      throw invalid(
        "Railway has no wall-clock max age; use lifecycle.idleTimeoutMs"
      );
    }
    if (lc?.onIdle && lc.onIdle !== "destroy") {
      throw invalid(
        `lifecycle.onIdle '${lc.onIdle}' is not supported: idle Railway sandboxes are destroyed`
      );
    }
    if (lc?.idleTimeoutMs !== undefined) {
      out.idleTimeoutMinutes = Math.ceil(lc.idleTimeoutMs / 60_000);
    }

    const r = spec.resources;
    if (r?.gpu || r?.gpuCount) {
      throw invalid("Railway sandboxes have no GPUs");
    }
    if (r?.vcpus !== undefined || r?.memoryMB !== undefined) {
      out.resources = {
        ...(r.vcpus === undefined ? {} : { cpu: r.vcpus }),
        // The SDK takes decimal GB (1 GB = 1,000,000,000 bytes).
        ...(r.memoryMB === undefined ? {} : { memoryGB: r.memoryMB / 1000 }),
      };
    }

    if (spec.region) {
      out.region = spec.region;
    }

    const net = spec.network;
    if (net && (net.mode !== "allow-all" || net.deny || net.inject)) {
      throw invalid(
        "Railway sandboxes have open NAT egress; egress filtering is not supported"
      );
    }
    if (spec.volumes && spec.volumes.length > 0) {
      throw invalid("Railway sandboxes do not support volumes");
    }
    if (spec.ports && spec.ports.length > 0) {
      if (networkIsolation !== "PRIVATE") {
        throw invalid(
          'preview domains (spec.ports) require railway({ networkIsolation: "PRIVATE" })'
        );
      }
      out.domains = spec.ports.map((port) => ({ port }));
    }
    return out;
  };

  /** Find a sandbox an earlier attempt of the same create already made. */
  const findByIdempotencyKey = async (
    key: string
  ): Promise<RailwaySandbox | undefined> => {
    const { Sandbox } = await load();
    for (const info of await Sandbox.list(clientCfg())) {
      if (mapRailwayStatus(info.status) !== "running") {
        continue;
      }
      const sb = await Sandbox.connect(info.id, clientCfg());
      if ((await readRecord(sb)).idempotencyKey === key) {
        return sb;
      }
    }
    return undefined;
  };

  const makeHandle = (sb: RailwaySandbox): DriverHandle<RailwaySandbox> => {
    /** Live background processes started through this handle. */
    const procs = new Map<string, ExecHandle>();
    let localIds = 0;

    const start = (
      target: string | { sessionName: string },
      o: ExecOptions,
      ctx: CallContext,
      interactive: boolean
    ): { h: ExecHandle; events: AsyncQueue<OutputEvent> } => {
      const events = new AsyncQueue<OutputEvent>();
      const streamOpts: RailwayExecOptions = {
        captureOutput: false,
        onStderr: (data) => events.push({ data, type: "stderr" }),
        onStdout: (data) => events.push({ data, type: "stdout" }),
        signal: o.signal ?? ctx.signal,
      };
      // cwd/env/timeout/stdin are fresh-exec only (rejected on reattach).
      const h =
        typeof target === "string"
          ? sb.exec(target, {
              ...streamOpts,
              ...(o.cwd ? { cwd: o.cwd } : {}),
              ...(o.env && Object.keys(o.env).length > 0 ? { env: o.env } : {}),
              ...(o.timeoutMs
                ? { timeoutSec: Math.max(1, Math.ceil(o.timeoutMs / 1000)) }
                : {}),
              ...(interactive ? { stdin: true } : {}),
            })
          : sb.exec(target, streamOpts);
      h.then((r) => {
        if (r.timedOut) {
          events.fail(
            new SandboxError(
              "Timeout",
              `command timed out after ${o.timeoutMs}ms`,
              { provider: PROVIDER, timedOut: true }
            )
          );
          return;
        }
        // -1 = terminated by a signal; null = termination unconfirmed.
        events.push({ exitCode: r.exitCode ?? -1, type: "exit" });
        events.close();
      }).catch((error: unknown) => events.fail(wrap(error)));
      return { events, h };
    };

    const asDriver = (
      h: ExecHandle,
      events: AsyncQueue<OutputEvent>,
      pid: Promise<string>,
      withStdin: boolean
    ): DriverExec => ({
      [Symbol.asyncIterator]: () => events.iterator(),
      async kill(signal) {
        await h.kill(toExecSignal(signal));
      },
      pid,
      ...(withStdin
        ? {
            async writeStdin(data: Uint8Array) {
              await h.stdin.write(data);
            },
          }
        : {}),
    });

    return {
      async connectProcess(processId, ctx): Promise<DriverProcess> {
        const { events, h } = start({ sessionName: processId }, {}, ctx, false);
        return {
          ...asDriver(h, events, Promise.resolve(processId), false),
          id: processId,
        };
      },

      async destroy() {
        await sb.destroy();
        records.delete(sb.id);
      },

      async deleteSnapshot(ref) {
        const { Sandbox } = await load();
        const cps = await Sandbox.checkpoints(clientCfg());
        const cp = cps.find((c) => c.key === ref || c.id === ref);
        if (!cp) {
          throw new SandboxError("NotFound", `no checkpoint '${ref}'`, {
            provider: PROVIDER,
          });
        }
        await Sandbox.deleteCheckpoint(cp.id, clientCfg());
      },

      async download(path) {
        return sb.files.read(path, { format: "stream" });
      },

      exec(cmd, o, ctx): DriverExec {
        const { events, h } = start(cmd, o, ctx, false);
        return asDriver(
          h,
          events,
          h.sessionName.catch(() => ""),
          false
        );
      },

      async exposePort(port): Promise<Preview> {
        const d = sb.domains.find((x) => x.port === port);
        if (!d) {
          throw invalid(
            `port ${port} has no Railway domain; declare it in spec.ports at create time`
          );
        }
        return { auth: { type: "public" }, port, url: domainUrl(d) };
      },

      async fork(count): Promise<DriverHandle<RailwaySandbox>[]> {
        const parent = await readRecord(sb);
        const children = await Promise.all(
          Array.from({ length: count }, () =>
            sb.fork({
              networkIsolation: sb.networkIsolation,
              ...(sb.idleTimeoutMinutes === null
                ? {}
                : { idleTimeoutMinutes: sb.idleTimeoutMinutes }),
            })
          )
        );
        // The clone copies the metadata file; drop the name + retry key so a
        // fork never answers getOrCreate or an idempotent retry for its parent.
        const { [NAME_KEY]: _name, ...metadata } = parent.metadata;
        await Promise.all(children.map((c) => writeRecord(c, { metadata })));
        return children.map((c) => makeHandle(c));
      },

      async getInfo(): Promise<SandboxInfo> {
        await sb.refresh();
        const state = mapRailwayStatus(sb.status);
        const rec =
          state === "running"
            ? await readRecord(sb)
            : (records.get(sb.id) ?? EMPTY_RECORD);
        return toInfo(sb.toJSON(), rec);
      },

      id: sb.id,

      async killProcess(processId, signal, ctx) {
        const live = procs.get(processId);
        if (live) {
          await live.kill(toExecSignal(signal));
          procs.delete(processId);
          return;
        }
        // Not started by this handle: reattach to the session, then kill it.
        const { h } = start({ sessionName: processId }, {}, ctx, false);
        await h.kill(toExecSignal(signal));
      },

      async listDir(path): Promise<DirEntry[]> {
        const entries = await sb.files.list(path);
        return entries.map((e) => ({
          name: e.name,
          path: joinPath(path, e.name),
          type: e.isDir ? "dir" : "file",
        }));
      },

      async listPorts(): Promise<Preview[]> {
        return sb.domains.map((d) => ({
          auth: { type: "public" },
          port: d.port,
          url: domainUrl(d),
        }));
      },

      async listProcesses(): Promise<ProcessInfo[]> {
        const sessions = (await sb.sessions()) ?? [];
        return sessions
          .filter((s) => s.kind === "EXEC" && s.running)
          .map((s) => ({ cmd: s.command, id: s.name }));
      },

      async listSnapshots(): Promise<SnapshotRef[]> {
        const { Sandbox } = await load();
        const cps = await Sandbox.checkpoints(clientCfg());
        return cps.map((cp) => checkpointRef(cp));
      },

      async mkdir(path) {
        // Railway's mkdir always creates missing parents (mkdir -p).
        await sb.files.mkdir(path);
      },

      raw: sb,

      async readFile(path) {
        return sb.files.read(path, { format: "bytes" });
      },

      async remove(path, recursive, ctx) {
        if (!recursive) {
          await sb.files.remove(path);
          return;
        }
        // files.remove only handles files and empty directories.
        const quoted = `'${path.replaceAll("'", `'\\''`)}'`;
        const { events } = start(`rm -rf -- ${quoted}`, {}, ctx, false);
        let stderr = "";
        for await (const ev of events.iterator()) {
          if (ev.type === "stderr") {
            stderr += ev.data;
          }
          if (ev.type === "exit" && ev.exitCode !== 0) {
            throw new SandboxError("Provider", `rm -rf failed: ${stderr}`, {
              provider: PROVIDER,
            });
          }
        }
      },

      async rename(from, to) {
        await sb.files.rename(from, to);
      },

      async snapshot(snapOpts): Promise<SnapshotRef> {
        const name =
          snapOpts.name ??
          `sbox-${sb.id.slice(0, 8)}-${Date.now().toString(36)}`;
        return checkpointRef(await sb.checkpoint(name));
      },

      async spawn(cmd, o, ctx): Promise<DriverProcess> {
        const { events, h } = start(cmd, o, ctx, true);
        const id = await h.sessionName.catch(() => `local-${++localIds}`);
        procs.set(id, h);
        void h
          .finally(() => procs.delete(id))
          .catch(() => {
            /* surfaced through the event stream */
          });
        return { ...asDriver(h, events, Promise.resolve(id), true), id };
      },

      async stat(path): Promise<FileInfo> {
        const s = await sb.files.stat(path);
        const mtime = s.modTime ? new Date(s.modTime) : undefined;
        return {
          path,
          size: s.size,
          type: s.isDir ? "dir" : "file",
          ...(mtime && !Number.isNaN(mtime.getTime()) ? { mtime } : {}),
        };
      },

      async upload(path, data: FileBody) {
        await sb.files.write(path, data);
      },

      async writeFile(path, data) {
        await sb.files.write(path, data);
      },
    };
  };

  const checkpointRef = (cp: SandboxCheckpointInfo): SnapshotRef => ({
    createdAt: cp.createdAt ? new Date(cp.createdAt) : undefined,
    // Railway boots checkpoints by key (name), so the key is the portable id.
    id: cp.key,
    includesMemory: false,
    name: cp.key,
    provider: PROVIDER,
    raw: cp,
  });

  const provider: SandboxProvider<RailwayCaps, RailwaySandbox> = {
    capabilities: RAILWAY_CAPS,

    async connect(id) {
      const { Sandbox } = await load();
      return makeHandle(await Sandbox.connect(id, clientCfg()));
    },

    async create(spec, ctx) {
      const cfg = creationOptions(spec);
      const key = ctx.idempotencyKey;
      if (key && ctx.attempt > 1) {
        const existing = await findByIdempotencyKey(key);
        if (existing) {
          return makeHandle(existing);
        }
      }
      const { Sandbox } = await load();
      // `template` and `fromSnapshot` are both checkpoint names on Railway.
      const source = spec.fromSnapshot ?? spec.template;
      const sb = source
        ? await Sandbox.create(source, cfg)
        : opts.template
          ? await Sandbox.create(opts.template, cfg)
          : await Sandbox.create(cfg);
      try {
        await writeRecord(sb, {
          idempotencyKey: key,
          metadata: { ...spec.metadata },
          name: spec.name,
        });
      } catch (error) {
        await sb.destroy().catch(() => {
          /* best effort: never leak a sandbox we can't label */
        });
        throw error;
      }
      return makeHandle(sb);
    },

    flags: RAILWAY_FLAGS,

    async *list(filter: ListFilter | undefined) {
      const { Sandbox } = await load();
      // NOTE: the SDK returns one page and exposes no cursor (see docs).
      let infos = await Sandbox.list(clientCfg());
      if (filter?.state) {
        infos = infos.filter(
          (i) => mapRailwayStatus(i.status) === filter.state
        );
      }
      const byMeta =
        filter?.metadata && Object.keys(filter.metadata).length > 0;
      if (!byMeta && filter?.limit !== undefined) {
        infos = infos.slice(0, filter.limit);
      }
      const recs = await mapLimit(infos, 8, async (i) => {
        if (mapRailwayStatus(i.status) !== "running") {
          return records.get(i.id) ?? EMPTY_RECORD;
        }
        const cached = records.get(i.id);
        if (cached) {
          return cached;
        }
        try {
          return await readRecord(await Sandbox.connect(i.id, clientCfg()));
        } catch {
          return EMPTY_RECORD; // destroyed between list and connect
        }
      });
      let n = 0;
      for (const [idx, i] of infos.entries()) {
        const rec = recs[idx] ?? EMPTY_RECORD;
        if (
          byMeta &&
          !Object.entries(filter.metadata ?? {}).every(
            ([k, v]) => rec.metadata[k] === v
          )
        ) {
          continue;
        }
        if (filter?.limit !== undefined && n >= filter.limit) {
          return;
        }
        n++;
        yield toInfo(i, rec);
      }
    },

    mapError: mapRailwayError,
    name: PROVIDER,

    async verify() {
      const { Sandbox } = await load();
      await Sandbox.list({ ...clientCfg(), first: 1 });
      return { account: opts.environmentId };
    },
  };
  return provider;
});
