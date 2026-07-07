import pkg from "../../package.json" with { type: "json" };
import type { TelemetryOptions } from "./types.js";

type TelemetryValue = string | number | boolean | null | undefined;

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
  if (options.enabled === true || isTruthy(env("SBOX_TELEMETRY"))) {
    return true;
  }
  return true;
}

function getProjectKey(options: TelemetryOptions): string | undefined {
  return (
    options.projectKey ??
    env("SBOX_TELEMETRY_POSTHOG_KEY") ??
    DEFAULT_POSTHOG_PROJECT_KEY ??
    undefined
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
  if (globalThis.process?.versions?.node) {
    return `node-${globalThis.process.versions.node.split(".")[0]}`;
  }
  if ("Bun" in globalThis) {
    return "bun";
  }
  if ("Deno" in globalThis) {
    return "deno";
  }
  return "web";
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

class NoopTelemetryReporter implements TelemetryReporter {
  track(): void {}

  async flush(): Promise<void> {}
}

class PostHogTelemetryReporter implements TelemetryReporter {
  readonly #fetch: typeof fetch;
  readonly #host: string;
  readonly #projectKey: string;
  readonly #distinctId: string;
  readonly #flushAt: number;
  readonly #flushIntervalMs: number;
  #queue: QueuedEvent[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inflight: Promise<void> | undefined;

  constructor(fetchImpl: typeof fetch, options: TelemetryOptions) {
    this.#fetch = fetchImpl;
    this.#host = getHost(options);
    this.#projectKey = getProjectKey(options)!;
    this.#distinctId = distinctId(options);
    this.#flushAt = options.flushAt ?? 10;
    this.#flushIntervalMs = options.flushIntervalMs ?? 1000;
  }

  track(
    event: TelemetryEventName,
    properties: Record<string, TelemetryValue> = {}
  ): void {
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
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        void this.flush();
      }, this.#flushIntervalMs);
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

  async #send(batch: QueuedEvent[]): Promise<void> {
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
      });
    } catch {
      // Telemetry must never affect SDK behavior.
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

export function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return error instanceof Error ? error.name : "Unknown";
}
