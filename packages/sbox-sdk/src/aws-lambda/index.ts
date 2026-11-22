/**
 * `sbox-sdk/aws-lambda` — adapter for AWS Lambda MicroVMs (Firecracker-based
 * serverless sandboxes).
 *
 * Two planes:
 *  - CONTROL plane via `@aws-sdk/client-lambda-microvms`: RunMicrovm (from a
 *    MicroVM image ARN, idempotent via `clientToken`), GetMicrovm, Suspend /
 *    Resume, Terminate, ListMicrovms, CreateMicrovmAuthToken (JWE, ≤ 60 min).
 *  - DATA plane via fetch to the MicroVM's HTTPS endpoint with the
 *    `X-aws-proxy-auth` / `X-aws-proxy-port` headers. AWS has no exec/fs API, so
 *    the image must run the reference runner in `./runner` (streaming exec with
 *    kill, raw file routes). `spec.env`/`metadata` travel in `runHookPayload`
 *    to the runner's `/run` hook, which only fires when the image was created
 *    with `hooks: { port, microvmHooks: { run: "ENABLED" } }`.
 *
 * Templates: `templates.build({ dockerfile, context })` zips the context with the
 * Dockerfile at the root, uploads it to the `s3Bucket` option (via a dynamic
 * import of `@aws-sdk/client-s3`) and runs CreateMicrovmImage, polling the image
 * version and its builds.
 *
 * `pause()` = Suspend (memory + disk kept); `destroy()` = Terminate. There is no
 * stop state and no API to change lifetime or idle policy after launch.
 * Requires the optional peer dependency `@aws-sdk/client-lambda-microvms`.
 */
import type {
  IdlePolicy,
  Logging,
  RunMicrovmCommandInput,
} from "@aws-sdk/client-lambda-microvms";

import {
  AsyncQueue,
  defineProvider,
  loadTemplateContext,
  SandboxError,
} from "../adapter/index.js";
import type {
  CallContext,
  CapabilityFlags,
  CapabilityMap,
  DriverExec,
  DriverHandle,
  DriverTemplates,
  ExecOptions,
  OutputEvent,
  Preview,
  ProcessInfo,
  ResolvedSandboxSpec,
  SandboxErrorCode,
  SandboxInfo,
  SandboxProvider,
  SandboxState,
  TemplateBuildEvent,
  TemplateRef,
} from "../adapter/index.js";

type AwsModule = typeof import("@aws-sdk/client-lambda-microvms");
/** The typed control-plane client. */
export type MicrovmsClient = InstanceType<AwsModule["LambdaMicrovmsClient"]>;

export interface AwsLambdaOptions {
  /** MicroVM image ARN used when `spec.template` is unset. */
  imageIdentifier?: string;
  /** Pin an image version (default: the latest active version). */
  imageVersion?: string;
  region?: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /** Runner (data-plane) port inside the MicroVM (default 8080). */
  port?: number;
  /** Lifecycle-hooks port used for images built by `templates.build` (default 9000). */
  hooksPort?: number;
  /** Base path your runner serves under (default ""). */
  runnerBasePath?: string;
  /** Auth-token lifetime in minutes, 1–60 (default 30). */
  tokenTtlMinutes?: number;
  /** Max running+suspended lifetime in seconds (1–28 800). Overrides `lifecycle.maxAgeMs`. */
  maximumDurationInSeconds?: number;
  /** Defaults for the idle policy; `lifecycle` fields win. */
  idlePolicy?: Partial<IdlePolicy>;
  /** Runtime logging (`{ cloudWatch: { logGroup } }` or `{ disabled: {} }`). */
  logging?: Logging;
  executionRoleArn?: string;
  ingressNetworkConnectors?: string[];
  egressNetworkConnectors?: string[];
  /** Override the control-plane endpoint (testing/localstack). */
  endpoint?: string;
  /** Override the data-plane transport (testing). Defaults to the client's fetch. */
  fetch?: typeof fetch;
  // ---- template builds ----
  /** S3 bucket for template build artifacts (enables `templates.build`). */
  s3Bucket?: string;
  /** Key prefix inside `s3Bucket` (default "sbox-templates/"). */
  s3Prefix?: string;
  /** IAM role assumed by the image build (needs s3:GetObject on the artifact). */
  buildRoleArn?: string;
  /** Lambda-managed base image (default `arn:aws:lambda:<region>:aws:microvm-image:al2023-1`). */
  baseImageArn?: string;
  /** Poll interval for builds (default 5000 ms). */
  pollIntervalMs?: number;
}

/** What `sandbox.raw()` returns. */
export interface MicrovmRef {
  microvmId: string;
  endpoint: string;
}

export const AWS_LAMBDA_CAPS = {
  background: "unsupported",
  codeInterpreter: "unsupported",
  egressControl: "unsupported", // connectors are fixed at launch
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "unsupported",
  fork: "unsupported",
  gpu: "unsupported",
  killProcess: "native",
  list: "native",
  metrics: "unsupported",
  pause: "native",
  privatePreview: "native",
  proxiedFetch: "native",
  pty: "unsupported",
  region: "native",
  secretsVault: "unsupported",
  setTimeout: "unsupported", // no API changes lifetime/idle policy after RunMicrovm
  snapshot: "unsupported",
  ssh: "unsupported",
  statefulKernel: "unsupported",
  stdin: "unsupported",
  stop: "unsupported",
  streaming: "native",
  volumes: "unsupported",
  templateBuild: "native",
} as const satisfies CapabilityMap;

export type AwsLambdaCaps = typeof AWS_LAMBDA_CAPS;

const AWS_LAMBDA_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true, // the runner applies cwd/env per request
  preservesDiskOnStop: false,
  preservesMemoryOnPause: true, // Suspend snapshots memory + disk
  previewBrowserAuth: false, // header token (browsers need WS subprotocols)
  previewModel: "tunnel",
  templateSources: ["dockerfile"],
};

const P = "aws-lambda";
const MAX_TOKEN_MIN = 60;
const MAX_DURATION_SEC = 28_800;
const MAX_PAYLOAD = 16_384;
const CACHE_TAG = "sbox-cache-key";

let cached: AwsModule | null = null;
async function loadAws(): Promise<AwsModule> {
  cached ??= await import("@aws-sdk/client-lambda-microvms");
  return cached;
}

// ---------------------------------------------------------------------------
// pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Map a MicroVM state to a `SandboxState`. */
export function mapMicrovmState(state: string | undefined): SandboxState {
  switch (state) {
    case "PENDING": {
      return "creating";
    }
    case "RUNNING": {
      return "running";
    }
    case "SUSPENDING": {
      return "suspending";
    }
    case "SUSPENDED": {
      return "paused";
    }
    case "TERMINATING":
    case "TERMINATED": {
      return "destroyed";
    }
    default: {
      return "unknown";
    }
  }
}

const NAME_CODES: Record<string, SandboxErrorCode> = {
  AccessDeniedException: "Unauthorized",
  ConflictException: "Conflict",
  ExpiredTokenException: "Unauthorized",
  InsufficientCapacityException: "QuotaExceeded",
  InvalidParameterValueException: "Validation",
  ResourceConflictException: "Conflict",
  ResourceNotFoundException: "NotFound",
  ServiceQuotaExceededException: "QuotaExceeded",
  ThrottlingException: "QuotaExceeded",
  TimeoutError: "Timeout",
  TooManyRequestsException: "QuotaExceeded",
  UnrecognizedClientException: "Unauthorized",
  ValidationException: "Validation",
};

function codeForStatus(status: number | undefined): SandboxErrorCode {
  if (status === 401 || status === 403) {
    return "Unauthorized";
  }
  if (status === 404) {
    return "NotFound";
  }
  if (status === 408) {
    return "Timeout";
  }
  if (status === 409) {
    return "Conflict";
  }
  if (status === 429) {
    return "QuotaExceeded";
  }
  if (status === 400) {
    return "Validation";
  }
  return "Provider";
}

/** Normalize AWS SDK (`name`, `$metadata.httpStatusCode`) and fetch errors. */
export function mapAwsLambdaError(err: unknown): SandboxError | undefined {
  if (err instanceof SandboxError) {
    return err;
  }
  if (!(err instanceof Error)) {
    return undefined;
  }
  if (err.name === "AbortError") {
    return new SandboxError("Timeout", err.message, {
      aborted: true,
      cause: err,
      provider: P,
    });
  }
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;
  const code = NAME_CODES[err.name] ?? codeForStatus(status);
  return new SandboxError(code, `${err.name}: ${err.message}`, {
    cause: err,
    provider: P,
    retryable:
      code === "QuotaExceeded" ||
      code === "Timeout" ||
      (code === "Provider" && (status === undefined || status >= 500)),
    status,
  });
}

function dpError(path: string, status: number, text: string): SandboxError {
  const code = codeForStatus(status);
  return new SandboxError(
    code,
    `aws-lambda ${path} -> ${status} ${text}`.trim(),
    {
      provider: P,
      retryable: status === 429 || status >= 500,
      status,
    }
  );
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(Math.max(n, lo), hi);

/** Build the IdlePolicy from `lifecycle` + option defaults (all three fields are required). */
export function idlePolicyFor(
  lifecycle: ResolvedSandboxSpec["lifecycle"],
  defaults: Partial<IdlePolicy> | undefined,
  maxDurationSec: number | undefined
): IdlePolicy | undefined {
  const idleSec = lifecycle?.idleTimeoutMs
    ? Math.ceil(lifecycle.idleTimeoutMs / 1000)
    : defaults?.maxIdleDurationSeconds;
  if (idleSec === undefined) {
    return undefined;
  }
  const suspended =
    lifecycle?.onIdle === "destroy"
      ? 1 // terminate (almost) as soon as it is suspended
      : (defaults?.suspendedDurationSeconds ??
        maxDurationSec ??
        MAX_DURATION_SEC);
  return {
    autoResumeEnabled:
      lifecycle?.autoResume ?? defaults?.autoResumeEnabled ?? true,
    maxIdleDurationSeconds: clamp(idleSec, 1, MAX_DURATION_SEC),
    suspendedDurationSeconds: clamp(suspended, 1, MAX_DURATION_SEC),
  };
}

async function sha256Hex(s: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s)
  );
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---- minimal ZIP writer (STORE, no compression) for build artifacts --------
/* oxlint-disable no-bitwise, unicorn/prefer-math-trunc -- CRC-32 is bit math */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xff_ff_ff_ff;
  for (const b of data) {
    c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xff_ff_ff_ff) >>> 0;
}

/** Zip `files` (path -> bytes) with the STORE method. */
export function zipStore(files: Map<string, Uint8Array>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [path, data] of files) {
    const name = enc.encode(path);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04_03_4b_50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x08_00, true); // UTF-8 names
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02_01_4b_50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x08_00, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, 0x81_a4_00_00, true); // regular file, -rw-r--r-- (0o100644 << 16)
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06_05_4b_50, true);
  ev.setUint16(8, files.size, true);
  ev.setUint16(10, files.size, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/* oxlint-enable no-bitwise, unicorn/prefer-math-trunc */

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(
          new SandboxError("Timeout", "aborted", { aborted: true, provider: P })
        );
      },
      { once: true }
    );
  });

// ---------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------

export const awsLambda = defineProvider<
  AwsLambdaCaps,
  MicrovmRef,
  AwsLambdaOptions
>((opts) => {
  const port = opts.port ?? 8080;
  const hooksPort = opts.hooksPort ?? 9000;
  const runnerBase = opts.runnerBasePath ?? "";
  const tokenTtl = opts.tokenTtlMinutes ?? 30;
  if (!Number.isInteger(tokenTtl) || tokenTtl < 1 || tokenTtl > MAX_TOKEN_MIN) {
    throw new SandboxError(
      "Validation",
      `tokenTtlMinutes must be an integer from 1 to ${MAX_TOKEN_MIN} (got ${tokenTtl})`,
      { provider: P }
    );
  }
  const pollMs = opts.pollIntervalMs ?? 5000;
  /** Metadata/name of sandboxes this process created (MicroVMs have no tags). */
  const known = new Map<
    string,
    { metadata: Record<string, string>; name?: string }
  >();

  let clientP: Promise<MicrovmsClient> | null = null;
  const getClient = (): Promise<MicrovmsClient> => {
    clientP ??= loadAws().then(
      (mod) =>
        new mod.LambdaMicrovmsClient({
          credentials: opts.credentials,
          endpoint: opts.endpoint,
          region: opts.region,
        })
    );
    return clientP;
  };

  const dpFetch = (ctx: CallContext): typeof fetch => opts.fetch ?? ctx.fetch;

  /** Mint a token scoped to `ports`; returns it with its expiry. */
  const mintToken = async (
    microvmId: string,
    ports: number[]
  ): Promise<{ token: string; expiresAt: Date }> => {
    const mod = await loadAws();
    const client = await getClient();
    const res = await client.send(
      new mod.CreateMicrovmAuthTokenCommand({
        allowedPorts: ports.map((p) => ({ port: p })),
        expirationInMinutes: tokenTtl,
        microvmIdentifier: microvmId,
      })
    );
    const token = res.authToken?.["X-aws-proxy-auth"];
    if (!token) {
      throw new SandboxError(
        "Provider",
        "CreateMicrovmAuthToken returned no token",
        {
          provider: P,
        }
      );
    }
    // Refresh a minute early.
    return { expiresAt: new Date(Date.now() + tokenTtl * 60_000), token };
  };

  const makeHandle = (ref: MicrovmRef): DriverHandle<MicrovmRef> => {
    const tokens = new Map<number, { token: string; expiresAt: Date }>();
    const tokenFor = async (p: number, force = false) => {
      const t = tokens.get(p);
      if (!force && t && t.expiresAt.getTime() - Date.now() > 60_000) {
        return t;
      }
      const fresh = await mintToken(ref.microvmId, [p]);
      tokens.set(p, fresh);
      return fresh;
    };

    /** Data-plane request to the runner, refreshing an expired token once. */
    const dp = async (
      ctx: CallContext,
      path: string,
      init: {
        method: string;
        body?: BodyInit;
        json?: unknown;
        signal?: AbortSignal;
      }
    ): Promise<Response> => {
      const call = async (force: boolean) => {
        const { token } = await tokenFor(port, force);
        const headers: Record<string, string> = {
          "x-aws-proxy-auth": token,
          "x-aws-proxy-port": String(port),
        };
        if (init.json !== undefined) {
          headers["content-type"] = "application/json";
        }
        return dpFetch(ctx)(`https://${ref.endpoint}${runnerBase}${path}`, {
          body: init.json === undefined ? init.body : JSON.stringify(init.json),
          headers,
          method: init.method,
          signal: init.signal ?? ctx.signal,
        });
      };
      let res = await call(false);
      if (res.status === 401 || res.status === 403) {
        res = await call(true);
      }
      if (!res.ok) {
        throw dpError(path, res.status, await res.text().catch(() => ""));
      }
      return res;
    };

    const getMicrovm = async () => {
      const mod = await loadAws();
      const client = await getClient();
      return client.send(
        new mod.GetMicrovmCommand({ microvmIdentifier: ref.microvmId })
      );
    };

    const previewFor = async (p: number): Promise<Preview> => {
      const t = await tokenFor(p);
      return {
        auth: {
          headers: {
            "X-aws-proxy-auth": t.token,
            "X-aws-proxy-port": String(p),
          },
          type: "header",
        },
        expiresAt: t.expiresAt,
        port: p,
        url: `https://${ref.endpoint}`,
      };
    };

    return {
      id: ref.microvmId,
      raw: ref,

      async getInfo(ctx) {
        const got = await getMicrovm();
        let meta = known.get(ref.microvmId);
        if (!meta && got.state === "RUNNING") {
          // Not created by this process: ask the runner what /run delivered.
          meta = await dp(ctx, "/sbox/info", { method: "GET" })
            .then(
              (r) =>
                r.json() as Promise<{
                  metadata?: Record<string, string>;
                  name?: string;
                }>
            )
            .then((j) => ({ metadata: j.metadata ?? {}, name: j.name }))
            .catch(() => undefined);
          if (meta) {
            known.set(ref.microvmId, meta);
          }
        }
        return {
          createdAt: got.startedAt,
          id: ref.microvmId,
          metadata: meta?.metadata ?? {},
          name: meta?.name,
          provider: P,
          raw: got,
          state: mapMicrovmState(got.state),
        };
      },
      async destroy() {
        const mod = await loadAws();
        await (
          await getClient()
        ).send(
          new mod.TerminateMicrovmCommand({ microvmIdentifier: ref.microvmId })
        );
        known.delete(ref.microvmId);
      },
      async pause() {
        const mod = await loadAws();
        await (
          await getClient()
        ).send(
          new mod.SuspendMicrovmCommand({ microvmIdentifier: ref.microvmId })
        );
      },
      async resume() {
        const mod = await loadAws();
        await (
          await getClient()
        ).send(
          new mod.ResumeMicrovmCommand({ microvmIdentifier: ref.microvmId })
        );
      },

      exec(cmd: string, options: ExecOptions, ctx: CallContext): DriverExec {
        const queue = new AsyncQueue<OutputEvent>();
        const id = globalThis.crypto.randomUUID();
        const ac = new AbortController();
        ctx.signal?.addEventListener("abort", () => ac.abort(), { once: true });
        let done = false;
        const finish = (fn: () => void) => {
          if (!done) {
            done = true;
            fn();
          }
        };
        void (async () => {
          const res = await dp(ctx, "/sbox/exec", {
            json: {
              cmd,
              cwd: options.cwd,
              env: options.env,
              id,
              stream: true,
              timeoutMs: options.timeoutMs,
            },
            method: "POST",
            signal: ac.signal,
          });
          if (!(res.headers.get("content-type") ?? "").includes("ndjson")) {
            // Older buffered runner: one JSON object.
            const r = (await res.json()) as {
              stdout?: string;
              stderr?: string;
              exitCode?: number;
              timedOut?: boolean;
            };
            finish(() => {
              if (r.timedOut) {
                queue.fail(
                  new SandboxError("Timeout", "command timed out", {
                    provider: P,
                  })
                );
                return;
              }
              if (r.stdout) queue.push({ data: r.stdout, type: "stdout" });
              if (r.stderr) queue.push({ data: r.stderr, type: "stderr" });
              queue.push({ exitCode: r.exitCode ?? 0, type: "exit" });
              queue.close();
            });
            return;
          }
          const reader = res
            .body!.pipeThrough(new TextDecoderStream())
            .getReader();
          let buf = "";
          for (;;) {
            const { value, done: eof } = await reader.read();
            if (eof) {
              break;
            }
            buf += value;
            let nl = buf.indexOf("\n");
            while (nl !== -1) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              nl = buf.indexOf("\n");
              if (!line) {
                continue;
              }
              const ev = JSON.parse(line) as
                | { type: "stdout" | "stderr"; data: string }
                | {
                    type: "exit";
                    exitCode: number;
                    signal?: string;
                    timedOut?: boolean;
                  };
              if (ev.type === "exit") {
                finish(() => {
                  if (ev.timedOut) {
                    queue.fail(
                      new SandboxError(
                        "Timeout",
                        `command timed out after ${options.timeoutMs}ms`,
                        { provider: P, timedOut: true }
                      )
                    );
                    return;
                  }
                  queue.push({
                    exitCode: ev.exitCode,
                    signal: ev.signal,
                    type: "exit",
                  });
                  queue.close();
                });
              } else if (!done) {
                queue.push({ data: ev.data, type: ev.type });
              }
            }
          }
          finish(() =>
            queue.fail(
              new SandboxError(
                "Provider",
                "runner closed the stream without an exit",
                {
                  provider: P,
                }
              )
            )
          );
        })().catch((error: unknown) =>
          finish(() => queue.fail(mapAwsLambdaError(error) ?? error))
        );
        return {
          async kill(signal?: string) {
            await dp(ctx, "/sbox/kill", {
              json: { id, signal: signal ?? "SIGKILL" },
              method: "POST",
            }).catch(() => {});
          },
          pid: Promise.resolve(id),
          [Symbol.asyncIterator]: () => queue.iterator(),
        };
      },

      async listProcesses(ctx): Promise<ProcessInfo[]> {
        const res = await dp(ctx, "/sbox/ps", { method: "GET" });
        return ((await res.json()) as { id: string; cmd: string }[]).map(
          (p) => ({
            cmd: p.cmd,
            id: p.id,
          })
        );
      },
      async killProcess(processId, signal, ctx) {
        await dp(ctx, "/sbox/kill", {
          json: { id: processId, signal: signal ?? "SIGKILL" },
          method: "POST",
        });
      },

      async readFile(path, ctx) {
        const res = await dp(
          ctx,
          `/sbox/files?path=${encodeURIComponent(path)}`,
          {
            method: "GET",
          }
        );
        return new Uint8Array(await res.arrayBuffer());
      },
      async writeFile(path, data, ctx) {
        await dp(ctx, `/sbox/files?path=${encodeURIComponent(path)}`, {
          body: new Blob([new Uint8Array(data)]),
          method: "PUT",
        });
      },

      exposePort(p: number) {
        // Every MicroVM port is private: access needs a token scoped to it.
        return previewFor(p);
      },
      async listPorts() {
        return Promise.all(
          [...tokens.keys()].filter((p) => p !== port).map(previewFor)
        );
      },
      async unexposePort(p: number) {
        tokens.delete(p); // tokens cannot be revoked; they expire
      },
      async proxyFetch(p, path, init, ctx) {
        const pv = await previewFor(p);
        const headers = new Headers(init?.headers);
        if (pv.auth?.type === "header") {
          for (const [k, v] of Object.entries(pv.auth.headers)) {
            headers.set(k, v);
          }
        }
        return dpFetch(ctx)(new URL(path ?? "/", pv.url).toString(), {
          ...init,
          headers,
        });
      },
    };
  };

  // ---- templates -----------------------------------------------------------

  const resolveRegion = async (): Promise<string> =>
    opts.region ?? (await (await getClient()).config.region());

  const toRef = (img: {
    imageArn?: string;
    name?: string;
    createdAt?: Date;
    tags?: Record<string, string>;
  }): TemplateRef => ({
    cacheKey: img.tags?.[CACHE_TAG],
    createdAt: img.createdAt,
    id: img.imageArn ?? "",
    name: img.name,
    provider: P,
    raw: img,
  });

  async function* listImages() {
    const mod = await loadAws();
    const client = await getClient();
    let nextToken: string | undefined;
    do {
      const res = await client.send(
        new mod.ListMicrovmImagesCommand({ nextToken })
      );
      yield* res.items ?? [];
      nextToken = res.nextToken;
    } while (nextToken);
  }

  async function waitForVersion(
    imageArn: string,
    imageVersion: string,
    onEvent: (e: TemplateBuildEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const mod = await loadAws();
    const client = await getClient();
    const seen = new Map<string, string>();
    for (;;) {
      const v = await client.send(
        new mod.GetMicrovmImageVersionCommand({
          imageIdentifier: imageArn,
          imageVersion,
        })
      );
      const builds = await client
        .send(
          new mod.ListMicrovmImageBuildsCommand({
            imageIdentifier: imageArn,
            imageVersion,
          })
        )
        .catch(() => ({ items: [] }));
      for (const b of builds.items ?? []) {
        if (b.buildId && seen.get(b.buildId) !== b.buildState) {
          seen.set(b.buildId, b.buildState ?? "");
          let reason = b.stateReason;
          if (b.buildState === "FAILED" && !reason) {
            const detail = await client
              .send(
                new mod.GetMicrovmImageBuildCommand({
                  buildId: b.buildId,
                  imageIdentifier: imageArn,
                  imageVersion,
                })
              )
              .catch(() => undefined);
            reason = detail?.stateReason;
          }
          onEvent({
            line: `build ${b.buildId} (${b.architecture ?? "?"}/${b.chipset ?? "?"}): ${b.buildState}${reason ? ` - ${reason}` : ""}`,
            step: "build",
            type: "log",
          });
        }
      }
      if (v.state === "SUCCESSFUL") {
        return;
      }
      if (v.state === "FAILED" || v.state === "DELETED") {
        throw new SandboxError(
          "Provider",
          `image ${imageArn} version ${imageVersion} ${v.state}: ${v.stateReason ?? "see CloudWatch /aws/lambda-microvms/<image-name>"}`,
          { provider: P }
        );
      }
      onEvent({ message: v.state, status: "building", type: "status" });
      await sleep(pollMs, signal);
    }
  }

  const templates: DriverTemplates = {
    async build(spec, bopts) {
      const { source } = spec;
      if (!("dockerfile" in source) || source.dockerfile === undefined) {
        throw new SandboxError(
          "NotSupported",
          "aws-lambda templates are built from a Dockerfile",
          { provider: P }
        );
      }
      if (!opts.s3Bucket || !opts.buildRoleArn) {
        throw new SandboxError(
          "Validation",
          "aws-lambda template builds need the s3Bucket and buildRoleArn options",
          { provider: P }
        );
      }
      const mod = await loadAws();
      const client = await getClient();
      const region = await resolveRegion();
      // Zip the context with the Dockerfile at the root.
      const files = await loadTemplateContext(source.context);
      files.set("Dockerfile", new TextEncoder().encode(source.dockerfile));
      const zip = zipStore(files);
      const key = `${opts.s3Prefix ?? "sbox-templates/"}${spec.name}-${spec.cacheKey.slice(0, 16)}.zip`;
      bopts.onEvent({
        line: `uploading s3://${opts.s3Bucket}/${key} (${zip.length} bytes)`,
        step: "upload",
        type: "log",
      });
      const s3 = await import("@aws-sdk/client-s3");
      await new s3.S3Client({
        credentials: opts.credentials,
        region,
      }).send(
        new s3.PutObjectCommand({
          Body: zip,
          Bucket: opts.s3Bucket,
          ContentType: "application/zip",
          Key: key,
        })
      );
      const name = spec.name.replaceAll(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
      const input = {
        baseImageArn:
          opts.baseImageArn ??
          `arn:aws:lambda:${region}:aws:microvm-image:al2023-1`,
        buildRoleArn: opts.buildRoleArn,
        clientToken: spec.cacheKey.slice(0, 64),
        codeArtifact: { uri: `s3://${opts.s3Bucket}/${key}` },
        description: `sbox template ${spec.cacheKey.slice(0, 12)}`,
        environmentVariables: spec.env,
        hooks: { microvmHooks: { run: "ENABLED" as const }, port: hooksPort },
        logging: opts.logging,
        resources: spec.resources?.memoryMB
          ? [{ minimumMemoryInMiB: spec.resources.memoryMB }]
          : undefined,
      };
      let imageArn: string;
      let imageVersion: string;
      try {
        const res = await client.send(
          new mod.CreateMicrovmImageCommand({
            ...input,
            name,
            tags: { [CACHE_TAG]: spec.cacheKey },
          })
        );
        imageArn = res.imageArn!;
        imageVersion = res.imageVersion!;
      } catch (error) {
        if (mapAwsLambdaError(error)?.code !== "Conflict") {
          throw error;
        }
        // An image with this name exists (e.g. a forced rebuild): new version.
        const res = await client.send(
          new mod.UpdateMicrovmImageCommand({ ...input, imageIdentifier: name })
        );
        imageArn = res.imageArn!;
        imageVersion = res.imageVersion!;
        await client.send(
          new mod.TagResourceCommand({
            Resource: imageArn,
            Tags: { [CACHE_TAG]: spec.cacheKey },
          })
        );
      }
      bopts.onEvent({
        message: `${imageArn} v${imageVersion}`,
        status: "building",
        type: "status",
      });
      await waitForVersion(imageArn, imageVersion, bopts.onEvent, bopts.signal);
      return toRef({
        createdAt: new Date(),
        imageArn,
        name,
        tags: { [CACHE_TAG]: spec.cacheKey },
      });
    },

    async lookup(idOrKey) {
      const mod = await loadAws();
      const client = await getClient();
      const ready = (s?: string) => s === "CREATED" || s === "UPDATED";
      if (idOrKey.startsWith("arn:")) {
        try {
          const img = await client.send(
            new mod.GetMicrovmImageCommand({ imageIdentifier: idOrKey })
          );
          return ready(img.state) ? toRef(img) : undefined;
        } catch (error) {
          if (mapAwsLambdaError(error)?.code === "NotFound") {
            return undefined;
          }
          throw error;
        }
      }
      const isKey = /^[0-9a-f]{32,}$/.test(idOrKey);
      for await (const img of listImages()) {
        if (!ready(img.state) || !img.latestActiveImageVersion) {
          continue;
        }
        if (img.name === idOrKey) {
          return toRef(img);
        }
        if (isKey && img.name?.startsWith("sbox-")) {
          const full = await client.send(
            new mod.GetMicrovmImageCommand({ imageIdentifier: img.imageArn! })
          );
          if (full.tags?.[CACHE_TAG] === idOrKey) {
            return toRef(full);
          }
        }
      }
      if (isKey) {
        // Custom-named templates: check tags on every image (cold path).
        for await (const img of listImages()) {
          if (!ready(img.state) || img.name?.startsWith("sbox-")) {
            continue;
          }
          const full = await client.send(
            new mod.GetMicrovmImageCommand({ imageIdentifier: img.imageArn! })
          );
          if (full.tags?.[CACHE_TAG] === idOrKey) {
            return toRef(full);
          }
        }
      }
      return undefined;
    },
    async *list() {
      for await (const img of listImages()) {
        yield toRef(img);
      }
    },
    async delete(id) {
      const mod = await loadAws();
      await (
        await getClient()
      ).send(new mod.DeleteMicrovmImageCommand({ imageIdentifier: id }));
    },
  };

  // ---- provider --------------------------------------------------------------

  const provider: SandboxProvider<AwsLambdaCaps, MicrovmRef> = {
    capabilities: AWS_LAMBDA_CAPS,
    flags: AWS_LAMBDA_FLAGS,
    mapError: mapAwsLambdaError,
    name: P,
    templates,

    async create(spec: ResolvedSandboxSpec, ctx) {
      const image = spec.template ?? opts.imageIdentifier;
      if (!image) {
        throw new SandboxError(
          "Validation",
          "aws-lambda requires an image ARN (spec.template or the imageIdentifier option)",
          { provider: P }
        );
      }
      if (spec.resources?.gpu || spec.volumes?.length || spec.fromSnapshot) {
        throw new SandboxError(
          "Validation",
          "aws-lambda MicroVMs have no GPUs, volumes or boot-from-snapshot",
          { provider: P }
        );
      }
      if (spec.network?.mode === "allow-list") {
        throw new SandboxError(
          "Validation",
          "aws-lambda egress is all-or-nothing (network connectors); allow-list is not supported",
          { provider: P }
        );
      }
      const env: Record<string, string> = { ...spec.env };
      for (const s of spec.secrets ?? []) {
        if (s.value === undefined || s.mode === "egress") {
          throw new SandboxError(
            "Validation",
            "aws-lambda secrets must be inline values (delivered via the run hook)",
            { provider: P }
          );
        }
        env[s.envVar ?? s.name] = s.value;
      }
      const metadata = { ...spec.metadata };
      const payload = JSON.stringify({ env, metadata, name: spec.name });
      if (new TextEncoder().encode(payload).length > MAX_PAYLOAD) {
        throw new SandboxError(
          "Validation",
          `env + metadata exceed the ${MAX_PAYLOAD}-byte runHookPayload limit`,
          { provider: P }
        );
      }
      const maxDuration =
        opts.maximumDurationInSeconds ??
        (spec.lifecycle?.maxAgeMs
          ? clamp(
              Math.ceil(spec.lifecycle.maxAgeMs / 1000),
              1,
              MAX_DURATION_SEC
            )
          : undefined);
      const idlePolicy = idlePolicyFor(
        spec.lifecycle,
        opts.idlePolicy,
        maxDuration
      );
      const key = ctx.idempotencyKey;
      const input: RunMicrovmCommandInput = {
        clientToken: key
          ? key.length <= 64
            ? key
            : (await sha256Hex(key)).slice(0, 64)
          : undefined,
        egressNetworkConnectors:
          spec.network?.mode === "block-all"
            ? []
            : opts.egressNetworkConnectors,
        executionRoleArn: opts.executionRoleArn,
        idlePolicy,
        imageIdentifier: image,
        imageVersion: spec.template ? undefined : opts.imageVersion,
        ingressNetworkConnectors: opts.ingressNetworkConnectors,
        logging: opts.logging,
        maximumDurationInSeconds: maxDuration,
        runHookPayload: payload,
      };
      const mod = await loadAws();
      const run = await (
        await getClient()
      ).send(new mod.RunMicrovmCommand(input));
      if (!run.microvmId || !run.endpoint) {
        throw new SandboxError(
          "Provider",
          "RunMicrovm returned no id/endpoint",
          {
            provider: P,
          }
        );
      }
      known.set(run.microvmId, { metadata, name: spec.name });
      return makeHandle({ endpoint: run.endpoint, microvmId: run.microvmId });
    },

    async connect(id) {
      const mod = await loadAws();
      const got = await (
        await getClient()
      ).send(new mod.GetMicrovmCommand({ microvmIdentifier: id }));
      return makeHandle({ endpoint: got.endpoint ?? "", microvmId: id });
    },

    async *list(filter) {
      const mod = await loadAws();
      const client = await getClient();
      let nextToken: string | undefined;
      let n = 0;
      do {
        const res = await client.send(
          new mod.ListMicrovmsCommand({ nextToken })
        );
        for (const m of res.items ?? []) {
          const id = m.microvmId ?? "";
          const state = mapMicrovmState(m.state);
          if (filter?.state ? state !== filter.state : state === "destroyed") {
            continue;
          }
          const meta = known.get(id);
          if (
            filter?.metadata &&
            !Object.entries(filter.metadata).every(
              ([k, v]) => meta?.metadata[k] === v
            )
          ) {
            continue;
          }
          if (filter?.limit !== undefined && n >= filter.limit) {
            return;
          }
          n++;
          yield {
            createdAt: m.startedAt,
            id,
            metadata: meta?.metadata ?? {},
            name: meta?.name,
            provider: P,
            raw: m,
            state,
          } satisfies SandboxInfo;
        }
        nextToken = res.nextToken;
      } while (nextToken);
    },

    async verify() {
      const mod = await loadAws();
      await (
        await getClient()
      ).send(new mod.ListMicrovmsCommand({ maxResults: 1 }));
      return { account: await resolveRegion() };
    },
  };
  return provider;
});
