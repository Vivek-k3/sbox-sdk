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
  | "paused"
  | "stopped"
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
  gpu?: string;
}

export interface VolumeMount {
  id: string;
  mountPath: string;
  readOnly?: boolean;
}

export interface SecretRef {
  name: string;
  envVar?: string;
}

export interface SandboxSpec {
  /** Build-time base: image / snapshot / blueprint id, provider-specific. */
  template?: string;
  name?: string;
  metadata?: Record<string, string>;
  env?: Record<string, string>;
  resources?: ResourceSpec;
  ttlMs?: number;
  onIdle?: "pause" | "stop" | "destroy";
  ports?: number[];
  region?: string;
  volumes?: VolumeMount[];
  secrets?: SecretRef[];
  /** Safe-retry key so create() never spawns duplicate VMs across fallback. */
  idempotencyKey?: string;
  signal?: AbortSignal;
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
}

export interface Process {
  readonly id: string;
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  wait(): Promise<ExecResult>;
  kill(signal?: string): Promise<void>;
  writeStdin(data: string | Uint8Array): Promise<void>;
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

export interface Preview {
  url: string;
  port: number;
  token?: string;
}

export interface EgressPolicy {
  mode: "allow-all" | "block-all" | "allow-list";
  domains?: string[];
  cidrs?: string[];
}

export interface SshCredentials {
  host: string;
  port: number;
  user: string;
  privateKey: string;
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
  raw: unknown;
}

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

export interface PortsAPI {
  expose(port: number, opts?: { private?: boolean }): Promise<Preview>;
  unexpose(port: number): Promise<void>;
  list(): Promise<Preview[]>;
  fetch(port: number, path?: string, init?: RequestInit): Promise<Response>;
}

export interface SnapshotsAPI {
  create(opts?: { name?: string }): Promise<SnapshotRef>;
  restore(ref: SnapshotRef | string): Promise<void>;
  fork(count?: number): Promise<Sandbox[]>;
  list(): Promise<SnapshotRef[]>;
  delete(ref: SnapshotRef | string): Promise<void>;
}

export interface NetworkAPI {
  setEgressPolicy(policy: EgressPolicy): Promise<void>;
  createSsh(): Promise<SshCredentials>;
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

  // top-level lifecycle: ALWAYS present, runtime-gated (preserves swap-one-import)
  getInfo(): Promise<SandboxInfo>;
  setTimeout(ttlMs: number): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  destroy(): Promise<void>;

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
  connect(id: string): Promise<Sandbox<Caps, Raw> & Ext>;
  list(filter?: ListFilter): AsyncIterable<SandboxInfo>;
  readonly provider: string;
  readonly capabilities: Capabilities;
  dispose(): Promise<void>;
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
  /** Opt-in lossy emulations (e.g. fork via snapshot+restore). */
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
}

export interface DriverProcess extends DriverExec {
  readonly id: string;
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

  snapshot?(
    opts: { name?: string },
    ctx: CallContext
  ): MaybePromise<SnapshotRef>;
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

  create(spec: SandboxSpec, ctx: CallContext): MaybePromise<DriverHandle<Raw>>;
  connect(id: string, ctx: CallContext): MaybePromise<DriverHandle<Raw>>;
  list?(
    filter: ListFilter | undefined,
    ctx: CallContext
  ): AsyncIterable<SandboxInfo>;
  dispose?(): MaybePromise<void>;
}
