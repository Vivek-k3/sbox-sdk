import type { Sandbox as VercelSandbox } from "@vercel/sandbox";

/**
 * `sbox-sdk/vercel` — adapter for `@vercel/sandbox` (ephemeral microVMs).
 * Exercises the exec-emulation surface: no PTY, no fs watch, no code interpreter.
 * Node-only (uses Buffer for binary fs). Requires the optional peer dependency
 * `@vercel/sandbox`; auth via a Vercel token + team/project ids (OIDC or PAT).
 */
import {
  AsyncQueue,
  defineProvider,
  numExit,
  SandboxError,
} from "../adapter/index.js";
import type {
  CapabilityFlags,
  CapabilityMap,
  DirEntry,
  DriverExec,
  DriverHandle,
  DriverProcess,
  ExecOptions,
  FileInfo,
  OutputEvent,
  Preview,
  SandboxInfo,
  SandboxProvider,
  SandboxSpec,
  SandboxState,
} from "../adapter/index.js";

export interface VercelOptions {
  token: string;
  teamId: string;
  projectId: string;
}

export const VERCEL_CAPS = {
  background: "native",
  codeInterpreter: "unsupported",
  egressControl: "unsupported",
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "unsupported",
  fork: "unsupported",
  gpu: "unsupported",
  killProcess: "unsupported",
  list: "unsupported",
  metrics: "unsupported",
  pause: "unsupported",
  privatePreview: "unsupported",
  proxiedFetch: "unsupported",
  pty: "unsupported",
  region: "unsupported",
  secretsVault: "unsupported",
  setTimeout: "unsupported",
  snapshot: "unsupported",
  ssh: "unsupported",
  statefulKernel: "unsupported",
  stdin: "unsupported",
  stop: "unsupported",
  streaming: "native",
  volumes: "unsupported",
} as const satisfies CapabilityMap;

export type VercelCaps = typeof VERCEL_CAPS;

const VERCEL_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true,
  preservesDiskOnStop: true, // stop() auto-snapshots the filesystem
  preservesMemoryOnPause: false,
  previewModel: "declaredPorts",
};

type VercelModule = typeof import("@vercel/sandbox");
let cached: VercelModule | null = null;
async function loadVercel(): Promise<VercelModule> {
  if (!cached) {
    cached = (await import("@vercel/sandbox")) as unknown as VercelModule;
  }
  return cached;
}

function mapState(status: string | undefined): SandboxState {
  switch (status) {
    case "running": {
      return "running";
    }
    case "stopped":
    case "stopping": {
      return "stopped";
    }
    case "pending":
    case "initializing": {
      return "creating";
    }
    case "failed": {
      return "error";
    }
    default: {
      return "unknown";
    }
  }
}

function mapVercelError(e: unknown): SandboxError | undefined {
  const msg = e instanceof Error ? e.message : String(e);
  if (/not ?found/i.test(msg)) {
    return new SandboxError("NotFound", msg, { cause: e, provider: "vercel" });
  }
  if (/unauthor|forbidden|token/i.test(msg)) {
    return new SandboxError("Unauthorized", msg, {
      cause: e,
      provider: "vercel",
    });
  }
  if (/timeout|timed out/i.test(msg)) {
    return new SandboxError("Timeout", msg, { cause: e, provider: "vercel" });
  }
  return undefined;
}

interface VercelCmd {
  cmdId: string;
  logs(): AsyncIterable<{ stream: "stdout" | "stderr"; data: string }>;
  wait(): Promise<{ exitCode: number }>;
}

export const vercel = defineProvider<VercelCaps, VercelSandbox, VercelOptions>(
  (opts) => {
    const creds = {
      projectId: opts.projectId,
      teamId: opts.teamId,
      token: opts.token,
    };

    const makeHandle = (sb: VercelSandbox): DriverHandle<VercelSandbox> => {
      const v = sb as unknown as {
        sandboxId: string;
        status?: string;
        domain(port: number): string;
        stop(): Promise<void>;
        runCommand(params: {
          cmd: string;
          args?: string[];
          cwd?: string;
          env?: Record<string, string>;
          detached?: boolean;
        }): Promise<VercelCmd>;
        fs: {
          readFileToBuffer(file: { path: string }): Promise<Uint8Array | null>;
          writeFiles(
            files: { path: string; content: Uint8Array }[]
          ): Promise<void>;
          readdir(
            path: string,
            o: { withFileTypes: true }
          ): Promise<{ name: string; isDirectory(): boolean }[]>;
          mkdir(path: string, o?: { recursive?: boolean }): Promise<unknown>;
          rm(
            path: string,
            o?: { recursive?: boolean; force?: boolean }
          ): Promise<void>;
          stat(
            path: string
          ): Promise<{ size: number; mtime?: Date; isDirectory(): boolean }>;
        };
      };

      const drive = (
        queue: AsyncQueue<OutputEvent>,
        cmdP: Promise<VercelCmd>
      ): void => {
        void (async () => {
          let cmd: VercelCmd;
          try {
            cmd = await cmdP;
          } catch (error) {
            queue.fail(
              mapVercelError(error) ?? SandboxError.wrap(error, "vercel")
            );
            return;
          }
          try {
            for await (const log of cmd.logs()) {
              queue.push({
                data: log.data,
                type: log.stream === "stderr" ? "stderr" : "stdout",
              });
            }
            const fin = await cmd.wait();
            queue.push({ exitCode: fin.exitCode, type: "exit" });
          } catch (error) {
            queue.push({ exitCode: numExit(error), type: "exit" });
          }
          queue.close();
        })();
      };

      return {
        id: v.sandboxId,
        raw: sb,

        getInfo(): SandboxInfo {
          return {
            id: v.sandboxId,
            metadata: {},
            provider: "vercel",
            raw: sb,
            state: mapState(v.status),
          };
        },

        async destroy(): Promise<void> {
          await v.stop();
        },

        exec(cmd: string, options: ExecOptions): DriverExec {
          const queue = new AsyncQueue<OutputEvent>();
          const cmdP = v.runCommand({
            args: ["-c", cmd],
            cmd: "sh",
            cwd: options.cwd,
            detached: true,
            env: options.env,
          });
          drive(queue, cmdP);
          return {
            pid: cmdP.then((c) => c.cmdId).catch(() => ""),
            async kill() {
              /* no kill handle exposed by the SDK */
            },
            [Symbol.asyncIterator]: () => queue.iterator(),
          };
        },

        async spawn(cmd: string, options: ExecOptions): Promise<DriverProcess> {
          const c = await v.runCommand({
            args: ["-c", cmd],
            cmd: "sh",
            cwd: options.cwd,
            detached: true,
            env: options.env,
          });
          const queue = new AsyncQueue<OutputEvent>();
          drive(queue, Promise.resolve(c));
          return {
            id: c.cmdId,
            pid: Promise.resolve(c.cmdId),
            async kill() {
              /* no kill handle exposed by the SDK */
            },
            [Symbol.asyncIterator]: () => queue.iterator(),
          };
        },

        async readFile(path: string): Promise<Uint8Array> {
          const buf = await v.fs.readFileToBuffer({ path });
          if (!buf) {
            throw new SandboxError("NotFound", `no such file: '${path}'`, {
              provider: "vercel",
            });
          }
          return new Uint8Array(buf);
        },

        async writeFile(path: string, data: Uint8Array): Promise<void> {
          await v.fs.writeFiles([{ content: data, path }]);
        },

        async listDir(path: string): Promise<DirEntry[]> {
          const entries = await v.fs.readdir(path, { withFileTypes: true });
          return entries.map((d) => ({
            name: d.name,
            path: `${path.replace(/\/$/, "")}/${d.name}`,
            type: d.isDirectory() ? "dir" : "file",
          }));
        },

        async mkdir(path: string, recursive: boolean): Promise<void> {
          await v.fs.mkdir(path, { recursive });
        },

        async remove(path: string, recursive: boolean): Promise<void> {
          await v.fs.rm(path, { force: true, recursive });
        },

        async stat(path: string): Promise<FileInfo> {
          const s = await v.fs.stat(path);
          return {
            mtime: s.mtime,
            path,
            size: s.size,
            type: s.isDirectory() ? "dir" : "file",
          };
        },

        exposePort(port: number): Preview {
          return { port, url: v.domain(port) };
        },
        // NOTE: rename is omitted -> the core polyfills it via exec(`mv`).
      };
    };

    const provider: SandboxProvider<VercelCaps, VercelSandbox> = {
      capabilities: VERCEL_CAPS,
      async connect(id: string): Promise<DriverHandle<VercelSandbox>> {
        const { Sandbox } = await loadVercel();
        const sb = await Sandbox.get({ ...creds, sandboxId: id } as never);
        return makeHandle(sb as VercelSandbox);
      },
      async create(spec: SandboxSpec): Promise<DriverHandle<VercelSandbox>> {
        const { Sandbox } = await loadVercel();
        const sb = await Sandbox.create({
          ...creds,
          env: spec.env,
          name: spec.name,
          ports: spec.ports,
          resources: spec.resources?.vcpus
            ? { vcpus: spec.resources.vcpus }
            : undefined,
          runtime: spec.template,
          signal: spec.signal,
          timeout: spec.ttlMs,
        } as never);
        return makeHandle(sb as VercelSandbox);
      },
      flags: VERCEL_FLAGS,
      mapError: mapVercelError,
      name: "vercel",
    };
    return provider;
  }
);
