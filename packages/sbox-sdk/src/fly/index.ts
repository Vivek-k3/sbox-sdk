/**
 * `sbox-sdk/fly` — adapter for the Fly Machines REST API (no SDK; pure fetch, so
 * it runs anywhere the core does). A "sandbox" is a Fly Machine inside an
 * existing Fly app.
 *
 * - exec is the buffered `/exec` endpoint (timeout ≤ 600 s per call; no
 *   per-command cwd/env, so the core folds those into a wrapper via
 *   `perCommandEnvCwd: false`). `kill()` finds the command through `/ps` (each
 *   exec carries a unique `$0` marker) and SIGKILLs its process tree.
 * - Files move over `/exec` with the payload in the request's `stdin` field
 *   (never argv), chunked, so large and binary files round-trip.
 * - Machines boot `init.exec = ["sleep","inf"]` with `restart: no` so plain
 *   images (whose CMD would exit) stay up, and `rootfs.persist = "always"` so the
 *   disk survives stop/start and the restarts caused by config updates.
 * - Previews: Fly routes per APP (`https://<app>.fly.dev`), not per machine.
 *   Exposing a port adds a machine `service`; to reach THIS machine the request
 *   must carry `fly-force-instance-id: <machine id>`, so the preview's `auth` is
 *   `{ type: "header" }`. The app needs a public IP (`fly ips allocate-v6`).
 *
 * Every request goes through `ctx.fetch` (or the `fetch` option) so tests can
 * inject a fake transport.
 */
import {
  AsyncQueue,
  base64ToBytes,
  bytesToBase64,
  defineProvider,
  SandboxError,
  shellQuote as sq,
} from "../adapter/index.js";
import type {
  CallContext,
  CapabilityFlags,
  CapabilityMap,
  DriverExec,
  DriverHandle,
  DriverVolumes,
  ExecOptions,
  ListFilter,
  OutputEvent,
  Preview,
  ProcessInfo,
  ResolvedSandboxSpec,
  SandboxErrorCode,
  SandboxInfo,
  SandboxProvider,
  SandboxState,
  VolumeInfo,
} from "../adapter/index.js";

export interface FlyOptions {
  /** Fly API token (`fly tokens create deploy` or an org token). */
  apiToken: string;
  /** Existing Fly app the machines are created in. */
  appName: string;
  /** Default image when `spec.template` is unset (default "ubuntu:22.04"). */
  image?: string;
  /** Default region, e.g. "iad". */
  region?: string;
  /** Public app hostname for preview URLs (default `<appName>.fly.dev`). */
  appDomain?: string;
  /** Machines API base (default https://api.machines.dev/v1). */
  apiBaseUrl?: string;
  /** Override the transport (testing). Defaults to the client's fetch. */
  fetch?: typeof fetch;
  /** "shared" (default) or "performance" CPUs. */
  cpuKind?: "shared" | "performance";
  /**
   * Keep the machine alive with `init.exec = ["sleep","inf"]` instead of the
   * image's ENTRYPOINT/CMD (default true). Set `false` for images that run their
   * own long-lived process (e.g. a server you want to preview).
   */
  keepAlive?: boolean;
  /** Persist the root filesystem across stop/start (default true). */
  persistRootfs?: boolean;
  /**
   * `/exec` timeout in seconds for commands without `timeoutMs` (default and
   * maximum 600). Fly kills commands that run longer.
   */
  execTimeoutSec?: number;
}

/** The Fly Machine object (subset of the Machines API `Machine` schema). */
export interface FlyMachine {
  id: string;
  name?: string;
  state?: string;
  region?: string;
  created_at?: string;
  config?: FlyMachineConfig;
  incomplete_config?: FlyMachineConfig;
}

/** Subset of `fly.MachineConfig` this adapter reads and writes. */
export interface FlyMachineConfig {
  image?: string;
  env?: Record<string, string>;
  metadata?: Record<string, string>;
  init?: { exec?: string[]; cmd?: string[]; entrypoint?: string[] };
  restart?: { policy?: "no" | "always" | "on-failure"; max_retries?: number };
  rootfs?: { persist?: "never" | "always" | "restart"; size_gb?: number };
  guest?: { cpus?: number; memory_mb?: number; cpu_kind?: string };
  services?: FlyService[];
  mounts?: { volume: string; path: string }[];
  auto_destroy?: boolean;
  [key: string]: unknown;
}

interface FlyService {
  protocol?: "tcp" | "udp";
  internal_port: number;
  ports?: { port: number; handlers?: string[]; force_https?: boolean }[];
  autostop?: "off" | "stop" | "suspend";
  autostart?: boolean;
}

interface FlyExecResponse {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  exit_signal?: number;
}

interface FlyVolume {
  id: string;
  name?: string;
  region?: string;
  size_gb?: number;
  created_at?: string;
  state?: string;
}

export const FLY_CAPS = {
  background: "unsupported",
  codeInterpreter: "unsupported",
  egressControl: "unsupported",
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "unsupported",
  fork: "unsupported",
  gpu: "unsupported", // the Machines API rejects guest.gpus / gpu_kind
  killProcess: "native",
  list: "native",
  metrics: "unsupported",
  pause: "native",
  privatePreview: "unsupported",
  proxiedFetch: "native",
  pty: "unsupported",
  region: "native",
  secretsVault: "native",
  setTimeout: "unsupported",
  snapshot: "unsupported",
  ssh: "unsupported",
  statefulKernel: "unsupported",
  stdin: "unsupported",
  stop: "native",
  streaming: "emulated",
  volumes: "native",
  templateBuild: "unsupported",
} as const satisfies CapabilityMap;

export type FlyCaps = typeof FLY_CAPS;

const P = "fly";
const IDEM_KEY = "sbox-idem";
const MAX_EXEC_SEC = 600;
/** Raw bytes per file chunk; base64 makes it ~1 MiB per request/response. */
const FILE_CHUNK = 768 * 1024;

const STATE_MAP: Record<string, SandboxState> = {
  archived: "archived",
  created: "creating",
  destroyed: "destroyed",
  destroying: "destroyed",
  failed: "error",
  migrated: "unknown", // transient: the machine continues on its new host
  migrating: "creating",
  pending: "creating",
  replaced: "destroyed", // a superseded machine version
  replacing: "creating",
  started: "running",
  starting: "creating",
  stopped: "stopped",
  stopping: "stopped",
  suspended: "paused",
  suspending: "suspending",
};

/** Map a Fly machine state to a `SandboxState`. */
export function mapFlyState(state: string | undefined): SandboxState {
  return STATE_MAP[state ?? ""] ?? "unknown";
}

/** SandboxState filter -> Fly `state` query value (only the filterable ones). */
const STATE_QUERY: Partial<Record<SandboxState, string>> = {
  creating: "created",
  paused: "suspended",
  running: "started",
  stopped: "stopped",
};

function codeForStatus(status: number, body: string): SandboxErrorCode {
  if (status === 401 || status === 403) {
    return "Unauthorized";
  }
  if (status === 404) {
    return "NotFound";
  }
  if (status === 408) {
    return "Timeout";
  }
  if (status === 409 || status === 412) {
    return "Conflict";
  }
  if (status === 429 || /insufficient_capacity|quota/i.test(body)) {
    return "QuotaExceeded";
  }
  if (status === 400 || status === 413 || status === 422) {
    return "Validation";
  }
  return "Provider";
}

/** Normalize anything thrown by this adapter into a `SandboxError`. */
export function mapFlyError(err: unknown): SandboxError | undefined {
  if (err instanceof SandboxError) {
    return err;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return new SandboxError("Timeout", err.message, {
      aborted: true,
      cause: err,
      provider: P,
    });
  }
  if (err instanceof Error) {
    return new SandboxError("Provider", err.message, {
      cause: err,
      provider: P,
    });
  }
  return undefined;
}

/** Strip Fly-internal metadata keys (`fly_*`) and the idempotency marker. */
function userMetadata(
  meta: Record<string, string> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (!k.startsWith("fly_") && k !== IDEM_KEY) {
      out[k] = v;
    }
  }
  return out;
}

function machineConfig(m: FlyMachine): FlyMachineConfig {
  return m.config ?? m.incomplete_config ?? {};
}

function toInfo(m: FlyMachine): SandboxInfo {
  const meta = userMetadata(machineConfig(m).metadata);
  return {
    createdAt: m.created_at ? new Date(m.created_at) : undefined,
    id: m.id,
    metadata: meta,
    name: meta["sbox-name"] ?? m.name,
    provider: P,
    raw: m,
    state: mapFlyState(m.state),
  };
}

function dirname(path: string): string {
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

/**
 * Public port for an internal port: the first exposed port gets 443 (+80
 * redirect); further ports are published on their own number.
 */
function servicesWithPort(
  services: FlyService[],
  port: number,
  lifecycle?: ResolvedSandboxSpec["lifecycle"]
): FlyService[] {
  if (services.some((s) => s.internal_port === port)) {
    return services;
  }
  const used = new Set(
    services.flatMap((s) => (s.ports ?? []).map((p) => p.port))
  );
  const svc: FlyService = {
    internal_port: port,
    ports: used.has(443)
      ? [{ handlers: ["tls", "http"], port }]
      : [
          { handlers: ["tls", "http"], port: 443 },
          { force_https: true, handlers: ["http"], port: 80 },
        ],
    protocol: "tcp",
  };
  if (used.has(443) && used.has(port)) {
    throw new SandboxError(
      "Conflict",
      `public port ${port} is already used by another service on this machine`,
      { provider: P }
    );
  }
  if (lifecycle?.onIdle === "pause" || lifecycle?.onIdle === "stop") {
    svc.autostop = lifecycle.onIdle === "pause" ? "suspend" : "stop";
    svc.autostart = lifecycle.autoResume ?? true;
  }
  return [...services, svc];
}

function publicPort(svc: FlyService): number {
  const tls = (svc.ports ?? []).find((p) => p.handlers?.includes("tls"));
  return tls?.port ?? svc.ports?.[0]?.port ?? 443;
}

export const fly = defineProvider<FlyCaps, FlyMachine, FlyOptions>((opts) => {
  const base = (opts.apiBaseUrl ?? "https://api.machines.dev/v1").replace(
    /\/+$/,
    ""
  );
  const app = encodeURIComponent(opts.appName);
  const appHost = (opts.appDomain ?? `${opts.appName}.fly.dev`)
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  const persistRootfs = opts.persistRootfs ?? true;
  const execDefaultSec = Math.min(
    Math.max(opts.execTimeoutSec ?? MAX_EXEC_SEC, 1),
    MAX_EXEC_SEC
  );

  const flags: CapabilityFlags = {
    exitCodeNative: true,
    perCommandEnvCwd: false, // /exec has no per-call cwd/env
    preservesDiskOnStop: persistRootfs, // rootfs.persist = "always"
    preservesMemoryOnPause: true, // suspend snapshots memory
    previewModel: "declaredPorts",
    previewBrowserAuth: false, // routing needs the fly-force-instance-id header
  };

  const doFetch = (ctx: CallContext): typeof fetch => opts.fetch ?? ctx.fetch;

  async function raw(
    ctx: CallContext,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<Response> {
    const res = await doFetch(ctx)(`${base}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        authorization: `Bearer ${opts.apiToken}`,
        "content-type": "application/json",
      },
      method,
      signal: signal ?? ctx.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new SandboxError(
        codeForStatus(res.status, text),
        `fly ${method} ${path} -> ${res.status} ${text}`.trim(),
        {
          provider: P,
          retryable:
            res.status === 429 ||
            res.status >= 500 ||
            /insufficient_capacity/.test(text),
          status: res.status,
        }
      );
    }
    return res;
  }

  async function api<T>(
    ctx: CallContext,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    const res = await raw(ctx, method, path, body, signal);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const mpath = (id: string, suffix = "") =>
    `/apps/${app}/machines/${encodeURIComponent(id)}${suffix}`;

  const getMachine = (ctx: CallContext, id: string) =>
    api<FlyMachine>(ctx, "GET", mpath(id));

  /** Block until the machine reaches `state` (the API waits ≤ 60 s per call). */
  async function waitFor(
    ctx: CallContext,
    id: string,
    state: string,
    attempts = 3
  ): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        await api(ctx, "GET", mpath(id, `/wait?state=${state}&timeout=60`));
        return;
      } catch (error) {
        if (
          !(error instanceof SandboxError) ||
          (error.code !== "Timeout" && error.status !== 408)
        ) {
          throw error;
        }
      }
    }
    throw new SandboxError(
      "Timeout",
      `machine ${id} did not reach '${state}'`,
      { provider: P }
    );
  }

  /** One `/exec` call; argv runs directly (not through a shell). */
  const execOnce = (
    ctx: CallContext,
    id: string,
    command: string[],
    extra: { stdin?: string; timeoutSec?: number; signal?: AbortSignal } = {}
  ) =>
    api<FlyExecResponse>(
      ctx,
      "POST",
      mpath(id, "/exec"),
      {
        command,
        timeout: extra.timeoutSec ?? 60,
        ...(extra.stdin === undefined ? {} : { stdin: extra.stdin }),
      },
      extra.signal
    );

  async function listProcs(
    ctx: CallContext,
    id: string
  ): Promise<{ pid: number; command: string }[]> {
    return (
      (await api<{ pid: number; command: string }[]>(
        ctx,
        "GET",
        mpath(id, "/ps")
      )) ?? []
    );
  }

  /** SIGKILL a process and its descendants (via /proc children lists). */
  async function killTree(
    ctx: CallContext,
    id: string,
    pid: number,
    signal = "KILL"
  ): Promise<void> {
    const sig = signal.replace(/^SIG/, "");
    await execOnce(ctx, id, [
      "sh",
      "-c",
      `k(){ for c in $(cat /proc/$1/task/*/children 2>/dev/null); do k $c; done; kill -s ${sig} $1 2>/dev/null; }; k ${pid}`,
    ]).catch(() => {});
    await execOnce(ctx, id, ["kill", "-s", sig, String(pid)]).catch(() => {});
  }

  /** Ensure every SecretRef exists as an app secret; returns min version. */
  async function applySecrets(
    ctx: CallContext,
    spec: ResolvedSandboxSpec
  ): Promise<number | undefined> {
    let version: number | undefined;
    for (const s of spec.secrets ?? []) {
      if (s.mode === "egress") {
        throw new SandboxError(
          "Validation",
          "fly has no egress credential injection (secret mode 'egress')",
          { provider: P }
        );
      }
      if (s.value === undefined) {
        if (s.envVar && s.envVar !== s.name) {
          throw new SandboxError(
            "Validation",
            `fly exposes app secret '${s.name}' under its own name; envVar '${s.envVar}' cannot alias it`,
            { provider: P }
          );
        }
        continue; // existing app secret: machines receive it automatically
      }
      const res = await api<{ version?: number; Version?: number }>(
        ctx,
        "POST",
        `/apps/${app}/secrets/${encodeURIComponent(s.envVar ?? s.name)}`,
        { value: s.value }
      );
      const v = res?.version ?? res?.Version;
      if (v !== undefined) {
        version = Math.max(version ?? 0, v);
      }
    }
    return version;
  }

  function buildConfig(spec: ResolvedSandboxSpec, ctx: CallContext) {
    const r = spec.resources;
    if (r?.gpu || r?.gpuCount) {
      throw new SandboxError(
        "Validation",
        "fly Machines no longer accept GPUs",
        { provider: P }
      );
    }
    if (spec.network && spec.network.mode !== "allow-all") {
      throw new SandboxError(
        "Validation",
        "fly has no per-machine egress policy",
        { provider: P }
      );
    }
    if (spec.fromSnapshot) {
      throw new SandboxError(
        "Validation",
        "fly machines cannot boot from a snapshot",
        { provider: P }
      );
    }
    if ((spec.volumes?.length ?? 0) > 1) {
      throw new SandboxError(
        "Validation",
        "a Fly Machine can mount at most one volume",
        { provider: P }
      );
    }
    const cpuKind = opts.cpuKind ?? "shared";
    const step = cpuKind === "performance" ? 1024 : 256;
    const memory = r?.memoryMB
      ? Math.ceil(r.memoryMB / step) * step
      : cpuKind === "performance"
        ? 2048
        : 256;
    let services: FlyService[] = [];
    for (const port of spec.ports ?? []) {
      services = servicesWithPort(services, port, spec.lifecycle);
    }
    const config: FlyMachineConfig = {
      auto_destroy: false,
      env: { ...spec.env },
      guest: { cpu_kind: cpuKind, cpus: r?.vcpus ?? 1, memory_mb: memory },
      image: spec.template ?? opts.image ?? "ubuntu:22.04",
      metadata: {
        ...spec.metadata,
        ...(ctx.idempotencyKey ? { [IDEM_KEY]: ctx.idempotencyKey } : {}),
      },
      restart: { policy: "no" },
    };
    if (opts.keepAlive ?? true) {
      config.init = { exec: ["sleep", "inf"] };
    }
    if (persistRootfs || r?.diskMB) {
      config.rootfs = {
        ...(persistRootfs ? { persist: "always" as const } : {}),
        ...(r?.diskMB ? { size_gb: Math.ceil(r.diskMB / 1024) } : {}),
      };
    }
    if (services.length > 0) {
      config.services = services;
    }
    if (spec.volumes?.[0]) {
      config.mounts = [
        { path: spec.volumes[0].mountPath, volume: spec.volumes[0].id },
      ];
    }
    return config;
  }

  const makeHandle = (machine: FlyMachine): DriverHandle<FlyMachine> => {
    const { id } = machine;

    const findService = async (ctx: CallContext, port: number) => {
      const m = await getMachine(ctx, id);
      return {
        machine: m,
        svc: machineConfig(m).services?.find((s) => s.internal_port === port),
      };
    };

    const previewFor = (svc: FlyService): Preview => {
      const pub = publicPort(svc);
      return {
        auth: { headers: { "fly-force-instance-id": id }, type: "header" },
        port: svc.internal_port,
        url: `https://${appHost}${pub === 443 ? "" : `:${pub}`}`,
      };
    };

    const updateConfig = async (ctx: CallContext, config: FlyMachineConfig) => {
      await api(ctx, "POST", mpath(id), { config });
      // A config update restarts the machine; wait until it serves again.
      await waitFor(ctx, id, "started");
    };

    return {
      id,
      name: machine.name,
      raw: machine,

      async getInfo(ctx) {
        return toInfo(await getMachine(ctx, id));
      },
      async destroy(ctx) {
        await api(ctx, "DELETE", mpath(id, "?force=true"));
      },
      async stop(ctx) {
        await api(ctx, "POST", mpath(id, "/stop"));
      },
      async pause(ctx) {
        await api(ctx, "POST", mpath(id, "/suspend"));
      },
      async resume(ctx) {
        await api(ctx, "POST", mpath(id, "/start"));
        await waitFor(ctx, id, "started");
      },

      exec(cmd: string, options: ExecOptions, ctx: CallContext): DriverExec {
        const queue = new AsyncQueue<OutputEvent>();
        const marker = `sbox-${globalThis.crypto.randomUUID().slice(0, 12)}`;
        const ac = new AbortController();
        ctx.signal?.addEventListener("abort", () => ac.abort(), { once: true });
        let done = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (fn: () => void) => {
          if (done) {
            return;
          }
          done = true;
          if (timer) {
            clearTimeout(timer);
          }
          fn();
        };
        const killRemote = async () => {
          const procs = await listProcs(ctx, id).catch(() => []);
          for (const p of procs) {
            if (p.command.includes(marker)) {
              await killTree(ctx, id, p.pid);
            }
          }
        };
        const { timeoutMs } = options;
        const timeoutSec = timeoutMs
          ? Math.min(Math.ceil(timeoutMs / 1000) + 1, MAX_EXEC_SEC)
          : execDefaultSec;
        if (timeoutMs !== undefined && timeoutMs > 0) {
          timer = setTimeout(() => {
            finish(() =>
              queue.fail(
                new SandboxError(
                  "Timeout",
                  `command timed out after ${timeoutMs}ms`,
                  { provider: P, timedOut: true }
                )
              )
            );
            void killRemote().finally(() => ac.abort());
          }, timeoutMs);
        }
        const stdin =
          typeof options.stdin === "string"
            ? options.stdin
            : options.stdin instanceof Uint8Array
              ? new TextDecoder().decode(options.stdin)
              : undefined;
        // `$0` = marker, so /ps can find (and kill) this exact command.
        void execOnce(ctx, id, ["sh", "-c", cmd, marker], {
          signal: ac.signal,
          stdin,
          timeoutSec,
        })
          .then((r) =>
            finish(() => {
              if (r.stdout) {
                queue.push({ data: r.stdout, type: "stdout" });
              }
              if (r.stderr) {
                queue.push({ data: r.stderr, type: "stderr" });
              }
              const code =
                r.exit_code ?? (r.exit_signal ? 128 + r.exit_signal : 0);
              queue.push({ exitCode: code, type: "exit" });
              queue.close();
            })
          )
          .catch((error: unknown) =>
            finish(() => queue.fail(mapFlyError(error) ?? error))
          );
        return {
          async kill() {
            await killRemote();
            finish(() => {
              queue.push({ exitCode: 137, signal: "SIGKILL", type: "exit" });
              queue.close();
            });
            ac.abort();
          },
          pid: Promise.resolve(marker),
          [Symbol.asyncIterator]: () => queue.iterator(),
        };
      },

      async listProcesses(ctx): Promise<ProcessInfo[]> {
        return (await listProcs(ctx, id)).map((p) => ({
          cmd: p.command,
          id: String(p.pid),
        }));
      },
      async killProcess(processId, signal, ctx) {
        // `/signal` only reaches the machine's main process, so arbitrary
        // pids are signalled from inside the machine.
        const pid = /^\d+$/.test(processId)
          ? Number(processId)
          : (await listProcs(ctx, id)).find((p) =>
              p.command.includes(processId)
            )?.pid;
        if (pid === undefined) {
          throw new SandboxError("NotFound", `no process ${processId}`, {
            provider: P,
          });
        }
        await killTree(ctx, id, pid, signal ?? "KILL");
      },

      async readFile(path, ctx) {
        let r: FlyExecResponse;
        try {
          r = await execOnce(ctx, id, ["base64", path]);
        } catch (error) {
          // Output too large for one /exec response: read it in chunks.
          if (error instanceof SandboxError && error.status === 413) {
            return readChunked(ctx, path);
          }
          throw error;
        }
        if ((r.exit_code ?? 1) !== 0) {
          throw new SandboxError(
            /directory/i.test(r.stderr ?? "") ? "Validation" : "NotFound",
            `cannot read '${path}': ${(r.stderr ?? "").trim() || "no such file"}`,
            { provider: P }
          );
        }
        return base64ToBytes(r.stdout ?? "");
      },
      async writeFile(path, data, ctx) {
        // Payload travels in the request's `stdin` field (not argv), chunked.
        const dir = dirname(path);
        let offset = 0;
        do {
          const chunk = data.subarray(offset, offset + FILE_CHUNK);
          const op = offset === 0 ? ">" : ">>";
          const script =
            offset === 0
              ? `mkdir -p ${sq(dir)} && base64 -d ${op} ${sq(path)}`
              : `base64 -d ${op} ${sq(path)}`;
          const r = await execOnce(ctx, id, ["sh", "-c", script], {
            stdin: bytesToBase64(chunk),
          });
          if ((r.exit_code ?? 1) !== 0) {
            throw new SandboxError(
              "Provider",
              `write failed: '${path}': ${(r.stderr ?? "").trim()}`,
              { provider: P }
            );
          }
          offset += FILE_CHUNK;
        } while (offset < data.length);
      },

      async exposePort(port, _o, ctx) {
        const found = await findService(ctx, port);
        if (found.svc) {
          return previewFor(found.svc);
        }
        const config = machineConfig(found.machine);
        const services = servicesWithPort(config.services ?? [], port);
        await updateConfig(ctx, { ...config, services });
        return previewFor(services.find((s) => s.internal_port === port)!);
      },
      async unexposePort(port, ctx) {
        const found = await findService(ctx, port);
        if (!found.svc) {
          return;
        }
        const config = machineConfig(found.machine);
        await updateConfig(ctx, {
          ...config,
          services: (config.services ?? []).filter(
            (s) => s.internal_port !== port
          ),
        });
      },
      async listPorts(ctx) {
        const m = await getMachine(ctx, id);
        return (machineConfig(m).services ?? []).map(previewFor);
      },
      async proxyFetch(port, path, init, ctx) {
        const { svc } = await findService(ctx, port);
        if (!svc) {
          throw new SandboxError(
            "Validation",
            `port ${port} has no Fly service; call ports.expose(${port}) first`,
            { provider: P }
          );
        }
        const preview = previewFor(svc);
        const headers = new Headers(init?.headers);
        headers.set("fly-force-instance-id", id);
        return doFetch(ctx)(new URL(path ?? "/", preview.url).toString(), {
          ...init,
          headers,
        });
      },
    };

    async function readChunked(
      ctx: CallContext,
      path: string
    ): Promise<Uint8Array> {
      const st = await execOnce(ctx, id, ["stat", "-c", "%s", path]);
      const size = Number((st.stdout ?? "").trim());
      if ((st.exit_code ?? 1) !== 0 || !Number.isFinite(size)) {
        throw new SandboxError("NotFound", `cannot stat '${path}'`, {
          provider: P,
        });
      }
      const out = new Uint8Array(size);
      for (let i = 0; i * FILE_CHUNK < size; i++) {
        const r = await execOnce(ctx, id, [
          "sh",
          "-c",
          `dd if=${sq(path)} bs=${FILE_CHUNK} skip=${i} count=1 2>/dev/null | base64`,
        ]);
        out.set(base64ToBytes(r.stdout ?? ""), i * FILE_CHUNK);
      }
      return out;
    }
  };

  async function* listMachines(
    ctx: CallContext,
    filter: ListFilter | undefined,
    extraQuery: Record<string, string> = {}
  ): AsyncGenerator<FlyMachine> {
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ limit: "1000", ...extraQuery });
      for (const [k, v] of Object.entries(filter?.metadata ?? {})) {
        q.set(`metadata.${k}`, v);
      }
      const stateQ = filter?.state ? STATE_QUERY[filter.state] : undefined;
      if (stateQ) {
        q.set("state", stateQ);
      }
      if (cursor) {
        q.set("cursor", cursor);
      }
      const res = await raw(ctx, "GET", `/apps/${app}/machines?${q}`);
      const page = ((await res.json()) as FlyMachine[]) ?? [];
      yield* page;
      cursor = res.headers.get("fly-next-cursor") ?? undefined;
    } while (cursor);
  }

  const volumes: DriverVolumes = {
    async create(spec, ctx) {
      const region = spec.region ?? opts.region;
      if (!region) {
        throw new SandboxError(
          "Validation",
          "fly volumes need a region (VolumeSpec.region or the region option)",
          { provider: P }
        );
      }
      const v = await api<FlyVolume>(ctx, "POST", `/apps/${app}/volumes`, {
        name: spec.name
          .toLowerCase()
          .replaceAll(/[^a-z0-9_]/g, "_")
          .slice(0, 30),
        region,
        size_gb: Math.max(1, Math.ceil((spec.sizeMB ?? 1024) / 1024)),
      });
      return toVolume(v);
    },
    async delete(volId, ctx) {
      await api(
        ctx,
        "DELETE",
        `/apps/${app}/volumes/${encodeURIComponent(volId)}`
      );
    },
    async get(idOrName, ctx) {
      if (idOrName.startsWith("vol_")) {
        try {
          return toVolume(
            await api<FlyVolume>(
              ctx,
              "GET",
              `/apps/${app}/volumes/${encodeURIComponent(idOrName)}`
            )
          );
        } catch (error) {
          if (error instanceof SandboxError && error.code === "NotFound") {
            return undefined;
          }
          throw error;
        }
      }
      for await (const v of volumes.list(ctx)) {
        if (v.name === idOrName) {
          return v;
        }
      }
      return undefined;
    },
    async *list(ctx) {
      let cursor: string | undefined;
      do {
        const q = new URLSearchParams({ limit: "1000" });
        if (cursor) {
          q.set("cursor", cursor);
        }
        const res = await raw(ctx, "GET", `/apps/${app}/volumes?${q}`);
        for (const v of ((await res.json()) as FlyVolume[]) ?? []) {
          if (v.state !== "destroyed" && v.state !== "pending_destroy") {
            yield toVolume(v);
          }
        }
        cursor = res.headers.get("fly-next-cursor") ?? undefined;
      } while (cursor);
    },
  };

  const provider: SandboxProvider<FlyCaps, FlyMachine> = {
    capabilities: FLY_CAPS,
    flags,
    mapError: mapFlyError,
    name: P,
    volumes,

    async create(spec, ctx) {
      // Idempotency: a retried create with the same key finds the machine it
      // already made (Fly machine names are not unique, so use metadata).
      if (ctx.idempotencyKey) {
        for await (const m of listMachines(ctx, {
          metadata: { [IDEM_KEY]: ctx.idempotencyKey },
        })) {
          if (mapFlyState(m.state) !== "destroyed") {
            await waitFor(ctx, m.id, "started").catch(() => {});
            return makeHandle(m);
          }
        }
      }
      const config = buildConfig(spec, ctx);
      const minSecrets = await applySecrets(ctx, spec);
      const machine = await api<FlyMachine>(
        ctx,
        "POST",
        `/apps/${app}/machines`,
        {
          config,
          ...(minSecrets === undefined
            ? {}
            : { min_secrets_version: minSecrets }),
          ...(spec.name ? { name: spec.name } : {}),
          region: spec.region ?? opts.region,
        }
      );
      await waitFor(ctx, machine.id, "started");
      return makeHandle(machine);
    },

    async connect(id, ctx) {
      return makeHandle(await getMachine(ctx, id));
    },

    async *list(filter, ctx) {
      let n = 0;
      for await (const m of listMachines(ctx, filter)) {
        const info = toInfo(m);
        if (info.state === "destroyed" && filter?.state !== "destroyed") {
          continue;
        }
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
    },

    async verify(ctx) {
      const a = await api<{ organization?: { slug?: string } }>(
        ctx,
        "GET",
        `/apps/${app}`
      );
      return { account: a?.organization?.slug ?? opts.appName };
    },
  };
  return provider;
});

function toVolume(v: FlyVolume): VolumeInfo {
  return {
    createdAt: v.created_at ? new Date(v.created_at) : undefined,
    id: v.id,
    name: v.name,
    raw: v,
    region: v.region,
    sizeMB: v.size_gb === undefined ? undefined : v.size_gb * 1024,
  };
}
