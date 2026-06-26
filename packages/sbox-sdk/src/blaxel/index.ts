/**
 * `sbox-sdk/blaxel` — adapter for Blaxel (`@blaxel/core`, `SandboxInstance`).
 * Blaxel is the "perpetual sandbox" platform: a sandbox stays in standby
 * indefinitely and resumes in sub-25ms on the next request, so there is no
 * explicit pause/resume — `destroy()` deletes it. exec is the buffered
 * `process.exec({ command, waitForCompletion: true })`; it has no per-command env
 * (only `workingDir`), so the core folds cwd+env into a `cd … && KEY=v …` wrapper
 * (`perCommandEnvCwd: false`). Filesystem uses the binary-safe `fs.readBinary` /
 * `fs.writeBinary`; directory ops the core can't get from those are polyfilled via
 * exec. Ports are preview URLs (`previews.createIfNotExists`, public or private).
 * Requires the optional peer dependency `@blaxel/core`.
 */
import {
  AsyncQueue,
  defineProvider,
  SandboxError,
} from "../adapter/index.js";
import type {
  CapabilityFlags,
  CapabilityMap,
  DirEntry,
  DriverExec,
  DriverHandle,
  ExecOptions,
  OutputEvent,
  Preview,
  SandboxInfo,
  SandboxProvider,
  SandboxSpec,
  SandboxState,
} from "../adapter/index.js";

export interface BlaxelOptions {
  /** Blaxel API key (falls back to BL_API_KEY in the environment). */
  apiKey?: string;
  /** Blaxel workspace (falls back to BL_WORKSPACE in the environment). */
  workspace?: string;
  /** Default sandbox image when a spec omits `template`. */
  image?: string;
  /** Default memory (MB) for new sandboxes. */
  memory?: number;
  region?: string;
}

export const BLAXEL_CAPS = {
  background: "unsupported",
  codeInterpreter: "unsupported",
  egressControl: "unsupported",
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "unsupported",
  fork: "unsupported",
  gpu: "unsupported",
  killProcess: "unsupported",
  list: "native",
  metrics: "unsupported",
  pause: "unsupported",
  privatePreview: "native",
  proxiedFetch: "unsupported",
  pty: "unsupported",
  region: "native",
  secretsVault: "unsupported",
  setTimeout: "unsupported",
  snapshot: "unsupported",
  ssh: "unsupported",
  statefulKernel: "unsupported",
  stdin: "unsupported",
  stop: "unsupported",
  streaming: "emulated",
  volumes: "native",
} as const satisfies CapabilityMap;

export type BlaxelCaps = typeof BLAXEL_CAPS;

const BLAXEL_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: false, // process.exec has no per-call env — core wraps it
  preservesDiskOnStop: true, // standby preserves disk + memory automatically
  preservesMemoryOnPause: true,
  previewModel: "subdomain",
};

// Structural views of the `@blaxel/core` SandboxInstance surface.
interface BlaxelProcessResult {
  pid?: string;
  exitCode?: number;
  status?: string;
  logs?: string;
  stdout?: string;
}
interface BlaxelLs {
  subdirectories?: ({ path?: string; name?: string } | string)[];
  files?: ({ path?: string; name?: string } | string)[];
}
interface BlaxelInstance {
  metadata?: { name?: string; status?: string };
  status?: string;
  process: {
    exec(opts: {
      command: string;
      workingDir?: string;
      waitForCompletion?: boolean;
      timeout?: number;
    }): Promise<BlaxelProcessResult>;
    kill(name: string): Promise<void>;
  };
  fs: {
    readBinary(path: string): Promise<Blob | Uint8Array | ArrayBuffer>;
    writeBinary(path: string, data: Uint8Array): Promise<void>;
    mkdir(path: string): Promise<void>;
    ls(path: string): Promise<BlaxelLs>;
  };
  previews: {
    createIfNotExists(opts: {
      metadata: { name: string };
      spec: { port: number; public: boolean; prefixUrl?: string };
    }): Promise<{ spec?: { url?: string } }>;
  };
  delete(): Promise<void>;
}
interface BlaxelStatic {
  createIfNotExists(opts: Record<string, unknown>): Promise<BlaxelInstance>;
  get(name: string): Promise<BlaxelInstance>;
  list(): Promise<BlaxelInstance[]>;
  delete(name: string): Promise<void>;
}

type BlaxelModule = { SandboxInstance: BlaxelStatic };
let cached: BlaxelModule | null = null;
async function loadBlaxel(): Promise<BlaxelModule> {
  if (!cached) {
    cached = (await import("@blaxel/core")) as unknown as BlaxelModule;
  }
  return cached;
}

function mapState(state: string | undefined): SandboxState {
  switch ((state ?? "").toUpperCase()) {
    case "DEPLOYED":
    case "RUNNING": {
      return "running";
    }
    case "STANDBY":
    case "SUSPENDED": {
      return "paused";
    }
    case "DEPLOYING":
    case "PENDING": {
      return "creating";
    }
    case "DELETED": {
      return "destroyed";
    }
    default: {
      return "unknown";
    }
  }
}

async function toBytes(
  data: Blob | Uint8Array | ArrayBuffer
): Promise<Uint8Array> {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(await data.arrayBuffer());
}

function entryName(e: { path?: string; name?: string } | string): string {
  if (typeof e === "string") {
    return e;
  }
  return e.name ?? (e.path ? e.path.split("/").pop() ?? e.path : "");
}

export const blaxel = defineProvider<BlaxelCaps, BlaxelInstance, BlaxelOptions>(
  (opts) => {
    const ensureAuth = (): void => {
      if (opts.apiKey) {
        process.env.BL_API_KEY ??= opts.apiKey;
      }
      if (opts.workspace) {
        process.env.BL_WORKSPACE ??= opts.workspace;
      }
    };

    const makeHandle = (inst: BlaxelInstance): DriverHandle<BlaxelInstance> => {
      const name = inst.metadata?.name ?? "";

      return {
        id: name,
        name,
        raw: inst,

        getInfo(): SandboxInfo {
          return {
            id: name,
            name,
            state: mapState(inst.metadata?.status ?? inst.status),
            provider: "blaxel",
            metadata: {},
            raw: inst,
          };
        },
        async destroy(): Promise<void> {
          await inst.delete();
        },

        exec(cmd: string): DriverExec {
          const queue = new AsyncQueue<OutputEvent>();
          void inst.process
            .exec({ command: cmd, waitForCompletion: true })
            .then((r) => {
              const out = r.logs ?? r.stdout ?? "";
              if (out) {
                queue.push({ type: "stdout", data: out });
              }
              queue.push({ type: "exit", exitCode: r.exitCode ?? 0 });
              queue.close();
            })
            .catch((error) =>
              queue.fail(
                error instanceof SandboxError
                  ? error
                  : SandboxError.wrap(error, "blaxel")
              )
            );
          return {
            pid: Promise.resolve(""),
            async kill() {
              /* exec runs with waitForCompletion; no kill handle */
            },
            [Symbol.asyncIterator]: () => queue.iterator(),
          };
        },

        async readFile(path: string): Promise<Uint8Array> {
          return toBytes(await inst.fs.readBinary(path));
        },
        async writeFile(path: string, data: Uint8Array): Promise<void> {
          await inst.fs.writeBinary(path, data);
        },
        async mkdir(path: string): Promise<void> {
          await inst.fs.mkdir(path);
        },
        async listDir(path: string): Promise<DirEntry[]> {
          const ls = await inst.fs.ls(path);
          const base = path.replace(/\/$/, "");
          const dirs = (ls.subdirectories ?? []).map((d) => {
            const nm = entryName(d);
            return { name: nm, path: `${base}/${nm}`, type: "dir" as const };
          });
          const files = (ls.files ?? []).map((f) => {
            const nm = entryName(f);
            return { name: nm, path: `${base}/${nm}`, type: "file" as const };
          });
          return [...dirs, ...files];
        },

        async exposePort(
          port: number,
          portOpts: { private?: boolean }
        ): Promise<Preview> {
          const preview = await inst.previews.createIfNotExists({
            metadata: { name: `sbox-${port}` },
            spec: { port, public: !portOpts.private },
          });
          return { url: preview.spec?.url ?? "", port };
        },
      };
    };

    const provider: SandboxProvider<BlaxelCaps, BlaxelInstance> = {
      name: "blaxel",
      capabilities: BLAXEL_CAPS,
      flags: BLAXEL_FLAGS,

      async create(spec: SandboxSpec): Promise<DriverHandle<BlaxelInstance>> {
        ensureAuth();
        const mod = await loadBlaxel();
        const name =
          spec.name ?? `sbox-${globalThis.crypto.randomUUID().slice(0, 8)}`;
        const inst = await mod.SandboxInstance.createIfNotExists({
          name,
          image: spec.template ?? opts.image ?? "blaxel/prod-base:latest",
          memory: spec.resources?.memoryMB ?? opts.memory ?? 2048,
          region: spec.region ?? opts.region,
          ports: spec.ports?.map((p) => ({ target: p, protocol: "HTTP" })),
          labels: spec.metadata,
          ttl: spec.ttlMs ? `${Math.ceil(spec.ttlMs / 1000)}s` : undefined,
          volumes: spec.volumes?.map((v) => ({
            name: v.id,
            mountPath: v.mountPath,
            readOnly: v.readOnly ?? false,
          })),
        });
        return makeHandle(inst);
      },

      async connect(id: string): Promise<DriverHandle<BlaxelInstance>> {
        ensureAuth();
        const mod = await loadBlaxel();
        return makeHandle(await mod.SandboxInstance.get(id));
      },

      async *list(): AsyncIterable<SandboxInfo> {
        ensureAuth();
        const mod = await loadBlaxel();
        for (const inst of await mod.SandboxInstance.list()) {
          const name = inst.metadata?.name ?? "";
          yield {
            id: name,
            name,
            state: mapState(inst.metadata?.status ?? inst.status),
            provider: "blaxel",
            metadata: {},
            raw: inst,
          };
        }
      },
    };
    return provider;
  }
);
