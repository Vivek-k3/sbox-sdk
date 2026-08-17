import pkg from "../../package.json" with { type: "json" };
/**
 * Anonymous, opt-out product telemetry. A `TelemetryReporter` batches lifecycle
 * and command events (outcome flags, duration buckets + raw ms, and non-secret
 * sandbox config dims — never secrets, ids, or command strings) and ships them
 * to PostHog over the injected `fetch`. The router and `buildSandbox` are the
 * only callers; when disabled (option, env opt-out, or a runtime without
 * `fetch`) a no-op reporter is returned so telemetry can never observably alter
 * SDK behavior.
 */
import { SandboxError } from "./errors.js";
import { detectRuntime } from "./runtime.js";
import type { SandboxSpec, TelemetryOptions } from "./types.js";

export type TelemetryValue = string | number | boolean | null | undefined;

/** Non-secret create-time dims inherited by later events on the same sandbox. */
export type TelemetryContext = Readonly<Record<string, TelemetryValue>>;

export type TelemetryEventName =
  | "client_initialized"
  | "sandbox_connect"
  | "sandbox_create"
  | "sandbox_destroy"
  | "client_dispose"
  | "sandbox_list"
  | "command_run";

export interface TelemetryReporter {
  track(
    event: TelemetryEventName,
    properties?: Record<string, TelemetryValue>
  ): void;
  flush(): Promise<void>;
  /** Flush remaining events and stop accepting new ones (idempotent). */
  close(): Promise<void>;
}

export interface TelemetryReporterOptions {
  fetch: typeof fetch | undefined;
  telemetry?: boolean | TelemetryOptions;
}

interface QueuedEvent {
  event: string;
  distinct_id: string;
  properties: Record<string, TelemetryValue>;
  timestamp: string;
}

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const DEFAULT_POSTHOG_PROJECT_KEY =
  "phc_osTPjb7RBcKe5HmXcU6zgovnELKZGUpDXLQ4ftVLPEk4";
const SDK_NAME = "sbox-sdk";
const SDK_VERSION = pkg.version;
const DEFAULT_REQUEST_TIMEOUT_MS = 1500;

let processDistinctId: string | undefined;

function env(name: string): string | undefined {
  const value = globalThis.process?.env?.[name];
  return typeof value === "string" ? value : undefined;
}

function isTruthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? "");
}

function isFalsy(value: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test(value ?? "");
}

function getOption(
  telemetry: boolean | TelemetryOptions | undefined
): TelemetryOptions {
  if (telemetry === false) {
    return { enabled: false };
  }
  if (telemetry === true || telemetry === undefined) {
    return {};
  }
  return telemetry;
}

function telemetryEnabled(
  telemetry: boolean | TelemetryOptions | undefined
): boolean {
  const options = getOption(telemetry);
  if (options.enabled === false) {
    return false;
  }
  if (isTruthy(env("SBOX_TELEMETRY_DISABLED"))) {
    return false;
  }
  if (isTruthy(env("SBOX_DISABLE_TELEMETRY"))) {
    return false;
  }
  if (isTruthy(env("DO_NOT_TRACK"))) {
    return false;
  }
  if (isFalsy(env("SBOX_TELEMETRY"))) {
    return false;
  }
  return true;
}

function getProjectKey(options: TelemetryOptions): string {
  return (
    options.projectKey ??
    env("SBOX_TELEMETRY_POSTHOG_KEY") ??
    DEFAULT_POSTHOG_PROJECT_KEY
  );
}

function getHost(options: TelemetryOptions): string {
  return (
    options.host ??
    env("SBOX_TELEMETRY_POSTHOG_HOST") ??
    DEFAULT_POSTHOG_HOST
  ).replace(/\/+$/, "");
}

function randomId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function distinctId(options: TelemetryOptions): string {
  if (options.distinctId) {
    return options.distinctId;
  }
  processDistinctId ??= `anon_${randomId()}`;
  return processDistinctId;
}

function platform(): string {
  const nodePlatform = globalThis.process?.platform;
  if (typeof nodePlatform === "string") {
    return nodePlatform;
  }
  return "unknown";
}

function runtime(): string {
  const rt = detectRuntime();
  if (rt === "node") {
    const major = globalThis.process?.versions?.node?.split(".")[0];
    return major ? `node-${major}` : "node";
  }
  return rt;
}

function safeProperties(
  properties: Record<string, TelemetryValue> = {}
): Record<string, TelemetryValue> {
  return {
    $lib: SDK_NAME,
    $lib_version: SDK_VERSION,
    $process_person_profile: false,
    platform: platform(),
    runtime: runtime(),
    sdk_name: SDK_NAME,
    sdk_version: SDK_VERSION,
    ...properties,
  };
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as { unref?: () => void }).unref?.();
}

class NoopTelemetryReporter implements TelemetryReporter {
  track(): void {}

  async flush(): Promise<void> {}

  async close(): Promise<void> {}
}

class PostHogTelemetryReporter implements TelemetryReporter {
  readonly #fetch: typeof fetch;
  readonly #host: string;
  readonly #projectKey: string;
  readonly #distinctId: string;
  readonly #flushAt: number;
  readonly #flushIntervalMs: number;
  readonly #requestTimeoutMs: number;
  #queue: QueuedEvent[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inflight: Promise<void> | undefined;
  #closed = false;

  constructor(fetchImpl: typeof fetch, options: TelemetryOptions) {
    // Wrap rather than store the bare reference: calling a native `fetch` as a
    // method (`this.#fetch(...)`) binds `this` to the reporter, which throws
    // `Illegal invocation` in browsers and some worker runtimes.
    this.#fetch = (input, init) => fetchImpl(input, init);
    this.#host = getHost(options);
    this.#projectKey = getProjectKey(options);
    this.#distinctId = distinctId(options);
    this.#flushAt = options.flushAt ?? 10;
    this.#flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  track(
    event: TelemetryEventName,
    properties: Record<string, TelemetryValue> = {}
  ): void {
    // Never observably affect SDK behavior: ignore events after shutdown, and
    // swallow environments where scheduling a timer throws (e.g. the Workers
    // global scope) instead of letting it escape into the caller.
    if (this.#closed) {
      return;
    }
    this.#queue.push({
      distinct_id: this.#distinctId,
      event: `sbox_sdk_${event}`,
      properties: safeProperties(properties),
      timestamp: new Date().toISOString(),
    });
    if (this.#queue.length >= this.#flushAt) {
      void this.flush();
      return;
    }
    if (!this.#timer) {
      try {
        const timer = setTimeout(() => {
          this.#timer = undefined;
          void this.flush();
        }, this.#flushIntervalMs);
        unrefTimer(timer);
        this.#timer = timer;
      } catch {
        // Timer scheduling unavailable (e.g. Workers global scope): the batch
        // still flushes on the next size threshold or on explicit flush().
      }
    }
  }

  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#inflight) {
      await this.#inflight;
    }
    const batch = this.#queue.splice(0);
    if (batch.length === 0) {
      return;
    }
    this.#inflight = this.#send(batch).finally(() => {
      this.#inflight = undefined;
    });
    await this.#inflight;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.flush();
  }

  async #send(batch: QueuedEvent[]): Promise<void> {
    const controller =
      this.#requestTimeoutMs > 0 ? new AbortController() : undefined;
    const timeout =
      controller && this.#requestTimeoutMs > 0
        ? setTimeout(() => controller.abort(), this.#requestTimeoutMs)
        : undefined;
    if (timeout) {
      unrefTimer(timeout);
    }
    try {
      await this.#fetch(`${this.#host}/batch/`, {
        body: JSON.stringify({
          api_key: this.#projectKey,
          batch,
          historical_migration: false,
          sent_at: new Date().toISOString(),
        }),
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        method: "POST",
        signal: controller?.signal,
      });
    } catch {
      // Telemetry must never affect SDK behavior.
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}

export function createTelemetryReporter(
  options: TelemetryReporterOptions
): TelemetryReporter {
  const telemetry = getOption(options.telemetry);
  if (!telemetryEnabled(options.telemetry)) {
    return new NoopTelemetryReporter();
  }
  if (!options.fetch) {
    return new NoopTelemetryReporter();
  }
  if (!getProjectKey(telemetry)) {
    return new NoopTelemetryReporter();
  }
  return new PostHogTelemetryReporter(options.fetch, telemetry);
}

export function durationBucket(ms: number): string {
  if (ms < 100) {
    return "lt_100ms";
  }
  if (ms < 500) {
    return "100_499ms";
  }
  if (ms < 1000) {
    return "500_999ms";
  }
  if (ms < 5000) {
    return "1_4s";
  }
  if (ms < 30_000) {
    return "5_29s";
  }
  return "gte_30s";
}

/** Drop undefined entries so PostHog payloads stay sparse. */
export function compactTelemetry(
  properties: Record<string, TelemetryValue>
): Record<string, TelemetryValue> {
  const out: Record<string, TelemetryValue> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Non-secret summary of a create `SandboxSpec` for anonymous trend analysis.
 * Never includes names, metadata values, env/secret keys or values, or ids.
 */
export function telemetryContextFromSpec(spec: SandboxSpec): TelemetryContext {
  return compactTelemetry({
    disk_mb: spec.resources?.diskMB,
    has_env: spec.env !== undefined && Object.keys(spec.env).length > 0,
    has_gpu: spec.resources?.gpu !== undefined,
    has_secrets: (spec.secrets?.length ?? 0) > 0,
    has_volumes: (spec.volumes?.length ?? 0) > 0,
    memory_mb: spec.resources?.memoryMB,
    on_idle: spec.onIdle,
    port_count: spec.ports?.length,
    region: spec.region,
    template: spec.template,
    ttl_ms: spec.ttlMs,
    vcpus: spec.resources?.vcpus,
  });
}

export function errorCode(error: unknown): string {
  // Normalize through the shared taxonomy so `error_code` stays a bounded,
  // low-cardinality dimension (raw vendor/system codes like `ECONNRESET`
  // collapse to `Provider`) — and pass-through for already-wrapped errors.
  return SandboxError.wrap(error).code;
}
