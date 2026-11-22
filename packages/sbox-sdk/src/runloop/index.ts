/**
 * `sbox-sdk/runloop`: adapter for the Runloop devbox API (`@runloop/api-client`).
 *
 * **Deprecated.** Runloop is winding down: support for existing customers ended
 * on 2026-11-13. This adapter only receives crash/leak fixes and will be
 * removed in sbox-sdk 0.2.0.
 *
 * A "sandbox" is a Runloop devbox. exec is `executeAndAwaitCompletion` (the
 * devbox runs it through a shell, so the core folds cwd/env into a wrapper:
 * `perCommandEnvCwd: false`). Files use the binary-safe `downloadFile` /
 * `uploadFile` endpoints. `suspend`/`resume` = pause (memory preserved),
 * `shutdown` = destroy. Snapshots map to `snapshotDisk`; `fork()` snapshots then
 * boots N devboxes from it. Ports share the devbox's single V2 tunnel
 * (`https://{port}-{tunnel_key}.tunnel.runloop.ai`).
 *
 * Requires the optional peer dependency `@runloop/api-client`.
 */
import type { Runloop } from "@runloop/api-client";

import { AsyncQueue, defineProvider, SandboxError } from "../adapter/index.js";
import type {
  CallContext,
  CapabilityFlags,
  CapabilityMap,
  DriverExec,
  DriverHandle,
  ExecOptions,
  OutputEvent,
  Preview,
  ResolvedSandboxSpec,
  SandboxInfo,
  SandboxProvider,
  SandboxState,
  SnapshotRef,
} from "../adapter/index.js";

type Mod = typeof import("@runloop/api-client");
type RunloopClient = InstanceType<Mod["default"]>;
/** The SDK's devbox view (`raw()` on a Runloop sandbox). */
export type DevboxView = Runloop.DevboxView;
type TunnelView = Runloop.TunnelView;
type DevboxCreateParams = Runloop.DevboxCreateParams;

export interface RunloopOptions {
  /** Runloop API key. Defaults to `RUNLOOP_API_KEY`. */
  apiKey?: string;
  /** Override the API base URL (default uses the SDK default). */
  baseURL?: string;
  /** Default blueprint id used when `spec.template` is not provided. */
  blueprintId?: string;
}

export const RUNLOOP_CAPS = {
  background: "unsupported",
  codeInterpreter: "unsupported",
  egressControl: "unsupported",
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "unsupported",
  fork: "native",
  gpu: "unsupported",
  killProcess: "unsupported",
  list: "native",
  metrics: "unsupported",
  pause: "native",
  privatePreview: "unsupported",
  proxiedFetch: "unsupported",
  pty: "unsupported",
  region: "unsupported",
  secretsVault: "unsupported",
  setTimeout: "unsupported",
  snapshot: "native",
  ssh: "unsupported",
  statefulKernel: "unsupported",
  stdin: "unsupported",
  stop: "unsupported",
  streaming: "emulated",
  volumes: "unsupported",
  templateBuild: "unsupported",
} as const satisfies CapabilityMap;

export type RunloopCaps = typeof RUNLOOP_CAPS;

const RUNLOOP_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: false, // execute has no cwd/env: core wraps `cd && KEY=v`
  preservesDiskOnStop: false,
  preservesMemoryOnPause: true, // suspend preserves memory
  previewModel: "tunnel",
};

const PROVIDER = "runloop";

let cached: Mod | null = null;
async function loadRunloop(): Promise<Mod> {
  cached ??= await import("@runloop/api-client");
  return cached;
}

let warned = false;
function warnDeprecated(): void {
  if (!warned) {
    warned = true;
    console.warn(
      "[sbox] sbox-sdk/runloop is deprecated: Runloop ended customer support on 2026-11-13. The adapter will be removed in sbox-sdk 0.2.0."
    );
  }
}

/** Runloop devbox status (+ execution `queued`) -> SandboxState. */
export function mapRunloopState(state: string | undefined): SandboxState {
  switch (state) {
    case "running": {
      return "running";
    }
    case "suspending": {
      return "suspending";
    }
    case "suspended": {
      return "paused";
    }
    case "queued":
    case "scheduled":
    case "provisioning":
    case "initializing":
    case "resuming": {
      return "creating";
    }
    case "failure": {
      return "error";
    }
    case "shutdown": {
      return "destroyed";
    }
    default: {
      return "unknown";
    }
  }
}

/** Stainless `APIError`s carry `status`; long-poll failures are timeouts. */
export function mapRunloopError(err: unknown): SandboxError | undefined {
  if (err instanceof SandboxError) {
    return err;
  }
  if (!(err instanceof Error)) {
    return undefined;
  }
  const opts = { cause: err, provider: PROVIDER };
  if (
    err.name === "PollingTimeoutError" ||
    err.name === "APIConnectionTimeoutError" ||
    err.name === "AbortError"
  ) {
    return new SandboxError("Timeout", err.message, opts);
  }
  const status = (err as { status?: unknown }).status;
  if (typeof status !== "number") {
    return undefined;
  }
  const init = { ...opts, status };
  if (status === 401 || status === 403) {
    return new SandboxError("Unauthorized", err.message, init);
  }
  if (status === 404) {
    return new SandboxError("NotFound", err.message, init);
  }
  if (status === 409) {
    return new SandboxError("Conflict", err.message, init);
  }
  if (status === 429) {
    return new SandboxError("QuotaExceeded", err.message, {
      ...init,
      retryable: true,
    });
  }
  if (status === 408) {
    return new SandboxError("Timeout", err.message, init);
  }
  if (status === 400 || status === 422) {
    return new SandboxError("Validation", err.message, init);
  }
  return new SandboxError("Provider", err.message, init);
}

const wrap = (e: unknown): SandboxError =>
  mapRunloopError(e) ?? SandboxError.wrap(e, PROVIDER);

function info(d: DevboxView): SandboxInfo {
  return {
    createdAt: d.create_time_ms ? new Date(d.create_time_ms) : undefined,
    id: d.id,
    metadata: { ...d.metadata },
    name: d.name ?? undefined,
    provider: PROVIDER,
    raw: d,
    state: mapRunloopState(d.status),
  };
}

function tunnelPreview(tunnel: TunnelView, port: number): Preview {
  const url = `https://${port}-${tunnel.tunnel_key}.tunnel.runloop.ai`;
  if (tunnel.auth_mode === "authenticated" && tunnel.auth_token) {
    return {
      auth: {
        headers: {
          "X-Runloop-Tunnel-Authorization": `Bearer ${tunnel.auth_token}`,
        },
        type: "header",
      },
      port,
      url,
    };
  }
  return { auth: { type: "public" }, port, url };
}

/**
 * @deprecated Runloop ended customer support on 2026-11-13. This adapter will
 * be removed in sbox-sdk 0.2.0.
 */
export const runloop = defineProvider<RunloopCaps, DevboxView, RunloopOptions>(
  (opts = {}) => {
    warnDeprecated();
    let clientP: Promise<RunloopClient> | null = null;
    const getClient = (): Promise<RunloopClient> => {
      clientP ??= loadRunloop().then(
        (mod) =>
          new mod.default({ baseURL: opts.baseURL, bearerToken: opts.apiKey })
      );
      return clientP;
    };

    const makeHandle = (
      initial: DevboxView,
      client: RunloopClient,
      toFile: Mod["toFile"]
    ): DriverHandle<DevboxView> => {
      const { id } = initial;
      let devbox = initial;
      const exposed = new Set<number>();

      return {
        async destroy(): Promise<void> {
          await client.devboxes.shutdown(id);
        },
        exec(cmd: string, eopts: ExecOptions, ctx: CallContext): DriverExec {
          const queue = new AsyncQueue<OutputEvent>();
          const ac = new AbortController();
          let settled = false;
          const outer = eopts.signal ?? ctx.signal;
          outer?.addEventListener("abort", () => ac.abort(), { once: true });
          void client.devboxes
            .executeAndAwaitCompletion(
              id,
              { command: cmd },
              {
                signal: ac.signal,
                ...(eopts.timeoutMs && eopts.timeoutMs > 0
                  ? { longPoll: { timeoutMs: eopts.timeoutMs } }
                  : {}),
              }
            )
            .then((r) => {
              if (settled) {
                return;
              }
              settled = true;
              if (r.stdout) {
                queue.push({ data: r.stdout, type: "stdout" });
              }
              if (r.stderr) {
                queue.push({ data: r.stderr, type: "stderr" });
              }
              queue.push({ exitCode: r.exit_status ?? 0, type: "exit" });
              queue.close();
            })
            .catch((error: unknown) => {
              if (!settled) {
                settled = true;
                queue.fail(wrap(error));
              }
            });
          return {
            [Symbol.asyncIterator]: () => queue.iterator(),
            async kill() {
              // Stops waiting on the execution. The deprecated adapter does not
              // track execution ids, so the remote command is not signalled.
              ac.abort();
              if (!settled) {
                settled = true;
                queue.push({ exitCode: 137, signal: "SIGKILL", type: "exit" });
                queue.close();
              }
            },
            pid: Promise.resolve(""),
          };
        },
        async exposePort(port: number): Promise<Preview> {
          // One tunnel per devbox serves every port; reuse it if present.
          let tunnel = devbox.tunnel;
          if (!tunnel) {
            devbox = await client.devboxes.retrieve(id);
            tunnel = devbox.tunnel;
          }
          tunnel ??= await client.devboxes.enableTunnel(id);
          devbox = { ...devbox, tunnel };
          exposed.add(port);
          return tunnelPreview(tunnel, port);
        },
        async fork(count: number): Promise<DriverHandle<DevboxView>[]> {
          // No in-place fork: snapshot the disk, then boot N devboxes from it.
          const snap = await client.devboxes.snapshotDisk(id, {});
          const forks = await Promise.all(
            Array.from({ length: count }, () =>
              client.devboxes.createAndAwaitRunning({ snapshot_id: snap.id })
            )
          );
          return forks.map((d) => makeHandle(d, client, toFile));
        },
        async getInfo(): Promise<SandboxInfo> {
          devbox = await client.devboxes.retrieve(id);
          return info(devbox);
        },
        id,
        name: initial.name ?? undefined,
        async pause(): Promise<void> {
          await client.devboxes.suspend(id);
          await client.devboxes.awaitSuspended(id);
        },
        get raw() {
          return devbox;
        },
        async readFile(path: string): Promise<Uint8Array> {
          try {
            const res = await client.devboxes.downloadFile(id, { path });
            return new Uint8Array(await res.arrayBuffer());
          } catch (error) {
            const err = wrap(error);
            // Runloop reports a missing path as a 400 with a message.
            if (
              err.code === "Validation" &&
              /not found|no such file|does not exist/i.test(err.message)
            ) {
              throw new SandboxError("NotFound", `no such file: '${path}'`, {
                cause: error,
                provider: PROVIDER,
                status: err.status,
              });
            }
            throw err;
          }
        },
        async resume(): Promise<void> {
          await client.devboxes.resume(id);
          await client.devboxes.awaitRunning(id);
        },
        async snapshot(snapOpts: { name?: string }): Promise<SnapshotRef> {
          const snap = await client.devboxes.snapshotDisk(id, {
            name: snapOpts.name,
          });
          return {
            createdAt: new Date(snap.create_time_ms),
            id: snap.id,
            includesMemory: false,
            name: snap.name ?? snapOpts.name,
            provider: PROVIDER,
            raw: snap,
          };
        },
        async unexposePort(port: number): Promise<void> {
          exposed.delete(port);
          // removeTunnel takes no port: it tears down the devbox's only tunnel,
          // so only do it once nothing else is exposed through it.
          if (exposed.size === 0) {
            await client.devboxes.removeTunnel(id);
            devbox = { ...devbox, tunnel: null };
          }
        },
        async writeFile(path: string, data: Uint8Array): Promise<void> {
          const name = path.slice(path.lastIndexOf("/") + 1) || "file";
          await client.devboxes.uploadFile(id, {
            file: await toFile(data, name),
            path,
          });
        },
      };
    };

    const provider: SandboxProvider<RunloopCaps, DevboxView> = {
      capabilities: RUNLOOP_CAPS,
      async connect(id: string): Promise<DriverHandle<DevboxView>> {
        const [client, mod] = await Promise.all([getClient(), loadRunloop()]);
        return makeHandle(
          await client.devboxes.retrieve(id),
          client,
          mod.toFile
        );
      },
      async create(
        spec: ResolvedSandboxSpec
      ): Promise<DriverHandle<DevboxView>> {
        const [client, mod] = await Promise.all([getClient(), loadRunloop()]);
        const params: DevboxCreateParams = {
          environment_variables: spec.env,
          metadata: spec.metadata,
          name: spec.name,
        };
        const tpl = spec.fromSnapshot ?? spec.template ?? opts.blueprintId;
        // A snapshot id restores disk state; otherwise it's a blueprint id.
        if (spec.fromSnapshot || (tpl && /^snp|snapshot/i.test(tpl))) {
          params.snapshot_id = tpl;
        } else if (tpl) {
          params.blueprint_id = tpl;
        }
        // Throws if the devbox fails to boot instead of handing back a
        // provisioning/failed devbox.
        const devbox = await client.devboxes.createAndAwaitRunning(params);
        return makeHandle(devbox, client, mod.toFile);
      },
      flags: RUNLOOP_FLAGS,
      async *list(filter): AsyncIterable<SandboxInfo> {
        const client = await getClient();
        let n = 0;
        // The page promise auto-paginates across every cursor page.
        for await (const d of client.devboxes.list({ limit: 100 })) {
          const i = info(d);
          if (filter?.state && i.state !== filter.state) {
            continue;
          }
          if (
            filter?.metadata &&
            !Object.entries(filter.metadata).every(
              ([k, v]) => i.metadata[k] === v
            )
          ) {
            continue;
          }
          if (filter?.limit !== undefined && n >= filter.limit) {
            return;
          }
          n++;
          yield i;
        }
      },
      mapError: mapRunloopError,
      name: PROVIDER,
      async verify() {
        const client = await getClient();
        await client.devboxes.list({ limit: 1 });
        return undefined;
      },
    };
    return provider;
  }
);
