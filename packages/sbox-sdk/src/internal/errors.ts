/**
 * One normalized error taxonomy for every provider. Providers must never leak
 * their native SDK errors past the adapter boundary — they route through
 * `mapError` or `SandboxError.wrap()`.
 */

export type SandboxErrorCode =
  | "NotFound" // sandbox/process/file/snapshot id unknown
  | "Unauthorized" // bad/expired credentials
  | "Timeout" // op exceeded timeoutMs / TTL
  | "QuotaExceeded" // provider resource/billing limit
  | "NotSupported" // capability gap — thrown BEFORE any network call
  | "Conflict" // idempotency/state conflict (already running, duplicate create)
  | "ProviderNotFound" // unknown provider id
  | "Validation" // bad options (negative ttl, volume on a no-volume provider)
  | "AllProvidersFailed" // every route in the fallback chain failed
  | "Provider"; // catch-all: normalized provider/network failure

const RETRYABLE_CODES = new Set<SandboxErrorCode>([
  "Timeout",
  "QuotaExceeded",
  "Provider",
]);

export interface SandboxErrorInit {
  provider?: string;
  status?: number;
  cause?: unknown;
  retryable?: boolean;
  timedOut?: boolean;
  aborted?: boolean;
}

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly provider?: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly timedOut: boolean;
  readonly aborted: boolean;

  constructor(
    code: SandboxErrorCode,
    message: string,
    init: SandboxErrorInit = {}
  ) {
    super(`[sbox]${init.provider ? ` [${init.provider}]` : ""} ${message}`, {
      cause: init.cause,
    });
    this.name = "SandboxError";
    this.code = code;
    this.provider = init.provider;
    this.status = init.status;
    this.retryable = init.retryable ?? RETRYABLE_CODES.has(code);
    this.timedOut = init.timedOut ?? code === "Timeout";
    this.aborted = init.aborted ?? false;
    Error.captureStackTrace?.(this, SandboxError);
  }

  /** Coerce any thrown value into a SandboxError (pass-through if already one). */
  static wrap(
    err: unknown,
    provider?: string,
    fallback: SandboxErrorCode = "Provider"
  ): SandboxError {
    if (err instanceof SandboxError) {
      return err;
    }
    if (err instanceof Error && err.name === "AbortError") {
      return new SandboxError("Timeout", err.message, {
        aborted: true,
        cause: err,
        provider,
      });
    }
    return new SandboxError(
      fallback,
      err instanceof Error ? err.message : String(err),
      { cause: err, provider }
    );
  }
}

/** Thrown synchronously by a namespace facade before any network call. */
export class NotSupportedError extends SandboxError {
  readonly feature: string;
  constructor(provider: string, feature: string) {
    super(
      "NotSupported",
      `'${feature}' is not supported by provider '${provider}'`,
      { provider, retryable: false }
    );
    this.name = "NotSupportedError";
    this.feature = feature;
  }
}

export class ProviderNotFoundError extends SandboxError {
  constructor(name: string, known: string[] = []) {
    super(
      "ProviderNotFound",
      `Unknown provider "${name}". Registered: ${known.join(", ") || "(none)"}`
    );
    this.name = "ProviderNotFoundError";
  }
}

export interface ProviderAttempt {
  provider: string;
  error: unknown;
}

export class AllProvidersFailedError extends SandboxError {
  readonly attempts: ProviderAttempt[];
  constructor(attempts: ProviderAttempt[]) {
    super(
      "AllProvidersFailed",
      `all providers failed: ${attempts.map((a) => a.provider).join(", ")}`,
      { cause: attempts }
    );
    this.name = "AllProvidersFailedError";
    this.attempts = attempts;
  }
}

/** Centralized HTTP-status retryability classifier. */
export function isRetryableStatus(status?: number): boolean {
  return (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    (status !== undefined && status >= 500)
  );
}

export function isRetryableError(err: unknown): err is SandboxError {
  return err instanceof SandboxError && err.retryable;
}
