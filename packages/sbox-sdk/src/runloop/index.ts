/**
 * `sbox-sdk/runloop` — adapter for the Runloop devbox API (`@runloop/api-client`).
 * A "sandbox" is a Runloop devbox. exec is the buffered `devboxes.executeSync`
 * (`{ stdout, stderr, exit_status }`); the devbox applies cwd/env via a shell, so
 * the core folds them into a `cd … && KEY=v …` wrapper (`perCommandEnvCwd:
 * false`). Files use the binary-safe `downloadFile`/`uploadFile` endpoints.
 * Lifecycle: `suspend`/`resume` = pause (memory preserved), `shutdown` = destroy.
 * Snapshots map to `snapshotDisk`; `fork()` snapshots then boots N devboxes from
 * it (in-place restore is unsupported). Ports are tunnels (`enableTunnel`).
 * Requires the optional peer dependency `@runloop/api-client`.
 */
import {
  AsyncQueue,
  defineProvider,
  SandboxError,
} from "../adapter/index.js";
import type {
  CapabilityFlags,
  CapabilityMap,
  DriverExec,
  DriverHandle,
  ExecOptions,
  OutputEvent,
  Preview,
  SandboxInfo,
  SandboxProvider,
  SandboxSpec,
  SandboxState,
  SnapshotRef,
} from "../adapter/index.js";

export interface RunloopOptions {
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
} as const satisfies CapabilityMap;

export type RunloopCaps = typeof RUNLOOP_CAPS;

const RUNLOOP_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: false, // executeSync has no cwd/env — core wraps `cd && KEY=v`
  preservesDiskOnStop: false,
  preservesMemoryOnPause: true, // suspend preserves memory
  previewModel: "subdomain",
};

// Structural views of the Stainless-generated `@runloop/api-client` surface.
interface DevboxView {
  id: string;
  status?: string;
}
interface ExecDetail {
  stdout?: string;
  stderr?: string;
  exit_status?: number;
}
interface TunnelView {
  url: string;
}
interface SnapshotView {
  id: string;
  name?: string;
}
interface RunloopClient {
  devboxes: {
    create(params: Record<string, unknown>): Promise<DevboxView>;
    retrieve(id: string): Promise<DevboxView>;
    list(params?: Record<string, unknown>): Promise<{ devboxes?: DevboxView[] }>;
    executeSync(
      id: string,
      params: { command: string; shell_name?: string }
    ): Promise<ExecDetail>;
    shutdown(id: string): Promise<DevboxView>;
    suspend(id: string): Promise<DevboxView>;
    resume(id: string): Promise<DevboxView>;
    snapshotDisk(id: string, params: { name?: string }): Promise<SnapshotView>;
    uploadFile(
      id: string,
      params: { path: string; file: Uint8Array }
    ): Promise<unknown>;
    downloadFile(id: string, params: { path: string }): Promise<Response>;
    enableTunnel(id: string, params: { port: number }): Promise<TunnelView>;
    removeTunnel(id: string, params: { port: number }): Promise<unknown>;
  };
}

type RunloopModule = { default: new (opts: Record<string, unknown>) => RunloopClient };
let cached: RunloopModule | null = null;
async function loadRunloop(): Promise<RunloopModule> {
  if (!cached) {
    cached = (await import("@runloop/api-client")) as unknown as RunloopModule;
  }
  return cached;
}

function mapState(state: string | undefined): SandboxState {
  switch ((state ?? "").toLowerCase()) {
    case "running": {
      return "running";
    }
    case "suspended":
    case "suspending": {
      return "paused";
    }
    case "provisioning":
    case "initializing": {
      return "creating";
    }
    case "shutdown":
    case "failure": {
      return state === "failure" ? "error" : "destroyed";
    }
    default: {
      return "unknown";
    }
  }
}

export const runloop = defineProvider<RunloopCaps, DevboxView, RunloopOptions>(
  (opts) => {
    let clientP: Promise<RunloopClient> | null = null;
    const getClient = (): Promise<RunloopClient> => {
      if (!clientP) {
        clientP = loadRunloop().then(
          (mod) =>
            new mod.default({
              bearerToken: opts.apiKey,
              baseURL: opts.baseURL,
            })
        );
      }
      return clientP;
    };

    const makeHandle = (
      devbox: DevboxView,
      client: RunloopClient
    ): DriverHandle<DevboxView> => {
      const { id } = devbox;

      return {
        id,
        raw: devbox,

        getInfo(): SandboxInfo {
          return {
            id,
            state: mapState(devbox.status),
            provider: "runloop",
            metadata: {},
            raw: devbox,
          };
        },
        async destroy(): Promise<void> {
          await client.devboxes.shutdown(id);
        },
        async pause(): Promise<void> {
          await client.devboxes.suspend(id);
        },
        async resume(): Promise<void> {
          await client.devboxes.resume(id);
        },

        exec(cmd: string): DriverExec {
          const queue = new AsyncQueue<OutputEvent>();
          void client.devboxes
            .executeSync(id, { command: cmd })
            .then((r) => {
              if (r.stdout) {
                queue.push({ type: "stdout", data: r.stdout });
              }
              if (r.stderr) {
                queue.push({ type: "stderr", data: r.stderr });
              }
              queue.push({ type: "exit", exitCode: r.exit_status ?? 0 });
              queue.close();
            })
            .catch((error) =>
              queue.fail(
                error instanceof SandboxError
                  ? error
                  : SandboxError.wrap(error, "runloop")
              )
            );
          return {
            pid: Promise.resolve(""),
            async kill() {
              /* executeSync is buffered; no kill handle */
            },
            [Symbol.asyncIterator]: () => queue.iterator(),
          };
        },

        async readFile(path: string): Promise<Uint8Array> {
          const res = await client.devboxes.downloadFile(id, { path });
          return new Uint8Array(await res.arrayBuffer());
        },
        async writeFile(path: string, data: Uint8Array): Promise<void> {
          await client.devboxes.uploadFile(id, { path, file: data });
        },

        async exposePort(port: number): Promise<Preview> {
          const tunnel = await client.devboxes.enableTunnel(id, { port });
          return { url: tunnel.url, port };
        },
        async unexposePort(port: number): Promise<void> {
          await client.devboxes.removeTunnel(id, { port });
        },

        async snapshot(snapOpts: { name?: string }): Promise<SnapshotRef> {
          const snap = await client.devboxes.snapshotDisk(id, {
            name: snapOpts.name,
          });
          return {
            id: snap.id,
            name: snap.name ?? snapOpts.name,
            provider: "runloop",
            raw: snap,
          };
        },
        async fork(count: number): Promise<DriverHandle<DevboxView>[]> {
          // Runloop has no in-place fork: snapshot the disk, then boot N devboxes
          // from that snapshot.
          const snap = await client.devboxes.snapshotDisk(id, {});
          const forks = await Promise.all(
            Array.from({ length: count }, () =>
              client.devboxes.create({ snapshot_id: snap.id })
            )
          );
          return forks.map((d) => makeHandle(d, client));
        },
      };
    };

    const provider: SandboxProvider<RunloopCaps, DevboxView> = {
      name: "runloop",
      capabilities: RUNLOOP_CAPS,
      flags: RUNLOOP_FLAGS,

      async create(spec: SandboxSpec): Promise<DriverHandle<DevboxView>> {
        const client = await getClient();
        const tpl = spec.template ?? opts.blueprintId;
        const params: Record<string, unknown> = {
          name: spec.name,
          environment_variables: spec.env,
        };
        // A snapshot id restores disk state; otherwise treat the template as a
        // blueprint id.
        if (tpl) {
          if (/^snp|snapshot/i.test(tpl)) {
            params.snapshot_id = tpl;
          } else {
            params.blueprint_id = tpl;
          }
        }
        const devbox = await client.devboxes.create(params);
        // Best-effort wait for the devbox to finish provisioning.
        for (let i = 0; i < 30 && devbox.status !== "running"; i++) {
          const got = await client.devboxes.retrieve(devbox.id).catch(() => null);
          if (!got) {
            break;
          }
          devbox.status = got.status;
          if (got.status === "running" || got.status === "failure") {
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        return makeHandle(devbox, client);
      },

      async connect(id: string): Promise<DriverHandle<DevboxView>> {
        const client = await getClient();
        return makeHandle(await client.devboxes.retrieve(id), client);
      },

      async *list(): AsyncIterable<SandboxInfo> {
        const client = await getClient();
        const page = await client.devboxes.list();
        for (const d of page.devboxes ?? []) {
          yield {
            id: d.id,
            state: mapState(d.status),
            provider: "runloop",
            metadata: {},
            raw: d,
          };
        }
      },
    };
    return provider;
  }
);
