/**
 * `sbox-sdk/codesandbox` — adapter for the CodeSandbox SDK (`@codesandbox/sdk`).
 * A "sandbox" is a CodeSandbox microVM. The SDK has two halves: a control object
 * (`sdk.sandboxes.*` — create/resume/hibernate/shutdown/list) and a per-sandbox
 * `client` you get from `sandbox.connect()` for commands/fs/ports. This adapter
 * holds both.
 *
 * exec is the buffered `client.commands.run` (native cwd/env), which THROWS a
 * `CommandError` on non-zero exit — the adapter catches it and emits a normal
 * `exit` event so the core never sees a throw. Filesystem is native
 * (`client.fs.*`). Ports are public hosts (`client.hosts.getUrl`). `pause()` =
 * hibernate (memory snapshotted), `resume()` wakes it, `shutdown()` destroys.
 * `setTimeout()` maps to the hibernation timeout. Requires the optional peer
 * dependency `@codesandbox/sdk`.
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
  Preview,
  SandboxInfo,
  SandboxProvider,
  SandboxSpec,
  SandboxState,
} from "../adapter/index.js";

export interface CodeSandboxOptions {
  apiKey?: string;
  /** Default template/sandbox id to fork from when `spec.template` is unset. */
  templateId?: string;
}

export const CODESANDBOX_CAPS = {
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
  pause: "native",
  privatePreview: "native",
  proxiedFetch: "unsupported",
  pty: "unsupported",
  region: "unsupported",
  secretsVault: "unsupported",
  setTimeout: "native",
  snapshot: "unsupported",
  ssh: "unsupported",
  statefulKernel: "unsupported",
  stdin: "unsupported",
  stop: "unsupported",
  streaming: "emulated",
  volumes: "unsupported",
} as const satisfies CapabilityMap;

export type CodeSandboxCaps = typeof CODESANDBOX_CAPS;

const CODESANDBOX_FLAGS: CapabilityFlags = {
  exitCodeNative: true, // exit code recovered from CommandError
  perCommandEnvCwd: true, // commands.run accepts { cwd, env }
  preservesDiskOnStop: false,
  preservesMemoryOnPause: true, // hibernate snapshots memory
  previewModel: "subdomain",
};

// Structural views of the `@codesandbox/sdk` surface.
interface CsbCommandError {
  exitCode?: number;
  output?: string;
}
interface CsbFsEntry {
  name: string;
  type?: string;
  isSymlink?: boolean;
}
interface CsbStat {
  type?: string;
  size?: number;
  mtime?: number;
}
interface CsbClient {
  commands: {
    run(
      cmd: string,
      opts?: { cwd?: string; env?: Record<string, string> }
    ): Promise<string>;
  };
  fs: {
    readFile(path: string): Promise<Uint8Array>;
    writeFile(
      path: string,
      data: Uint8Array,
      opts?: { create?: boolean; overwrite?: boolean }
    ): Promise<void>;
    readdir(path: string): Promise<CsbFsEntry[]>;
    stat(path: string): Promise<CsbStat>;
    rename(from: string, to: string): Promise<void>;
    remove(path: string, recursive?: boolean): Promise<void>;
  };
  hosts: { getUrl(port: number, protocol?: string): string };
}
interface CsbSandbox {
  id: string;
  connect(): Promise<CsbClient>;
  updateHibernationTimeout(seconds: number): Promise<void>;
}
interface CsbSdk {
  sandboxes: {
    create(opts?: Record<string, unknown>): Promise<CsbSandbox>;
    resume(id: string): Promise<CsbSandbox>;
    hibernate(id: string): Promise<void>;
    shutdown(id: string): Promise<void>;
    list(): Promise<{ sandboxes?: { id: string; status?: string }[] }>;
  };
}

interface CsbModule {
  CodeSandbox: new (apiKey?: string) => CsbSdk;
}
let cached: CsbModule | null = null;
async function loadCsb(): Promise<CsbModule> {
  if (!cached) {
    cached = (await import("@codesandbox/sdk")) as unknown as CsbModule;
  }
  return cached;
}

function mapState(state: string | undefined): SandboxState {
  switch ((state ?? "").toLowerCase()) {
    case "running":
    case "connected": {
      return "running";
    }
    case "hibernated": {
      return "paused";
    }
    case "shutdown": {
      return "stopped";
    }
    default: {
      return "unknown";
    }
  }
}

function mapFileType(type: string | undefined): "file" | "dir" | "symlink" {
  if (type === "directory" || type === "dir") {
    return "dir";
  }
  if (type === "symlink") {
    return "symlink";
  }
  return "file";
}

export const codesandbox = defineProvider<
  CodeSandboxCaps,
  CsbSandbox,
  CodeSandboxOptions
>((opts) => {
  let sdkP: Promise<CsbSdk> | null = null;
  const getSdk = (): Promise<CsbSdk> => {
    if (!sdkP) {
      sdkP = loadCsb().then((mod) => new mod.CodeSandbox(opts.apiKey));
    }
    return sdkP;
  };

  const makeHandle = (
    sb: CsbSandbox,
    client: CsbClient
  ): DriverHandle<CsbSandbox> => ({
    id: sb.id,
    raw: sb,

    getInfo(): SandboxInfo {
      return {
        id: sb.id,
        state: "running",
        provider: "codesandbox",
        metadata: {},
        raw: sb,
      };
    },
    async destroy(): Promise<void> {
      const sdk = await getSdk();
      await sdk.sandboxes.shutdown(sb.id);
    },
    async pause(): Promise<void> {
      const sdk = await getSdk();
      await sdk.sandboxes.hibernate(sb.id);
    },
    async resume(): Promise<void> {
      const sdk = await getSdk();
      await sdk.sandboxes.resume(sb.id);
    },
    async setTimeout(ttlMs: number): Promise<void> {
      await sb.updateHibernationTimeout(Math.max(1, Math.ceil(ttlMs / 1000)));
    },

    exec(cmd: string, options: ExecOptions): DriverExec {
      const queue = new AsyncQueue<OutputEvent>();
      void client.commands
        .run(cmd, { cwd: options.cwd, env: options.env })
        .then((stdout) => {
          if (stdout) {
            queue.push({ type: "stdout", data: stdout });
          }
          queue.push({ type: "exit", exitCode: 0 });
          queue.close();
        })
        .catch((error: unknown) => {
          // CommandError carries the non-zero exit code + buffered output; turn
          // it into a normal exit event rather than a thrown error.
          const ce = error as CsbCommandError;
          if (typeof ce?.exitCode === "number") {
            if (ce.output) {
              queue.push({ type: "stderr", data: ce.output });
            }
            queue.push({ type: "exit", exitCode: ce.exitCode });
            queue.close();
            return;
          }
          queue.fail(
            error instanceof SandboxError
              ? error
              : SandboxError.wrap(error, "codesandbox")
          );
        });
      return {
        pid: Promise.resolve(""),
        async kill() {
          /* commands.run is buffered; use runBackground for control (not wired) */
        },
        [Symbol.asyncIterator]: () => queue.iterator(),
      };
    },

    async readFile(path: string): Promise<Uint8Array> {
      return new Uint8Array(await client.fs.readFile(path));
    },
    async writeFile(path: string, data: Uint8Array): Promise<void> {
      await client.fs.writeFile(path, data, { create: true, overwrite: true });
    },
    async listDir(path: string): Promise<DirEntry[]> {
      const entries = await client.fs.readdir(path);
      const base = path.replace(/\/$/, "");
      return entries.map((e) => ({
        name: e.name,
        path: `${base}/${e.name}`,
        type: mapFileType(e.type),
      }));
    },
    async remove(path: string, recursive: boolean): Promise<void> {
      await client.fs.remove(path, recursive);
    },
    async rename(from: string, to: string): Promise<void> {
      await client.fs.rename(from, to);
    },
    async stat(path: string): Promise<FileInfo> {
      const s = await client.fs.stat(path);
      return {
        path,
        type: mapFileType(s.type),
        size: s.size ?? 0,
        mtime: s.mtime ? new Date(s.mtime) : undefined,
      };
    },

    exposePort(port: number): Preview {
      return { url: client.hosts.getUrl(port), port };
    },
  });

  const provider: SandboxProvider<CodeSandboxCaps, CsbSandbox> = {
    name: "codesandbox",
    capabilities: CODESANDBOX_CAPS,
    flags: CODESANDBOX_FLAGS,

    async create(spec: SandboxSpec): Promise<DriverHandle<CsbSandbox>> {
      const sdk = await getSdk();
      const id = spec.template ?? opts.templateId;
      const sb = await sdk.sandboxes.create({
        id,
        title: spec.name,
        tags: spec.metadata ? Object.values(spec.metadata) : undefined,
        hibernationTimeoutSeconds: spec.ttlMs
          ? Math.ceil(spec.ttlMs / 1000)
          : undefined,
      });
      const client = await sb.connect();
      return makeHandle(sb, client);
    },

    async connect(id: string): Promise<DriverHandle<CsbSandbox>> {
      const sdk = await getSdk();
      const sb = await sdk.sandboxes.resume(id);
      const client = await sb.connect();
      return makeHandle(sb, client);
    },

    async *list(): AsyncIterable<SandboxInfo> {
      const sdk = await getSdk();
      const res = await sdk.sandboxes.list();
      for (const s of res.sandboxes ?? []) {
        yield {
          id: s.id,
          state: mapState(s.status),
          provider: "codesandbox",
          metadata: {},
          raw: s,
        };
      }
    },
  };
  return provider;
});
