/**
 * `sbox-sdk/morph` — adapter for MorphCloud (`morphcloud` SDK). A "sandbox" is a
 * Morph instance booted from a snapshot. Morph's model is snapshot-first: there
 * is no boot-from-image, so `create()` either starts from a snapshot id
 * (`spec.template` like `snapshot_…`) or lazily builds a snapshot from an image
 * (`imageId`) and starts that.
 *
 * exec is the buffered `instance.exec(cmd)` (no per-call cwd/env — the core folds
 * those into a `cd … && KEY=v …` wrapper via `perCommandEnvCwd: false`);
 * filesystem is done via exec + base64. Morph's marquee features map cleanly:
 * `snapshots.create()` -> `instance.snapshot()` and `snapshots.fork()` ->
 * `instance.branch()` (in-place restore is unsupported — branching makes new
 * instances). Ports are public HTTP services (`exposeHttpService`). `destroy()`
 * stops the instance. Requires the optional peer dependency `morphcloud`.
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
  CapabilityFlags,
  CapabilityMap,
  DriverExec,
  DriverHandle,
  OutputEvent,
  Preview,
  SandboxInfo,
  SandboxProvider,
  SandboxSpec,
  SandboxState,
  SnapshotRef,
} from "../adapter/index.js";

export interface MorphOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Default image to snapshot from when `spec.template` is not a snapshot id. */
  imageId?: string;
  /** Defaults applied to a lazily-created snapshot. */
  vcpus?: number;
  memory?: number;
  diskSize?: number;
}

export const MORPH_CAPS = {
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
  pause: "unsupported",
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

export type MorphCaps = typeof MORPH_CAPS;

const MORPH_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: false, // instance.exec(cmd) has no cwd/env — core wraps `cd && KEY=v`
  preservesDiskOnStop: false,
  preservesMemoryOnPause: false,
  previewModel: "subdomain",
};

// Structural views of the `morphcloud` SDK surface (avoids a hard type dep).
interface MorphExecResult {
  exitCode?: number;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
}
interface MorphSnapshot {
  id: string;
}
interface MorphHttpService {
  url: string;
}
interface MorphInstance {
  id: string;
  status?: string;
  exec(cmd: string): Promise<MorphExecResult>;
  stop(): Promise<void>;
  waitUntilReady(timeout?: number): Promise<void>;
  snapshot(): Promise<MorphSnapshot>;
  branch(count?: number): Promise<unknown>;
  exposeHttpService(name: string, port: number): Promise<MorphHttpService>;
  hideHttpService(name: string): Promise<void>;
}
interface MorphClient {
  snapshots: {
    create(opts: {
      imageId?: string;
      vcpus?: number;
      memory?: number;
      diskSize?: number;
    }): Promise<MorphSnapshot>;
  };
  instances: {
    start(opts: { snapshotId: string }): Promise<MorphInstance>;
    get(opts: { instanceId: string }): Promise<MorphInstance>;
    list(): Promise<MorphInstance[]>;
  };
}

interface MorphModule {
  MorphCloudClient: new (opts: MorphOptions) => MorphClient;
}
let cached: MorphModule | null = null;
async function loadMorph(): Promise<MorphModule> {
  if (!cached) {
    cached = (await import("morphcloud")) as unknown as MorphModule;
  }
  return cached;
}

function mapState(state: string | undefined): SandboxState {
  switch ((state ?? "").toLowerCase()) {
    case "ready":
    case "running": {
      return "running";
    }
    case "paused":
    case "saving": {
      return "paused";
    }
    case "pending":
    case "starting": {
      return "creating";
    }
    case "stopped":
    case "terminated": {
      return "destroyed";
    }
    default: {
      return "unknown";
    }
  }
}

function portServiceName(port: number): string {
  return `sbox-${port}`;
}

export const morph = defineProvider<MorphCaps, MorphInstance, MorphOptions>(
  (opts) => {
    let clientP: Promise<MorphClient> | null = null;
    const getClient = (): Promise<MorphClient> => {
      if (!clientP) {
        clientP = loadMorph().then(
          (mod) => new mod.MorphCloudClient({ ...opts })
        );
      }
      return clientP;
    };

    const makeHandle = (inst: MorphInstance): DriverHandle<MorphInstance> => {
      const exec1 = (cmd: string) => inst.exec(cmd);

      return {
        id: inst.id,
        raw: inst,

        getInfo(): SandboxInfo {
          return {
            id: inst.id,
            state: mapState(inst.status),
            provider: "morph",
            metadata: {},
            raw: inst,
          };
        },
        async destroy(): Promise<void> {
          await inst.stop();
        },

        exec(cmd: string): DriverExec {
          const queue = new AsyncQueue<OutputEvent>();
          void exec1(cmd)
            .then((r) => {
              if (r.stdout) {
                queue.push({ type: "stdout", data: r.stdout });
              }
              if (r.stderr) {
                queue.push({ type: "stderr", data: r.stderr });
              }
              queue.push({
                type: "exit",
                exitCode: r.exitCode ?? r.exit_code ?? 0,
              });
              queue.close();
            })
            .catch((error) =>
              queue.fail(
                error instanceof SandboxError
                  ? error
                  : SandboxError.wrap(error, "morph")
              )
            );
          return {
            pid: Promise.resolve(""),
            async kill() {
              /* instance.exec is buffered; no kill handle */
            },
            [Symbol.asyncIterator]: () => queue.iterator(),
          };
        },

        async readFile(path: string): Promise<Uint8Array> {
          const r = await exec1(`base64 ${sq(path)}`);
          if ((r.exitCode ?? r.exit_code ?? 1) !== 0) {
            throw new SandboxError("NotFound", `no such file: '${path}'`, {
              provider: "morph",
            });
          }
          return base64ToBytes(r.stdout ?? "");
        },
        async writeFile(path: string, data: Uint8Array): Promise<void> {
          const b64 = bytesToBase64(data);
          const r = await exec1(
            `mkdir -p "$(dirname ${sq(path)})" && printf %s ${sq(b64)} | base64 -d > ${sq(path)}`
          );
          if ((r.exitCode ?? r.exit_code ?? 1) !== 0) {
            throw new SandboxError("Provider", `write failed: '${path}'`, {
              provider: "morph",
            });
          }
        },

        async exposePort(port: number): Promise<Preview> {
          const svc = await inst.exposeHttpService(portServiceName(port), port);
          return { url: svc.url, port };
        },
        async unexposePort(port: number): Promise<void> {
          await inst.hideHttpService(portServiceName(port));
        },

        async snapshot(snapOpts: { name?: string }): Promise<SnapshotRef> {
          const snap = await inst.snapshot();
          return {
            id: snap.id,
            name: snapOpts.name,
            provider: "morph",
            raw: snap,
          };
        },
        async fork(count: number): Promise<DriverHandle<MorphInstance>[]> {
          const res = (await inst.branch(count)) as
            | MorphInstance[]
            | { instances?: MorphInstance[] };
          const instances = Array.isArray(res) ? res : (res.instances ?? []);
          return instances.map((i) => makeHandle(i));
        },
      };
    };

    const provider: SandboxProvider<MorphCaps, MorphInstance> = {
      name: "morph",
      capabilities: MORPH_CAPS,
      flags: MORPH_FLAGS,

      async create(spec: SandboxSpec): Promise<DriverHandle<MorphInstance>> {
        const client = await getClient();
        const tpl = spec.template;
        // A snapshot id boots directly; anything else is treated as an image to
        // snapshot first (Morph has no boot-from-image path).
        let snapshotId: string;
        if (tpl && /^snapshot[_-]/i.test(tpl)) {
          snapshotId = tpl;
        } else {
          const snap = await client.snapshots.create({
            imageId: tpl ?? opts.imageId ?? "morphvm-minimal",
            vcpus: spec.resources?.vcpus ?? opts.vcpus,
            memory: spec.resources?.memoryMB ?? opts.memory,
            diskSize: spec.resources?.diskMB ?? opts.diskSize,
          });
          snapshotId = snap.id;
        }
        const inst = await client.instances.start({ snapshotId });
        await inst.waitUntilReady().catch(() => {});
        return makeHandle(inst);
      },

      async connect(id: string): Promise<DriverHandle<MorphInstance>> {
        const client = await getClient();
        return makeHandle(await client.instances.get({ instanceId: id }));
      },

      async *list(): AsyncIterable<SandboxInfo> {
        const client = await getClient();
        for (const inst of await client.instances.list()) {
          yield {
            id: inst.id,
            state: mapState(inst.status),
            provider: "morph",
            metadata: {},
            raw: inst,
          };
        }
      },
    };
    return provider;
  }
);
