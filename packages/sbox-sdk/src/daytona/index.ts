import type { Daytona, Sandbox as DaytonaSandbox } from "@daytonaio/sdk";

/**
 * `sbox-sdk/daytona` — adapter for `@daytonaio/sdk`. A full-featured sandbox:
 * exec + code interpreter (with matplotlib charts), filesystem, snapshots,
 * stop/pause/resume, preview links, regions. Node-only (uses Buffer for fs).
 * Notable normalization: Daytona timeouts are in SECONDS — the adapter converts
 * from the SDK's milliseconds. Requires the optional peer dependency
 * `@daytonaio/sdk`.
 */
import { AsyncQueue, defineProvider, SandboxError } from "../adapter/index.js";
import type {
  CapabilityFlags,
  CapabilityMap,
  CodeExecution,
  DirEntry,
  DriverExec,
  DriverHandle,
  ExecOptions,
  FileInfo,
  KernelContext,
  OutputEvent,
  Preview,
  SandboxInfo,
  SandboxProvider,
  SandboxSpec,
  SandboxState,
} from "../adapter/index.js";

export interface DaytonaOptions {
  apiKey: string;
  apiUrl?: string;
  /** Target region, e.g. "us" or "eu". */
  target?: string;
}

export const DAYTONA_CAPS = {
  background: "unsupported",
  codeInterpreter: "native",
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
  region: "native",
  secretsVault: "unsupported",
  setTimeout: "native",
  snapshot: "unsupported",
  ssh: "unsupported",
  statefulKernel: "unsupported",
  stdin: "unsupported",
  stop: "native",
  streaming: "emulated",
  volumes: "unsupported",
} as const satisfies CapabilityMap;

export type DaytonaCaps = typeof DAYTONA_CAPS;

const DAYTONA_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true,
  preservesDiskOnStop: true,
  preservesMemoryOnPause: true,
  previewModel: "subdomain",
};

type DaytonaModule = typeof import("@daytonaio/sdk");
let cached: DaytonaModule | null = null;
async function loadDaytona(): Promise<DaytonaModule> {
  if (!cached) {
    cached = (await import("@daytonaio/sdk")) as unknown as DaytonaModule;
  }
  return cached;
}

function mapState(state: string | undefined): SandboxState {
  switch (state) {
    case "started":
    case "running": {
      return "running";
    }
    case "stopped":
    case "archived": {
      return "stopped";
    }
    case "paused": {
      return "paused";
    }
    case "starting":
    case "creating": {
      return "creating";
    }
    case "error": {
      return "error";
    }
    default: {
      return "unknown";
    }
  }
}

function secs(ms: number | undefined): number | undefined {
  return ms === undefined ? undefined : Math.ceil(ms / 1000);
}

function mapDaytonaError(e: unknown): SandboxError | undefined {
  const msg = e instanceof Error ? e.message : String(e);
  if (/not ?found/i.test(msg)) {
    return new SandboxError("NotFound", msg, { cause: e, provider: "daytona" });
  }
  if (/unauthor|forbidden|api key/i.test(msg)) {
    return new SandboxError("Unauthorized", msg, {
      cause: e,
      provider: "daytona",
    });
  }
  if (/timeout|timed out/i.test(msg)) {
    return new SandboxError("Timeout", msg, { cause: e, provider: "daytona" });
  }
  return undefined;
}

interface DaytonaProc {
  executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeout?: number
  ): Promise<{
    exitCode?: number;
    result?: string;
    artifacts?: { stdout?: string; charts?: unknown[] };
  }>;
  codeRun(
    code: string,
    params?: unknown,
    timeout?: number
  ): Promise<{
    exitCode?: number;
    result?: string;
    artifacts?: { stdout?: string; charts?: unknown[] };
  }>;
}

interface DaytonaFs {
  uploadFile(
    file: Uint8Array,
    remotePath: string,
    timeout?: number
  ): Promise<void>;
  downloadFile(remotePath: string, timeout?: number): Promise<Uint8Array>;
  listFiles(
    path: string
  ): Promise<
    { name: string; isDir?: boolean; size?: number; modTime?: string }[]
  >;
  createFolder(path: string, mode: string): Promise<void>;
  deleteFile(path: string, recursive?: boolean): Promise<void>;
  moveFiles(source: string, destination: string): Promise<void>;
  getFileDetails(
    path: string
  ): Promise<{ isDir?: boolean; size?: number; modTime?: string }>;
}

export const daytona = defineProvider<
  DaytonaCaps,
  DaytonaSandbox,
  DaytonaOptions
>((opts) => {
  let client: Daytona | null = null;
  const getClient = async (): Promise<Daytona> => {
    if (!client) {
      const mod = await loadDaytona();
      client = new mod.Daytona({
        apiKey: opts.apiKey,
        apiUrl: opts.apiUrl,
        target: opts.target,
      });
    }
    return client;
  };

  const makeHandle = (sb: DaytonaSandbox): DriverHandle<DaytonaSandbox> => {
    const proc = (sb as unknown as { process: DaytonaProc }).process;
    const { fs } = sb as unknown as { fs: DaytonaFs };
    const lifecycle = sb as unknown as {
      id: string;
      state?: string;
      stop(timeout?: number, force?: boolean): Promise<void>;
      start(timeout?: number): Promise<void>;
      pause(timeout?: number): Promise<void>;
      delete(timeout?: number): Promise<void>;
      setAutostopInterval(interval: number): Promise<void>;
      getPreviewLink(port: number): Promise<{ url: string; token?: string }>;
    };

    return {
      id: lifecycle.id,
      raw: sb,

      getInfo(): SandboxInfo {
        return {
          id: lifecycle.id,
          state: mapState(lifecycle.state),
          provider: "daytona",
          metadata: {},
          raw: sb,
        };
      },
      async destroy(): Promise<void> {
        await lifecycle.delete();
      },
      async stop(): Promise<void> {
        await lifecycle.stop();
      },
      async pause(): Promise<void> {
        await lifecycle.pause();
      },
      async resume(): Promise<void> {
        await lifecycle.start();
      },
      async setTimeout(ttlMs: number): Promise<void> {
        await lifecycle.setAutostopInterval(
          Math.max(0, Math.ceil(ttlMs / 60_000))
        );
      },

      exec(cmd: string, options: ExecOptions): DriverExec {
        const queue = new AsyncQueue<OutputEvent>();
        void proc
          .executeCommand(
            cmd,
            options.cwd,
            options.env,
            secs(options.timeoutMs)
          )
          .then((res) => {
            const out = res.result ?? res.artifacts?.stdout ?? "";
            if (out) {
              queue.push({ type: "stdout", data: out });
            }
            queue.push({ type: "exit", exitCode: res.exitCode ?? 0 });
            queue.close();
          })
          .catch((error) =>
            queue.fail(
              mapDaytonaError(error) ?? SandboxError.wrap(error, "daytona")
            )
          );
        return {
          pid: Promise.resolve(""),
          async kill() {
            /* executeCommand is buffered; no kill handle */
          },
          [Symbol.asyncIterator]: () => queue.iterator(),
        };
      },

      async readFile(path: string): Promise<Uint8Array> {
        return new Uint8Array(await fs.downloadFile(path));
      },
      async writeFile(path: string, data: Uint8Array): Promise<void> {
        await fs.uploadFile(data, path);
      },
      async listDir(path: string): Promise<DirEntry[]> {
        const files = await fs.listFiles(path);
        return files.map((f) => ({
          name: f.name,
          path: `${path.replace(/\/$/, "")}/${f.name}`,
          type: f.isDir ? "dir" : "file",
        }));
      },
      async mkdir(path: string): Promise<void> {
        await fs.createFolder(path, "755");
      },
      async remove(path: string, recursive: boolean): Promise<void> {
        await fs.deleteFile(path, recursive);
      },
      async rename(from: string, to: string): Promise<void> {
        await fs.moveFiles(from, to);
      },
      async stat(path: string): Promise<FileInfo> {
        const d = await fs.getFileDetails(path);
        return {
          path,
          type: d.isDir ? "dir" : "file",
          size: d.size ?? 0,
          mtime: d.modTime ? new Date(d.modTime) : undefined,
        };
      },

      async exposePort(port: number): Promise<Preview> {
        const link = await lifecycle.getPreviewLink(port);
        return { url: link.url, port, token: link.token };
      },

      async runCode(
        code: string,
        options: { language?: string }
      ): Promise<CodeExecution> {
        const res = await proc.codeRun(code, { language: options.language });
        const charts = res.artifacts?.charts ?? [];
        return {
          results: charts.map((c) => {
            const cc = c as { png?: string };
            const mime: Record<string, string> = {};
            if (cc.png) {
              mime["image/png"] = cc.png;
            }
            return { mime };
          }),
          logs: { stdout: res.result ? [res.result] : [], stderr: [] },
          error:
            res.exitCode && res.exitCode !== 0
              ? { name: "Error", value: res.result ?? "" }
              : undefined,
        };
      },
      async createContext(options: {
        language?: string;
      }): Promise<KernelContext> {
        // Daytona codeRun is stateless; return a nominal context (statefulKernel = unsupported).
        return { id: "default", language: options.language ?? "python" };
      },
    };
  };

  const provider: SandboxProvider<DaytonaCaps, DaytonaSandbox> = {
    name: "daytona",
    capabilities: DAYTONA_CAPS,
    flags: DAYTONA_FLAGS,
    mapError: mapDaytonaError,

    async create(spec: SandboxSpec): Promise<DriverHandle<DaytonaSandbox>> {
      const c = await getClient();
      const tpl = spec.template;
      const base =
        tpl && /[:/]/.test(tpl) ? { image: tpl } : tpl ? { snapshot: tpl } : {};
      const sb = await c.create(
        {
          ...base,
          envVars: spec.env,
          labels: spec.metadata,
          ...(spec.resources?.vcpus
            ? { resources: { cpu: spec.resources.vcpus } }
            : {}),
        } as never,
        spec.ttlMs ? { timeout: secs(spec.ttlMs) } : undefined
      );
      return makeHandle(sb as DaytonaSandbox);
    },

    async connect(id: string): Promise<DriverHandle<DaytonaSandbox>> {
      const c = await getClient();
      return makeHandle((await c.get(id)) as DaytonaSandbox);
    },

    async *list(): AsyncIterable<SandboxInfo> {
      const c = await getClient();
      for await (const s of c.list()) {
        const sb = s as unknown as { id: string; state?: string };
        yield {
          id: sb.id,
          state: mapState(sb.state),
          provider: "daytona",
          metadata: {},
          raw: s,
        };
      }
    },
  };
  return provider;
});
