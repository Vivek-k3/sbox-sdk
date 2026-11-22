/**
 * `sbox-sdk/tensorlake`: adapter for Tensorlake sandboxes (Firecracker /
 * Cloud Hypervisor microVMs).
 *
 * The runtime talks to the documented Tensorlake HTTP API directly over
 * `fetch` (`https://api.tensorlake.ai` for lifecycle, the per-sandbox proxy
 * `https://<id>.sandbox.tensorlake.ai` for processes, files and PTYs, and
 * `https://git.tensorlake.ai` for volumes). The `tensorlake` npm package is a
 * thin shim over a required native Rust binding (no darwin-x64 build, Node
 * only), so it is NOT used for the runtime.
 *
 * The one exception is `templates.build()`: Tensorlake publishes no HTTP API
 * for image builds, so template builds lazily import the optional `tensorlake`
 * peer and call its `createSandboxImage` / `importSandboxImage`.
 */
import {
  AsyncQueue,
  defaultTemplateName,
  defineProvider,
  loadTemplateContext,
  NotSupportedError,
  SandboxError,
} from "../adapter/index.js";
import type {
  CallContext,
  CapabilityFlags,
  CapabilityMap,
  DirEntry,
  DriverExec,
  DriverHandle,
  DriverProcess,
  DriverPty,
  DriverTemplates,
  DriverVolumes,
  EgressPolicy,
  ExecOptions,
  FileBody,
  ListFilter,
  OutputEvent,
  Preview,
  ProcessInfo,
  PtyOptions,
  ResolvedSandboxSpec,
  SandboxInfo,
  SandboxMetrics,
  SandboxProvider,
  SandboxState,
  SnapshotRef,
  TemplateBuildEvent,
  TemplateRef,
  TemplateSpec,
  VolumeInfo,
} from "../adapter/index.js";

// --------------------------------------------------------------------------
// options + capabilities
// --------------------------------------------------------------------------

/** Minimal WebSocket shape the PTY needs (Node 22+/Bun global WebSocket). */
export interface TensorlakeWebSocket {
  binaryType: string;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", fn: () => void): void;
  addEventListener(
    type: "message",
    fn: (ev: { data: ArrayBuffer | Uint8Array | string }) => void
  ): void;
  addEventListener(
    type: "close",
    fn: (ev: { code: number; reason: string }) => void
  ): void;
  addEventListener(type: "error", fn: (ev: unknown) => void): void;
}

/**
 * WebSocket constructor that accepts upgrade headers. Node's (undici) and
 * Bun's global `WebSocket` both take `{ headers }` as the second argument;
 * the PTY attach needs `Authorization` and `X-PTY-Token` headers.
 */
export type TensorlakeWebSocketCtor = new (
  url: string,
  init: { headers: Record<string, string> }
) => TensorlakeWebSocket;

export interface TensorlakeOptions {
  /** Project-scoped API key (`TENSORLAKE_API_KEY`). */
  apiKey: string;
  /** Lifecycle API origin. Default `https://api.tensorlake.ai`. */
  apiUrl?: string;
  /**
   * Project id, needed only for `client.volumes` (Cloud Volumes live under
   * `git.tensorlake.ai/project/<id>`). Read from the minted volume token when
   * omitted.
   */
  projectId?: string;
  /** Cloud Volumes origin. Default `https://git.tensorlake.ai`. */
  volumesUrl?: string;
  /** Default image for sandboxes created without a `template`. */
  defaultImage?: string;
  /** How long `create()`/`resume()` wait for `running`. Default 300 000 ms. */
  readyTimeoutMs?: number;
  /** Transport override (tests). Defaults to the client's `fetch`. */
  fetch?: typeof fetch;
  /** WebSocket override for PTYs (tests). Defaults to `globalThis.WebSocket`. */
  WebSocket?: TensorlakeWebSocketCtor;
}

export const TENSORLAKE_CAPS = {
  background: "native",
  codeInterpreter: "unsupported",
  egressControl: "native",
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "unsupported",
  fork: "native",
  gpu: "native",
  killProcess: "native",
  list: "native",
  metrics: "native",
  pause: "native",
  privatePreview: "native",
  proxiedFetch: "unsupported",
  pty: "native",
  region: "unsupported",
  secretsVault: "native",
  setTimeout: "unsupported",
  snapshot: "native",
  ssh: "unsupported",
  statefulKernel: "unsupported",
  stdin: "native",
  stop: "unsupported",
  streaming: "native",
  templateBuild: "native",
  volumes: "native",
} as const satisfies CapabilityMap;

export type TensorlakeCaps = typeof TENSORLAKE_CAPS;

const TENSORLAKE_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true,
  preservesDiskOnStop: false,
  preservesMemoryOnPause: true,
  // Private ports need `Authorization: Bearer <api key>`; browsers can't send
  // that on a WebSocket (the session-cookie flow is for Tensorlake Cloud users).
  previewBrowserAuth: false,
  previewModel: "subdomain",
  templateSources: ["dockerfile", "image"],
};

const PROVIDER = "tensorlake";
const DEFAULT_API = "https://api.tensorlake.ai";
const DEFAULT_INGRESS = "https://sandbox.tensorlake.ai";
const DEFAULT_VOLUMES = "https://git.tensorlake.ai";
/** Where `spec.env` is persisted so reconnected handles see it. */
const ENV_FILE = "/var/tmp/.sbox/env.json";

// --------------------------------------------------------------------------
// wire types (snake_case, from https://docs.tensorlake.ai/api-reference/openapi.yaml)
// --------------------------------------------------------------------------

export type TlSandboxStatus =
  | "pending"
  | "running"
  | "snapshotting"
  | "suspending"
  | "suspended"
  | "terminated"
  | "resume_failed"
  | "timeout"
  | "failed";

export interface TlNetwork {
  allow_internet_access?: boolean;
  allow_out?: string[];
  deny_out?: string[];
}

export interface TlFileSystemMount {
  file_system_id: string;
  mount_path: string;
  read_only?: boolean;
}

export interface TlSandboxInfo {
  id: string;
  name?: string | null;
  namespace?: string;
  status: TlSandboxStatus;
  image?: string;
  created_at?: number;
  resources?: { cpus: number; memory_mb: number; disk_mb: number };
  timeout_secs?: number;
  ingress_endpoint?: string | null;
  sandbox_url?: string | null;
  network_policy?: TlNetwork | null;
  allow_unauthenticated_access?: boolean;
  exposed_ports?: number[] | null;
  auto_resume?: boolean;
  termination_reason?: string | null;
  error_details?: string | null;
  pending_reason?: string | null;
  file_systems?: TlFileSystemMount[];
}

export interface TlCreateRequest {
  name?: string;
  image?: string;
  snapshot_id?: string;
  resources?: {
    cpus?: number;
    memory_mb?: number;
    disk_mb?: number;
    gpus?: { count: number; model: string }[];
  };
  secret_names?: string[];
  timeout_secs?: number;
  network?: TlNetwork;
  allow_unauthenticated_access?: boolean;
  exposed_ports?: number[];
  auto_resume?: boolean;
  file_systems?: TlFileSystemMount[];
  wait?: boolean;
}

interface TlCreateResponse {
  sandbox_id: string;
  status?: TlSandboxStatus;
  state?: TlSandboxStatus;
  ingress_endpoint?: string | null;
}

interface TlSnapshotInfo {
  snapshot_id?: string;
  id?: string;
  sandbox_id?: string;
  status?: string;
  snapshot_type?: "memory" | "filesystem";
  created_at?: number | string;
  error?: string;
}

interface TlRunEvent {
  pid?: number;
  line?: string;
  stream?: "stdout" | "stderr";
  exit_code?: number;
  signal?: number;
  reason?: string;
}

interface TlProcessInfo {
  pid: number;
  status: "running" | "exited" | "signaled" | "oom_killed";
  exit_code?: number | null;
  signal?: number | null;
  command: string;
  args: string[];
}

// --------------------------------------------------------------------------
// errors
// --------------------------------------------------------------------------

/** An HTTP error from the Tensorlake API or the sandbox proxy. */
export class TensorlakeHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "TensorlakeHttpError";
    this.status = status;
    this.code = code;
  }
}

export function mapTensorlakeError(err: unknown): SandboxError | undefined {
  if (err instanceof SandboxError) {
    return err;
  }
  if (err instanceof TensorlakeHttpError) {
    const init = { cause: err, provider: PROVIDER, status: err.status };
    const msg = `${err.message}${err.code ? ` (${err.code})` : ""}`;
    if (err.code === "QUOTA_EXCEEDED") {
      return new SandboxError("QuotaExceeded", msg, init);
    }
    switch (err.status) {
      case 401:
      case 403:
        return new SandboxError("Unauthorized", msg, init);
      case 404:
        return new SandboxError("NotFound", msg, init);
      case 409:
        return new SandboxError("Conflict", msg, init);
      case 408:
      case 504:
        return new SandboxError("Timeout", msg, init);
      case 429:
        return new SandboxError("QuotaExceeded", msg, {
          ...init,
          retryable: true,
        });
      case 400:
      case 422:
        return new SandboxError("Validation", msg, init);
      default:
        return new SandboxError("Provider", msg, init);
    }
  }
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return new SandboxError("Timeout", err.message, {
        aborted: err.name === "AbortError",
        cause: err,
        provider: PROVIDER,
      });
    }
    // Native image-build errors carry a stable `code`.
    const code = (err as { code?: unknown }).code;
    if (code === "auth") {
      return new SandboxError("Unauthorized", err.message, {
        cause: err,
        provider: PROVIDER,
      });
    }
    if (code === "not_found") {
      return new SandboxError("NotFound", err.message, {
        cause: err,
        provider: PROVIDER,
      });
    }
    if (code === "timeout") {
      return new SandboxError("Timeout", err.message, {
        cause: err,
        provider: PROVIDER,
      });
    }
  }
  return undefined;
}

const wrap = (err: unknown): SandboxError =>
  mapTensorlakeError(err) ?? SandboxError.wrap(err, PROVIDER);

// --------------------------------------------------------------------------
// state mapping
// --------------------------------------------------------------------------

export function mapTensorlakeStatus(status: string | undefined): SandboxState {
  switch (status) {
    case "pending":
      return "creating";
    // Snapshotting is a live VM that returns to running on its own.
    case "running":
    case "snapshotting":
      return "running";
    case "suspending":
      return "suspending";
    case "suspended":
      return "paused";
    case "terminated":
    case "timeout":
      return "destroyed";
    case "failed":
    case "resume_failed":
      return "error";
    default:
      return "unknown";
  }
}

/** Egress policy → Tensorlake `network`. `null` clears the policy. */
export function toTensorlakeNetwork(policy: EgressPolicy): TlNetwork | null {
  if (policy.inject && policy.inject.length > 0) {
    throw new SandboxError(
      "Validation",
      "Tensorlake has no egress credential injection (EgressPolicy.inject)",
      { provider: PROVIDER }
    );
  }
  const deny = [...(policy.deny?.domains ?? []), ...(policy.deny?.cidrs ?? [])];
  switch (policy.mode) {
    case "allow-all":
      return deny.length === 0
        ? null
        : { allow_internet_access: true, allow_out: [], deny_out: deny };
    case "block-all":
      return { allow_internet_access: false, allow_out: [], deny_out: [] };
    case "allow-list": {
      const allow = [...(policy.domains ?? []), ...(policy.cidrs ?? [])];
      if (allow.length === 0) {
        return { allow_internet_access: false, allow_out: [], deny_out: [] };
      }
      return { allow_internet_access: true, allow_out: allow, deny_out: deny };
    }
    default:
      throw new SandboxError("Validation", "unknown egress mode", {
        provider: PROVIDER,
      });
  }
}

/** Map the provider-neutral spec onto `POST /sandboxes`. */
export function toTensorlakeCreate(
  spec: ResolvedSandboxSpec,
  name: string | undefined,
  defaultImage?: string
): { body: TlCreateRequest; inlineSecretEnv: Record<string, string> } {
  const body: TlCreateRequest = { wait: true };
  if (name) {
    body.name = name;
  }
  if (spec.fromSnapshot) {
    body.snapshot_id = spec.fromSnapshot;
  } else if (spec.template ?? defaultImage) {
    body.image = spec.template ?? defaultImage;
  }
  const r = spec.resources;
  if (r) {
    const resources: NonNullable<TlCreateRequest["resources"]> = {};
    if (r.vcpus !== undefined) {
      resources.cpus = r.vcpus;
    }
    if (r.memoryMB !== undefined) {
      resources.memory_mb = r.memoryMB;
    }
    if (r.diskMB !== undefined) {
      resources.disk_mb = r.diskMB;
    }
    if (r.gpu !== undefined || r.gpuCount !== undefined) {
      resources.gpus = [{ count: r.gpuCount ?? 1, model: r.gpu ?? "A10" }];
    }
    if (Object.keys(resources).length > 0) {
      body.resources = resources;
    }
  }
  const lc = spec.lifecycle;
  if (lc?.idleTimeoutMs !== undefined) {
    body.timeout_secs = Math.max(1, Math.ceil(lc.idleTimeoutMs / 1000));
  }
  if (lc?.autoResume !== undefined && name) {
    body.auto_resume = lc.autoResume;
  }
  if (spec.network) {
    const net = toTensorlakeNetwork(spec.network);
    if (net) {
      body.network = net;
    }
  }
  if (spec.ports && spec.ports.length > 0) {
    // Ports declared at create follow the core's default visibility: public.
    body.exposed_ports = [...new Set(spec.ports)];
    body.allow_unauthenticated_access = true;
  }
  if (spec.volumes && spec.volumes.length > 0) {
    body.file_systems = spec.volumes.map((v) => ({
      file_system_id: v.id,
      mount_path: v.mountPath,
      ...(v.readOnly ? { read_only: true } : {}),
    }));
  }
  const inlineSecretEnv: Record<string, string> = {};
  const secretNames: string[] = [];
  for (const s of spec.secrets ?? []) {
    if (s.mode === "egress") {
      throw new SandboxError(
        "Validation",
        `secret '${s.name}': Tensorlake has no egress-injected secrets`,
        { provider: PROVIDER }
      );
    }
    if (s.value !== undefined) {
      inlineSecretEnv[s.envVar ?? s.name] = s.value;
      continue;
    }
    if (s.envVar && s.envVar !== s.name) {
      throw new SandboxError(
        "Validation",
        `secret '${s.name}': Tensorlake injects project secrets under their own name; envVar renaming is not supported`,
        { provider: PROVIDER }
      );
    }
    secretNames.push(s.name);
  }
  if (secretNames.length > 0) {
    body.secret_names = secretNames;
  }
  return { body, inlineSecretEnv };
}

// --------------------------------------------------------------------------
// small helpers
// --------------------------------------------------------------------------

const enc = new TextEncoder();

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

async function sha256Hex(s: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    enc.encode(s)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Tensorlake sandbox/image names: lowercase alphanumerics and `-`. */
function slug(s: string, max = 40): string {
  const out = s
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return out.slice(0, max).replace(/-$/, "") || "sbox";
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

async function bodyBytes(data: FileBody): Promise<Uint8Array> {
  if (typeof data === "string") {
    return enc.encode(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  return new Uint8Array(await new Response(data).arrayBuffer());
}

/** `ingress_endpoint` origin + label → `https://<label>.<host>`. */
function ingressUrl(ingress: string | null | undefined, label: string): string {
  const u = new URL(ingress || DEFAULT_INGRESS);
  return `${u.protocol}//${label}.${u.host}`;
}

/**
 * Parse a `text/event-stream` body into frames.
 * @yields {{ event: string; data: string }} One item per SSE frame.
 */
async function* readSse(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const td = new TextDecoder();
  let buf = "";
  let event = "message";
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        buf += td.decode(value, { stream: true });
      }
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") {
          if (data.length > 0) {
            yield { data: data.join("\n"), event };
          }
          event = "message";
          data = [];
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        } else if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        }
        nl = buf.indexOf("\n");
      }
      if (done) {
        if (data.length > 0) {
          yield { data: data.join("\n"), event };
        }
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Tensorlake streams output as lines (newline stripped), like its own SDK
 * which joins them with "\n". Emit "\n" BEFORE every line but the first per
 * stream, so the concatenated stream equals `lines.join("\n")` with no
 * buffering delay.
 */
function lineJoiner(): (stream: "stdout" | "stderr", line: string) => string {
  const seen = { stderr: false, stdout: false };
  return (stream, line) => {
    const out = seen[stream] ? `\n${line}` : line;
    seen[stream] = true;
    return out;
  };
}

const SIGNALS: Record<string, number> = {
  HUP: 1,
  INT: 2,
  KILL: 9,
  QUIT: 3,
  TERM: 15,
  USR1: 10,
  USR2: 12,
};

function signalNumber(signal: string | undefined): number {
  if (!signal) {
    return 9;
  }
  const n = Number(signal);
  if (Number.isInteger(n) && n > 0) {
    return n;
  }
  return SIGNALS[signal.toUpperCase().replace(/^SIG/, "")] ?? 9;
}

// --------------------------------------------------------------------------
// HTTP client
// --------------------------------------------------------------------------

interface CallInit {
  method?: string;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Return the raw Response (caller consumes the body). */
  raw?: boolean;
  /** Treat 404 as `undefined` instead of throwing. */
  allow404?: boolean;
}

class Http {
  readonly #apiKey: string;
  readonly #override?: typeof fetch;
  constructor(apiKey: string, override?: typeof fetch) {
    this.#apiKey = apiKey;
    this.#override = override;
  }

  get authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.#apiKey}` };
  }

  async call<T>(
    ctx: CallContext,
    url: string,
    init: CallInit = {}
  ): Promise<T | undefined> {
    const f = this.#override ?? ctx.fetch ?? globalThis.fetch;
    const headers: Record<string, string> = {
      ...this.authHeader,
      ...init.headers,
    };
    let body = init.body;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    const reqInit: RequestInit & { duplex?: "half" } = {
      body,
      headers,
      method: init.method ?? "GET",
      signal: init.signal ?? ctx.signal,
    };
    if (body instanceof ReadableStream) {
      reqInit.duplex = "half";
    }
    const res = await f(url, reqInit);
    if (!res.ok) {
      if (res.status === 404 && init.allow404) {
        await res.body?.cancel();
        return undefined;
      }
      throw await httpError(res);
    }
    if (init.raw) {
      return res as unknown as T;
    }
    if (res.status === 204) {
      return undefined;
    }
    const text = await res.text();
    if (!text) {
      return undefined;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
}

async function httpError(res: Response): Promise<TensorlakeHttpError> {
  const text = await res.text().catch(() => "");
  let message = text || res.statusText || `HTTP ${res.status}`;
  let code: string | undefined;
  try {
    const parsed = JSON.parse(text) as { error?: string; code?: string };
    if (parsed && typeof parsed === "object") {
      message = parsed.error ?? message;
      code = parsed.code;
    }
  } catch {
    // plain-text error body
  }
  return new TensorlakeHttpError(res.status, message, code);
}

// --------------------------------------------------------------------------
// lazy SDK (template builds only)
// --------------------------------------------------------------------------

type TensorlakeModule = typeof import("tensorlake");
let sdkModule: TensorlakeModule | null = null;
async function loadSdk(): Promise<TensorlakeModule> {
  if (!sdkModule) {
    try {
      sdkModule = await import("tensorlake");
    } catch (error) {
      throw new SandboxError(
        "Validation",
        "templates.build() on Tensorlake needs the optional peer 'tensorlake' (npm i tensorlake); Tensorlake has no public HTTP image-build API",
        { cause: error, provider: PROVIDER }
      );
    }
  }
  return sdkModule;
}

/**
 * The SDK's image builders read `TENSORLAKE_API_KEY`/`TENSORLAKE_API_URL`
 * synchronously at call start (`buildContextFromEnv()` is their first
 * statement). Swap the env for that synchronous prefix only, then restore,
 * so concurrent clients with different keys never see each other's key.
 */
function withSdkEnv<T>(apiKey: string, apiUrl: string, fn: () => T): T {
  const prevKey = process.env.TENSORLAKE_API_KEY;
  const prevUrl = process.env.TENSORLAKE_API_URL;
  process.env.TENSORLAKE_API_KEY = apiKey;
  process.env.TENSORLAKE_API_URL = apiUrl;
  try {
    return fn();
  } finally {
    if (prevKey === undefined) {
      delete process.env.TENSORLAKE_API_KEY;
    } else {
      process.env.TENSORLAKE_API_KEY = prevKey;
    }
    if (prevUrl === undefined) {
      delete process.env.TENSORLAKE_API_URL;
    } else {
      process.env.TENSORLAKE_API_URL = prevUrl;
    }
  }
}

function dockerConfigFor(
  image: string,
  auth: { username: string; password: string }
): string {
  const first = image.split("/")[0] ?? "";
  const registry =
    first.includes(".") || first.includes(":") || first === "localhost"
      ? first
      : "https://index.docker.io/v1/";
  const token = btoa(`${auth.username}:${auth.password}`);
  return JSON.stringify({ auths: { [registry]: { auth: token } } });
}

/** Registered image name for a template: always ends with the key prefix. */
export function tensorlakeTemplateName(name: string, cacheKey: string): string {
  if (name === defaultTemplateName(cacheKey)) {
    return name;
  }
  return `${slug(name, 40)}-${cacheKey.slice(0, 12)}`;
}

function templateLines(spec: TemplateSpec): string[] {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    lines.push(`ENV ${k}=${JSON.stringify(v)}`);
  }
  if (spec.workdir) {
    lines.push(`WORKDIR ${spec.workdir}`);
  }
  if (spec.user) {
    lines.push(`USER ${spec.user}`);
  }
  if (spec.startCmd) {
    lines.push(`CMD ["sh", "-c", ${JSON.stringify(spec.startCmd)}]`);
  }
  return lines;
}

// --------------------------------------------------------------------------
// provider
// --------------------------------------------------------------------------

export type TensorlakeRaw = TlSandboxInfo;

export const tensorlake = defineProvider(
  (opts: TensorlakeOptions): SandboxProvider<TensorlakeCaps, TensorlakeRaw> => {
    if (!opts?.apiKey) {
      throw new SandboxError(
        "Unauthorized",
        "tensorlake({ apiKey }) is required (TENSORLAKE_API_KEY)",
        { provider: PROVIDER }
      );
    }
    const apiUrl = (opts.apiUrl ?? DEFAULT_API).replace(/\/$/, "");
    const volumesUrl = (opts.volumesUrl ?? DEFAULT_VOLUMES).replace(/\/$/, "");
    const readyTimeoutMs = opts.readyTimeoutMs ?? 300_000;
    const http = new Http(opts.apiKey, opts.fetch);
    const sb = (id: string, suffix = ""): string =>
      `${apiUrl}/sandboxes/${encodeURIComponent(id)}${suffix}`;

    const getInfo = async (
      ctx: CallContext,
      id: string
    ): Promise<TlSandboxInfo> => {
      const info = await http.call<TlSandboxInfo>(ctx, sb(id));
      if (!info) {
        throw new SandboxError("NotFound", `no sandbox ${id}`, {
          provider: PROVIDER,
        });
      }
      return info;
    };

    /** Poll until the sandbox leaves its transient states. */
    const waitFor = async (
      ctx: CallContext,
      id: string,
      want: TlSandboxStatus,
      timeoutMs = readyTimeoutMs
    ): Promise<TlSandboxInfo> => {
      const deadline = Date.now() + timeoutMs;
      let delay = 250;
      for (;;) {
        const info = await getInfo(ctx, id);
        if (info.status === want) {
          return info;
        }
        if (
          info.status === "terminated" ||
          info.status === "failed" ||
          info.status === "timeout" ||
          (info.status === "resume_failed" && want === "running")
        ) {
          throw new SandboxError(
            "Provider",
            `sandbox ${id} is ${info.status}${info.termination_reason ? ` (${info.termination_reason})` : ""}${info.error_details ? `: ${info.error_details}` : ""}`,
            { provider: PROVIDER, retryable: false }
          );
        }
        if (Date.now() > deadline) {
          throw new SandboxError(
            "Timeout",
            `sandbox ${id} still ${info.status} after ${timeoutMs}ms${info.pending_reason ? ` (${info.pending_reason})` : ""}`,
            { provider: PROVIDER }
          );
        }
        await sleep(delay, ctx.signal);
        delay = Math.min(delay * 2, 2000);
      }
    };

    const toInfo = (info: TlSandboxInfo): SandboxInfo => ({
      createdAt:
        info.created_at === undefined ? undefined : new Date(info.created_at),
      id: info.id,
      // Tensorlake has no labels: metadata is not stored (see docs).
      metadata: {},
      name: info.name ?? undefined,
      provider: PROVIDER,
      raw: info,
      state: mapTensorlakeStatus(info.status),
    });

    // ---- handle -------------------------------------------------------------

    const makeHandle = (
      initial: TlSandboxInfo,
      seedEnv?: Record<string, string>
    ): DriverHandle<TensorlakeRaw> => {
      let info = initial;
      const id = initial.id;
      /** Management URL (port 9501) of the sandbox proxy. */
      const proxy = (): string =>
        (info.sandbox_url || ingressUrl(info.ingress_endpoint, id)).replace(
          /\/$/,
          ""
        );
      let envCache: Record<string, string> | undefined = seedEnv;
      const loadEnv = async (
        ctx: CallContext
      ): Promise<Record<string, string>> => {
        if (envCache) {
          return envCache;
        }
        try {
          const res = await http.call<Response>(
            ctx,
            `${proxy()}/api/v1/files?path=${encodeURIComponent(ENV_FILE)}`,
            { allow404: true, raw: true }
          );
          envCache = res
            ? (JSON.parse(await res.text()) as Record<string, string>)
            : {};
        } catch {
          envCache = {};
        }
        return envCache;
      };

      const ptys = new Map<string, DriverPty>();
      const procs = new Map<
        string,
        { kill: (sig?: string) => Promise<void> }
      >();

      /** Background-free exec over `POST /api/v1/processes/run` (SSE). */
      const runExec = (
        cmd: string,
        execOpts: ExecOptions,
        ctx: CallContext
      ): DriverExec => {
        const q = new AsyncQueue<OutputEvent>();
        const ac = new AbortController();
        const onCtxAbort = () => ac.abort(ctx.signal?.reason);
        ctx.signal?.addEventListener("abort", onCtxAbort, { once: true });
        let resolvePid!: (pid: string) => void;
        let rejectPid!: (e: unknown) => void;
        const pid = new Promise<string>((res, rej) => {
          resolvePid = res;
          rejectPid = rej;
        });
        pid.catch(() => {});
        let pidNum: number | undefined;
        let killedWith: number | undefined;
        const started = Date.now();
        const join = lineJoiner();
        void (async () => {
          try {
            const env = { ...(await loadEnv(ctx)), ...execOpts.env };
            const res = await http.call<Response>(
              ctx,
              `${proxy()}/api/v1/processes/run`,
              {
                json: {
                  args: ["-c", cmd],
                  command: "sh",
                  env,
                  ...(execOpts.cwd ? { working_dir: execOpts.cwd } : {}),
                  ...(execOpts.user ? { user: execOpts.user } : {}),
                  ...(execOpts.timeoutMs
                    ? { timeout: execOpts.timeoutMs / 1000 }
                    : {}),
                },
                method: "POST",
                raw: true,
                signal: ac.signal,
              }
            );
            if (!res?.body) {
              throw new SandboxError("Provider", "empty run stream", {
                provider: PROVIDER,
              });
            }
            let exited = false;
            for await (const frame of readSse(res.body)) {
              let ev: TlRunEvent;
              try {
                ev = JSON.parse(frame.data) as TlRunEvent;
              } catch {
                continue;
              }
              if (typeof ev.line === "string") {
                const stream = ev.stream === "stderr" ? "stderr" : "stdout";
                q.push({ data: join(stream, ev.line), type: stream });
              } else if ("exit_code" in ev || "signal" in ev) {
                exited = true;
                const timedOut =
                  ev.reason === "timed_out" ||
                  (killedWith === undefined &&
                    typeof ev.signal === "number" &&
                    !!execOpts.timeoutMs &&
                    Date.now() - started >= execOpts.timeoutMs);
                if (timedOut) {
                  q.fail(
                    new SandboxError(
                      "Timeout",
                      `command timed out after ${execOpts.timeoutMs}ms`,
                      { provider: PROVIDER, timedOut: true }
                    )
                  );
                  return;
                }
                const code =
                  typeof ev.exit_code === "number"
                    ? ev.exit_code
                    : 128 + (ev.signal ?? 9);
                q.push({
                  exitCode: code,
                  type: "exit",
                  ...(typeof ev.signal === "number"
                    ? { signal: String(ev.signal) }
                    : {}),
                });
                break;
              } else if (typeof ev.pid === "number") {
                pidNum = ev.pid;
                resolvePid(String(ev.pid));
              }
            }
            if (!exited) {
              if (killedWith === undefined) {
                throw new SandboxError(
                  "Provider",
                  "run stream ended without an exit event",
                  { provider: PROVIDER }
                );
              }
              q.push({ exitCode: 128 + killedWith, type: "exit" });
            }
            q.close();
          } catch (error) {
            if (killedWith === undefined) {
              q.fail(wrap(error));
            } else {
              q.push({ exitCode: 128 + killedWith, type: "exit" });
              q.close();
            }
            rejectPid(error);
          } finally {
            ctx.signal?.removeEventListener("abort", onCtxAbort);
          }
        })();
        return {
          [Symbol.asyncIterator]: () => q.iterator(),
          async kill(signal?: string) {
            const num = signalNumber(signal);
            killedWith = num;
            if (pidNum !== undefined) {
              try {
                await signalProcess(String(pidNum), num, ctx);
              } catch {
                // already gone
              }
            }
            // Drop the stream so the iterator settles even if no exit frame comes.
            setTimeout(() => ac.abort(), 2000).unref?.();
          },
          pid,
        };
      };

      const signalProcess = async (
        processId: string,
        num: number,
        ctx: CallContext
      ): Promise<void> => {
        if (num === 9) {
          await http.call(
            ctx,
            `${proxy()}/api/v1/processes/${encodeURIComponent(processId)}`,
            { method: "DELETE" }
          );
          return;
        }
        await http.call(
          ctx,
          `${proxy()}/api/v1/processes/${encodeURIComponent(processId)}/signal`,
          { json: { signal: num }, method: "POST" }
        );
      };

      /** Follow a background process's output, then read its exit status. */
      const followProcess = (
        processId: string,
        ctx: CallContext
      ): DriverProcess => {
        const q = new AsyncQueue<OutputEvent>();
        const ac = new AbortController();
        const join = lineJoiner();
        void (async () => {
          try {
            const res = await http.call<Response>(
              ctx,
              `${proxy()}/api/v1/processes/${encodeURIComponent(processId)}/output/follow`,
              { raw: true, signal: ac.signal }
            );
            if (res?.body) {
              for await (const frame of readSse(res.body)) {
                if (frame.event === "eof") {
                  break;
                }
                try {
                  const ev = JSON.parse(frame.data) as TlRunEvent;
                  if (typeof ev.line === "string") {
                    const stream = ev.stream === "stderr" ? "stderr" : "stdout";
                    q.push({ data: join(stream, ev.line), type: stream });
                  }
                } catch {
                  // ignore malformed frames
                }
              }
            }
            // The exit status lands right after eof; poll briefly.
            for (let i = 0; i < 50; i++) {
              const p = await http.call<TlProcessInfo>(
                ctx,
                `${proxy()}/api/v1/processes/${encodeURIComponent(processId)}`,
                { allow404: true }
              );
              if (!p) {
                q.push({ exitCode: 137, type: "exit" });
                break;
              }
              if (p.status !== "running") {
                q.push({
                  exitCode:
                    typeof p.exit_code === "number"
                      ? p.exit_code
                      : 128 + (p.signal ?? 9),
                  type: "exit",
                  ...(typeof p.signal === "number"
                    ? { signal: String(p.signal) }
                    : {}),
                });
                break;
              }
              await sleep(100);
            }
            q.close();
          } catch (error) {
            q.fail(wrap(error));
          } finally {
            procs.delete(processId);
          }
        })();
        const kill = async (signal?: string) => {
          await signalProcess(processId, signalNumber(signal), ctx).catch(
            (error: unknown) => {
              const e = wrap(error);
              if (e.code !== "NotFound") {
                throw e;
              }
            }
          );
        };
        procs.set(processId, { kill });
        return {
          [Symbol.asyncIterator]: () => q.iterator(),
          id: processId,
          kill,
          pid: Promise.resolve(processId),
          async writeStdin(data: Uint8Array) {
            await http.call(
              ctx,
              `${proxy()}/api/v1/processes/${encodeURIComponent(processId)}/stdin`,
              {
                body: data as BodyInit,
                headers: { "Content-Type": "application/octet-stream" },
                method: "POST",
              }
            );
          },
        };
      };

      // ---- PTY over WebSocket ----------------------------------------------

      const openPty = async (
        sessionId: string,
        token: string,
        ctx: CallContext
      ): Promise<DriverPty> => {
        const Ctor =
          opts.WebSocket ??
          // Node (undici) and Bun accept `{ headers }` as the second argument.
          (globalThis.WebSocket as unknown as
            | TensorlakeWebSocketCtor
            | undefined);
        if (!Ctor) {
          throw new SandboxError(
            "NotSupported",
            "PTY needs a global WebSocket (Node 22+ or Bun) or opts.WebSocket",
            { provider: PROVIDER }
          );
        }
        const wsUrl = `${proxy().replace(/^http/, "ws")}/api/v1/pty/${encodeURIComponent(sessionId)}/ws`;
        const ws = new Ctor(wsUrl, {
          headers: { ...http.authHeader, "X-PTY-Token": token },
        });
        ws.binaryType = "arraybuffer";
        const out = new AsyncQueue<Uint8Array>();
        let exitCode: number | undefined;
        let resolveExit!: (n: number) => void;
        const exited = new Promise<number>((r) => {
          resolveExit = r;
        });
        const finish = (code: number) => {
          if (exitCode === undefined) {
            exitCode = code;
            out.close();
            ptys.delete(compoundId);
            resolveExit(code);
          }
        };
        await new Promise<void>((resolve, reject) => {
          ws.addEventListener("open", () => {
            ws.send(new Uint8Array([0x02])); // READY: flush buffered output
            resolve();
          });
          ws.addEventListener("error", (ev) => {
            reject(
              new SandboxError("Provider", "PTY WebSocket failed to connect", {
                cause: ev,
                provider: PROVIDER,
              })
            );
          });
        });
        ws.addEventListener("message", (ev) => {
          const raw =
            typeof ev.data === "string"
              ? enc.encode(ev.data)
              : ev.data instanceof Uint8Array
                ? ev.data
                : new Uint8Array(ev.data);
          if (raw.length === 0) {
            return;
          }
          if (raw[0] === 0x00) {
            out.push(raw.slice(1));
          } else if (raw[0] === 0x03 && raw.length >= 5) {
            finish(new DataView(raw.buffer, raw.byteOffset + 1, 4).getInt32(0));
          }
        });
        ws.addEventListener("close", (ev) => {
          const m = /^exit:(-?\d+)/.exec(ev.reason ?? "");
          finish(m ? Number(m[1]) : 130);
        });
        const compoundId = `${sessionId}:${token}`;
        const pty: DriverPty = {
          id: compoundId,
          async kill() {
            await http
              .call(
                ctx,
                `${proxy()}/api/v1/pty/${encodeURIComponent(sessionId)}`,
                { method: "DELETE" }
              )
              .catch(() => {});
            ws.close(1000, "killed");
            finish(130);
          },
          output: { [Symbol.asyncIterator]: () => out.iterator() },
          async resize(cols: number, rows: number) {
            const frame = new Uint8Array(5);
            const dv = new DataView(frame.buffer);
            frame[0] = 0x01;
            dv.setUint16(1, cols);
            dv.setUint16(3, rows);
            ws.send(frame);
          },
          wait: () => exited,
          async write(data: Uint8Array) {
            if (exitCode !== undefined) {
              return;
            }
            const frame = new Uint8Array(data.length + 1);
            frame[0] = 0x00;
            frame.set(data, 1);
            ws.send(frame);
          },
        };
        ptys.set(compoundId, pty);
        return pty;
      };

      const handle: DriverHandle<TensorlakeRaw> = {
        connectProcess: (processId, ctx) => followProcess(processId, ctx),

        connectPty: async (ptyId, ctx) => {
          const live = ptys.get(ptyId);
          if (live) {
            return live;
          }
          const sep = ptyId.indexOf(":");
          if (sep === -1) {
            throw new SandboxError(
              "Validation",
              "Tensorlake PTY ids are '<session>:<token>' (as returned by pty.create())",
              { provider: PROVIDER }
            );
          }
          return openPty(ptyId.slice(0, sep), ptyId.slice(sep + 1), ctx);
        },

        createPty: async (popts: PtyOptions, ctx) => {
          const env = { ...(await loadEnv(ctx)), ...popts.env };
          const created = await http.call<{
            session_id: string;
            token: string;
          }>(ctx, `${proxy()}/api/v1/pty`, {
            json: {
              args: popts.cmd ? ["-c", popts.cmd] : ["-l"],
              command: popts.cmd ? "sh" : "bash",
              env,
              ...(popts.cwd ? { working_dir: popts.cwd } : {}),
              cols: popts.cols ?? 80,
              rows: popts.rows ?? 24,
            },
            method: "POST",
          });
          if (!created) {
            throw new SandboxError(
              "Provider",
              "PTY create returned no session",
              {
                provider: PROVIDER,
              }
            );
          }
          return openPty(created.session_id, created.token, ctx);
        },

        deleteSnapshot: async (ref, ctx) => {
          await http.call(
            ctx,
            `${apiUrl}/snapshots/${encodeURIComponent(ref)}`,
            {
              allow404: true,
              method: "DELETE",
            }
          );
        },

        destroy: async (ctx) => {
          for (const p of ptys.values()) {
            await p.kill().catch(() => {});
          }
          await http.call(ctx, sb(id), { allow404: true, method: "DELETE" });
        },

        exec: (cmd, execOpts, ctx) => runExec(cmd, execOpts, ctx),

        exposePort: async (port, eopts, ctx) => {
          const cur = await getInfo(ctx, id);
          const ports = new Set(cur.exposed_ports ?? []);
          const others = [...ports].filter((p) => p !== port);
          const wantPublic = !eopts.private;
          // Visibility is sandbox-wide on Tensorlake. Tightening (public →
          // private) applies to every exposed port; loosening while other
          // private ports exist would silently publish them, so refuse.
          if (
            wantPublic &&
            cur.allow_unauthenticated_access === false &&
            others.length > 0
          ) {
            throw new SandboxError(
              "Conflict",
              `Tensorlake preview visibility is sandbox-wide; ports ${others.join(", ")} are private. Unexpose them or expose ${port} as private.`,
              { provider: PROVIDER }
            );
          }
          ports.add(port);
          const updated = await http.call<TlSandboxInfo>(ctx, sb(id), {
            json: {
              allow_unauthenticated_access: wantPublic,
              exposed_ports: [...ports].toSorted((a, b) => a - b),
            },
            method: "PATCH",
          });
          info = updated ?? cur;
          return previewFor(port, wantPublic);
        },

        fork: async (count, ctx) => {
          const base = slug(info.name ?? id, 40);
          const suffix = Math.random().toString(36).slice(2, 8);
          const qs = new URLSearchParams({
            name: `${base}-fork-${suffix}`,
            times: String(count),
          });
          const res = await http.call<{
            sandboxes: { sandbox_id: string; status: string }[];
          }>(ctx, `${sb(id, "/copy")}?${qs.toString()}`, { method: "POST" });
          const out: DriverHandle<TensorlakeRaw>[] = [];
          for (const c of res?.sandboxes ?? []) {
            const ready = await waitFor(ctx, c.sandbox_id, "running");
            out.push(makeHandle(ready, envCache));
          }
          return out;
        },

        getInfo: async (ctx) => {
          info = await getInfo(ctx, id);
          return toInfo(info);
        },

        getMetrics: async (ctx) => {
          interface Usage {
            observed_at_ms: number;
            cpu_total_ticks: number;
            cpu_idle_ticks: number;
            memory_used_bytes: number;
            memory_limit_bytes: number;
          }
          const url = `${proxy()}/api/v1/resource-usage`;
          const a = await http.call<Usage>(ctx, url);
          await sleep(250, ctx.signal);
          const b = await http.call<Usage>(ctx, url);
          if (!a || !b) {
            throw new SandboxError("Provider", "no resource sample", {
              provider: PROVIDER,
            });
          }
          const dTotal = b.cpu_total_ticks - a.cpu_total_ticks;
          const dIdle = b.cpu_idle_ticks - a.cpu_idle_ticks;
          const metrics: SandboxMetrics = {
            memoryTotalMB: b.memory_limit_bytes / 1_048_576,
            memoryUsedMB: b.memory_used_bytes / 1_048_576,
            raw: b,
            timestamp: new Date(b.observed_at_ms),
            ...(dTotal > 0 ? { cpuPercent: 100 * (1 - dIdle / dTotal) } : {}),
            ...(info.resources?.disk_mb
              ? { diskTotalMB: info.resources.disk_mb }
              : {}),
          };
          return metrics;
        },

        get id() {
          return id;
        },

        killProcess: async (processId, signal, ctx) => {
          const local = procs.get(processId);
          if (local) {
            await local.kill(signal);
            return;
          }
          await signalProcess(processId, signalNumber(signal), ctx);
        },

        listDir: async (path, ctx) => {
          const res = await http.call<{
            entries: { name: string; is_dir: boolean }[];
          }>(
            ctx,
            `${proxy()}/api/v1/files/list?path=${encodeURIComponent(path)}`
          );
          return (res?.entries ?? []).map(
            (e): DirEntry => ({
              name: e.name,
              path: joinPath(path, e.name),
              type: e.is_dir ? "dir" : "file",
            })
          );
        },

        listPorts: async (ctx) => {
          info = await getInfo(ctx, id);
          const pub = info.allow_unauthenticated_access === true;
          return (info.exposed_ports ?? []).map((p) => previewFor(p, pub));
        },

        listProcesses: async (ctx) => {
          const res = await http.call<{ processes: TlProcessInfo[] }>(
            ctx,
            `${proxy()}/api/v1/processes`
          );
          return (res?.processes ?? [])
            .filter((p) => p.status === "running")
            .map(
              (p): ProcessInfo => ({
                cmd: [p.command, ...(p.args ?? [])].join(" "),
                id: String(p.pid),
              })
            );
        },

        listSnapshots: async (ctx) => {
          const res = await http.call<
            { snapshots?: TlSnapshotInfo[] } | TlSnapshotInfo[]
          >(ctx, `${apiUrl}/snapshots`);
          const all = Array.isArray(res) ? res : (res?.snapshots ?? []);
          return all
            .filter((s) => s.sandbox_id === id)
            .map((s) => snapshotRef(s));
        },

        get name() {
          return info.name ?? undefined;
        },

        pause: async (ctx) => {
          // Only named sandboxes can suspend (ours are named unless
          // `onIdle: "destroy"` asked for an ephemeral one); the API answers
          // 400 for ephemeral sandboxes, surfaced as a Validation error.
          await http.call(ctx, sb(id, "/suspend"), { method: "POST" });
          info = await waitFor(ctx, id, "suspended");
        },

        get raw() {
          return info;
        },

        readFile: async (path, ctx) => {
          const res = await http.call<Response>(
            ctx,
            `${proxy()}/api/v1/files?path=${encodeURIComponent(path)}`,
            { raw: true }
          );
          if (!res) {
            throw new SandboxError("NotFound", `no such file: '${path}'`, {
              provider: PROVIDER,
            });
          }
          return new Uint8Array(await res.arrayBuffer());
        },

        remove: async (path, recursive, ctx) => {
          if (recursive) {
            const ex = runExec(
              `rm -rf -- '${path.replaceAll("'", `'\\''`)}'`,
              {},
              ctx
            );
            for await (const ev of ex) {
              if (ev.type === "exit" && ev.exitCode !== 0) {
                throw new SandboxError("Provider", `rm -rf ${path} failed`, {
                  provider: PROVIDER,
                });
              }
            }
            return;
          }
          await http.call(
            ctx,
            `${proxy()}/api/v1/files?path=${encodeURIComponent(path)}`,
            { allow404: true, method: "DELETE" }
          );
        },

        resume: async (ctx) => {
          await http.call(ctx, `${sb(id, "/resume")}?wait_ms=30000`, {
            method: "POST",
          });
          // Placement (and so ingress) can change across a resume.
          info = await waitFor(ctx, id, "running");
        },

        setEgressPolicy: async (policy, ctx) => {
          const network = toTensorlakeNetwork(policy);
          const updated = await http.call<TlSandboxInfo>(ctx, sb(id), {
            json: { network },
            method: "PATCH",
          });
          if (updated) {
            info = updated;
          }
        },

        snapshot: async (sopts, ctx) => {
          const mode = sopts.mode ?? "filesystem";
          const started = await http.call<{ snapshot_id: string }>(
            ctx,
            sb(id, "/snapshot"),
            { json: { snapshot_type: mode }, method: "POST" }
          );
          if (!started?.snapshot_id) {
            throw new SandboxError("Provider", "snapshot returned no id", {
              provider: PROVIDER,
            });
          }
          const snap = await waitSnapshot(ctx, started.snapshot_id);
          return { ...snapshotRef(snap, mode), name: sopts.name };
        },

        spawn: async (cmd, execOpts, ctx) => {
          const env = { ...(await loadEnv(ctx)), ...execOpts.env };
          const p = await http.call<TlProcessInfo>(
            ctx,
            `${proxy()}/api/v1/processes`,
            {
              json: {
                args: ["-c", cmd],
                command: "sh",
                env,
                stderr_mode: "capture",
                stdin_mode: "pipe",
                stdout_mode: "capture",
                ...(execOpts.cwd ? { working_dir: execOpts.cwd } : {}),
                ...(execOpts.user ? { user: execOpts.user } : {}),
              },
              method: "POST",
            }
          );
          if (!p) {
            throw new SandboxError(
              "Provider",
              "process start returned nothing",
              {
                provider: PROVIDER,
              }
            );
          }
          const proc = followProcess(String(p.pid), ctx);
          if (execOpts.timeoutMs) {
            setTimeout(() => {
              void proc.kill("KILL").catch(() => {});
            }, execOpts.timeoutMs).unref?.();
          }
          return proc;
        },

        unexposePort: async (port, ctx) => {
          const cur = await getInfo(ctx, id);
          const ports = (cur.exposed_ports ?? []).filter((p) => p !== port);
          const updated = await http.call<TlSandboxInfo>(ctx, sb(id), {
            json: { exposed_ports: ports },
            method: "PATCH",
          });
          info = updated ?? cur;
        },

        upload: async (path, data, ctx) => {
          const body: BodyInit =
            data instanceof ReadableStream
              ? data
              : ((await bodyBytes(data)) as BodyInit);
          await http.call(
            ctx,
            `${proxy()}/api/v1/files?path=${encodeURIComponent(path)}`,
            {
              body,
              headers: { "Content-Type": "application/octet-stream" },
              method: "PUT",
            }
          );
        },

        writeFile: async (path, data, ctx) => {
          await http.call(
            ctx,
            `${proxy()}/api/v1/files?path=${encodeURIComponent(path)}`,
            {
              body: data as BodyInit,
              headers: { "Content-Type": "application/octet-stream" },
              method: "PUT",
            }
          );
        },

        download: async (path, ctx) => {
          const res = await http.call<Response>(
            ctx,
            `${proxy()}/api/v1/files?path=${encodeURIComponent(path)}`,
            { raw: true }
          );
          if (!res?.body) {
            throw new SandboxError("NotFound", `no such file: '${path}'`, {
              provider: PROVIDER,
            });
          }
          return res.body;
        },
      };

      const previewFor = (port: number, isPublic: boolean): Preview => {
        const url = ingressUrl(info.ingress_endpoint, `${port}-${id}`);
        return {
          auth: isPublic
            ? { type: "public" }
            : { headers: http.authHeader, type: "header" },
          port,
          url,
          wsUrl: url.replace(/^http/, "ws"),
        };
      };

      return handle;
    };

    const snapshotRef = (
      s: TlSnapshotInfo,
      mode?: "memory" | "filesystem"
    ): SnapshotRef => {
      const type = s.snapshot_type ?? mode;
      return {
        createdAt:
          s.created_at === undefined ? undefined : new Date(s.created_at),
        id: s.snapshot_id ?? s.id ?? "",
        includesMemory: type === "memory",
        provider: PROVIDER,
        raw: s,
      };
    };

    const waitSnapshot = async (
      ctx: CallContext,
      snapshotId: string
    ): Promise<TlSnapshotInfo> => {
      const deadline = Date.now() + readyTimeoutMs;
      for (;;) {
        const s = await http.call<TlSnapshotInfo>(
          ctx,
          `${apiUrl}/snapshots/${encodeURIComponent(snapshotId)}`
        );
        if (s?.status === "local_ready" || s?.status === "completed") {
          return { ...s, snapshot_id: s.snapshot_id ?? snapshotId };
        }
        if (s?.status === "failed") {
          throw new SandboxError(
            "Provider",
            `snapshot ${snapshotId} failed${s.error ? `: ${s.error}` : ""}`,
            { provider: PROVIDER, retryable: false }
          );
        }
        if (Date.now() > deadline) {
          throw new SandboxError(
            "Timeout",
            `snapshot ${snapshotId} not ready after ${readyTimeoutMs}ms`,
            { provider: PROVIDER }
          );
        }
        await sleep(1000, ctx.signal);
      }
    };

    // ---- create / connect -------------------------------------------------

    const writeEnvFile = async (
      ctx: CallContext,
      handle: DriverHandle<TensorlakeRaw>,
      env: Record<string, string>
    ): Promise<void> => {
      if (Object.keys(env).length === 0) {
        return;
      }
      await handle.writeFile(ENV_FILE, enc.encode(JSON.stringify(env)), ctx);
    };

    const create = async (
      spec: ResolvedSandboxSpec,
      ctx: CallContext
    ): Promise<DriverHandle<TensorlakeRaw>> => {
      // Named sandboxes can suspend/resume and make create idempotent (a
      // retried create with the same derived name is a 409, not a 2nd VM).
      // `onIdle: "destroy"` asks for an ephemeral sandbox instead, which
      // terminates on its idle timeout.
      const derived = ctx.idempotencyKey
        ? `sbox-${(await sha256Hex(ctx.idempotencyKey)).slice(0, 16)}`
        : undefined;
      const ephemeral = spec.lifecycle?.onIdle === "destroy" && !spec.name;
      const name = spec.name ?? (ephemeral ? undefined : derived);
      const { body, inlineSecretEnv } = toTensorlakeCreate(
        spec,
        name,
        opts.defaultImage
      );
      const env = { ...inlineSecretEnv, ...spec.env };
      let created: TlCreateResponse | undefined;
      try {
        created = await http.call<TlCreateResponse>(
          ctx,
          `${apiUrl}/sandboxes`,
          {
            json: body,
            method: "POST",
          }
        );
      } catch (error) {
        const ours =
          name !== undefined && (name === derived || ctx.attempt > 1);
        if (
          error instanceof TensorlakeHttpError &&
          error.status === 409 &&
          ours
        ) {
          const existing = await waitFor(ctx, name, "running");
          return makeHandle(existing, env);
        }
        throw error;
      }
      if (!created?.sandbox_id) {
        throw new SandboxError("Provider", "create returned no sandbox id", {
          provider: PROVIDER,
        });
      }
      const ready = await waitFor(ctx, created.sandbox_id, "running");
      const handle = makeHandle(ready, env);
      await writeEnvFile(ctx, handle, env);
      return handle;
    };

    const connect = async (
      id: string,
      ctx: CallContext
    ): Promise<DriverHandle<TensorlakeRaw>> => {
      const info = await getInfo(ctx, id);
      if (info.status === "terminated" || info.status === "timeout") {
        throw new SandboxError("NotFound", `sandbox ${id} is ${info.status}`, {
          provider: PROVIDER,
        });
      }
      return makeHandle(info);
    };

    // ---- templates (lazy SDK) ----------------------------------------------

    const templateRef = (
      t: { id?: string; name?: string; createdAt?: string },
      cacheKey?: string
    ): TemplateRef => ({
      cacheKey,
      createdAt: t.createdAt ? new Date(t.createdAt) : undefined,
      id: t.name ?? t.id ?? "",
      name: t.name,
      provider: PROVIDER,
      raw: t,
    });

    const cloud = async () => {
      const mod = await loadSdk();
      return new mod.CloudClient({ apiKey: opts.apiKey, apiUrl });
    };

    const templates: DriverTemplates = {
      async build(spec, bopts) {
        const mod = await loadSdk();
        const registeredName = tensorlakeTemplateName(spec.name, spec.cacheKey);
        const emit = (event: Record<string, unknown>) => {
          const message =
            typeof event.message === "string" ? event.message : undefined;
          const type = typeof event.type === "string" ? event.type : "event";
          if (message) {
            const ev: TemplateBuildEvent = {
              line: message,
              step: type,
              type: "log",
              ...(event.stream === "stderr" ? { stream: "stderr" } : {}),
            };
            bopts.onEvent(ev);
          }
        };
        const common = {
          isPublic: false,
          registeredName,
          ...(spec.resources?.diskMB ? { diskMb: spec.resources.diskMB } : {}),
          ...(bopts.signal ? { signal: bopts.signal } : {}),
        };
        const { source } = spec;
        const extra = templateLines(spec);
        let result: Record<string, unknown>;
        if (
          "image" in source &&
          source.image !== undefined &&
          extra.length === 0
        ) {
          result = await withSdkEnv(opts.apiKey, apiUrl, () =>
            mod.importSandboxImage(
              source.image,
              {
                ...common,
                dockerConfigJson: source.registryAuth
                  ? dockerConfigFor(source.image, source.registryAuth)
                  : "{}",
              },
              { emit }
            )
          );
        } else if (
          ("dockerfile" in source && source.dockerfile !== undefined) ||
          ("image" in source && source.image !== undefined)
        ) {
          const fs = await import("node:fs/promises");
          const os = await import("node:os");
          const path = await import("node:path");
          const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbox-tl-"));
          try {
            let dockerfile: string;
            let dockerConfigJson = "{}";
            if ("dockerfile" in source && source.dockerfile !== undefined) {
              dockerfile = source.dockerfile;
              const files = await loadTemplateContext(source.context);
              for (const [rel, data] of files) {
                const target = path.join(dir, rel);
                if (!target.startsWith(dir + path.sep)) {
                  throw new SandboxError(
                    "Validation",
                    `template context path escapes the context: ${rel}`,
                    { provider: PROVIDER }
                  );
                }
                await fs.mkdir(path.dirname(target), { recursive: true });
                await fs.writeFile(target, data);
              }
            } else {
              const img = (source as { image: string }).image;
              dockerfile = `FROM ${img}\n`;
              const auth = (
                source as {
                  registryAuth?: { username: string; password: string };
                }
              ).registryAuth;
              if (auth) {
                dockerConfigJson = dockerConfigFor(img, auth);
              }
            }
            const text = [dockerfile.replace(/\n*$/, ""), ...extra, ""].join(
              "\n"
            );
            const dockerfilePath = path.join(dir, "Dockerfile");
            await fs.writeFile(dockerfilePath, text);
            result = await withSdkEnv(opts.apiKey, apiUrl, () =>
              mod.createSandboxImage(
                dockerfilePath,
                { ...common, dockerConfigJson },
                { emit }
              )
            );
          } finally {
            await fs.rm(dir, { force: true, recursive: true });
          }
        } else {
          throw new NotSupportedError(
            PROVIDER,
            "templates.build({ snapshot })"
          );
        }
        return templateRef(
          {
            createdAt:
              typeof result.createdAt === "string"
                ? result.createdAt
                : undefined,
            id: typeof result.id === "string" ? result.id : undefined,
            name: registeredName,
          },
          spec.cacheKey
        );
      },

      async delete(idOrName) {
        await (await cloud()).deleteSandboxImage(idOrName);
      },

      async *list() {
        for (const t of await (await cloud()).listSandboxImages()) {
          yield templateRef(t);
        }
      },

      async lookup(idOrKey) {
        const client = await cloud();
        if (/^[0-9a-f]{64}$/.test(idOrKey)) {
          // A content hash: our registered names always end with its prefix.
          const suffix = `-${idOrKey.slice(0, 12)}`;
          const def = defaultTemplateName(idOrKey);
          for (const t of await client.listSandboxImages()) {
            if (t.name === def || t.name?.endsWith(suffix)) {
              return templateRef(t, idOrKey);
            }
          }
          return undefined;
        }
        const found = await client.findSandboxImageByName(idOrKey);
        return found ? templateRef(found) : undefined;
      },
    };

    // ---- volumes (Cloud Volumes over git.tensorlake.ai) --------------------

    let volToken:
      | { token: string; expires: number; project: string }
      | undefined;
    const volumeAuth = async (
      ctx: CallContext
    ): Promise<{ headers: Record<string, string>; project: string }> => {
      if (!volToken || volToken.expires - Date.now() < 60_000) {
        const t = await http.call<{ token: string; expiresAt?: string }>(
          ctx,
          `${apiUrl}/artifact-storage/v1/token`,
          { json: {}, method: "POST" }
        );
        if (!t?.token) {
          throw new SandboxError(
            "Unauthorized",
            "could not mint a volume token",
            {
              provider: PROVIDER,
            }
          );
        }
        let project = opts.projectId;
        if (!project) {
          try {
            const payload = JSON.parse(
              atob(
                t.token
                  .split(".")[1]
                  ?.replaceAll("-", "+")
                  .replaceAll("_", "/") ?? ""
              )
            ) as { iss?: string; project?: string };
            project = payload.project ?? payload.iss;
          } catch {
            // fall through
          }
        }
        if (!project) {
          throw new SandboxError(
            "Validation",
            "tensorlake({ projectId }) is required for volumes",
            { provider: PROVIDER }
          );
        }
        volToken = {
          expires: t.expiresAt
            ? Date.parse(t.expiresAt)
            : Date.now() + 3_000_000,
          project,
          token: t.token,
        };
      }
      return {
        headers: { Authorization: `Basic ${btoa(`t:${volToken.token}`)}` },
        project: volToken.project,
      };
    };

    const volumeInfo = (r: { name: string; status?: string }): VolumeInfo => ({
      id: r.name,
      name: r.name,
      raw: r,
    });

    const volumes: DriverVolumes = {
      async create(vspec, ctx) {
        const { headers, project } = await volumeAuth(ctx);
        await http.call(
          ctx,
          `${volumesUrl}/project/${encodeURIComponent(project)}/repos/${encodeURIComponent(vspec.name)}`,
          { headers, json: { kind: "filesystem" }, method: "POST" }
        );
        return volumeInfo({ name: vspec.name });
      },
      async delete(volId, ctx) {
        const { headers, project } = await volumeAuth(ctx);
        await http.call(
          ctx,
          `${volumesUrl}/project/${encodeURIComponent(project)}/repos/${encodeURIComponent(volId)}`,
          { allow404: true, headers, method: "DELETE" }
        );
      },
      async get(idOrName, ctx) {
        const { headers, project } = await volumeAuth(ctx);
        const r = await http.call<{ name: string; kind?: string }>(
          ctx,
          `${volumesUrl}/project/${encodeURIComponent(project)}/repos/${encodeURIComponent(idOrName)}/meta`,
          { allow404: true, headers }
        );
        return r && (r.kind ?? "filesystem") === "filesystem"
          ? volumeInfo(r)
          : undefined;
      },
      async *list(ctx) {
        const { headers, project } = await volumeAuth(ctx);
        let after: string | null | undefined;
        do {
          const qs = new URLSearchParams({ kind: "filesystem" });
          if (after) {
            qs.set("after", after);
          }
          const page = await http.call<{
            repos: { name: string; kind?: string; status?: string }[];
            next_after?: string | null;
          }>(
            ctx,
            `${volumesUrl}/project/${encodeURIComponent(project)}/repos?${qs.toString()}`,
            { headers }
          );
          for (const r of page?.repos ?? []) {
            if ((r.kind ?? "filesystem") === "filesystem") {
              yield volumeInfo(r);
            }
          }
          after = page?.next_after;
        } while (after);
      },
    };

    // ---- list ---------------------------------------------------------------

    async function* list(
      filter: ListFilter | undefined,
      ctx: CallContext
    ): AsyncIterable<SandboxInfo> {
      const meta = { ...filter?.metadata };
      const wantName = meta["sbox-name"];
      delete meta["sbox-name"];
      if (Object.keys(meta).length > 0) {
        throw new NotSupportedError(
          PROVIDER,
          "list({ metadata }) — Tensorlake sandboxes have no labels"
        );
      }
      const statusParam =
        filter?.state === "running"
          ? "running"
          : filter?.state === "paused"
            ? "suspended"
            : undefined;
      let cursor: string | null | undefined;
      let n = 0;
      do {
        const qs = new URLSearchParams({ limit: "100" });
        if (cursor) {
          qs.set("cursor", cursor);
        }
        if (statusParam) {
          qs.set("status", statusParam);
        }
        const page = await http.call<{
          sandboxes: TlSandboxInfo[];
          next_cursor?: string | null;
        }>(ctx, `${apiUrl}/sandboxes?${qs.toString()}`);
        for (const s of page?.sandboxes ?? []) {
          const info = toInfo(s);
          if (filter?.state && info.state !== filter.state) {
            continue;
          }
          if (wantName !== undefined && info.name !== wantName) {
            continue;
          }
          if (filter?.limit !== undefined && n >= filter.limit) {
            return;
          }
          n++;
          yield info;
        }
        cursor = page?.next_cursor;
      } while (cursor);
    }

    const provider: SandboxProvider<TensorlakeCaps, TensorlakeRaw> = {
      capabilities: TENSORLAKE_CAPS,
      connect,
      create,
      flags: TENSORLAKE_FLAGS,
      async getOrCreate(spec, ctx) {
        const existing = await http.call<TlSandboxInfo>(ctx, sb(spec.name), {
          allow404: true,
        });
        if (
          existing &&
          existing.status !== "terminated" &&
          existing.status !== "timeout"
        ) {
          if (
            existing.status === "suspended" ||
            existing.status === "suspending"
          ) {
            if (existing.status === "suspending") {
              await waitFor(ctx, existing.id, "suspended");
            }
            await http.call(
              ctx,
              `${sb(existing.id, "/resume")}?wait_ms=30000`,
              {
                method: "POST",
              }
            );
          }
          const ready =
            existing.status === "running"
              ? existing
              : await waitFor(ctx, existing.id, "running");
          return makeHandle(ready);
        }
        return create(spec, { ...ctx, attempt: Math.max(ctx.attempt, 2) });
      },
      list,
      mapError: mapTensorlakeError,
      name: PROVIDER,
      templates,
      async verify(ctx) {
        await http.call(ctx, `${apiUrl}/sandboxes?limit=1`);
        return undefined;
      },
      volumes,
    };
    return provider;
  }
);
