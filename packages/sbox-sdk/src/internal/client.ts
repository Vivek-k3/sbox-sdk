import { memory } from "../memory/index.js";
/**
 * `createSandboxClient` — the single entry point. Owns provider selection
 * (instance, or the in-memory default), idempotency-aware retry + fallback,
 * lifecycle hooks, and disposal. The router is the only caller of providers.
 */
import { freezeCapabilities } from "./capabilities.js";
import type { CapabilityMap } from "./capabilities.js";
import {
  AllProvidersFailedError,
  NotSupportedError,
  SandboxError,
} from "./errors.js";
import type { ProviderAttempt } from "./errors.js";
import type { MergePlugins, SandboxPlugin } from "./plugin.js";
import { buildSandbox } from "./sandbox.js";
import type {
  CallContext,
  ClientOptions,
  ListFilter,
  RetryPolicy,
  Sandbox,
  SandboxClient,
  SandboxCreateOptions,
  SandboxProvider,
  SandboxSpec,
} from "./types.js";

function defaultShouldRetry(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "retryable" in err &&
    (err as { retryable?: unknown }).retryable === true
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function createSandboxClient(): SandboxClient;
export function createSandboxClient<
  Caps extends CapabilityMap,
  Raw,
  const Ps extends readonly SandboxPlugin[] = [],
>(
  options: ClientOptions<Caps, Raw> & {
    provider: SandboxProvider<Caps, Raw>;
    plugins?: Ps;
  }
): SandboxClient<Caps, Raw, MergePlugins<Ps>>;
export function createSandboxClient(options?: ClientOptions): SandboxClient {
  const provider: SandboxProvider = options?.provider ?? memory();
  const fetchImpl: typeof fetch = options?.fetch ?? globalThis.fetch;
  const retry: RetryPolicy = { retries: 2, ...options?.retry };
  const fallback = options?.fallback ?? [];
  const hooks = options?.hooks;
  const plugins = options?.plugins ?? [];
  const aiProviders = plugins.filter((p) => p.kind === "ai-provider");
  if (aiProviders.length > 1) {
    throw new SandboxError(
      "Validation",
      `a client supports one AI-provider plugin, got ${aiProviders.length} (${aiProviders
        .map((p) => p.name)
        .join(
          ", "
        )}). Use the standalone toXTools(sandbox) helpers for multiple frameworks.`
    );
  }
  const caps = freezeCapabilities(provider.capabilities, provider.flags);
  const base = {
    defaultMetadata: options?.defaultMetadata,
    emulate: options?.emulate,
    fetch: fetchImpl,
    plugins,
  };

  const mkCtx = (
    attempt: number,
    signal?: AbortSignal,
    idempotencyKey?: string
  ): CallContext => ({
    attempt,
    fetch: fetchImpl,
    idempotencyKey,
    metadata: options?.defaultMetadata,
    signal,
  });

  const backoff = (n: number): number => Math.min(100 * 2 ** (n - 1), 2000);

  const withRetry = async <T>(
    fn: (attempt: number) => Promise<T>
  ): Promise<T> => {
    const max = retry.retries ?? 2;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= max + 1; attempt++) {
      try {
        return await fn(attempt);
      } catch (error) {
        lastErr = error;
        await hooks?.onError?.(error, attempt);
        const should = (retry.shouldRetry ?? defaultShouldRetry)(
          error,
          attempt
        );
        if (!should || attempt > max) {
          throw error;
        }
        await sleep((retry.delayMs ?? backoff)(attempt, error));
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new SandboxError("Provider", String(lastErr));
  };

  const client: SandboxClient = {
    get capabilities() {
      return caps;
    },

    async connect(id: string): Promise<Sandbox> {
      const handle = await withRetry((attempt) =>
        Promise.resolve(provider.connect(id, mkCtx(attempt)))
      );
      const sandbox = buildSandbox(provider, handle, base);
      for (const pl of plugins) {
        await pl.onCreate?.(sandbox as Sandbox, {});
      }
      return sandbox as unknown as Sandbox;
    },

    async create(
      spec: SandboxSpec = {},
      createOptions?: SandboxCreateOptions
    ): Promise<Sandbox> {
      const idem = spec.idempotencyKey ?? globalThis.crypto.randomUUID();
      await hooks?.beforeCreate?.(spec);
      // Only fall back across providers when the caller supplied an idempotency
      // key — otherwise a retried create could orphan a second VM.
      const canFallback = !!spec.idempotencyKey && fallback.length > 0;
      const chain: SandboxProvider[] = canFallback
        ? [provider, ...fallback]
        : [provider];
      const attempts: ProviderAttempt[] = [];
      for (const p of chain) {
        try {
          const handle = await withRetry((attempt) =>
            Promise.resolve(
              p.create(
                {
                  ...spec,
                  metadata: { ...options?.defaultMetadata, ...spec.metadata },
                },
                mkCtx(attempt, spec.signal, idem)
              )
            )
          );
          await hooks?.afterCreate?.({ id: handle.id, provider: p.name });
          const sandbox = buildSandbox(p, handle, base, { createOptions });
          for (const pl of plugins) {
            await pl.onCreate?.(sandbox as Sandbox, { createOptions });
          }
          return sandbox as unknown as Sandbox;
        } catch (error) {
          attempts.push({ error, provider: p.name });
        }
      }
      if (attempts.length === 1) {
        throw attempts[0]!.error;
      }
      throw new AllProvidersFailedError(attempts);
    },

    async dispose() {
      await provider.dispose?.();
    },

    async *list(filter?: ListFilter) {
      if (!provider.list) {
        throw new NotSupportedError(provider.name, "list");
      }
      yield* provider.list(filter, mkCtx(1));
    },

    get provider() {
      return provider.name;
    },
  };

  return client;
}
