/**
 * `sbox-sdk/northflank` — adapter for Northflank (`@northflank/js-client`).
 * Northflank is a services platform, so a "sandbox" is a deployment service that
 * runs a base image with a `sleep infinity` keep-alive command. exec uses
 * `apiClient.exec.execServiceSession`, which streams stdout/stderr over Node
 * EventEmitters and resolves an exit code via `waitForCommandResult()`; the
 * adapter buffers it. There is no per-call cwd/env, so the core folds those into
 * a `cd … && KEY=v …` wrapper (`perCommandEnvCwd: false`). Filesystem is exec +
 * base64.
 *
 * `pause()` scales the service to zero (volume retained, memory lost),
 * `resume()` scales it back, `destroy()` deletes the service and its children.
 * Ports are made public via the service port config and resolved to their public
 * DNS. Node-only (the SDK uses EventEmitters). Requires the optional peer
 * dependency `@northflank/js-client`.
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
} from "../adapter/index.js";

export interface NorthflankOptions {
  /** Northflank API token. */
  token: string;
  /** Project the sandbox services live in (required). */
  projectId: string;
  /** Billing/compute plan for new sandboxes (default "nf-compute-200"). */
  deploymentPlan?: string;
  /** Default base image (default "ubuntu:22.04"). */
  image?: string;
  /** Ephemeral storage in MB for new sandboxes (default 2048). */
  ephemeralStorageMB?: number;
}

interface NfRef {
  projectId: string;
  serviceId: string;
}

export const NORTHFLANK_CAPS = {
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
  streaming: "emulated",
  volumes: "unsupported",
} as const satisfies CapabilityMap;

export type NorthflankCaps = typeof NORTHFLANK_CAPS;

const NORTHFLANK_FLAGS: CapabilityFlags = {
  exitCodeNative: true, // waitForCommandResult() returns the exit code
  perCommandEnvCwd: false, // execServiceSession has no cwd/env — core wraps it
  preservesDiskOnStop: false,
  preservesMemoryOnPause: false, // scale-to-zero loses memory (volume retained)
  previewModel: "subdomain",
};

// Structural views of the `@northflank/js-client` surface (loosely typed; the
// real client carries deep generics we deliberately don't depend on).
interface NfEventStream {
  on(event: "data", cb: (chunk: unknown) => void): void;
}
interface NfExecHandle {
  stdOut: NfEventStream;
  stdErr: NfEventStream;
  waitForCommandResult(): Promise<{ exitCode?: number }>;
}
interface NfReq {
  parameters: Record<string, string>;
  data?: Record<string, unknown>;
  options?: Record<string, unknown>;
}
interface NfApiClient {
  create: {
    service: { deployment(req: NfReq): Promise<{ data?: { id?: string } }> };
  };
  exec: {
    execServiceSession(
      params: NfReq,
      data: { shell: string; command: string }
    ): Promise<NfExecHandle>;
  };
  get: {
    service: ((req: NfReq) => Promise<{ data?: { status?: string } }>) & {
      ports(req: NfReq): Promise<{
        data?: { ports?: { internalPort: number; dns?: string }[] };
      }>;
    };
  };
  update: { service: { ports(req: NfReq): Promise<unknown> } };
  pause: { service(req: NfReq): Promise<unknown> };
  resume: { service(req: NfReq): Promise<unknown> };
  delete: { service(req: NfReq): Promise<unknown> };
  list: {
    services(
      req: NfReq
    ): Promise<{ data?: { services?: { id: string; status?: string }[] } }>;
  };
}

interface NfModule {
  ApiClient: new (provider: unknown, opts?: unknown) => NfApiClient;
  ApiClientInMemoryContextProvider: new () => {
    addContext(ctx: { name: string; token: string }): Promise<void>;
  };
}

let cached: NfModule | null = null;
async function loadNorthflank(): Promise<NfModule> {
  if (!cached) {
    cached = (await import("@northflank/js-client")) as unknown as NfModule;
  }
  return cached;
}

function mapState(state: string | undefined): SandboxState {
  switch ((state ?? "").toLowerCase()) {
    case "running": {
      return "running";
    }
    case "paused": {
      return "paused";
    }
    case "deploying":
    case "building":
    case "deploymentongoing": {
      return "creating";
    }
    case "failed":
    case "unhealthy": {
      return "error";
    }
    default: {
      return "unknown";
    }
  }
}

export const northflank = defineProvider<
  NorthflankCaps,
  NfRef,
  NorthflankOptions
>((opts) => {
  const { projectId } = opts;
  let clientP: Promise<NfApiClient> | null = null;
  const getClient = (): Promise<NfApiClient> => {
    if (!clientP) {
      clientP = (async () => {
        const mod = await loadNorthflank();
        const ctx = new mod.ApiClientInMemoryContextProvider();
        await ctx.addContext({ name: "sbox", token: opts.token });
        return new mod.ApiClient(ctx, { throwErrorOnHttpErrorCode: true });
      })();
    }
    return clientP;
  };

  const makeHandle = (ref: NfRef, client: NfApiClient): DriverHandle<NfRef> => {
    const params = { projectId: ref.projectId, serviceId: ref.serviceId };

    const exec1 = async (
      cmd: string
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      const handle = await client.exec.execServiceSession(
        { parameters: params },
        { shell: "sh -c", command: cmd }
      );
      const out: string[] = [];
      const err: string[] = [];
      handle.stdOut.on("data", (d) => out.push(String(d)));
      handle.stdErr.on("data", (d) => err.push(String(d)));
      const result = await handle.waitForCommandResult();
      return {
        stdout: out.join(""),
        stderr: err.join(""),
        exitCode: result.exitCode ?? 0,
      };
    };

    return {
      id: ref.serviceId,
      raw: ref,

      async getInfo(): Promise<SandboxInfo> {
        const res = await client.get.service({ parameters: params });
        return {
          id: ref.serviceId,
          state: mapState(res.data?.status),
          provider: "northflank",
          metadata: {},
          raw: ref,
        };
      },
      async destroy(): Promise<void> {
        await client.delete.service({
          parameters: params,
          options: { delete_child_objects: true },
        });
      },
      async pause(): Promise<void> {
        await client.pause.service({ parameters: params });
      },
      async resume(): Promise<void> {
        await client.resume.service({ parameters: params });
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
            queue.push({ type: "exit", exitCode: r.exitCode });
            queue.close();
          })
          .catch((error) =>
            queue.fail(
              error instanceof SandboxError
                ? error
                : SandboxError.wrap(error, "northflank")
            )
          );
        return {
          pid: Promise.resolve(""),
          async kill() {
            /* execServiceSession is buffered here; no kill handle */
          },
          [Symbol.asyncIterator]: () => queue.iterator(),
        };
      },

      async readFile(path: string): Promise<Uint8Array> {
        const r = await exec1(`base64 ${sq(path)}`);
        if (r.exitCode !== 0) {
          throw new SandboxError("NotFound", `no such file: '${path}'`, {
            provider: "northflank",
          });
        }
        return base64ToBytes(r.stdout);
      },
      async writeFile(path: string, data: Uint8Array): Promise<void> {
        const b64 = bytesToBase64(data);
        const r = await exec1(
          `mkdir -p "$(dirname ${sq(path)})" && printf %s ${sq(b64)} | base64 -d > ${sq(path)}`
        );
        if (r.exitCode !== 0) {
          throw new SandboxError("Provider", `write failed: '${path}'`, {
            provider: "northflank",
          });
        }
      },

      async exposePort(port: number): Promise<Preview> {
        await client.update.service.ports({
          parameters: params,
          data: {
            ports: [
              {
                name: `p${port}`,
                internalPort: port,
                public: true,
                protocol: "HTTP",
              },
            ],
          },
        });
        const got = await client.get.service.ports({ parameters: params });
        const dns = got.data?.ports?.find((p) => p.internalPort === port)?.dns;
        return { url: dns ? `https://${dns}` : "", port };
      },
    };
  };

  const provider: SandboxProvider<NorthflankCaps, NfRef> = {
    name: "northflank",
    capabilities: NORTHFLANK_CAPS,
    flags: NORTHFLANK_FLAGS,

    async create(spec: SandboxSpec): Promise<DriverHandle<NfRef>> {
      const client = await getClient();
      const serviceId =
        spec.name ?? `sandbox-${globalThis.crypto.randomUUID().slice(0, 8)}`;
      await client.create.service.deployment({
        parameters: { projectId },
        data: {
          name: serviceId,
          billing: { deploymentPlan: opts.deploymentPlan ?? "nf-compute-200" },
          deployment: {
            instances: 1,
            docker: {
              configType: "customCommand",
              customCommand: "sleep infinity",
            },
            external: {
              imagePath: spec.template ?? opts.image ?? "ubuntu:22.04",
            },
            storage: {
              ephemeralStorage: {
                storageSize: opts.ephemeralStorageMB ?? 2048,
              },
            },
          },
          runtimeEnvironment: spec.env ?? {},
        },
      });
      const ref: NfRef = { projectId, serviceId };
      // Best-effort wait for the service to come up before returning.
      for (let i = 0; i < 60; i++) {
        const res = await client.get
          .service({ parameters: { projectId, serviceId } })
          .catch(() => null);
        const status = res?.data?.status;
        if (status === "running") {
          break;
        }
        if (status === "failed") {
          throw new SandboxError(
            "Provider",
            `service ${serviceId} failed to start`,
            {
              provider: "northflank",
            }
          );
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      return makeHandle(ref, client);
    },

    async connect(id: string): Promise<DriverHandle<NfRef>> {
      const client = await getClient();
      return makeHandle({ projectId, serviceId: id }, client);
    },

    async *list(): AsyncIterable<SandboxInfo> {
      const client = await getClient();
      const res = await client.list.services({ parameters: { projectId } });
      for (const s of res.data?.services ?? []) {
        yield {
          id: s.id,
          state: mapState(s.status),
          provider: "northflank",
          metadata: {},
          raw: { projectId, serviceId: s.id },
        };
      }
    },
  };
  return provider;
});
