/**
 * `sbox-sdk/railway` — adapter for Railway Sandboxes (the `railway` SDK). A
 * "sandbox" is an ephemeral, isolated Debian Linux VM provisioned on demand.
 * This is one of the richest adapters: exec streams natively via `onStdout`/
 * `onStderr` callbacks (`streaming: native`) and returns a real exit code;
 * filesystem is native and byte-accurate (`files.read(path, { format: "bytes" })`
 * / `files.write`). `snapshot()` maps to `checkpoint()` and `fork()` to the
 * native `fork()` (clone filesystem). Sandboxes are network-isolated, so there
 * are no public preview ports. `destroy()` tears the VM down. Requires the
 * optional peer dependency `railway`.
 */
import { AsyncQueue, defineProvider, SandboxError } from "../adapter/index.js";
import type {
  CapabilityFlags,
  CapabilityMap,
  DirEntry,
  DriverExec,
  DriverHandle,
  ExecOptions,
  FileInfo,
  OutputEvent,
  SandboxInfo,
  SandboxProvider,
  SandboxSpec,
  SandboxState,
  SnapshotRef,
} from "../adapter/index.js";

export interface RailwayOptions {
  /** Railway API token (falls back to RAILWAY_API_TOKEN in the environment). */
  token?: string;
  /** Target environment id (falls back to RAILWAY_ENVIRONMENT_ID). */
  environmentId?: string;
  /** Network isolation for new sandboxes (default "ISOLATED"). */
  networkIsolation?: "ISOLATED" | "PRIVATE";
}

export const RAILWAY_CAPS = {
  background: "unsupported",
  codeInterpreter: "unsupported",
  egressControl: "unsupported",
  exposePort: "unsupported",
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
  streaming: "native",
  volumes: "unsupported",
} as const satisfies CapabilityMap;

export type RailwayCaps = typeof RAILWAY_CAPS;

const RAILWAY_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true, // exec accepts { cwd, env }
  preservesDiskOnStop: false,
  preservesMemoryOnPause: false,
  previewModel: "none", // sandboxes are network-isolated
};

// Structural views of the `railway` SDK Sandbox surface.
interface RailwayExecResult {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
}
interface RailwayFiles {
  read(
    path: string,
    opts?: { format?: "text" | "bytes" | "stream" }
  ): Promise<Uint8Array | string>;
  write(path: string, content: Uint8Array | string): Promise<void>;
  list(dir: string): Promise<{ name: string; type?: string; isDir?: boolean }[]>;
  stat(path: string): Promise<{ size?: number; isDir?: boolean; type?: string; mtime?: number }>;
  mkdir(dir: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}
interface RailwaySandbox {
  id?: string;
  sandboxId?: string;
  exec(
    command: string,
    opts?: {
      timeoutSec?: number;
      cwd?: string;
      env?: Record<string, string>;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    }
  ): Promise<RailwayExecResult>;
  files: RailwayFiles;
  fork(opts?: Record<string, unknown>): Promise<RailwaySandbox>;
  checkpoint(name: string): Promise<{ name?: string; id?: string } | string>;
  destroy(): Promise<void>;
}
interface RailwayStatic {
  create(
    template?: string,
    config?: Record<string, unknown>
  ): Promise<RailwaySandbox>;
  connect(id: string): Promise<RailwaySandbox>;
  list(): Promise<{ id: string; status?: string }[]>;
}
type RailwayModule = { Sandbox: RailwayStatic };

let cached: RailwayModule | null = null;
async function loadRailway(): Promise<RailwayModule> {
  if (!cached) {
    cached = (await import("railway")) as unknown as RailwayModule;
  }
  return cached;
}

function sandboxId(sb: RailwaySandbox): string {
  return sb.id ?? sb.sandboxId ?? "";
}

function mapState(state: string | undefined): SandboxState {
  switch ((state ?? "").toLowerCase()) {
    case "running":
    case "active": {
      return "running";
    }
    case "idle":
    case "stopped": {
      return "stopped";
    }
    case "creating":
    case "provisioning": {
      return "creating";
    }
    case "destroyed": {
      return "destroyed";
    }
    default: {
      return "unknown";
    }
  }
}

function mapType(t: string | undefined, isDir: boolean | undefined): FileInfo["type"] {
  if (isDir || t === "dir" || t === "directory") {
    return "dir";
  }
  if (t === "symlink") {
    return "symlink";
  }
  return "file";
}

export const railway = defineProvider<
  RailwayCaps,
  RailwaySandbox,
  RailwayOptions
>((opts) => {
  const config = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    token: opts.token,
    environmentId: opts.environmentId,
    ...extra,
  });

  const makeHandle = (sb: RailwaySandbox): DriverHandle<RailwaySandbox> => {
    const id = sandboxId(sb);

    return {
      id,
      raw: sb,

      getInfo(): SandboxInfo {
        return {
          id,
          state: "running",
          provider: "railway",
          metadata: {},
          raw: sb,
        };
      },
      async destroy(): Promise<void> {
        await sb.destroy();
      },

      exec(cmd: string, options: ExecOptions): DriverExec {
        const queue = new AsyncQueue<OutputEvent>();
        void sb
          .exec(cmd, {
            cwd: options.cwd,
            env: options.env,
            timeoutSec: options.timeoutMs
              ? Math.ceil(options.timeoutMs / 1000)
              : undefined,
            onStdout: (chunk) => queue.push({ type: "stdout", data: chunk }),
            onStderr: (chunk) => queue.push({ type: "stderr", data: chunk }),
          })
          .then((r) => {
            queue.push({ type: "exit", exitCode: r.exitCode ?? 0 });
            queue.close();
          })
          .catch((error) =>
            queue.fail(
              error instanceof SandboxError
                ? error
                : SandboxError.wrap(error, "railway")
            )
          );
        return {
          pid: Promise.resolve(""),
          async kill() {
            /* streaming exec; kill handle not wired in v0.1 */
          },
          [Symbol.asyncIterator]: () => queue.iterator(),
        };
      },

      async readFile(path: string): Promise<Uint8Array> {
        const data = await sb.files.read(path, { format: "bytes" });
        return typeof data === "string"
          ? new TextEncoder().encode(data)
          : new Uint8Array(data);
      },
      async writeFile(path: string, data: Uint8Array): Promise<void> {
        await sb.files.write(path, data);
      },
      async listDir(path: string): Promise<DirEntry[]> {
        const entries = await sb.files.list(path);
        const base = path.replace(/\/$/, "");
        return entries.map((e) => ({
          name: e.name,
          path: `${base}/${e.name}`,
          type: mapType(e.type, e.isDir),
        }));
      },
      async mkdir(path: string): Promise<void> {
        await sb.files.mkdir(path);
      },
      async remove(path: string): Promise<void> {
        await sb.files.remove(path);
      },
      async rename(from: string, to: string): Promise<void> {
        await sb.files.rename(from, to);
      },
      async stat(path: string): Promise<FileInfo> {
        const s = await sb.files.stat(path);
        return {
          path,
          type: mapType(s.type, s.isDir),
          size: s.size ?? 0,
          mtime: s.mtime ? new Date(s.mtime) : undefined,
        };
      },

      async snapshot(snapOpts: { name?: string }): Promise<SnapshotRef> {
        const name =
          snapOpts.name ?? `snap-${globalThis.crypto.randomUUID().slice(0, 8)}`;
        const cp = await sb.checkpoint(name);
        const refId = typeof cp === "string" ? cp : cp.id ?? cp.name ?? name;
        return { id: refId, name, provider: "railway", raw: cp };
      },
      async fork(count: number): Promise<DriverHandle<RailwaySandbox>[]> {
        const forks = await Promise.all(
          Array.from({ length: count }, () => sb.fork())
        );
        return forks.map((f) => makeHandle(f));
      },
    };
  };

  const provider: SandboxProvider<RailwayCaps, RailwaySandbox> = {
    name: "railway",
    capabilities: RAILWAY_CAPS,
    flags: RAILWAY_FLAGS,

    async create(spec: SandboxSpec): Promise<DriverHandle<RailwaySandbox>> {
      const mod = await loadRailway();
      const sb = await mod.Sandbox.create(
        spec.template,
        config({
          env: spec.env,
          networkIsolation: opts.networkIsolation,
          idleTimeoutMinutes: spec.ttlMs
            ? Math.ceil(spec.ttlMs / 60_000)
            : undefined,
        })
      );
      return makeHandle(sb);
    },

    async connect(id: string): Promise<DriverHandle<RailwaySandbox>> {
      const mod = await loadRailway();
      return makeHandle(await mod.Sandbox.connect(id));
    },

    async *list(): AsyncIterable<SandboxInfo> {
      const mod = await loadRailway();
      for (const s of await mod.Sandbox.list()) {
        yield {
          id: s.id,
          state: mapState(s.status),
          provider: "railway",
          metadata: {},
          raw: s,
        };
      }
    },
  };
  return provider;
});
