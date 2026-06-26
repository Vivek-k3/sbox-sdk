import type { ModalClient, Sandbox as ModalSandbox } from "modal";

/**
 * `sbox-sdk/modal` — adapter for the Modal JS SDK (`modal`). Modal sandboxes
 * require an App + Image up front; the adapter creates/looks them up lazily.
 * exec is fully streaming (ContainerProcess stdout/stderr). Filesystem is done
 * via exec + base64 (robust across images; needs coreutils `base64`). Modal has
 * no keep-state stop or pause in JS — `destroy()` maps to terminate. GPU is a
 * first-class create option. Requires the optional peer dependency `modal`.
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
  ExecOptions,
  OutputEvent,
  Preview,
  SandboxInfo,
  SandboxProvider,
  SandboxSpec,
} from "../adapter/index.js";

export interface ModalOptions {
  tokenId?: string;
  tokenSecret?: string;
  environment?: string;
  /** Modal App name to attach sandboxes to (created if missing). */
  appName?: string;
  /** Default container image when a sandbox spec doesn't set `template`. */
  image?: string;
}

export const MODAL_CAPS = {
  background: "unsupported",
  codeInterpreter: "unsupported",
  egressControl: "unsupported",
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "unsupported",
  fork: "unsupported",
  gpu: "native",
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
  snapshot: "unsupported",
  ssh: "unsupported",
  statefulKernel: "unsupported",
  stdin: "unsupported",
  stop: "unsupported",
  streaming: "native",
  volumes: "unsupported",
} as const satisfies CapabilityMap;

export type ModalCaps = typeof MODAL_CAPS;

const MODAL_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true,
  preservesDiskOnStop: false,
  preservesMemoryOnPause: false,
  previewModel: "tunnel",
};

type ModalModule = typeof import("modal");
let cached: ModalModule | null = null;
async function loadModal(): Promise<ModalModule> {
  if (!cached) {
    cached = (await import("modal")) as unknown as ModalModule;
  }
  return cached;
}

function mapModalError(e: unknown): SandboxError | undefined {
  const name = e instanceof Error ? e.name : "";
  const msg = e instanceof Error ? e.message : String(e);
  if (name === "NotFoundError" || /not ?found/i.test(msg)) {
    return new SandboxError("NotFound", msg, { cause: e, provider: "modal" });
  }
  if (/unauthor|forbidden|token/i.test(msg)) {
    return new SandboxError("Unauthorized", msg, {
      cause: e,
      provider: "modal",
    });
  }
  if (name === "SandboxTimeoutError" || /timeout|timed out/i.test(msg)) {
    return new SandboxError("Timeout", msg, { cause: e, provider: "modal" });
  }
  return undefined;
}

interface ModalProc {
  stdout: AsyncIterable<string>;
  stderr: AsyncIterable<string>;
  wait(): Promise<number>;
}
interface ModalSb {
  sandboxId: string;
  exec(command: string[], params?: Record<string, unknown>): Promise<ModalProc>;
  terminate(): Promise<void>;
  tunnels(timeoutMs?: number): Promise<Record<number, { url: string }>>;
}

export const modal = defineProvider<ModalCaps, ModalSandbox, ModalOptions>(
  (opts) => {
    let client: ModalClient | null = null;
    const getClient = async (): Promise<ModalClient> => {
      if (!client) {
        const mod = await loadModal();
        client = new mod.ModalClient({
          tokenId: opts.tokenId,
          tokenSecret: opts.tokenSecret,
          environment: opts.environment,
        });
      }
      return client;
    };

    const makeHandle = (sb: ModalSandbox): DriverHandle<ModalSandbox> => {
      const s = sb as unknown as ModalSb;

      const drainBoth = (
        proc: ModalProc,
        queue: AsyncQueue<OutputEvent>
      ): Promise<void> => {
        const out = (async () => {
          for await (const c of proc.stdout) {
            queue.push({ type: "stdout", data: c });
          }
        })();
        const err = (async () => {
          for await (const c of proc.stderr) {
            queue.push({ type: "stderr", data: c });
          }
        })();
        return Promise.all([out, err]).then(() => {});
      };

      const runBuffered = async (
        argv: string[]
      ): Promise<{ stdout: string; exitCode: number }> => {
        const proc = await s.exec(argv, {
          stdout: "pipe",
          stderr: "ignore",
          mode: "text",
        });
        let out = "";
        for await (const c of proc.stdout) {
          out += c;
        }
        const exitCode = await proc.wait();
        return { stdout: out, exitCode };
      };

      return {
        id: s.sandboxId,
        raw: sb,

        getInfo(): SandboxInfo {
          return {
            id: s.sandboxId,
            state: "running",
            provider: "modal",
            metadata: {},
            raw: sb,
          };
        },
        async destroy(): Promise<void> {
          await s.terminate();
        },

        exec(cmd: string, options: ExecOptions): DriverExec {
          const queue = new AsyncQueue<OutputEvent>();
          void (async () => {
            const proc = await s.exec(["sh", "-c", cmd], {
              stdout: "pipe",
              stderr: "pipe",
              mode: "text",
              workdir: options.cwd,
              env: options.env,
              timeoutMs: options.timeoutMs,
            });
            await drainBoth(proc, queue);
            queue.push({ type: "exit", exitCode: await proc.wait() });
            queue.close();
          })().catch((error) =>
            queue.fail(
              mapModalError(error) ?? SandboxError.wrap(error, "modal")
            )
          );
          return {
            pid: Promise.resolve(""),
            async kill() {
              /* no per-process kill; terminate the sandbox to stop everything */
            },
            [Symbol.asyncIterator]: () => queue.iterator(),
          };
        },

        async readFile(path: string): Promise<Uint8Array> {
          const r = await runBuffered(["sh", "-c", `base64 ${sq(path)}`]);
          if (r.exitCode !== 0) {
            throw new SandboxError("NotFound", `no such file: '${path}'`, {
              provider: "modal",
            });
          }
          return base64ToBytes(r.stdout);
        },
        async writeFile(path: string, data: Uint8Array): Promise<void> {
          const b64 = bytesToBase64(data);
          const script = `mkdir -p "$(dirname ${sq(path)})" && printf %s ${sq(b64)} | base64 -d > ${sq(path)}`;
          const r = await runBuffered(["sh", "-c", script]);
          if (r.exitCode !== 0) {
            throw new SandboxError("Provider", `write failed: '${path}'`, {
              provider: "modal",
            });
          }
        },

        async exposePort(port: number): Promise<Preview> {
          const tunnels = await s.tunnels();
          const t = tunnels[port];
          if (!t) {
            throw new SandboxError(
              "Validation",
              `port ${port} not exposed (declare it in spec.ports at create)`,
              { provider: "modal" }
            );
          }
          return { url: t.url, port };
        },
      };
    };

    const provider: SandboxProvider<ModalCaps, ModalSandbox> = {
      name: "modal",
      capabilities: MODAL_CAPS,
      flags: MODAL_FLAGS,
      mapError: mapModalError,

      async create(spec: SandboxSpec): Promise<DriverHandle<ModalSandbox>> {
        const mod = await loadModal();
        const c = await getClient();
        const svc = c as unknown as {
          apps: {
            fromName(
              name: string,
              params?: { createIfMissing?: boolean }
            ): Promise<unknown>;
          };
          images: { fromRegistry(tag: string): unknown };
          sandboxes: {
            create(
              app: unknown,
              image: unknown,
              params?: Record<string, unknown>
            ): Promise<ModalSandbox>;
          };
        };
        const app = await svc.apps.fromName(opts.appName ?? "sbox-sdk", {
          createIfMissing: true,
        });
        const image = svc.images.fromRegistry(
          spec.template ?? opts.image ?? "python:3.13"
        );
        const sb = await svc.sandboxes.create(app, image, {
          cpu: spec.resources?.vcpus,
          memoryMiB: spec.resources?.memoryMB,
          gpu: spec.resources?.gpu,
          timeoutMs: spec.ttlMs,
          workdir: undefined,
          env: spec.env,
          encryptedPorts: spec.ports,
        });
        void mod;
        return makeHandle(sb);
      },

      async connect(id: string): Promise<DriverHandle<ModalSandbox>> {
        const mod = await loadModal();
        const c = await getClient();
        const Ctor = mod.Sandbox as unknown as new (
          client: ModalClient,
          sandboxId: string
        ) => ModalSandbox;
        return makeHandle(new Ctor(c, id));
      },

      async *list(): AsyncIterable<SandboxInfo> {
        const c = await getClient();
        const svc = c as unknown as {
          sandboxes: { list(params?: unknown): AsyncIterable<ModalSandbox> };
        };
        for await (const sb of svc.sandboxes.list()) {
          const s = sb as unknown as { sandboxId: string };
          yield {
            id: s.sandboxId,
            state: "running",
            provider: "modal",
            metadata: {},
            raw: sb,
          };
        }
      },
    };
    return provider;
  }
);
