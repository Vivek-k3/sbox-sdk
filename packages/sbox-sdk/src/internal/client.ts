import { memory } from "../memory/index.js";
/**
 * `createSandboxClient` — the single entry point. Owns provider selection
 * (instance, or the in-memory default), idempotency-aware retry + fallback,
 * lifecycle hooks, and disposal. The router is the only caller of providers.
 */
import { freezeCapabilities, isCapable } from "./capabilities.js";
import type { CapabilityMap } from "./capabilities.js";
import {
  AllProvidersFailedError,
  NotSupportedError,
  SandboxError,
} from "./errors.js";
import type { ProviderAttempt } from "./errors.js";
import type { MergePlugins, SandboxPlugin } from "./plugin.js";
import { buildSandbox } from "./sandbox.js";
import { assertEnvKeys } from "./shell.js";
import {
  createTelemetryReporter,
  durationBucket,
  errorCode,
} from "./telemetry.js";
import {
  defaultTemplateName,
  templateCacheKey,
  templateRefId,
} from "./templates.js";
import type {
  CallContext,
  ClientOptions,
  ConnectOptions,
  DriverHandle,
  ListFilter,
  ResolvedSandboxSpec,
  RetryPolicy,
  Sandbox,
  SandboxClient,
  SandboxCreateOptions,
  SandboxProvider,
  SandboxSpec,
  TemplateBuildOptions,
  TemplateRef,
  TemplateSpec,
  TemplatesAPI,
  VerifyResult,
  VolumesAPI,
} from "./types.js";

/** Metadata key used when the core emulates get-or-create by name. */
export const SBOX_NAME_KEY = "sbox-name";

function isTemplateSpec(t: unknown): t is TemplateSpec {
  return typeof t === "object" && t !== null && "source" in t;
}

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
  const telemetry = createTelemetryReporter({
    fetch: fetchImpl,
    telemetry: options?.telemetry,
  });
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
    telemetry,
  };

  telemetry.track("client_initialized", { provider: provider.name });

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

  // ---- templates -----------------------------------------------------------
  /** In-flight/finished builds by cache key, so concurrent creates build once. */
  const builds = new Map<string, Promise<TemplateRef>>();

  const buildTemplate = (
    p: SandboxProvider,
    spec: TemplateSpec,
    opts: TemplateBuildOptions = {}
  ): Promise<TemplateRef> => {
    const drv = p.templates;
    if (
      !drv ||
      !isCapable(freezeCapabilities(p.capabilities, p.flags), "templateBuild")
    ) {
      return Promise.reject(new NotSupportedError(p.name, "templates.build"));
    }
    const sources = freezeCapabilities(p.capabilities, p.flags).flags
      .templateSources;
    const kind =
      "dockerfile" in spec.source && spec.source.dockerfile !== undefined
        ? "dockerfile"
        : "image" in spec.source && spec.source.image !== undefined
          ? "image"
          : "snapshot";
    if (!sources.includes(kind)) {
      return Promise.reject(
        new NotSupportedError(p.name, `templates.build({ ${kind} })`)
      );
    }
    assertEnvKeys(spec.env);
    const emit = opts.onEvent ?? (() => {});
    const run = async (): Promise<TemplateRef> => {
      const startedAt = Date.now();
      const cacheKey = await templateCacheKey(spec);
      const ctx = mkCtx(1, opts.signal);
      try {
        if (!opts.force) {
          const existing = await drv.lookup(cacheKey, ctx);
          if (existing) {
            emit({ status: "cached", type: "status" });
            return existing;
          }
        }
        emit({ status: "queued", type: "status" });
        const ref = await drv.build(
          {
            ...spec,
            cacheKey,
            name: spec.name ?? defaultTemplateName(cacheKey),
          },
          { onEvent: emit, signal: opts.signal },
          ctx
        );
        emit({ status: "ready", type: "status" });
        telemetry.track("template_build", {
          duration_bucket: durationBucket(Date.now() - startedAt),
          ok: true,
          provider: p.name,
        });
        return ref;
      } catch (error) {
        emit({
          message: error instanceof Error ? error.message : String(error),
          status: "failed",
          type: "status",
        });
        telemetry.track("template_build", {
          duration_bucket: durationBucket(Date.now() - startedAt),
          error_code: errorCode(error),
          ok: false,
          provider: p.name,
        });
        throw p.mapError?.(error) ?? SandboxError.wrap(error, p.name);
      }
    };
    if (opts.force) {
      return run();
    }
    // Key the in-process memo by provider + a cheap fingerprint; the real
    // content hash is computed inside run().
    const memoKey = `${p.name}:${JSON.stringify(spec, (_k, v) =>
      v instanceof Uint8Array ? `bytes:${v.length}` : v
    )}`;
    let pending = builds.get(memoKey);
    if (!pending) {
      pending = run();
      builds.set(memoKey, pending);
      pending.catch(() => builds.delete(memoKey));
    }
    return pending;
  };

  const templates: TemplatesAPI = {
    build: (spec, opts) => buildTemplate(provider, spec, opts),
    async delete(ref) {
      if (!provider.templates?.delete) {
        throw new NotSupportedError(provider.name, "templates.delete");
      }
      await provider.templates.delete(templateRefId(ref), mkCtx(1));
    },
    async get(idOrName) {
      if (!provider.templates) {
        throw new NotSupportedError(provider.name, "templates.get");
      }
      return provider.templates.lookup(idOrName, mkCtx(1));
    },
    async *list() {
      if (!provider.templates?.list) {
        throw new NotSupportedError(provider.name, "templates.list");
      }
      yield* provider.templates.list(mkCtx(1));
    },
  };

  const volumes: VolumesAPI = {
    async create(spec) {
      if (!provider.volumes) {
        throw new NotSupportedError(provider.name, "volumes.create");
      }
      return provider.volumes.create(spec, mkCtx(1));
    },
    async delete(ref) {
      if (!provider.volumes) {
        throw new NotSupportedError(provider.name, "volumes.delete");
      }
      await provider.volumes.delete(
        typeof ref === "string" ? ref : ref.id,
        mkCtx(1)
      );
    },
    async get(idOrName) {
      if (!provider.volumes) {
        throw new NotSupportedError(provider.name, "volumes.get");
      }
      return provider.volumes.get(idOrName, mkCtx(1));
    },
    async *list() {
      if (!provider.volumes) {
        throw new NotSupportedError(provider.name, "volumes.list");
      }
      yield* provider.volumes.list(mkCtx(1));
    },
  };

  /** Resolve inline templates, snapshot refs and deprecated aliases. */
  const resolveSpec = async (
    p: SandboxProvider,
    spec: SandboxSpec
  ): Promise<ResolvedSandboxSpec> => {
    assertEnvKeys(spec.env);
    const {
      template,
      fromSnapshot,
      onTemplateEvent,
      ttlMs,
      onIdle,
      lifecycle,
      ...rest
    } = spec;
    let templateId: string | undefined;
    let templateRef: TemplateRef | undefined;
    if (isTemplateSpec(template)) {
      templateRef = await buildTemplate(p, template, {
        onEvent: onTemplateEvent,
        signal: spec.signal,
      });
      templateId = templateRef.id;
    } else if (typeof template === "object" && template !== null) {
      templateRef = template;
      templateId = template.id;
    } else {
      templateId = template;
    }
    const merged = {
      ...lifecycle,
      maxAgeMs: lifecycle?.maxAgeMs ?? ttlMs,
      onIdle: lifecycle?.onIdle ?? onIdle,
    };
    const hasLifecycle = Object.values(merged).some((v) => v !== undefined);
    return {
      ...rest,
      ...(templateId === undefined ? {} : { template: templateId }),
      ...(templateRef ? { templateRef } : {}),
      ...(fromSnapshot === undefined
        ? {}
        : {
            fromSnapshot:
              typeof fromSnapshot === "string" ? fromSnapshot : fromSnapshot.id,
          }),
      ...(hasLifecycle
        ? { lifecycle: merged, onIdle: merged.onIdle, ttlMs: merged.maxAgeMs }
        : {}),
      metadata: { ...options?.defaultMetadata, ...spec.metadata },
    };
  };

  const finishBuild = async (
    p: SandboxProvider,
    handle: DriverHandle,
    createOptions?: SandboxCreateOptions
  ): Promise<Sandbox> => {
    const sandbox = buildSandbox(p, handle, base, { createOptions });
    for (const pl of plugins) {
      await pl.onCreate?.(sandbox as Sandbox, { createOptions });
    }
    return sandbox as unknown as Sandbox;
  };

  const client: SandboxClient = {
    get capabilities() {
      return caps;
    },

    async connect(id: string, connectOpts?: ConnectOptions): Promise<Sandbox> {
      const startedAt = Date.now();
      try {
        const handle = await withRetry((attempt) =>
          Promise.resolve(
            provider.connect(id, mkCtx(attempt, connectOpts?.signal))
          )
        );
        let active = handle;
        if (connectOpts?.resume && handle.resume) {
          const info = await handle.getInfo(mkCtx(1, connectOpts.signal));
          if (
            info.state === "paused" ||
            info.state === "stopped" ||
            info.state === "archived"
          ) {
            await handle.resume(mkCtx(1, connectOpts.signal));
            // Providers whose resume changes the id: reconnect to the new one.
            if (provider.flags.resumeChangesId) {
              const fresh = await handle.getInfo(mkCtx(1));
              if (fresh.id !== handle.id) {
                active = await provider.connect(fresh.id, mkCtx(1));
              }
            }
          }
        }
        const sandbox = await finishBuild(provider, active);
        telemetry.track("sandbox_connect", {
          duration_bucket: durationBucket(Date.now() - startedAt),
          ok: true,
          provider: provider.name,
        });
        return sandbox;
      } catch (error) {
        telemetry.track("sandbox_connect", {
          duration_bucket: durationBucket(Date.now() - startedAt),
          error_code: errorCode(error),
          ok: false,
          provider: provider.name,
        });
        throw error;
      }
    },

    async create(
      spec: SandboxSpec = {},
      createOptions?: SandboxCreateOptions
    ): Promise<Sandbox> {
      const idem = spec.idempotencyKey ?? globalThis.crypto.randomUUID();
      const startedAt = Date.now();
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
          const resolved = await resolveSpec(p, spec);
          const handle = await withRetry((attempt) =>
            Promise.resolve(
              p.create(resolved, mkCtx(attempt, spec.signal, idem))
            )
          );
          await hooks?.afterCreate?.({ id: handle.id, provider: p.name });
          const sandbox = await finishBuild(p, handle, createOptions);
          telemetry.track("sandbox_create", {
            duration_bucket: durationBucket(Date.now() - startedAt),
            ok: true,
            provider: p.name,
          });
          return sandbox;
        } catch (error) {
          attempts.push({ error, provider: p.name });
        }
      }
      if (attempts.length === 1) {
        telemetry.track("sandbox_create", {
          duration_bucket: durationBucket(Date.now() - startedAt),
          error_code: errorCode(attempts[0]!.error),
          ok: false,
          provider: attempts[0]!.provider,
        });
        throw attempts[0]!.error;
      }
      telemetry.track("sandbox_create", {
        duration_bucket: durationBucket(Date.now() - startedAt),
        error_code: "AllProvidersFailed",
        ok: false,
        provider_count: attempts.length,
      });
      throw new AllProvidersFailedError(attempts);
    },

    async dispose() {
      const startedAt = Date.now();
      try {
        await provider.dispose?.();
        telemetry.track("client_dispose", {
          duration_bucket: durationBucket(Date.now() - startedAt),
          ok: true,
          provider: provider.name,
        });
      } catch (error) {
        telemetry.track("client_dispose", {
          duration_bucket: durationBucket(Date.now() - startedAt),
          error_code: errorCode(error),
          ok: false,
          provider: provider.name,
        });
        throw error;
      } finally {
        await telemetry.close();
      }
    },

    async *list(filter?: ListFilter) {
      if (!provider.list) {
        throw new NotSupportedError(provider.name, "list");
      }
      const startedAt = Date.now();
      let count = 0;
      let failure: string | undefined;
      try {
        for await (const info of provider.list(filter, mkCtx(1))) {
          count++;
          yield info;
        }
      } catch (error) {
        failure = errorCode(error);
        throw error;
      } finally {
        // Emit once on any exit — normal completion, a thrown error, or an
        // early consumer `break`/`return` (which unwinds through here). Early
        // termination is not a failure, so `ok` is false only when we caught.
        telemetry.track("sandbox_list", {
          count,
          duration_bucket: durationBucket(Date.now() - startedAt),
          ok: failure === undefined,
          provider: provider.name,
          ...(failure === undefined ? {} : { error_code: failure }),
        });
      }
    },

    async getOrCreate(
      spec: SandboxSpec & { name: string },
      createOptions?: SandboxCreateOptions
    ): Promise<Sandbox> {
      if (provider.getOrCreate) {
        const resolved = await resolveSpec(provider, spec);
        const handle = await withRetry((attempt) =>
          Promise.resolve(
            provider.getOrCreate!(
              { ...resolved, name: spec.name },
              mkCtx(attempt, spec.signal, spec.idempotencyKey)
            )
          )
        );
        return finishBuild(provider, handle, createOptions);
      }
      if (!provider.list) {
        throw new NotSupportedError(provider.name, "getOrCreate");
      }
      for await (const info of provider.list(
        { metadata: { [SBOX_NAME_KEY]: spec.name } },
        mkCtx(1, spec.signal)
      )) {
        const matches =
          info.metadata[SBOX_NAME_KEY] === spec.name || info.name === spec.name;
        if (matches && info.state !== "destroyed" && info.state !== "error") {
          return client.connect(info.id, { resume: true, signal: spec.signal });
        }
      }
      return client.create(
        {
          ...spec,
          idempotencyKey: spec.idempotencyKey ?? `sbox-name:${spec.name}`,
          metadata: { ...spec.metadata, [SBOX_NAME_KEY]: spec.name },
        },
        createOptions
      );
    },

    get provider() {
      return provider.name;
    },

    get templates() {
      return (
        isCapable(caps, "templateBuild") ? templates : undefined
      ) as never;
    },

    async verify(): Promise<VerifyResult> {
      if (!provider.verify) {
        return {
          error: new NotSupportedError(provider.name, "verify"),
          ok: false,
          provider: provider.name,
        };
      }
      try {
        const res = await provider.verify(mkCtx(1));
        return {
          ok: true,
          provider: provider.name,
          ...(res && res.account ? { account: res.account } : {}),
        };
      } catch (error) {
        return {
          error:
            provider.mapError?.(error) ??
            SandboxError.wrap(error, provider.name),
          ok: false,
          provider: provider.name,
        };
      }
    },

    get volumes() {
      return (isCapable(caps, "volumes") ? volumes : undefined) as never;
    },
  };

  return client;
}
