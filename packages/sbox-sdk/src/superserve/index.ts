import type {
  BuildStep,
  CommandResult,
  CommandSession,
  ConnectionOptions,
  NetworkConfig,
  PreviewAccessPolicy,
  SandboxCreateOptions,
  SandboxInfo as SsSandboxInfo,
  SandboxStatus,
  Sandbox as SsSandbox,
  SnapshotInfo,
  TemplateInfo,
  VolumeInfo as SsVolumeInfo,
} from "@superserve/sdk";

/**
 * `sbox-sdk/superserve` — adapter for Superserve (Firecracker microVMs, core
 * Apache-2.0). Backed by the optional peer `@superserve/sdk`, which is
 * lazy-imported inside create()/connect() so importing this subpath stays cheap.
 *
 * Exec runs over the SDK's WebSocket session (`commands.spawn`): output streams
 * with stdout/stderr kept apart, `kill()` signals the real process, stdin is
 * writable on spawned processes, and there is no 30 s default cap (the one-shot
 * `commands.run()` has one).
 */
import {
  AsyncQueue,
  defaultTemplateName,
  loadTemplateContext,
  NotSupportedError,
  parseDockerfile,
  SandboxError,
  joinPath,
  parseEnvArgs,
  resolveCopy,
  shellForm,
  splitFlags,
  splitShellWords as tokenize,
  substituteArgs,
} from "../adapter/index.js";
import type {
  CallContext,
  CapabilityFlags,
  CapabilityMap,
  DriverExec,
  DriverHandle,
  DriverProcess,
  DriverTemplates,
  DriverVolumes,
  EgressPolicy,
  ExecOptions,
  FileBody,
  LifecyclePolicy,
  ListFilter,
  OutputEvent,
  Preview,
  ResolvedSandboxSpec,
  SandboxInfo,
  SandboxProvider,
  SandboxState,
  SecretRef,
  SnapshotRef,
  TemplateBuildEvent,
  TemplateRef,
  TemplateSpec,
  VolumeInfo,
} from "../adapter/index.js";

type Mod = typeof import("@superserve/sdk");

const NAME = "superserve";

export interface SuperserveOptions {
  /** API key. Defaults to the `SUPERSERVE_API_KEY` env var. */
  apiKey?: string;
  /**
   * API base URL override. By default the region is derived from the key
   * (`ss_live_use_…` → us-east, `ss_live_usw_…` → us-west).
   */
  baseUrl?: string;
  /**
   * Lifetime, in seconds, of the token minted for a private preview port
   * (1–604800). Default 86400 (one day).
   */
  previewTokenTtlSeconds?: number;
}

export const SUPERSERVE_CAPS = {
  background: "native",
  codeInterpreter: "unsupported",
  egressControl: "native",
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "unsupported",
  fork: "native",
  gpu: "unsupported",
  killProcess: "native",
  list: "native",
  metrics: "unsupported",
  pause: "native",
  privatePreview: "native",
  proxiedFetch: "unsupported",
  pty: "unsupported",
  region: "unsupported",
  secretsVault: "native",
  setTimeout: "native",
  snapshot: "native",
  ssh: "unsupported",
  statefulKernel: "unsupported",
  stdin: "native",
  stop: "unsupported",
  streaming: "native",
  templateBuild: "native",
  volumes: "native",
} as const satisfies CapabilityMap;

export type SuperserveCaps = typeof SUPERSERVE_CAPS;

const SUPERSERVE_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true,
  preservesDiskOnStop: false,
  preservesMemoryOnPause: true,
  previewBrowserAuth: true,
  previewModel: "subdomain",
  templateSources: ["image", "dockerfile"],
};

/** Metadata key holding a hash of the create idempotency key. */
const IDEM_KEY = "sbox-idempotency-key";
/** The sandbox's DNS resolvers; a deny-all policy blocks them too. */
const DNS_RESOLVERS = ["1.1.1.1/32", "8.8.8.8/32"];
/** Total context bytes a Dockerfile `COPY` may inline into build steps. */
const MAX_COPY_BYTES = 4 * 1024 * 1024;
/** Base64 bytes per generated `run` step when inlining a file. */
const COPY_CHUNK = 48 * 1024;

// --------------------------------------------------------------------------
// lazy SDK loader (memoized)
// --------------------------------------------------------------------------

let sdkPromise: Promise<Mod> | undefined;
function loadSdk(): Promise<Mod> {
  sdkPromise ??= import("@superserve/sdk");
  return sdkPromise;
}

// --------------------------------------------------------------------------
// pure mapping helpers (exported for tests)
// --------------------------------------------------------------------------

const STATUS: Record<SandboxStatus, SandboxState> = {
  active: "running",
  deleted: "destroyed",
  failed: "error",
  migrating: "paused",
  paused: "paused",
  pausing: "suspending",
  resuming: "creating",
  starting: "creating",
};

/** Every Superserve status, mapped onto `SandboxState`. */
export function mapSuperserveStatus(status: string): SandboxState {
  return (
    (STATUS as Record<string, SandboxState | undefined>)[status] ?? "unknown"
  );
}

const STATE_FILTER: Partial<Record<SandboxState, SandboxStatus[]>> = {
  creating: ["starting", "resuming"],
  destroyed: ["deleted"],
  error: ["failed"],
  paused: ["paused", "migrating"],
  running: ["active"],
  suspending: ["pausing"],
};

function stripInternal(meta: Record<string, string>): Record<string, string> {
  const { [IDEM_KEY]: _drop, ...rest } = meta;
  return rest;
}

function toInfo(i: SsSandboxInfo): SandboxInfo {
  return {
    createdAt: i.createdAt,
    id: i.id,
    metadata: stripInternal(i.metadata ?? {}),
    name: i.name || undefined,
    provider: NAME,
    raw: i,
    state: mapSuperserveStatus(i.status),
  };
}

/** `EgressPolicy` → Superserve `NetworkConfig` (allow/deny lists). */
export function toNetworkConfig(policy: EgressPolicy): NetworkConfig {
  if (policy.inject?.length) {
    throw new NotSupportedError(
      NAME,
      "EgressPolicy.inject (Superserve swaps a stand-in token instead of adding headers; bind a Superserve secret with secrets: [{ name, envVar }])"
    );
  }
  if (policy.deny?.domains?.length) {
    throw new NotSupportedError(
      NAME,
      "EgressPolicy.deny.domains (Superserve deny rules take IPs/CIDRs only)"
    );
  }
  switch (policy.mode) {
    case "allow-all": {
      return { allowOut: [], denyOut: [...(policy.deny?.cidrs ?? [])] };
    }
    case "block-all": {
      return { allowOut: [], denyOut: ["0.0.0.0/0"] };
    }
    case "allow-list": {
      const domains = policy.domains ?? [];
      const allow = [...(policy.cidrs ?? []), ...domains];
      if (domains.length > 0) {
        for (const r of DNS_RESOLVERS) {
          if (!allow.includes(r)) {
            allow.push(r);
          }
        }
      }
      return { allowOut: allow, denyOut: ["0.0.0.0/0"] };
    }
    default: {
      throw new SandboxError(
        "Validation",
        `unknown egress mode '${String((policy as { mode: unknown }).mode)}'`,
        { provider: NAME }
      );
    }
  }
}

/**
 * Split `SecretRef`s: inline values become plain env vars; references to a
 * stored Superserve secret are bound by env var (the sandbox sees a stand-in
 * token, swapped for the real credential at egress).
 */
export function mapSecrets(secrets: SecretRef[] | undefined): {
  envVars: Record<string, string>;
  bindings: Record<string, string>;
} {
  const envVars: Record<string, string> = {};
  const bindings: Record<string, string> = {};
  for (const s of secrets ?? []) {
    const envKey = s.envVar ?? s.name;
    if (s.value === undefined) {
      bindings[envKey] = s.name;
    } else if ((s.mode ?? "env") === "env") {
      envVars[envKey] = s.value;
    } else {
      throw new NotSupportedError(
        NAME,
        "inline egress secret values (create the Superserve secret first, then reference it by name)"
      );
    }
  }
  return { bindings, envVars };
}

/** `LifecyclePolicy` → Superserve timeouts. */
export function lifecycleOptions(
  l: LifecyclePolicy | undefined
): Pick<
  SandboxCreateOptions,
  "timeoutSeconds" | "idleTimeoutSeconds" | "autoDeleteSeconds"
> {
  const out: Pick<
    SandboxCreateOptions,
    "timeoutSeconds" | "idleTimeoutSeconds" | "autoDeleteSeconds"
  > = {};
  if (!l) {
    return out;
  }
  if (l.maxAgeMs !== undefined) {
    out.timeoutSeconds = Math.max(1, Math.ceil(l.maxAgeMs / 1000));
  }
  if (l.idleTimeoutMs !== undefined) {
    out.idleTimeoutSeconds = Math.min(
      604_800,
      Math.max(60, Math.ceil(l.idleTimeoutMs / 1000))
    );
  }
  if (l.onIdle === "destroy") {
    // Superserve auto-pauses; deleting as soon as it is paused gives "destroy".
    out.autoDeleteSeconds = 0;
  }
  return out;
}

function normalizeSignal(signal: string | undefined): string {
  if (!signal) {
    return "SIGKILL";
  }
  if (/^\d+$/.test(signal)) {
    return signal === "9" ? "SIGKILL" : signal === "2" ? "SIGINT" : "SIGTERM";
  }
  const up = signal.toUpperCase();
  return up.startsWith("SIG") ? up : `SIG${up}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x80_00) {
    bin += String.fromCodePoint(...bytes.subarray(i, i + 0x80_00));
  }
  return btoa(bin);
}

function q(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function isNotFound(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "NotFoundError" ||
      (err as { statusCode?: unknown }).statusCode === 404)
  );
}

/** Normalize Superserve SDK errors into the sbox taxonomy. */
export function mapSuperserveError(err: unknown): SandboxError | undefined {
  if (err instanceof SandboxError) {
    return err;
  }
  if (!(err instanceof Error)) {
    return undefined;
  }
  const rawStatus = (err as { statusCode?: unknown }).statusCode;
  const status = typeof rawStatus === "number" ? rawStatus : undefined;
  const init = { cause: err, provider: NAME, status };
  switch (err.name) {
    case "AuthenticationError": {
      return new SandboxError("Unauthorized", err.message, init);
    }
    case "NotFoundError": {
      return new SandboxError("NotFound", err.message, init);
    }
    case "ConflictError": {
      return new SandboxError("Conflict", err.message, init);
    }
    case "RateLimitError": {
      return new SandboxError("QuotaExceeded", err.message, {
        ...init,
        retryable: true,
      });
    }
    case "BillingError": {
      return new SandboxError("QuotaExceeded", err.message, {
        ...init,
        retryable: false,
      });
    }
    case "TimeoutError": {
      return new SandboxError("Timeout", err.message, init);
    }
    case "ValidationError": {
      return new SandboxError("Validation", err.message, init);
    }
    case "BuildError": {
      return new SandboxError("Provider", err.message, {
        ...init,
        retryable: false,
      });
    }
    default: {
      break;
    }
  }
  if (status === 401 || status === 403) {
    return new SandboxError("Unauthorized", err.message, init);
  }
  if (status === 404) {
    return new SandboxError("NotFound", err.message, init);
  }
  if (status === 409) {
    return new SandboxError("Conflict", err.message, init);
  }
  if (status === 429) {
    return new SandboxError("QuotaExceeded", err.message, {
      ...init,
      retryable: true,
    });
  }
  if (status === 408 || status === 504) {
    return new SandboxError("Timeout", err.message, init);
  }
  return undefined;
}

function wrap(err: unknown): SandboxError {
  return mapSuperserveError(err) ?? SandboxError.wrap(err, NAME);
}

// --------------------------------------------------------------------------
// templates: TemplateSpec → BuildSpec
// --------------------------------------------------------------------------

export interface SuperserveBuildSpec {
  from: string;
  steps: BuildStep[];
  startCmd?: string;
  readyCmd?: string;
}

/**
 * Translate a Dockerfile into a BuildSpec. `FROM`/`RUN`/`ENV`/`WORKDIR`/`USER`
 * map one to one; `COPY`/`ADD` context files are inlined as base64 `run`
 * steps (BuildSpec has no copy step); `CMD`/`ENTRYPOINT` become `startCmd`;
 * `ARG` defaults are substituted textually. Metadata-only instructions
 * (`EXPOSE`, `LABEL`, ...) are reported in `ignored`.
 */
export function dockerfileToBuildSpec(
  dockerfile: string,
  context: ReadonlyMap<string, Uint8Array>
): SuperserveBuildSpec & { ignored: string[] } {
  let from: string | undefined;
  const steps: BuildStep[] = [];
  const ignored: string[] = [];
  const args = new Map<string, string>();
  let workdir = "/";
  let entrypoint: string | undefined;
  let cmd: string | undefined;
  let copied = 0;
  for (const ins of parseDockerfile(dockerfile)) {
    const text = substituteArgs(ins.args, args);
    switch (ins.op) {
      case "FROM": {
        if (from !== undefined) {
          throw new NotSupportedError(NAME, "multi-stage Dockerfiles");
        }
        const [image] = tokenize(splitFlags(text).rest);
        if (!image) {
          throw new SandboxError("Validation", "FROM needs an image", {
            provider: NAME,
          });
        }
        from = image;
        break;
      }
      case "ARG": {
        const [k, v] = text.split("=", 2);
        if (k && v !== undefined) {
          args.set(k.trim(), v.trim().replaceAll(/^["']|["']$/g, ""));
        }
        break;
      }
      case "RUN": {
        const { flags, rest } = splitFlags(text);
        if (flags.mount !== undefined) {
          throw new NotSupportedError(NAME, "RUN --mount");
        }
        steps.push({ run: shellForm(rest) });
        break;
      }
      case "ENV": {
        for (const [key, value] of parseEnvArgs(text)) {
          steps.push({ env: { key, value } });
        }
        break;
      }
      case "WORKDIR": {
        workdir = joinPath(text.startsWith("/") ? "/" : workdir, text);
        steps.push({ workdir });
        break;
      }
      case "USER": {
        const [name] = text.split(":");
        if (name) {
          steps.push({ user: { name } });
        }
        break;
      }
      case "COPY":
      case "ADD": {
        const res = resolveCopy(ins.op, text, context, workdir, NAME);
        for (const f of res.files) {
          copied += f.data.length;
          if (copied > MAX_COPY_BYTES) {
            throw new NotSupportedError(
              NAME,
              `COPY of more than ${MAX_COPY_BYTES} bytes (Superserve BuildSpec has no context upload; fetch large files in a RUN step)`
            );
          }
          const b64 = bytesToBase64(f.data);
          const dir = f.path.slice(0, f.path.lastIndexOf("/")) || "/";
          if (b64.length === 0) {
            steps.push({ run: `mkdir -p ${q(dir)} && : > ${q(f.path)}` });
          }
          for (let off = 0; off < b64.length; off += COPY_CHUNK) {
            const chunk = b64.slice(off, off + COPY_CHUNK);
            const redirect = off === 0 ? ">" : ">>";
            const mk = off === 0 ? `mkdir -p ${q(dir)} && ` : "";
            steps.push({
              run: `${mk}printf '%s' ${q(chunk)} | base64 -d ${redirect} ${q(f.path)}`,
            });
          }
          if (res.chmod) {
            steps.push({ run: `chmod ${q(res.chmod)} ${q(f.path)}` });
          }
          if (res.chown) {
            steps.push({ run: `chown ${q(res.chown)} ${q(f.path)}` });
          }
        }
        break;
      }
      case "CMD": {
        cmd = shellForm(text);
        break;
      }
      case "ENTRYPOINT": {
        entrypoint = shellForm(text);
        break;
      }
      default: {
        ignored.push(ins.op);
        break;
      }
    }
  }
  if (!from) {
    throw new SandboxError("Validation", "Dockerfile has no FROM", {
      provider: NAME,
    });
  }
  const start =
    entrypoint && cmd ? `${entrypoint} ${cmd}` : (entrypoint ?? cmd);
  return {
    from,
    ignored,
    steps,
    ...(start ? { startCmd: start } : {}),
  };
}

async function toBuildSpec(
  spec: TemplateSpec,
  onEvent: (e: TemplateBuildEvent) => void
): Promise<SuperserveBuildSpec> {
  const src = spec.source;
  let out: SuperserveBuildSpec;
  if ("image" in src && src.image !== undefined) {
    if (src.registryAuth) {
      throw new NotSupportedError(
        NAME,
        "templates.build({ image, registryAuth }) (private registries)"
      );
    }
    out = { from: src.image, steps: [] };
  } else if ("dockerfile" in src && src.dockerfile !== undefined) {
    const ctx = await loadTemplateContext(src.context);
    const { ignored, ...rest } = dockerfileToBuildSpec(src.dockerfile, ctx);
    for (const op of new Set(ignored)) {
      onEvent({ line: `ignored Dockerfile instruction: ${op}`, type: "log" });
    }
    out = rest;
  } else {
    throw new NotSupportedError(
      NAME,
      "templates.build({ snapshot }) (boot from it with create({ fromSnapshot }))"
    );
  }
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    out.steps.push({ env: { key, value } });
  }
  if (spec.workdir) {
    out.steps.push({ workdir: spec.workdir });
  }
  if (spec.user) {
    out.steps.push({ user: { name: spec.user } });
  }
  if (spec.startCmd) {
    out.startCmd = spec.startCmd;
  }
  if (spec.readyCmd) {
    out.readyCmd = spec.readyCmd;
  }
  return out;
}

/** Template name carrying the cache key, so `lookup(cacheKey)` finds it. */
export function superserveTemplateName(name: string, cacheKey: string): string {
  if (name === defaultTemplateName(cacheKey)) {
    return name;
  }
  const clean = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${clean || "sbox"}-${cacheKey.slice(0, 12)}`;
}

function toTemplateRef(
  t: Pick<TemplateInfo, "id" | "name" | "createdAt">,
  cacheKey: string | undefined,
  raw: unknown
): TemplateRef {
  return {
    createdAt: t.createdAt,
    id: t.id,
    name: t.name,
    provider: NAME,
    raw,
    ...(cacheKey ? { cacheKey } : {}),
  };
}

// --------------------------------------------------------------------------
// provider
// --------------------------------------------------------------------------

async function toFileInput(
  body: FileBody
): Promise<string | Uint8Array | Blob> {
  if (typeof body === "string" || body instanceof Uint8Array) {
    return body;
  }
  return new Response(body).blob();
}

export function superserve(
  opts: SuperserveOptions = {}
): SandboxProvider<SuperserveCaps, SsSandbox> {
  const conn: ConnectionOptions = {
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
  };
  const tokenTtl = opts.previewTokenTtlSeconds ?? 86_400;

  const makeHandle = (sb: SsSandbox): DriverHandle<SsSandbox> => {
    const procs = new Map<string, { kill: (s?: string) => Promise<void> }>();
    let counter = 0;

    /** One command over a WebSocket session. */
    const start = (
      cmd: string,
      o: ExecOptions,
      ctx: CallContext,
      interactive: boolean
    ): DriverExec & { id: string; started: Promise<CommandSession> } => {
      const id = `ss-${++counter}`;
      const queue = new AsyncQueue<OutputEvent>();
      const began = Date.now();
      let killed = false;
      let settled = false;
      let streamedOut = 0;
      let streamedErr = 0;
      const started = sb.commands.spawn(cmd, {
        ...(o.cwd ? { cwd: o.cwd } : {}),
        ...(o.env ? { env: o.env } : {}),
        ...(o.user ? { user: o.user } : {}),
        ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
        onStderr: (data) => {
          streamedErr += data.length;
          queue.push({ data, type: "stderr" });
        },
        onStdout: (data) => {
          streamedOut += data.length;
          queue.push({ data, type: "stdout" });
        },
        ...((o.signal ?? ctx.signal) ? { signal: o.signal ?? ctx.signal } : {}),
      });
      const finish = (r: CommandResult): void => {
        // Lifecycle error text is appended to the result, not streamed.
        if (r.stdout.length > streamedOut) {
          queue.push({ data: r.stdout.slice(streamedOut), type: "stdout" });
        }
        if (r.stderr.length > streamedErr) {
          queue.push({ data: r.stderr.slice(streamedErr), type: "stderr" });
        }
        if (
          !killed &&
          o.timeoutMs &&
          r.exitCode === 124 &&
          Date.now() - began >= o.timeoutMs - 50
        ) {
          queue.fail(
            new SandboxError(
              "Timeout",
              `command timed out after ${o.timeoutMs}ms`,
              { provider: NAME, timedOut: true }
            )
          );
          return;
        }
        queue.push({ exitCode: r.exitCode, type: "exit" });
        queue.close();
      };
      void (async () => {
        let session: CommandSession;
        try {
          session = await started;
        } catch (error) {
          settled = true;
          queue.fail(wrap(error));
          return;
        }
        if (!interactive) {
          // One-shot commands get EOF on stdin, like `commands.run()`.
          session.stdin.close();
        }
        let result: CommandResult | undefined;
        let failure: unknown;
        try {
          result = await session.wait();
        } catch (error) {
          failure = error;
        }
        settled = true;
        procs.delete(id);
        if (result) {
          finish(result);
        } else if (killed) {
          queue.push({ exitCode: 137, signal: "SIGKILL", type: "exit" });
          queue.close();
        } else {
          queue.fail(wrap(failure));
        }
      })();
      const kill = async (signal?: string): Promise<void> => {
        killed = true;
        const session = await started.catch(() => undefined);
        if (!session || settled) {
          return;
        }
        session.kill(normalizeSignal(signal));
        // If the process ignores the signal, drop the socket: the sandbox
        // stops a session's process when its connection closes.
        const t = setTimeout(() => {
          if (!settled) {
            void session.close();
          }
        }, 3000);
        (t as { unref?: () => void }).unref?.();
      };
      return {
        [Symbol.asyncIterator]: () => queue.iterator(),
        id,
        kill,
        pid: started.then(
          () => id,
          () => ""
        ),
        started,
      };
    };

    const toPreview = async (
      port: number,
      access: PreviewAccessPolicy
    ): Promise<Preview> => {
      const url = sb.getPreviewUrl(port);
      if (access === "public") {
        return { auth: { type: "public" }, port, url };
      }
      const tok = await sb.getPreviewToken(port, {
        expiresInSeconds: tokenTtl,
      });
      return {
        auth: { param: tok.queryParam, token: tok.token, type: "query" },
        port,
        url,
        ...(tok.expiresAt ? { expiresAt: tok.expiresAt } : {}),
      };
    };

    const toSnapRef = (s: SnapshotInfo, raw: unknown): SnapshotRef => ({
      createdAt: s.createdAt,
      id: s.id,
      includesMemory: s.kind === "mem+fs",
      provider: NAME,
      raw,
      ...(s.name ? { name: s.name } : {}),
    });

    const handle: DriverHandle<SsSandbox> = {
      async deleteSnapshot(ref) {
        const sdk = await loadSdk();
        await sdk.Snapshot.deleteById(ref, conn);
      },
      async destroy(ctx) {
        for (const p of procs.values()) {
          await p.kill().catch(() => {});
        }
        await sb.kill(ctx.signal ? { signal: ctx.signal } : {});
      },
      exec(cmd, o, ctx) {
        return start(cmd, o, ctx, false);
      },
      async exposePort(port, o) {
        const published = await sb.publishPreviewPort(port, {
          access: o.private ? "private" : "public",
        });
        return toPreview(port, published.access);
      },
      async fork(count) {
        const sdk = await loadSdk();
        const info = await sb.getInfo();
        const snap = await sb.snapshot({
          name: `sbox-fork-${Date.now().toString(36)}`,
        });
        try {
          const results = await Promise.allSettled(
            Array.from({ length: count }, (_, i) =>
              sdk.Sandbox.create({
                ...conn,
                fromSnapshot: snap.id,
                metadata: stripInternal(info.metadata ?? {}),
                name: `${sb.name}-fork-${i + 1}`,
              })
            )
          );
          const failed = results.find((r) => r.status === "rejected");
          if (failed) {
            for (const r of results) {
              if (r.status === "fulfilled") {
                await r.value.kill().catch(() => {});
              }
            }
            throw (failed as PromiseRejectedResult).reason;
          }
          return results.map((r) =>
            makeHandle((r as PromiseFulfilledResult<SsSandbox>).value)
          );
        } finally {
          // Sandboxes created from a snapshot don't depend on it.
          await snap.delete().catch(() => {});
        }
      },
      async getInfo() {
        return toInfo(await sb.getInfo());
      },
      id: sb.id,
      async killProcess(processId, signal) {
        const p = procs.get(processId);
        if (!p) {
          throw new SandboxError(
            "NotFound",
            `no process ${processId} on this handle (process ids are scoped to the handle that spawned them)`,
            { provider: NAME }
          );
        }
        await p.kill(signal);
      },
      async listPorts() {
        const { ports } = await sb.listPreviewPorts();
        return Promise.all(ports.map((p) => toPreview(p.port, p.access)));
      },
      async listSnapshots() {
        const list = await sb.snapshots();
        return list.map((s) => toSnapRef(s, s));
      },
      name: sb.name,
      async pause() {
        await sb.pause({ wait: true });
      },
      raw: sb,
      readFile(path, ctx) {
        return sb.files.read(path, ctx.signal ? { signal: ctx.signal } : {});
      },
      async resume() {
        await sb.resume();
      },
      async setEgressPolicy(policy) {
        await sb.update({ network: toNetworkConfig(policy) });
      },
      async setTimeout(ttlMs) {
        await sb.update({
          timeoutSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
        });
      },
      async snapshot(o) {
        const snap = await sb.snapshot(o.name ? { name: o.name } : {});
        return toSnapRef(snap, snap);
      },
      async spawn(cmd, o, ctx): Promise<DriverProcess> {
        const ex = start(cmd, o, ctx, true);
        const session = await ex.started;
        procs.set(ex.id, { kill: ex.kill });
        return {
          [Symbol.asyncIterator]: ex[Symbol.asyncIterator],
          id: ex.id,
          kill: ex.kill,
          pid: ex.pid,
          async closeStdin() {
            session.stdin.close();
          },
          async writeStdin(data) {
            session.stdin.write(data);
          },
        };
      },
      async unexposePort(port) {
        await sb.unpublishPreviewPort(port);
      },
      async upload(path, body, ctx) {
        await sb.files.write(
          path,
          await toFileInput(body),
          ctx.signal ? { signal: ctx.signal } : {}
        );
      },
      async writeFile(path, data, ctx) {
        await sb.files.write(
          path,
          data,
          ctx.signal ? { signal: ctx.signal } : {}
        );
      },
    };
    return handle;
  };

  const findByIdem = async (
    sdk: Mod,
    idem: string,
    signal?: AbortSignal
  ): Promise<SsSandboxInfo | undefined> => {
    const rows = await sdk.Sandbox.list({
      ...conn,
      limit: 5,
      metadata: { [IDEM_KEY]: idem },
      ...(signal ? { signal } : {}),
    });
    return rows.find((r) => r.status !== "deleted" && r.status !== "failed");
  };

  const templates: DriverTemplates = {
    async build(spec, { onEvent, signal }) {
      const sdk = await loadSdk();
      if (spec.resources?.gpu || spec.resources?.gpuCount) {
        throw new NotSupportedError(NAME, "GPU templates");
      }
      const name = superserveTemplateName(spec.name, spec.cacheKey);
      const existing = await sdk.Template.connect(name, conn).catch(
        (error: unknown) => {
          if (isNotFound(error)) {
            return undefined;
          }
          throw error;
        }
      );
      if (existing?.status === "ready") {
        return toTemplateRef(existing, spec.cacheKey, existing);
      }
      if (existing?.status === "failed") {
        await sdk.Template.deleteById(existing.id, conn);
      }
      const onLog = (ev: { text: string; stream: string }) => {
        const line = ev.text.replace(/\r?\n$/, "");
        if (line) {
          onEvent({
            line,
            type: "log",
            ...(ev.stream === "stdout" || ev.stream === "stderr"
              ? { stream: ev.stream }
              : {}),
          });
        }
      };
      if (existing && existing.status !== "failed") {
        onEvent({ status: "building", type: "status" });
        const info = await existing.waitUntilReady({
          onLog,
          ...(signal ? { signal } : {}),
        });
        return toTemplateRef(info, spec.cacheKey, info);
      }
      const bs = await toBuildSpec(spec, onEvent);
      const r = spec.resources;
      onEvent({ status: "building", type: "status" });
      const tpl = await sdk.Template.create({
        ...conn,
        from: bs.from,
        name,
        steps: bs.steps,
        ...(bs.startCmd ? { startCmd: bs.startCmd } : {}),
        ...(bs.readyCmd ? { readyCmd: bs.readyCmd } : {}),
        ...(r?.vcpus ? { vcpu: r.vcpus } : {}),
        ...(r?.memoryMB ? { memoryMib: r.memoryMB } : {}),
        ...(r?.diskMB ? { diskMib: r.diskMB } : {}),
        ...(signal ? { signal } : {}),
      });
      const info = await tpl.waitUntilReady({
        onLog,
        ...(signal ? { signal } : {}),
      });
      return toTemplateRef(info, spec.cacheKey, info);
    },
    async delete(id) {
      const sdk = await loadSdk();
      await sdk.Template.deleteById(id, conn);
    },
    async *list() {
      const sdk = await loadSdk();
      for (const t of await sdk.Template.list(conn)) {
        if (!t.name.startsWith("superserve/")) {
          yield toTemplateRef(t, undefined, t);
        }
      }
    },
    async lookup(idOrKey) {
      const sdk = await loadSdk();
      const isKey = /^[0-9a-f]{64}$/.test(idOrKey);
      if (!isKey) {
        try {
          const t = await sdk.Template.connect(idOrKey, conn);
          return t.status === "failed"
            ? undefined
            : toTemplateRef(t, undefined, t);
        } catch (error) {
          if (!isNotFound(error)) {
            throw error;
          }
        }
      }
      const tag = isKey ? idOrKey.slice(0, 12) : undefined;
      const exact = isKey ? defaultTemplateName(idOrKey) : undefined;
      const prefix = isKey
        ? undefined
        : `${superserveTemplateName(idOrKey, "0".repeat(64)).slice(0, -12)}`;
      const all = await sdk.Template.list(conn);
      const hit = all
        .filter((t) => t.status !== "failed")
        .filter((t) =>
          isKey
            ? t.name === exact || t.name.endsWith(`-${tag}`)
            : t.name.startsWith(prefix!) &&
              /^[0-9a-f]{12}$/.test(t.name.slice(prefix!.length))
        )
        .toSorted((a, b) => {
          const ready =
            Number(b.status === "ready") - Number(a.status === "ready");
          return ready || b.createdAt.getTime() - a.createdAt.getTime();
        })[0];
      if (!hit) {
        return undefined;
      }
      if (hit.status !== "ready") {
        const t = await sdk.Template.connect(hit.id, conn);
        const info = await t.waitUntilReady();
        return toTemplateRef(info, isKey ? idOrKey : undefined, info);
      }
      return toTemplateRef(hit, isKey ? idOrKey : undefined, hit);
    },
  };

  const toVolume = (v: SsVolumeInfo): VolumeInfo => ({
    createdAt: v.createdAt,
    id: v.id,
    name: v.name,
    raw: v,
    region: v.region,
    sizeMB: Math.round(v.capacityBytes / 1_048_576),
  });

  const volumes: DriverVolumes = {
    async create(spec, ctx) {
      if (spec.region) {
        throw new NotSupportedError(
          NAME,
          "volume region (volumes live in the API key's region)"
        );
      }
      const sdk = await loadSdk();
      const v = await sdk.Volume.create({
        ...conn,
        name: spec.name,
        ...(spec.sizeMB ? { capacityBytes: spec.sizeMB * 1_048_576 } : {}),
        ...(ctx.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return toVolume(v);
    },
    async delete(id) {
      const sdk = await loadSdk();
      await sdk.Volume.deleteById(id, conn);
    },
    async get(idOrName) {
      const sdk = await loadSdk();
      try {
        return toVolume(await sdk.Volume.connect(idOrName, conn));
      } catch (error) {
        if (isNotFound(error)) {
          return undefined;
        }
        throw error;
      }
    },
    async *list() {
      const sdk = await loadSdk();
      for (const v of await sdk.Volume.list(conn)) {
        yield toVolume(v);
      }
    },
  };

  const provider: SandboxProvider<SuperserveCaps, SsSandbox> = {
    capabilities: SUPERSERVE_CAPS,
    async connect(id, ctx) {
      const sdk = await loadSdk();
      // `connect` activates: a paused sandbox is resumed with a fresh token.
      return makeHandle(
        await sdk.Sandbox.connect(id, {
          ...conn,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
      );
    },
    async create(spec: ResolvedSandboxSpec, ctx) {
      if (spec.region) {
        throw new NotSupportedError(
          NAME,
          "region (Superserve picks the region from the API key)"
        );
      }
      if (
        spec.resources &&
        Object.values(spec.resources).some((v) => v !== undefined)
      ) {
        throw new NotSupportedError(
          NAME,
          "resources at create (sandboxes inherit vCPU/memory/disk from their template; pass resources to templates.build())"
        );
      }
      if (spec.template && spec.fromSnapshot) {
        throw new SandboxError(
          "Validation",
          "template and fromSnapshot are mutually exclusive",
          { provider: NAME }
        );
      }
      const network = spec.network ? toNetworkConfig(spec.network) : undefined;
      const { bindings, envVars } = mapSecrets(spec.secrets);
      const sdk = await loadSdk();
      const idem = ctx.idempotencyKey
        ? (await sha256Hex(ctx.idempotencyKey)).slice(0, 32)
        : undefined;
      if (idem && ctx.attempt > 1) {
        const existing = await findByIdem(sdk, idem, ctx.signal);
        if (existing) {
          return makeHandle(await sdk.Sandbox.connect(existing.id, conn));
        }
      }
      const env = { ...spec.env, ...envVars };
      const createOpts: SandboxCreateOptions = {
        ...conn,
        metadata: { ...spec.metadata, ...(idem ? { [IDEM_KEY]: idem } : {}) },
        name: spec.name ?? `sbox-${globalThis.crypto.randomUUID().slice(0, 8)}`,
        ...(Object.keys(env).length > 0 ? { envVars: env } : {}),
        ...(Object.keys(bindings).length > 0 ? { secrets: bindings } : {}),
        ...(network ? { network } : {}),
        ...(spec.template ? { fromTemplate: spec.template } : {}),
        ...(spec.fromSnapshot ? { fromSnapshot: spec.fromSnapshot } : {}),
        ...(spec.volumes?.length
          ? {
              volumes: spec.volumes.map((v) => ({
                mountPath: v.mountPath,
                volume: v.id,
                ...(v.readOnly === undefined ? {} : { readOnly: v.readOnly }),
              })),
            }
          : {}),
        ...lifecycleOptions(spec.lifecycle),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      };
      const sb = await sdk.Sandbox.create(createOpts);
      try {
        for (const port of spec.ports ?? []) {
          await sb.publishPreviewPort(port, { access: "public" });
        }
      } catch (error) {
        await sb.kill().catch(() => {});
        throw error;
      }
      return makeHandle(sb);
    },
    flags: SUPERSERVE_FLAGS,
    async *list(filter: ListFilter | undefined, ctx) {
      const sdk = await loadSdk();
      const statuses = filter?.state ? STATE_FILTER[filter.state] : undefined;
      if (filter?.state && !statuses) {
        return;
      }
      const pageSize = 100;
      let offset = 0;
      let yielded = 0;
      for (;;) {
        const page = await sdk.Sandbox.list({
          ...conn,
          limit: pageSize,
          offset,
          ...(filter?.metadata ? { metadata: filter.metadata } : {}),
          ...(statuses ? { status: statuses } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        for (const row of page) {
          const info = toInfo(row);
          if (filter?.state && info.state !== filter.state) {
            continue;
          }
          if (
            filter?.metadata &&
            !Object.entries(filter.metadata).every(
              ([k, v]) => row.metadata?.[k] === v
            )
          ) {
            continue;
          }
          if (filter?.limit !== undefined && yielded >= filter.limit) {
            return;
          }
          yielded++;
          yield info;
        }
        if (page.length < pageSize) {
          return;
        }
        offset += page.length;
      }
    },
    mapError: mapSuperserveError,
    name: NAME,
    templates,
    async verify(ctx) {
      const sdk = await loadSdk();
      await sdk.Sandbox.list({
        ...conn,
        limit: 1,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return {};
    },
    volumes,
  };
  return provider;
}
