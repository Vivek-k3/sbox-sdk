/**
 * The sbox gateway wire protocol, v1. Shared by the `cloud()` client adapter
 * and `createGatewayHandler()` so the two can never drift.
 *
 * Transport: HTTPS + JSON; streams are NDJSON (one JSON object per line).
 * Auth: `Authorization: Bearer <api key>`.
 * Every request carries `sbox-requires: cap1,cap2` (may be empty) so a
 * stateless gateway rebuilds the SAME router — and therefore the same
 * capability map — on every call.
 *
 *   POST   /v1/session                          -> SessionInfo
 *   POST   /v1/sandboxes                {spec}   -> { info }
 *   GET    /v1/sandboxes?filter=<json>          -> { items: info[] }
 *   GET    /v1/sandboxes/:id                    -> { info }
 *   DELETE /v1/sandboxes/:id                    -> 204
 *   POST   /v1/sandboxes/:id/exec       {cmd, opts}   -> NDJSON StreamFrame
 *   POST   /v1/sandboxes/:id/processes  {cmd, opts}   -> NDJSON StreamFrame
 *   GET    /v1/sandboxes/:id/processes/:pid           -> NDJSON StreamFrame
 *   GET    /v1/sandboxes/:id/files?path=...           -> bytes
 *   PUT    /v1/sandboxes/:id/files?path=...  (bytes)  -> 204
 *   POST   /v1/sandboxes/:id/rpc        {method, args} -> { result }
 *
 * Errors: non-2xx with `{ error: WireError }`, or an `{type:"error"}` frame
 * mid-stream. Previews are returned as provider URLs and are NOT proxied.
 */
import type {
  CapabilityFlags,
  CapabilityMap,
  CapabilityName,
} from "../internal/capabilities.js";
import { SandboxError } from "../internal/errors.js";
import type { SandboxErrorCode } from "../internal/errors.js";
import type {
  DriverHandle,
  ExecOptions,
  OutputEvent,
} from "../internal/types.js";

export const PROTOCOL_VERSION = 1;
export const REQUIRES_HEADER = "sbox-requires";
export const IDEMPOTENCY_HEADER = "idempotency-key";

/**
 * Capabilities the v1 protocol does not carry. The gateway reports them as
 * unsupported whatever the routed provider can do.
 */
export const WIRE_UNSUPPORTED: ReadonlySet<CapabilityName> = new Set([
  "codeInterpreter",
  "filesWatch",
  "proxiedFetch",
  "pty",
  "statefulKernel",
  "stdin",
  "templateBuild",
  "volumes",
]);

/**
 * Handle methods reachable through `/rpc`, and the capability each needs
 * (`null` = always available).
 */
export const RPC_METHODS = {
  createSsh: "ssh",
  deleteSnapshot: "snapshot",
  exposePort: "exposePort",
  fork: "fork",
  getInfo: null,
  getMetrics: "metrics",
  killProcess: "killProcess",
  listDir: null,
  listPorts: "exposePort",
  listProcesses: "background",
  listSnapshots: "snapshot",
  mkdir: null,
  pause: "pause",
  remove: null,
  rename: null,
  restoreSnapshot: "snapshot",
  resume: null,
  setEgressPolicy: "egressControl",
  setTimeout: "setTimeout",
  snapshot: "snapshot",
  stat: null,
  stop: "stop",
  unexposePort: "exposePort",
} as const satisfies Partial<Record<keyof DriverHandle, CapabilityName | null>>;

export type RpcMethod = keyof typeof RPC_METHODS;

export interface SessionInfo {
  protocol: number;
  capabilities: CapabilityMap;
  flags: CapabilityFlags;
  /** Route names the account can use (informational). */
  routes?: string[];
}

export interface ExecRequest {
  cmd: string;
  opts: Pick<ExecOptions, "cwd" | "env" | "timeoutMs" | "user">;
}

export interface RpcRequest {
  method: RpcMethod;
  args: unknown[];
}

export interface WireError {
  code: SandboxErrorCode;
  message: string;
  provider?: string;
  status?: number;
  retryable?: boolean;
}

export type StreamFrame =
  | { type: "start"; pid: string; id?: string }
  | OutputEvent
  | { type: "error"; error: WireError };

/** Map the effective capability map onto what the wire can carry. */
export function wireCapabilities(caps: CapabilityMap): CapabilityMap {
  const out = { ...caps };
  for (const name of WIRE_UNSUPPORTED) {
    out[name] = "unsupported";
  }
  return out;
}

export function wireFlags(flags: CapabilityFlags): CapabilityFlags {
  return { ...flags, templateSources: [] };
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

const DATE_KEYS = new Set(["createdAt", "expiresAt", "timestamp"]);

/** JSON.stringify that drops provider-native `raw` payloads. */
export function encode(value: unknown): string {
  return JSON.stringify(value, (key, v: unknown) =>
    key === "raw" ? undefined : v
  );
}

/** JSON.parse that revives known date fields and restores `raw: undefined`. */
export function decode<T>(text: string): T {
  return JSON.parse(text, (key, v: unknown) =>
    DATE_KEYS.has(key) && typeof v === "string" ? new Date(v) : v
  ) as T;
}

const PREFIX = /^\[sbox\](?: \[[^\]]*\])? /;

export function toWireError(err: unknown): WireError {
  const e = SandboxError.wrap(err);
  return {
    code: e.code,
    message: e.message.replace(PREFIX, ""),
    provider: e.provider,
    retryable: e.retryable,
    status: e.status,
  };
}

export function fromWireError(w: WireError): SandboxError {
  return new SandboxError(w.code, w.message, {
    provider: w.provider,
    retryable: w.retryable,
    status: w.status,
  });
}

/** HTTP status for an error code (the client relies on the body, not this). */
export function statusFor(code: SandboxErrorCode): number {
  switch (code) {
    case "NotFound":
    case "ProviderNotFound": {
      return 404;
    }
    case "Unauthorized": {
      return 401;
    }
    case "QuotaExceeded": {
      return 429;
    }
    case "Validation": {
      return 400;
    }
    case "NotSupported": {
      return 501;
    }
    case "Conflict": {
      return 409;
    }
    case "Timeout": {
      return 504;
    }
    default: {
      return 502;
    }
  }
}

/**
 * Parse an NDJSON byte stream into objects. Aborting `signal` cancels the
 * underlying stream.
 * @yields {T} one decoded object per non-empty line
 */
export async function* readNdjson<T>(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<T> {
  const reader = body.getReader();
  // Cancelling the reader propagates to the server's stream (its `cancel()`),
  // which is how a client-side kill reaches the gateway.
  const onAbort = (): void => {
    reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buf += dec.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          yield decode<T>(line);
        }
        nl = buf.indexOf("\n");
      }
    }
    const rest = (buf + dec.decode()).trim();
    if (rest) {
      yield decode<T>(rest);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
