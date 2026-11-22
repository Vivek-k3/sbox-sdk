/**
 * The full public type surface: the `Sandbox` the user holds, its namespaced
 * sub-APIs, the `SandboxClient`, and the provider/adapter contract the core
 * calls into. Everything is web-standard (no Node `Buffer`) so the core stays
 * portable across Node / Bun / Deno / Workers.
 */
import type {
  Capabilities,
  CapabilityFlags,
  CapabilityMap,
  Gated,
} from "./capabilities.js";
import type { SandboxError } from "./errors.js";
import type { SandboxPlugin } from "./plugin.js";

export type MaybePromise<T> = T | Promise<T>;
export type FileBody = string | Uint8Array | ReadableStream<Uint8Array>;

// ---------------------------------------------------------------------------
// State + info
// ---------------------------------------------------------------------------

export type SandboxState =
  | "creating"
  | "running"
  | "suspending"
  | "paused"
  | "stopped"
  /** Disk moved to cold storage; slower to bring back than `stopped`. */
  | "archived"
  | "destroyed"
  | "error"
  | "unknown";

export interface SandboxInfo {
  readonly id: string;
  readonly name?: string;
  readonly state: SandboxState;
  readonly provider: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt?: Date;
  readonly raw: unknown;
}

// ---------------------------------------------------------------------------
// Create input
// ---------------------------------------------------------------------------

export interface ResourceSpec {
  vcpus?: number;
  memoryMB?: number;
  diskMB?: number;
  /** Size of /dev/shm. Chromium needs ~1024. */
  shmMB?: number;
  /** GPU type, provider-specific (e.g. "A10G", "H100"). */
  gpu?: string;
  gpuCount?: number;
}

export interface VolumeMount {
  id: string;
  mountPath: string;
  readOnly?: boolean;
}

export interface SecretRef {
  /** Provider-side secret name (or a label when `value` is given). */
  name: string;
  /** Inline secret value, for providers that accept one. */
  value?: string;
  /** Env var to expose it as (mode "env"). Defaults to `name`. */
  envVar?: string;
  /**
   * "env" (default): visible inside the sandbox as an env var.
   * "egress": never enters the sandbox; injected by the egress proxy
   * (see `EgressPolicy.inject`). Requires egress credential injection.
   */
  mode?: "env" | "egress";
}

// ---------------------------------------------------------------------------
// Templates (build-time base images)
// ---------------------------------------------------------------------------

/** Build context: a local directory path (Node only) or in-memory files. */
export type TemplateContext = string | Record<string, FileBody>;

/** Exactly one source per template. */
export type TemplateSource =
  | {
      /** Dockerfile contents (not a path). */
      dockerfile: string;
      context?: TemplateContext;
      image?: never;
      snapshot?: never;
    }
  | {
      /** Registry reference, e.g. "debian:bookworm-slim". */
      image: string;
      registryAuth?: { username: string; password: string };
      dockerfile?: never;
      snapshot?: never;
    }
  | {
      /** Provider snapshot id used as the template base. */
      snapshot: string;
      dockerfile?: never;
      image?: never;
    };

export interface TemplateSpec {
  source: TemplateSource;
  /** Human alias. Defaults to `sbox-<cacheKey prefix>`. */
  name?: string;
  /** Default resources for sandboxes created from this template. */
  resources?: ResourceSpec;
  env?: Record<string, string>;
  workdir?: string;
  user?: string;
  /** Long-running process started when a sandbox boots. */
  startCmd?: string;
  /** Command that exits 0 once the sandbox is ready. */
  readyCmd?: string;
}

export interface TemplateRef {
  /** The id/alias you pass as `template` at create time. */
  readonly id: string;
  readonly name?: string;
  readonly provider: string;
  /** Content hash the core computed for this build. */
  readonly cacheKey?: string;
  readonly createdAt?: Date;
  readonly raw: unknown;
}

export type TemplateBuildEvent =
  | {
      type: "status";
      status: "cached" | "queued" | "building" | "ready" | "failed";
      message?: string;
    }
  | {
      type: "log";
      line: string;
      stream?: "stdout" | "stderr";
      step?: string;
    };

export interface TemplateBuildOptions {
  onEvent?: (event: TemplateBuildEvent) => void;
  signal?: AbortSignal;
  /** Rebuild even if a template with the same cache key exists. */
  force?: boolean;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface LifecyclePolicy {
  /** Suspend/stop after this much inactivity. */
  idleTimeoutMs?: number;
  /** Hard wall-clock limit from creation. */
  maxAgeMs?: number;
  /** What happens when the idle timeout (or max age) fires. */
  onIdle?: "pause" | "stop" | "destroy";
  /** Wake automatically on inbound traffic / connect. */
  autoResume?: boolean;
}

export interface SandboxSpec {
  /**
   * Build-time base. A provider template id/alias, a `TemplateRef` from
   * `client.templates.build()`, or an inline `TemplateSpec` (built on first
   * use, reused by content hash afterwards).
   */
  template?: string | TemplateRef | TemplateSpec;
  /** Boot from a snapshot instead of a template. */
  fromSnapshot?: string | SnapshotRef;
  name?: string;
  metadata?: Record<string, string>;
  env?: Record<string, string>;
  resources?: ResourceSpec;
  lifecycle?: LifecyclePolicy;
  /** @deprecated use `lifecycle.maxAgeMs`. */
  ttlMs?: number;
  /** @deprecated use `lifecycle.onIdle`. */
  onIdle?: "pause" | "stop" | "destroy";
  ports?: number[];
  /**
   * Default visibility for previews of this sandbox. Some providers (E2B) set
   * preview privacy per sandbox at creation, not per port.
   */
  previewVisibility?: "public" | "private";
  region?: string;
  volumes?: VolumeMount[];
  secrets?: SecretRef[];
  /** Egress policy applied at creation. */
  network?: EgressPolicy;
  /** Safe-retry key so create() never spawns duplicate VMs across fallback. */
  idempotencyKey?: string;
  /** Receives template build events when `template` is an inline spec. */
  onTemplateEvent?: (event: TemplateBuildEvent) => void;
  signal?: AbortSignal;
}

/**
 * What adapters receive in `create()`: the core has already resolved inline
 * templates, snapshot refs and deprecated aliases.
 * - `template` is always a plain id string (from `templateRef.id` if built).
 * - `lifecycle` is normalized; `ttlMs`/`onIdle` mirror it for older adapters.
 */
export interface ResolvedSandboxSpec extends Omit<
  SandboxSpec,
  "template" | "fromSnapshot" | "onTemplateEvent"
> {
  template?: string;
  templateRef?: TemplateRef;
  fromSnapshot?: string;
}

// ---------------------------------------------------------------------------
// Exec
// ---------------------------------------------------------------------------

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  user?: string;
  stdin?: FileBody;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface TelemetryOptions {
  /**
   * Anonymous telemetry is enabled by default. Set `false` to disable it for
   * this client regardless of environment variables.
   */
  enabled?: boolean;
  /** Override the default sbox PostHog project token for this client. */
  projectKey?: string;
  /** PostHog ingestion host. Defaults to https://us.i.posthog.com. */
  host?: string;
  /** Override the anonymous per-process distinct id. */
  distinctId?: string;
  /** Flush after this many queued events. Mostly useful for tests. */
  flushAt?: number;
  /** Delay before flushing queued events. Mostly useful for tests. */
  flushIntervalMs?: number;
  /** Maximum time to wait for a telemetry request before dropping it. */
  requestTimeoutMs?: number;
}

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** true when the exit code was parsed from a `$?` echo rather than native. */
  readonly exitCodeSynthesized?: boolean;
}

export type OutputEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; exitCode: number; signal?: string };

/**
 * Returned by `commands.run()`: BOTH a `Promise<ExecResult>` (await => buffered)
 * AND an `AsyncIterable<OutputEvent>` (for-await => streamed live).
 */
export interface ExecHandle
  extends Promise<ExecResult>, AsyncIterable<OutputEvent> {
  readonly pid: Promise<string>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  kill(signal?: string): Promise<void>;
  writeStdin(data: string | Uint8Array): Promise<void>;
  /** Signal EOF on stdin (e.g. so `cat` exits). */
  closeStdin(): Promise<void>;
}

export interface Process {
  readonly id: string;
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  wait(): Promise<ExecResult>;
  kill(signal?: string): Promise<void>;
  writeStdin(data: string | Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
}

export interface ProcessInfo {
  id: string;
  cmd: string;
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

export type FileType = "file" | "dir" | "symlink";

export interface FileInfo {
  path: string;
  type: FileType;
  size: number;
  mtime?: Date;
}

export interface DirEntry {
  name: string;
  path: string;
  type: FileType;
}

export interface StoredFile {
  path: string;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
  stream(): ReadableStream<Uint8Array>;
}

export interface FsEvent {
  type: "create" | "modify" | "delete";
  path: string;
}

export interface Watcher {
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Network + code
// ---------------------------------------------------------------------------

/** How a client must authenticate to a preview URL. */
export type PreviewAuth =
  | { type: "public" }
  /** Token in the query string: works for browsers and WebSockets. */
  | { type: "query"; param: string; token: string }
  /** Token in request headers: NOT usable from a browser WebSocket. */
  | { type: "header"; headers: Record<string, string> }
  /** Auth already baked into `url`/`wsUrl` (signed URL). */
  | { type: "signed-url" };

export interface Preview {
  /** https:// URL for the port. */
  url: string;
  port: number;
  /** wss:// URL for the same route. Filled by the core when omitted. */
  wsUrl?: string;
  /** Auth model. Defaults to public, or header-auth if only `token` is set. */
  auth?: PreviewAuth;
  expiresAt?: Date;
  /** @deprecated read `auth` instead. */
  token?: string;
}

export interface EgressRule {
  domains?: string[];
  cidrs?: string[];
}

/** Inject credentials into outbound requests; the secret never enters the sandbox. */
export interface EgressInjection {
  /** Hostnames (wildcards allowed, e.g. "*.github.com"). */
  domains: string[];
  /** Header name -> secret supplying its value. */
  headers: Record<string, SecretRef | string>;
}

export interface EgressPolicy {
  mode: "allow-all" | "block-all" | "allow-list";
  /** Allowed domains when mode is "allow-list". */
  domains?: string[];
  /** Allowed CIDRs when mode is "allow-list". */
  cidrs?: string[];
  /** Denied destinations (applies on top of "allow-all"). */
  deny?: EgressRule;
  inject?: EgressInjection[];
}

export interface SshCredentials {
  host: string;
  port: number;
  user: string;
  /** PEM private key. Empty string when the provider uses a token/password. */
  privateKey: string;
  /** Password or one-time token, for providers that authenticate that way. */
  password?: string;
  /** Ready-to-run command, e.g. `ssh token@host -p 2222`. */
  command?: string;
  expiresAt?: Date;
}

export interface KernelContext {
  readonly id: string;
  language: string;
}

export interface RichResult {
  mime: Record<string, string>;
  text?: string;
}

export interface CodeExecution {
  results: RichResult[];
  logs: { stdout: string[]; stderr: string[] };
  error?: { name: string; value: string; traceback?: string };
}

export interface SnapshotRef {
  id: string;
  name?: string;
  provider: string;
  createdAt?: Date;
  /** true = memory + processes captured; false = filesystem only. */
  includesMemory?: boolean;
  raw: unknown;
}

export interface SnapshotOptions {
  name?: string;
  /** "memory" captures RAM + processes; "filesystem" is disk only. */
  mode?: "memory" | "filesystem";
}

// ---------------------------------------------------------------------------
// PTY
// ---------------------------------------------------------------------------

export interface PtyOptions {
  /** Program to run. Defaults to the provider's login shell. */
  cmd?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
  user?: string;
}

export interface PtySession extends AsyncIterable<Uint8Array> {
  readonly id: string;
  write(data: string | Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  kill(): Promise<void>;
  /** Resolves with the exit code when the PTY process ends. */
  wait(): Promise<{ exitCode: number }>;
}

// ---------------------------------------------------------------------------
// Volumes, metrics, verify
// ---------------------------------------------------------------------------

export interface VolumeInfo {
  readonly id: string;
  readonly name?: string;
  readonly sizeMB?: number;
  readonly region?: string;
  readonly createdAt?: Date;
  readonly raw: unknown;
}

export interface VolumeSpec {
  name: string;
  sizeMB?: number;
  region?: string;
}

export interface SandboxMetrics {
  cpuPercent?: number;
  memoryUsedMB?: number;
  memoryTotalMB?: number;
  diskUsedMB?: number;
  diskTotalMB?: number;
  timestamp: Date;
  raw: unknown;
}

export type VerifyResult =
  | { ok: true; provider: string; account?: string }
  | { ok: false; provider: string; error: SandboxError };

// ---------------------------------------------------------------------------
// Namespaced sub-APIs (thin facades over the adapter)
// ---------------------------------------------------------------------------

export interface CommandsAPI {
  run(cmd: string | string[], opts?: ExecOptions): ExecHandle;
  spawn(cmd: string | string[], opts?: ExecOptions): Promise<Process>;
  connect(processId: string): Promise<Process>;
  kill(processId: string, signal?: string): Promise<void>;
  list(): Promise<ProcessInfo[]>;
}

export interface FilesAPI {
  read(path: string): Promise<StoredFile>;
  write(path: string, data: FileBody): Promise<void>;
  list(path: string): Promise<DirEntry[]>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<FileInfo>;
  exists(path: string): Promise<boolean>;
  upload(path: string, body: FileBody): Promise<void>;
  download(path: string): Promise<StoredFile>;
  watch(
    path: string,
    cb: (e: FsEvent) => void,
    opts?: { recursive?: boolean }
  ): Promise<Watcher>;
}

export interface CodeAPI {
  runCode(
    code: string,
    opts?: {
      context?: KernelContext;
      language?: string;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    }
  ): Promise<CodeExecution>;
  createContext(opts?: {
    language?: string;
    cwd?: string;
  }): Promise<KernelContext>;
}

export interface ExposeOptions {
  /** "public" (default) or "private" (auth required, see `Preview.auth`). */
  visibility?: "public" | "private";
  /** @deprecated use `visibility: "private"`. */
  private?: boolean;
}

export interface PortsAPI {
  expose(port: number, opts?: ExposeOptions): Promise<Preview>;
  unexpose(port: number): Promise<void>;
  list(): Promise<Preview[]>;
  fetch(port: number, path?: string, init?: RequestInit): Promise<Response>;
}

export interface SnapshotsAPI {
  create(opts?: SnapshotOptions): Promise<SnapshotRef>;
  /**
   * Restore IN PLACE. Providers whose restore boots a new sandbox don't
   * offer this; use `client.create({ fromSnapshot })` instead.
   */
  restore(ref: SnapshotRef | string): Promise<void>;
  /** @deprecated use `sandbox.fork()`. */
  fork(count?: number): Promise<Sandbox[]>;
  list(): Promise<SnapshotRef[]>;
  delete(ref: SnapshotRef | string): Promise<void>;
}

export interface NetworkAPI {
  setEgressPolicy(policy: EgressPolicy): Promise<void>;
  /** @deprecated use `sandbox.ssh.create()` (gated on the `ssh` cap). */
  createSsh(): Promise<SshCredentials>;
}

export interface SshAPI {
  create(): Promise<SshCredentials>;
}

export interface PtyAPI {
  create(opts?: PtyOptions): Promise<PtySession>;
  connect(id: string): Promise<PtySession>;
}

export interface TemplatesAPI {
  /** Build (or reuse, by content hash) a template in the user's account. */
  build(spec: TemplateSpec, opts?: TemplateBuildOptions): Promise<TemplateRef>;
  get(idOrName: string): Promise<TemplateRef | undefined>;
  list(): AsyncIterable<TemplateRef>;
  delete(ref: TemplateRef | string): Promise<void>;
}

export interface VolumesAPI {
  create(spec: VolumeSpec): Promise<VolumeInfo>;
  get(idOrName: string): Promise<VolumeInfo | undefined>;
  list(): AsyncIterable<VolumeInfo>;
  delete(ref: VolumeInfo | string): Promise<void>;
}

// ---------------------------------------------------------------------------
// The Sandbox the user holds
// ---------------------------------------------------------------------------

export interface Sandbox<
  Caps extends CapabilityMap = CapabilityMap,
  Raw = unknown,
> {
  readonly id: string;
  readonly name?: string;
  readonly provider: string;
  readonly capabilities: Capabilities;

  // always present (universal or polyfilled)
  readonly commands: CommandsAPI;
  readonly files: FilesAPI;

  // capability-gated sub-APIs: typed `undefined` when unsupported
  readonly ports: Gated<Caps["exposePort"], PortsAPI>;
  readonly code: Gated<Caps["codeInterpreter"], CodeAPI>;
  readonly snapshots: Gated<Caps["snapshot"], SnapshotsAPI>;
  readonly network: Gated<Caps["egressControl"], NetworkAPI>;
  readonly ssh: Gated<Caps["ssh"], SshAPI>;
  readonly pty: Gated<Caps["pty"], PtyAPI>;

  // top-level lifecycle: ALWAYS present, runtime-gated (preserves swap-one-import)
  getInfo(): Promise<SandboxInfo>;
  setTimeout(ttlMs: number): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  /**
   * Wake a paused, stopped or archived sandbox (needs `pause` or `stop`).
   * Check `capabilities.flags.resumeChangesId`: the id may change.
   */
  resume(): Promise<void>;
  destroy(): Promise<void>;
  /** Clone this sandbox (memory included where supported). Gated on `fork`. */
  fork(opts?: { count?: number }): Promise<Sandbox<Caps, Raw>[]>;
  /** Point-in-time resource usage. Gated on `metrics`. */
  metrics(): Promise<SandboxMetrics>;

  /** Runtime check + type-guard, for dynamically-chosen providers. */
  can<K extends keyof CapabilityMap>(
    cap: K
  ): this is Sandbox<Caps & Record<K, "native" | "emulated">, Raw>;

  /** Escape hatch: the native provider client, typed via the adapter Raw. */
  raw(): Raw;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ListFilter {
  metadata?: Record<string, string>;
  state?: SandboxState;
  limit?: number;
}

/**
 * Per-`create` overrides handed to plugins (e.g. the AI-provider policy). Opaque
 * to the core router; each plugin reads the keys it understands via
 * `PluginSetupContext.createOptions`.
 */
export type SandboxCreateOptions = Readonly<Record<string, unknown>>;

export interface SandboxClient<
  Caps extends CapabilityMap = CapabilityMap,
  Raw = unknown,
  Ext extends object = object,
> {
  create(
    spec?: SandboxSpec,
    options?: SandboxCreateOptions
  ): Promise<Sandbox<Caps, Raw> & Ext>;
  connect(id: string, opts?: ConnectOptions): Promise<Sandbox<Caps, Raw> & Ext>;
  /**
   * Return the sandbox called `spec.name`, creating it if absent. Native on
   * providers with named sandboxes; emulated via `list()` elsewhere.
   */
  getOrCreate(
    spec: SandboxSpec & { name: string },
    options?: SandboxCreateOptions
  ): Promise<Sandbox<Caps, Raw> & Ext>;
  list(filter?: ListFilter): AsyncIterable<SandboxInfo>;
  /** Cheapest authenticated call: "does this key work?" Never creates. */
  verify(): Promise<VerifyResult>;
  readonly templates: Gated<Caps["templateBuild"], TemplatesAPI>;
  readonly volumes: Gated<Caps["volumes"], VolumesAPI>;
  readonly provider: string;
  readonly capabilities: Capabilities;
  dispose(): Promise<void>;
}

export interface ConnectOptions {
  /** Resume the sandbox if it is paused/stopped. */
  resume?: boolean;
  signal?: AbortSignal;
}

export interface RetryPolicy {
  retries?: number;
  delayMs?: (attempt: number, err: unknown) => number;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}

export interface Hooks {
  beforeCreate?(spec: SandboxSpec): void | Promise<void>;
  afterCreate?(info: { id: string; provider: string }): void | Promise<void>;
  onError?(err: unknown, attempt: number): void | Promise<void>;
}

export interface ClientOptions<
  Caps extends CapabilityMap = CapabilityMap,
  Raw = unknown,
> {
  provider?: SandboxProvider<Caps, Raw>;
  fallback?: SandboxProvider[];
  retry?: RetryPolicy;
  hooks?: Hooks;
  fetch?: typeof fetch;
  /** @deprecated reserved; currently has no effect. */
  emulate?: (keyof CapabilityMap)[];
  defaultMetadata?: Record<string, string>;
  /** Plugins applied to every sandbox this client builds (incl. forks). */
  plugins?: readonly SandboxPlugin[];
  /** Anonymous product telemetry. Enabled by default; pass `false` to opt out. */
  telemetry?: boolean | TelemetryOptions;
}

// ---------------------------------------------------------------------------
// Provider / adapter contract (implemented by every `src/<provider>/index.ts`)
// ---------------------------------------------------------------------------

/** Per-call context threaded into every adapter method. */
export interface CallContext {
  attempt: number;
  signal?: AbortSignal;
  /** CRITICAL for create(): retries must not duplicate VMs. */
  idempotencyKey?: string;
  /** Injectable transport — the primary unit-test seam. */
  fetch: typeof fetch;
  metadata?: Record<string, string>;
}

/** Raw event stream returned by adapter exec; the core wraps it into ExecHandle. */
export interface DriverExec extends AsyncIterable<OutputEvent> {
  readonly pid: Promise<string>;
  kill(signal?: string): Promise<void>;
  writeStdin?(data: Uint8Array): Promise<void>;
  closeStdin?(): Promise<void>;
}

export interface DriverProcess extends DriverExec {
  readonly id: string;
}

/** Adapter-side PTY; the core wraps it into `PtySession`. */
export interface DriverPty {
  readonly id: string;
  readonly output: AsyncIterable<Uint8Array>;
  write(data: Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  kill(): Promise<void>;
  wait(): Promise<number>;
}

/** Adapter-side template registry. Presence MUST match `templateBuild`. */
export interface DriverTemplates {
  /**
   * Build `spec`. MUST tag the result with `cacheKey` (alias, label or name)
   * so `lookup(cacheKey)` returns it later. MUST NOT publish anything publicly.
   */
  build(
    spec: TemplateSpec & { cacheKey: string; name: string },
    opts: {
      onEvent: (event: TemplateBuildEvent) => void;
      signal?: AbortSignal;
    },
    ctx: CallContext
  ): MaybePromise<TemplateRef>;
  /** Look up by cache key, alias or id. Return undefined when absent. */
  lookup(
    idOrKey: string,
    ctx: CallContext
  ): MaybePromise<TemplateRef | undefined>;
  list?(ctx: CallContext): AsyncIterable<TemplateRef>;
  delete?(id: string, ctx: CallContext): MaybePromise<void>;
}

/** Adapter-side volume registry. Presence MUST match `volumes`. */
export interface DriverVolumes {
  create(spec: VolumeSpec, ctx: CallContext): MaybePromise<VolumeInfo>;
  get(idOrName: string, ctx: CallContext): MaybePromise<VolumeInfo | undefined>;
  list(ctx: CallContext): AsyncIterable<VolumeInfo>;
  delete(id: string, ctx: CallContext): MaybePromise<void>;
}

/** A live adapter-side handle to ONE sandbox. Required methods = common denominator. */
export interface DriverHandle<Raw = unknown> {
  readonly id: string;
  readonly name?: string;
  readonly raw: Raw;

  // ---- REQUIRED (irreducible minimum) ----
  getInfo(ctx: CallContext): MaybePromise<SandboxInfo>;
  destroy(ctx: CallContext): MaybePromise<void>;
  /** MUST NOT throw on non-zero exit; emit `{type:'exit',exitCode}` instead. */
  exec(cmd: string, opts: ExecOptions, ctx: CallContext): DriverExec;
  readFile(path: string, ctx: CallContext): MaybePromise<Uint8Array>;
  writeFile(
    path: string,
    data: Uint8Array,
    ctx: CallContext
  ): MaybePromise<void>;

  // ---- OPTIONAL (presence MUST match the static capabilities) ----
  setTimeout?(ttlMs: number, ctx: CallContext): MaybePromise<void>;
  stop?(ctx: CallContext): MaybePromise<void>;
  pause?(ctx: CallContext): MaybePromise<void>;
  resume?(ctx: CallContext): MaybePromise<void>;

  spawn?(
    cmd: string,
    opts: ExecOptions,
    ctx: CallContext
  ): MaybePromise<DriverProcess>;
  connectProcess?(
    processId: string,
    ctx: CallContext
  ): MaybePromise<DriverProcess>;
  killProcess?(
    processId: string,
    signal: string | undefined,
    ctx: CallContext
  ): MaybePromise<void>;
  listProcesses?(ctx: CallContext): MaybePromise<ProcessInfo[]>;

  listDir?(path: string, ctx: CallContext): MaybePromise<DirEntry[]>;
  mkdir?(
    path: string,
    recursive: boolean,
    ctx: CallContext
  ): MaybePromise<void>;
  remove?(
    path: string,
    recursive: boolean,
    ctx: CallContext
  ): MaybePromise<void>;
  rename?(from: string, to: string, ctx: CallContext): MaybePromise<void>;
  stat?(path: string, ctx: CallContext): MaybePromise<FileInfo>;
  upload?(path: string, data: FileBody, ctx: CallContext): MaybePromise<void>;
  download?(
    path: string,
    ctx: CallContext
  ): MaybePromise<ReadableStream<Uint8Array>>;
  watch?(
    path: string,
    cb: (e: FsEvent) => void,
    recursive: boolean,
    ctx: CallContext
  ): MaybePromise<() => Promise<void>>;

  exposePort?(
    port: number,
    opts: { private?: boolean },
    ctx: CallContext
  ): MaybePromise<Preview>;
  unexposePort?(port: number, ctx: CallContext): MaybePromise<void>;
  listPorts?(ctx: CallContext): MaybePromise<Preview[]>;
  proxyFetch?(
    port: number,
    path: string | undefined,
    init: RequestInit | undefined,
    ctx: CallContext
  ): MaybePromise<Response>;
  setEgressPolicy?(policy: EgressPolicy, ctx: CallContext): MaybePromise<void>;
  createSsh?(ctx: CallContext): MaybePromise<SshCredentials>;

  createPty?(opts: PtyOptions, ctx: CallContext): MaybePromise<DriverPty>;
  connectPty?(id: string, ctx: CallContext): MaybePromise<DriverPty>;
  getMetrics?(ctx: CallContext): MaybePromise<SandboxMetrics>;

  runCode?(
    code: string,
    opts: {
      context?: KernelContext;
      language?: string;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    },
    ctx: CallContext
  ): MaybePromise<CodeExecution>;
  createContext?(
    opts: { language?: string; cwd?: string },
    ctx: CallContext
  ): MaybePromise<KernelContext>;

  snapshot?(opts: SnapshotOptions, ctx: CallContext): MaybePromise<SnapshotRef>;
  restoreSnapshot?(ref: string, ctx: CallContext): MaybePromise<void>;
  fork?(count: number, ctx: CallContext): MaybePromise<DriverHandle<Raw>[]>;
  listSnapshots?(ctx: CallContext): MaybePromise<SnapshotRef[]>;
  deleteSnapshot?(ref: string, ctx: CallContext): MaybePromise<void>;
}

/** THE contract object each provider factory returns. */
export interface SandboxProvider<
  Caps extends CapabilityMap = CapabilityMap,
  Raw = unknown,
> {
  readonly name: string;
  readonly capabilities: Caps;
  readonly flags: CapabilityFlags;
  readonly mapError?: (err: unknown) => SandboxError | undefined;

  create(
    spec: ResolvedSandboxSpec,
    ctx: CallContext
  ): MaybePromise<DriverHandle<Raw>>;
  connect(id: string, ctx: CallContext): MaybePromise<DriverHandle<Raw>>;
  /** Native get-or-create by name. Optional; the core emulates it via list(). */
  getOrCreate?(
    spec: ResolvedSandboxSpec & { name: string },
    ctx: CallContext
  ): MaybePromise<DriverHandle<Raw>>;
  list?(
    filter: ListFilter | undefined,
    ctx: CallContext
  ): AsyncIterable<SandboxInfo>;
  /** Cheapest authenticated call. Resolve on success; throw on bad creds. */
  verify?(ctx: CallContext): MaybePromise<{ account?: string } | undefined>;
  readonly templates?: DriverTemplates;
  readonly volumes?: DriverVolumes;
  dispose?(): MaybePromise<void>;
}
