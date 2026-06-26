/**
 * `sbox-sdk/fly` — adapter for the Fly Machines REST API (no SDK; pure fetch, so
 * it runs anywhere the core does). A "sandbox" is a Fly Machine. exec is the
 * buffered `/exec` endpoint (no per-command cwd/env — the core folds those into
 * a `cd … && KEY=v …` wrapper via `perCommandEnvCwd: false`); filesystem is done
 * via exec + base64. stop() releases compute but the rootfs resets unless a
 * volume is attached (`preservesDiskOnStop: false` — callers are warned).
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
  SandboxState,
} from "../adapter/index.js";

export interface FlyOptions {
  apiToken: string;
  appName: string;
  image?: string;
  region?: string;
  /** Public app domain for preview URLs; defaults to `<appName>.fly.dev`. */
  appDomain?: string;
  /** Override the Machines API base (default https://api.machines.dev/v1). */
  apiBaseUrl?: string;
  /** Injectable fetch (testing); defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}

interface FlyMachine {
  id: string;
  state?: string;
  config?: unknown;
}

export const FLY_CAPS = {
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
  region: "native",
  secretsVault: "unsupported",
  setTimeout: "unsupported",
  snapshot: "unsupported",
  ssh: "unsupported",
  statefulKernel: "unsupported",
  stdin: "unsupported",
  stop: "native",
  streaming: "emulated",
  volumes: "unsupported",
} as const satisfies CapabilityMap;

export type FlyCaps = typeof FLY_CAPS;

const FLY_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: false, // /exec has no per-call cwd/env — core wraps `cd && KEY=v`
  preservesDiskOnStop: false, // rootfs resets on stop unless a volume is attached
  preservesMemoryOnPause: true, // suspend preserves memory
  previewModel: "subdomain",
};

function mapStatus(s: number): SandboxError["code"] {
  if (s === 404) {
    return "NotFound";
  }
  if (s === 401 || s === 403) {
    return "Unauthorized";
  }
  if (s === 429) {
    return "QuotaExceeded";
  }
  if (s === 408) {
    return "Timeout";
  }
  return "Provider";
}

export const fly = defineProvider<FlyCaps, FlyMachine, FlyOptions>((opts) => {
  const base = opts.apiBaseUrl ?? "https://api.machines.dev/v1";
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const app = opts.appName;

  async function api<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.apiToken}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new SandboxError(
        mapStatus(res.status),
        `fly ${method} ${path} -> ${res.status} ${text}`,
        {
          provider: "fly",
          status: res.status,
          retryable: res.status === 429 || res.status >= 500,
        }
      );
    }
    const ct = res.headers.get("content-type") ?? "";
    return (ct.includes("json") ? await res.json() : await res.text()) as T;
  }

  const makeHandle = (machine: FlyMachine): DriverHandle<FlyMachine> => {
    const { id } = machine;
    const exec1 = (cmd: string, timeoutMs?: number) =>
      api<{ stdout?: string; stderr?: string; exit_code?: number }>(
        "POST",
        `/apps/${app}/machines/${id}/exec`,
        {
          command: ["sh", "-c", cmd],
          timeout: timeoutMs ? Math.ceil(timeoutMs / 1000) : undefined,
        }
      );

    return {
      id,
      raw: machine,

      getInfo(): SandboxInfo {
        return {
          id,
          state: mapState(machine.state),
          provider: "fly",
          metadata: {},
          raw: machine,
        };
      },
      async destroy(): Promise<void> {
        await api("DELETE", `/apps/${app}/machines/${id}?force=true`);
      },
      async stop(): Promise<void> {
        await api("POST", `/apps/${app}/machines/${id}/stop`);
      },
      async pause(): Promise<void> {
        await api("POST", `/apps/${app}/machines/${id}/suspend`);
      },
      async resume(): Promise<void> {
        await api("POST", `/apps/${app}/machines/${id}/start`);
      },

      exec(cmd: string, options: ExecOptions): DriverExec {
        const queue = new AsyncQueue<OutputEvent>();
        void exec1(cmd, options.timeoutMs)
          .then((r) => {
            if (r.stdout) {
              queue.push({ type: "stdout", data: r.stdout });
            }
            if (r.stderr) {
              queue.push({ type: "stderr", data: r.stderr });
            }
            queue.push({ type: "exit", exitCode: r.exit_code ?? 0 });
            queue.close();
          })
          .catch((error) =>
            queue.fail(
              error instanceof SandboxError
                ? error
                : SandboxError.wrap(error, "fly")
            )
          );
        return {
          pid: Promise.resolve(""),
          async kill() {
            /* /exec is buffered; no kill handle */
          },
          [Symbol.asyncIterator]: () => queue.iterator(),
        };
      },

      async readFile(path: string): Promise<Uint8Array> {
        const r = await exec1(`base64 ${sq(path)}`);
        if ((r.exit_code ?? 1) !== 0) {
          throw new SandboxError("NotFound", `no such file: '${path}'`, {
            provider: "fly",
          });
        }
        return base64ToBytes(r.stdout ?? "");
      },
      async writeFile(path: string, data: Uint8Array): Promise<void> {
        const b64 = bytesToBase64(data);
        const r = await exec1(
          `mkdir -p "$(dirname ${sq(path)})" && printf %s ${sq(b64)} | base64 -d > ${sq(path)}`
        );
        if ((r.exit_code ?? 1) !== 0) {
          throw new SandboxError("Provider", `write failed: '${path}'`, {
            provider: "fly",
          });
        }
      },

      exposePort(port: number): Preview {
        return { url: opts.appDomain ?? `https://${app}.fly.dev`, port };
      },
    };
  };

  const provider: SandboxProvider<FlyCaps, FlyMachine> = {
    name: "fly",
    capabilities: FLY_CAPS,
    flags: FLY_FLAGS,

    async create(spec: SandboxSpec): Promise<DriverHandle<FlyMachine>> {
      const machine = await api<FlyMachine>("POST", `/apps/${app}/machines`, {
        region: spec.region ?? opts.region,
        config: {
          image: spec.template ?? opts.image ?? "ubuntu:22.04",
          env: spec.env,
          auto_destroy: false,
          guest: {
            cpus: spec.resources?.vcpus ?? 1,
            memory_mb: spec.resources?.memoryMB ?? 256,
            cpu_kind: "shared",
          },
        },
      });
      // Best-effort wait for the machine to reach 'started'.
      await api(
        "GET",
        `/apps/${app}/machines/${machine.id}/wait?state=started&timeout=60`
      ).catch(() => {});
      return makeHandle(machine);
    },

    async connect(id: string): Promise<DriverHandle<FlyMachine>> {
      return makeHandle(
        await api<FlyMachine>("GET", `/apps/${app}/machines/${id}`)
      );
    },

    async *list(): AsyncIterable<SandboxInfo> {
      const machines = await api<FlyMachine[]>("GET", `/apps/${app}/machines`);
      for (const m of machines) {
        yield {
          id: m.id,
          state: mapState(m.state),
          provider: "fly",
          metadata: {},
          raw: m,
        };
      }
    },
  };
  return provider;
});

function mapState(state: string | undefined): SandboxState {
  switch (state) {
    case "started": {
      return "running";
    }
    case "stopped": {
      return "stopped";
    }
    case "suspended": {
      return "paused";
    }
    case "created":
    case "starting": {
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
