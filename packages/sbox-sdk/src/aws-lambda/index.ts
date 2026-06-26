/**
 * `sbox-sdk/aws-lambda` — adapter for AWS Lambda MicroVMs (Firecracker-based
 * serverless sandboxes, GA June 2026).
 *
 * Two planes:
 *  - CONTROL plane via `@aws-sdk/client-lambda-microvms`: RunMicrovm (launch from
 *    a pre-built image ARN) -> {microvmId, endpoint}; CreateMicrovmAuthToken (JWE);
 *    Suspend/Resume (preserve memory+disk up to 8h); Terminate; ListMicrovms.
 *  - DATA plane via fetch to the microVM's dedicated HTTPS endpoint, with headers
 *    `X-aws-proxy-auth` (token) and `X-aws-proxy-port`. AWS does NOT provide a
 *    built-in exec/fs API — your image must run an HTTP "runner". This adapter
 *    speaks a tiny runner protocol (see ./runner): POST /sbox/exec, /sbox/fs/read,
 *    /sbox/fs/write. Bake the reference runner into your MicroVM image.
 *
 * `pause()` = Suspend (memory preserved); `destroy()` = Terminate. `stop()` is
 * unsupported (there is no keep-compute-but-release state in between). Requires
 * the optional peer dependency `@aws-sdk/client-lambda-microvms`.
 */
import {
  AsyncQueue,
  base64ToBytes,
  bytesToBase64,
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
} from "../adapter/index.js";

export interface AwsLambdaOptions {
  /** ARN of the MicroVM image to run (default for create when spec.template is unset). */
  imageIdentifier?: string;
  region?: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /** Runner port inside the MicroVM (default 8080). */
  port?: number;
  /** Base path your runner serves under (default ""). */
  runnerBasePath?: string;
  /** Auth-token lifetime in minutes (default 30). */
  tokenTtlMinutes?: number;
  /** Max running+suspended lifetime in seconds (1–28800). */
  maximumDurationInSeconds?: number;
  executionRoleArn?: string;
  ingressNetworkConnectors?: string[];
  egressNetworkConnectors?: string[];
  /** Override the control-plane client endpoint (testing/localstack). */
  endpoint?: string;
  /** Injectable fetch for the data plane (testing); defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}

interface MicrovmRef {
  microvmId: string;
  endpoint: string;
}

export const AWS_LAMBDA_CAPS = {
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
  region: "native",
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

export type AwsLambdaCaps = typeof AWS_LAMBDA_CAPS;

const AWS_LAMBDA_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true, // the runner applies cwd/env per /sbox/exec request
  preservesDiskOnStop: false,
  preservesMemoryOnPause: true, // Suspend preserves memory + disk
  previewModel: "tunnel",
};

type AwsModule = typeof import("@aws-sdk/client-lambda-microvms");
let cached: AwsModule | null = null;
async function loadAws(): Promise<AwsModule> {
  if (!cached) {
    cached =
      (await import("@aws-sdk/client-lambda-microvms")) as unknown as AwsModule;
  }
  return cached;
}

// Minimal structural view of the control-plane client (avoids deep AWS typings).
interface AwsClient {
  send(cmd: unknown): Promise<Record<string, unknown>>;
}

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

function mapState(state: string | undefined): SandboxState {
  switch ((state ?? "").toUpperCase()) {
    case "RUNNING": {
      return "running";
    }
    case "SUSPENDED": {
      return "paused";
    }
    case "PENDING":
    case "STARTING": {
      return "creating";
    }
    case "TERMINATED": {
      return "destroyed";
    }
    default: {
      return "unknown";
    }
  }
}

export const awsLambda = defineProvider<
  AwsLambdaCaps,
  MicrovmRef,
  AwsLambdaOptions
>((opts) => {
  const port = opts.port ?? 8080;
  const runnerBase = opts.runnerBasePath ?? "";
  const fetchImpl = opts.fetch ?? globalThis.fetch;

  let clientP: Promise<AwsClient> | null = null;
  const getClient = async (): Promise<AwsClient> => {
    if (!clientP) {
      clientP = loadAws().then(
        (mod) =>
          new mod.LambdaMicrovmsClient({
            region: opts.region,
            credentials: opts.credentials,
            endpoint: opts.endpoint,
          }) as unknown as AwsClient
      );
    }
    return clientP;
  };

  const mintToken = async (microvmId: string): Promise<string> => {
    const mod = await loadAws();
    const client = await getClient();
    const res = await client.send(
      new mod.CreateMicrovmAuthTokenCommand({
        microvmIdentifier: microvmId,
        expirationInMinutes: opts.tokenTtlMinutes ?? 30,
        allowedPorts: [{ allPorts: {} }],
      } as never)
    );
    const authToken = res.authToken as Record<string, string> | undefined;
    return authToken?.["X-aws-proxy-auth"] ?? "";
  };

  const makeHandle = (
    ref: MicrovmRef,
    initialToken: string
  ): DriverHandle<MicrovmRef> => {
    let token = initialToken;

    const dp = async <T>(path: string, body: unknown): Promise<T> => {
      const call = (): Promise<Response> =>
        fetchImpl(`https://${ref.endpoint}${runnerBase}${path}`, {
          method: "POST",
          headers: {
            "x-aws-proxy-auth": token,
            "x-aws-proxy-port": String(port),
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      let res = await call();
      if (res.status === 401) {
        token = await mintToken(ref.microvmId); // token expired -> refresh once
        res = await call();
      }
      if (res.status === 404) {
        throw new SandboxError("NotFound", `${path} -> 404`, {
          provider: "aws-lambda",
          status: 404,
        });
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new SandboxError(
          mapStatus(res.status),
          `aws-lambda ${path} -> ${res.status} ${text}`,
          {
            provider: "aws-lambda",
            status: res.status,
            retryable: res.status === 429 || res.status >= 500,
          }
        );
      }
      return (await res.json()) as T;
    };

    const ctl = async (
      Command: string,
      input: Record<string, unknown>
    ): Promise<Record<string, unknown>> => {
      const mod = (await loadAws()) as unknown as Record<
        string,
        new (i: unknown) => unknown
      >;
      const client = await getClient();
      return client.send(new mod[Command]!(input));
    };

    return {
      id: ref.microvmId,
      raw: ref,

      getInfo(): SandboxInfo {
        return {
          id: ref.microvmId,
          state: "running",
          provider: "aws-lambda",
          metadata: {},
          raw: ref,
        };
      },
      async destroy(): Promise<void> {
        await ctl("TerminateMicrovmCommand", {
          microvmIdentifier: ref.microvmId,
        });
      },
      async pause(): Promise<void> {
        await ctl("SuspendMicrovmCommand", {
          microvmIdentifier: ref.microvmId,
        });
      },
      async resume(): Promise<void> {
        await ctl("ResumeMicrovmCommand", { microvmIdentifier: ref.microvmId });
      },

      exec(cmd: string, options: ExecOptions): DriverExec {
        const queue = new AsyncQueue<OutputEvent>();
        void dp<{ stdout?: string; stderr?: string; exitCode?: number }>(
          "/sbox/exec",
          {
            cmd,
            cwd: options.cwd,
            env: options.env,
            timeoutMs: options.timeoutMs,
          }
        )
          .then((r) => {
            if (r.stdout) {
              queue.push({ type: "stdout", data: r.stdout });
            }
            if (r.stderr) {
              queue.push({ type: "stderr", data: r.stderr });
            }
            queue.push({ type: "exit", exitCode: r.exitCode ?? 0 });
            queue.close();
          })
          .catch((error) =>
            queue.fail(
              error instanceof SandboxError
                ? error
                : SandboxError.wrap(error, "aws-lambda")
            )
          );
        return {
          pid: Promise.resolve(""),
          async kill() {
            /* buffered runner exec; no kill handle */
          },
          [Symbol.asyncIterator]: () => queue.iterator(),
        };
      },

      async readFile(path: string): Promise<Uint8Array> {
        const r = await dp<{ contentBase64: string }>("/sbox/fs/read", {
          path,
        });
        return base64ToBytes(r.contentBase64);
      },
      async writeFile(path: string, data: Uint8Array): Promise<void> {
        await dp("/sbox/fs/write", {
          path,
          contentBase64: bytesToBase64(data),
        });
      },

      exposePort(p: number): Preview {
        // Single endpoint + port routing via the X-aws-proxy-port header; the JWE
        // token authorizes access. Consumers send both headers.
        return { url: `https://${ref.endpoint}`, port: p, token };
      },
    };
  };

  const provider: SandboxProvider<AwsLambdaCaps, MicrovmRef> = {
    name: "aws-lambda",
    capabilities: AWS_LAMBDA_CAPS,
    flags: AWS_LAMBDA_FLAGS,

    async create(spec: SandboxSpec): Promise<DriverHandle<MicrovmRef>> {
      const image = spec.template ?? opts.imageIdentifier;
      if (!image) {
        throw new SandboxError(
          "Validation",
          "aws-lambda requires an image ARN (spec.template or imageIdentifier option)",
          { provider: "aws-lambda" }
        );
      }
      const mod = await loadAws();
      const client = await getClient();
      const run = await client.send(
        new mod.RunMicrovmCommand({
          imageIdentifier: image,
          executionRoleArn: opts.executionRoleArn,
          maximumDurationInSeconds:
            opts.maximumDurationInSeconds ??
            (spec.ttlMs ? Math.ceil(spec.ttlMs / 1000) : undefined),
          ingressNetworkConnectors: opts.ingressNetworkConnectors,
          egressNetworkConnectors: opts.egressNetworkConnectors,
          runHookPayload: spec.env
            ? JSON.stringify({ env: spec.env })
            : undefined,
        } as never)
      );
      const ref: MicrovmRef = {
        microvmId: run.microvmId as string,
        endpoint: run.endpoint as string,
      };
      return makeHandle(ref, await mintToken(ref.microvmId));
    },

    async connect(id: string): Promise<DriverHandle<MicrovmRef>> {
      const mod = await loadAws();
      const client = await getClient();
      const got = await client.send(
        new mod.GetMicrovmCommand({ microvmIdentifier: id } as never)
      );
      const ref: MicrovmRef = {
        microvmId: id,
        endpoint: got.endpoint as string,
      };
      return makeHandle(ref, await mintToken(id));
    },

    async *list(): AsyncIterable<SandboxInfo> {
      const mod = await loadAws();
      const client = await getClient();
      const res = await client.send(new mod.ListMicrovmsCommand({} as never));
      const items = (res.microvms ?? res.items ?? []) as {
        microvmId?: string;
        id?: string;
        state?: string;
      }[];
      for (const m of items) {
        const id = m.microvmId ?? m.id ?? "";
        yield {
          id,
          state: mapState(m.state),
          provider: "aws-lambda",
          metadata: {},
          raw: m,
        };
      }
    },
  };
  return provider;
});
