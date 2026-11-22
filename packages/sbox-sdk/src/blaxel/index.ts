/**
 * `sbox-sdk/blaxel` — adapter for Blaxel (`@blaxel/core` >= 0.3, `SandboxInstance`).
 *
 * Blaxel sandboxes are "perpetual": an idle sandbox drops into standby on its
 * own and resumes (memory, processes and files intact) on the next request,
 * so there is no explicit pause. `stop()` archives the sandbox (filesystem
 * kept in cold storage, memory dropped); `connect()` unarchives it again.
 * `destroy()` deletes it.
 *
 * - exec is `process.exec` with native `env` / `workingDir` / `timeout`,
 *   streamed through `onStdout` / `onStderr` (stdout and stderr separate) and
 *   killed by process name. Background processes follow `streamLogs`.
 * - files use the binary-safe `fs.readBinary` / `fs.writeBinary` plus native
 *   `ls` / `mkdir` / `rm` / `watch`.
 * - previews are public or private; private previews mint a token that works
 *   as the `bl_preview_token` query parameter (browser-safe).
 * - snapshots capture memory + processes; `fork()` copies live state.
 * - templates build with `ImageInstance` in your workspace (registry image,
 *   or a Dockerfile translated into builder calls).
 *
 * Requires the optional peer dependency `@blaxel/core`.
 */
import type {
  EnvVar,
  SandboxCreateConfiguration,
  SandboxInstance,
} from "@blaxel/core";

import {
  AsyncQueue,
  defaultTemplateName,
  defineProvider,
  loadTemplateContext,
  parseDockerfile,
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
  DriverTemplates,
  DriverVolumes,
  EgressPolicy,
  ExecOptions,
  FileBody,
  FileInfo,
  FsEvent,
  ListFilter,
  OutputEvent,
  Preview,
  ProcessInfo,
  ResolvedSandboxSpec,
  SandboxInfo,
  SandboxProvider,
  SandboxState,
  SecretRef,
  SnapshotRef,
  TemplateRef,
  VolumeInfo,
} from "../adapter/index.js";

type Mod = typeof import("@blaxel/core");
type SandboxModel = Awaited<ReturnType<typeof SandboxInstance.delete>>;
type SandboxNetworkConfig = NonNullable<SandboxCreateConfiguration["network"]>;
type SandboxLifecycleConfig = NonNullable<
  SandboxCreateConfiguration["lifecycle"]
>;
type ProxyRoute = NonNullable<
  NonNullable<SandboxNetworkConfig["proxy"]>["routing"]
>[number];
type BlaxelSnapshot = Awaited<
  ReturnType<SandboxInstance["snapshots"]["create"]>
>;
type BlaxelVolume = Awaited<ReturnType<Mod["VolumeInstance"]["get"]>>;
type ImageBuilder = ReturnType<Mod["ImageInstance"]["fromRegistry"]>;
type ImageBuildOptions = Parameters<ImageBuilder["build"]>[0];

export interface BlaxelOptions {
  /** Blaxel API key. Falls back to `BL_API_KEY` / the Blaxel CLI login. */
  apiKey?: string;
  /** Blaxel workspace. Falls back to `BL_WORKSPACE` / the Blaxel CLI login. */
  workspace?: string;
  /** Default image when a spec has no `template`. Default `blaxel/base-image:latest`. */
  image?: string;
  /** Default memory (MB) for new sandboxes. CPU scales with memory (2048 MB per vCPU). */
  memory?: number;
  /** Default region, e.g. `us-pdx-1`. Falls back to `BL_REGION`. */
  region?: string;
  /** Lifetime of tokens minted for private previews. Default 24 h. */
  previewTokenTtlMs?: number;
  /**
   * Turn on the `proxy` firewall ruleset when a create-time egress policy
   * restricts traffic, so tools that ignore `HTTP(S)_PROXY` are filtered too.
   * Rulesets can only be set at creation. Default true.
   */
  egressFirewall?: boolean;
}

export const BLAXEL_CAPS = {
  background: "native",
  codeInterpreter: "unsupported",
  egressControl: "native",
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "native",
  fork: "native",
  gpu: "unsupported",
  killProcess: "native",
  list: "native",
  metrics: "unsupported",
  pause: "unsupported",
  privatePreview: "native",
  proxiedFetch: "native",
  pty: "unsupported",
  region: "native",
  secretsVault: "unsupported",
  setTimeout: "native",
  snapshot: "native",
  ssh: "unsupported",
  statefulKernel: "unsupported",
  stdin: "native",
  stop: "native",
  streaming: "native",
  templateBuild: "native",
  volumes: "native",
} as const satisfies CapabilityMap;

export type BlaxelCaps = typeof BLAXEL_CAPS;
export type BlaxelRaw = SandboxInstance;

const BLAXEL_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true, // process.exec takes { env, workingDir }
  preservesDiskOnStop: true, // archive keeps the filesystem
  preservesMemoryOnPause: true, // automatic standby keeps memory + processes
  previewBrowserAuth: true, // bl_preview_token query parameter
  previewModel: "subdomain",
  templateSources: ["dockerfile", "image"],
};

const PROVIDER = "blaxel";
const DEFAULT_IMAGE = "blaxel/base-image:latest";
const PREVIEW_TOKEN_PARAM = "bl_preview_token";
const TEMPLATE_KEY_LABEL = "sbox-template-cache-key";
const TEMPLATE_AUTO_LABEL = "x-blaxel-auto-generated";
const MAX_NAME = 49;

// ---------------------------------------------------------------------------
// pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Every Blaxel deployment status (plus the RUNNING/STANDBY runtime state) → SandboxState. */
export function mapBlaxelState(status: string | undefined): SandboxState {
  switch ((status ?? "").toUpperCase()) {
    // Standby is transparent (any request resumes it), so DEPLOYED is running.
    case "DEPLOYED": {
      return "running";
    }
    case "UPLOADING":
    case "BUILDING":
    case "BUILT":
    case "DEPLOYING":
    case "UNARCHIVING": {
      return "creating";
    }
    case "ARCHIVING":
    case "DEACTIVATING": {
      return "suspending";
    }
    case "ARCHIVED": {
      return "archived";
    }
    case "DEACTIVATED": {
      return "stopped";
    }
    case "DELETING":
    case "TERMINATED": {
      return "destroyed";
    }
    case "FAILED": {
      return "error";
    }
    default: {
      return "unknown";
    }
  }
}

/** Blaxel duration string, rounded up to whole seconds and clamped to `minSec`. */
export function blaxelDuration(ms: number, minSec = 0): string {
  return `${Math.max(minSec, Math.ceil(ms / 1000))}s`;
}

function errorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const e = err as Record<string, unknown>;
  const pick = (v: unknown): number | undefined =>
    typeof v === "number" && v >= 100 && v < 600 ? v : undefined;
  const nested = (v: unknown, k: string): unknown =>
    v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
  return (
    pick(e.status) ??
    pick(e.statusCode) ??
    pick(e.status_code) ??
    pick(e.code) ??
    pick(nested(e.error, "status")) ??
    pick(nested(e.response, "status")) ??
    pick(nested(e.data, "status_code")) ??
    pick(nested(e.data, "code")) ??
    pick(nested(nested(e.data, "error"), "status"))
  );
}

function errorCodeString(err: unknown): string {
  if (!err || typeof err !== "object") {
    return "";
  }
  const e = err as Record<string, unknown>;
  const nested = (v: unknown, k: string): unknown =>
    v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
  for (const v of [
    e.code,
    nested(e.error, "code"),
    nested(e.data, "code"),
    nested(nested(e.data, "error"), "code"),
  ]) {
    if (typeof v === "string") {
      return v.toUpperCase();
    }
  }
  return "";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.message === "string") {
      return e.message;
    }
    if (typeof e.error === "string") {
      return e.error;
    }
    const inner = e.error as Record<string, unknown> | undefined;
    if (inner && typeof inner.message === "string") {
      return inner.message;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/** Normalize Blaxel SDK / API errors into the sbox taxonomy. */
export function mapBlaxelError(err: unknown): SandboxError | undefined {
  if (err instanceof SandboxError) {
    return err;
  }
  const status = errorStatus(err);
  const code = errorCodeString(err);
  const message = errorMessage(err);
  const init = { cause: err, provider: PROVIDER, status };
  const name = err instanceof Error ? err.name : "";
  if (
    status === 401 ||
    status === 403 ||
    name === "CredentialsError" ||
    /^(UNAUTHORIZED|AUTHENTICATION_|TOKEN_REVOKED|FORBIDDEN|WORKSPACE_REQUIRED)/.test(
      code
    ) ||
    /unauthori[sz]ed|forbidden|invalid (api )?key|credentials/i.test(message)
  ) {
    return new SandboxError("Unauthorized", message, init);
  }
  if (
    status === 429 ||
    /QUOTA|RATE_LIMIT|USAGE_LIMIT/.test(code) ||
    /quota|rate limit|too many requests/i.test(message)
  ) {
    return new SandboxError("QuotaExceeded", message, {
      ...init,
      retryable: true,
    });
  }
  if (
    status === 404 ||
    code.endsWith("NOT_FOUND") ||
    /not found|no such file|does not exist/i.test(message)
  ) {
    return new SandboxError("NotFound", message, init);
  }
  if (
    status === 409 ||
    code === "SANDBOX_ALREADY_EXISTS" ||
    /already exists/i.test(message)
  ) {
    return new SandboxError("Conflict", message, init);
  }
  if (
    status === 408 ||
    status === 504 ||
    /TIMEOUT/.test(code) ||
    /timed? ?out|did not finish in time/i.test(message)
  ) {
    return new SandboxError("Timeout", message, init);
  }
  if (status === 400 || status === 422) {
    return new SandboxError("Validation", message, init);
  }
  return new SandboxError("Provider", message, init);
}

function isNotFound(err: unknown): boolean {
  return mapBlaxelError(err)?.code === "NotFound";
}

function headerSecretValue(
  v: SecretRef | string,
  secrets: Record<string, string>
): string {
  if (typeof v === "string") {
    return v;
  }
  if (v.value === undefined) {
    throw new SandboxError(
      "Validation",
      `egress injection secret '${v.name}' needs an inline value (Blaxel stores proxy secrets per rule)`,
      { provider: PROVIDER }
    );
  }
  secrets[v.name] = v.value;
  return `{{SECRET:${v.name}}}`;
}

/** sbox `EgressPolicy` (+ egress-mode secrets) → Blaxel `network` config. */
export function toBlaxelNetwork(
  policy: EgressPolicy | undefined,
  opts: { firewall?: boolean; secrets?: SecretRef[] } = {}
): SandboxNetworkConfig | undefined {
  const egressSecrets = (opts.secrets ?? []).filter((s) => s.mode === "egress");
  if (!policy && egressSecrets.length === 0) {
    return undefined;
  }
  if (policy?.cidrs?.length || policy?.deny?.cidrs?.length) {
    throw new SandboxError(
      "Validation",
      "Blaxel egress rules are domain-based; CIDR rules are not supported",
      { provider: PROVIDER }
    );
  }
  const proxy: NonNullable<SandboxNetworkConfig["proxy"]> = {};
  const mode = policy?.mode ?? "allow-all";
  if (mode === "block-all") {
    proxy.forbiddenDomains = ["*"];
  } else {
    if (mode === "allow-list") {
      proxy.allowedDomains = [...(policy?.domains ?? [])];
    }
    if (policy?.deny?.domains?.length) {
      proxy.forbiddenDomains = [...policy.deny.domains];
    }
  }
  const routing: ProxyRoute[] = [];
  for (const inj of policy?.inject ?? []) {
    const secrets: Record<string, string> = {};
    const headers: Record<string, string> = {};
    for (const [h, v] of Object.entries(inj.headers)) {
      headers[h] = headerSecretValue(v, secrets);
    }
    routing.push({
      destinations: [...inj.domains],
      headers,
      ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
    });
  }
  if (egressSecrets.length > 0 && !policy?.inject?.length) {
    throw new SandboxError(
      "Validation",
      "secrets with mode 'egress' need a matching network.inject rule",
      { provider: PROVIDER }
    );
  }
  proxy.routing = routing;
  const network: SandboxNetworkConfig = { proxy };
  if (opts.firewall && mode !== "allow-all") {
    network.firewall = { rulesets: ["proxy"] };
  }
  return network;
}

/** sbox lifecycle → Blaxel `ttl` (max age) + `ttl-idle` expiration policy. */
export function toBlaxelLifecycle(spec: ResolvedSandboxSpec): {
  ttl?: string;
  lifecycle?: SandboxLifecycleConfig;
} {
  const lc = spec.lifecycle ?? {};
  const maxAge = lc.maxAgeMs ?? spec.ttlMs;
  const onIdle = lc.onIdle ?? spec.onIdle;
  const out: { ttl?: string; lifecycle?: SandboxLifecycleConfig } = {};
  if (maxAge !== undefined) {
    out.ttl = blaxelDuration(maxAge, 300); // Blaxel minimum is 5m
  }
  // Idle sandboxes go to standby automatically (memory kept), so "pause" is
  // the platform default. Only "destroy" needs a policy; Blaxel has no
  // archive-on-idle action, so "stop" falls back to standby.
  if (
    lc.idleTimeoutMs !== undefined &&
    (onIdle === "destroy" || onIdle === undefined)
  ) {
    out.lifecycle = {
      expirationPolicies: [
        {
          action: "delete",
          type: "ttl-idle",
          value: blaxelDuration(lc.idleTimeoutMs, 60), // minimum 60s
        },
      ],
    };
  }
  return out;
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

/** Deterministic, Blaxel-valid sandbox name for an idempotency key. */
export async function nameFromIdempotencyKey(key: string): Promise<string> {
  return `sbox-${(await sha256Hex(key)).slice(0, 20)}`;
}

function shortId(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}

async function drain(body: FileBody): Promise<Uint8Array> {
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

function parentOf(path: string): string {
  const clean = path.replace(/\/+$/, "");
  const i = clean.lastIndexOf("/");
  return i <= 0 ? "/" : clean.slice(0, i);
}

function fsEventType(op: string): FsEvent["type"] {
  const first = op.split("|")[0] ?? op;
  if (first === "CREATE") {
    return "create";
  }
  if (first === "REMOVE" || first === "RENAME") {
    return "delete";
  }
  return "modify";
}

function snapshotRef(s: BlaxelSnapshot): SnapshotRef {
  return {
    createdAt: s.createdAt ? new Date(s.createdAt) : undefined,
    id: s.id,
    includesMemory: true, // Blaxel snapshots capture memory + processes
    name: s.name,
    provider: PROVIDER,
    raw: s,
  };
}

function volumeInfo(v: BlaxelVolume): VolumeInfo {
  const created = v.metadata?.createdAt;
  return {
    createdAt: created ? new Date(created) : undefined,
    id: v.name,
    name: v.displayName ?? v.name,
    raw: v,
    region: v.region,
    sizeMB: v.size,
  };
}

function infoFrom(
  model: {
    metadata: SandboxModel["metadata"];
    status?: SandboxModel["status"];
  },
  raw: unknown
): SandboxInfo {
  const created = model.metadata?.createdAt;
  return {
    createdAt: created ? new Date(created) : undefined,
    id: model.metadata.name,
    metadata: { ...model.metadata.labels },
    name: model.metadata.name,
    provider: PROVIDER,
    raw,
    state: mapBlaxelState(model.status),
  };
}

function instanceInfo(inst: SandboxInstance): SandboxInfo {
  return infoFrom({ metadata: inst.metadata, status: inst.status }, inst);
}

// ---------------------------------------------------------------------------
// Dockerfile → ImageInstance builder calls
// ---------------------------------------------------------------------------

function splitWords(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const m of s.matchAll(re)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}

function parseKeyValues(args: string): Record<string, string> {
  const words = splitWords(args);
  if (words.length >= 2 && !words[0]!.includes("=")) {
    // legacy `ENV KEY value with spaces`
    return {
      [words[0]!]: args
        .slice(args.indexOf(words[0]!) + words[0]!.length)
        .trim(),
    };
  }
  const out: Record<string, string> = {};
  for (const w of words) {
    const i = w.indexOf("=");
    if (i > 0) {
      out[w.slice(0, i)] = w.slice(i + 1);
    }
  }
  return out;
}

function execForm(args: string): string {
  const t = args.trim();
  if (t.startsWith("[")) {
    try {
      const arr = JSON.parse(t) as unknown;
      if (Array.isArray(arr)) {
        return arr.map(String).join(" ");
      }
    } catch {
      // fall through: treat as shell form
    }
  }
  return t;
}

interface DockerPlan {
  base: string;
  steps: ((img: ImageBuilder, ctxDir: string | undefined) => ImageBuilder)[];
  skipped: string[];
  needsContext: boolean;
}

/** Translate a single-stage Dockerfile into `ImageInstance` calls. */
export function planDockerfile(dockerfile: string): DockerPlan {
  const plan: DockerPlan = {
    base: "",
    needsContext: false,
    skipped: [],
    steps: [],
  };
  for (const ins of parseDockerfile(dockerfile)) {
    const { op, args } = ins;
    if (op === "FROM") {
      if (plan.base) {
        throw new SandboxError(
          "Validation",
          "multi-stage Dockerfiles are not supported by the Blaxel image builder",
          { provider: PROVIDER }
        );
      }
      plan.base = splitWords(args).find((w) => !w.startsWith("--")) ?? "";
      continue;
    }
    if (!plan.base && op !== "ARG") {
      throw new SandboxError("Validation", "Dockerfile must start with FROM", {
        provider: PROVIDER,
      });
    }
    switch (op) {
      case "RUN": {
        const cmd = execForm(args.replace(/^(--\S+\s+)+/, ""));
        plan.steps.push((img) => img.runCommands(cmd));
        break;
      }
      case "ENV": {
        const vars = parseKeyValues(args);
        plan.steps.push((img) => img.env(vars));
        break;
      }
      case "LABEL": {
        const labels = parseKeyValues(args);
        plan.steps.push((img) => img.label(labels));
        break;
      }
      case "WORKDIR": {
        plan.steps.push((img) => img.workdir(args));
        break;
      }
      case "USER": {
        plan.steps.push((img) => img.user(args));
        break;
      }
      case "EXPOSE": {
        const ports = splitWords(args)
          .map((p) => Number.parseInt(p, 10))
          .filter((n) => Number.isFinite(n));
        plan.steps.push((img) => img.expose(...ports));
        break;
      }
      case "ARG": {
        const [k, ...rest] = args.split("=");
        const key = (k ?? "").trim();
        const def = rest.length > 0 ? rest.join("=").trim() : undefined;
        plan.steps.push((img) => img.arg(key, def));
        break;
      }
      case "COPY":
      case "ADD": {
        const words = splitWords(args);
        if (words.some((w) => w.startsWith("--from"))) {
          throw new SandboxError(
            "Validation",
            "COPY --from (multi-stage) is not supported by the Blaxel image builder",
            { provider: PROVIDER }
          );
        }
        const paths = words.filter((w) => !w.startsWith("--"));
        if (paths.length < 2) {
          throw new SandboxError("Validation", `bad ${op}: ${ins.raw}`, {
            provider: PROVIDER,
          });
        }
        if (op === "ADD" && /^https?:\/\//.test(paths[0]!)) {
          throw new SandboxError("Validation", "ADD <url> is not supported", {
            provider: PROVIDER,
          });
        }
        const dest = paths.at(-1)!;
        const sources = paths.slice(0, -1);
        plan.needsContext = true;
        plan.steps.push((img, ctxDir) => {
          if (!ctxDir) {
            throw new SandboxError(
              "Validation",
              `${op} needs a build context`,
              {
                provider: PROVIDER,
              }
            );
          }
          return copyFromContext(img, ctxDir, sources, dest);
        });
        break;
      }
      default: {
        // CMD/ENTRYPOINT would replace Blaxel's sandbox-api entrypoint (the
        // sandbox would stop answering); metadata-only ops have no effect.
        plan.skipped.push(ins.raw);
      }
    }
  }
  if (!plan.base) {
    throw new SandboxError("Validation", "Dockerfile has no FROM", {
      provider: PROVIDER,
    });
  }
  return plan;
}

// Node-only helpers, resolved lazily so the subpath stays portable.
let nodeFs: typeof import("node:fs") | undefined;
let nodePath: typeof import("node:path") | undefined;

function copyFromContext(
  img: ImageBuilder,
  ctxDir: string,
  sources: string[],
  dest: string
): ImageBuilder {
  const fs = nodeFs!;
  const path = nodePath!;
  let out = img;
  for (const src of sources) {
    const rel = src.replace(/^\.\/?/, "");
    const abs = path.join(ctxDir, rel);
    const contextName =
      rel === "" ? "sbox-context" : `ctx-${rel.replaceAll(/[^\w.-]/g, "_")}`;
    const target =
      sources.length > 1 || dest.endsWith("/")
        ? joinPath(dest, path.basename(abs))
        : dest;
    out = fs.statSync(abs).isDirectory()
      ? out.addLocalDir(abs, rel === "" ? dest : target, contextName)
      : out.addLocalFile(abs, target, contextName);
  }
  return out;
}

function dockerConfigFor(
  image: string,
  auth: { username: string; password: string }
): Record<string, unknown> {
  const first = image.split("/")[0] ?? "";
  const host =
    image.includes("/") && (first.includes(".") || first.includes(":"))
      ? first
      : "https://index.docker.io/v1/";
  return {
    auths: { [host]: { auth: btoa(`${auth.username}:${auth.password}`) } },
  };
}

// ---------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------

/**
 * Blaxel provider. `initialize()` configures the Blaxel SDK process-wide, so
 * two `blaxel()` providers with different credentials in one process share the
 * last one configured.
 */
export const blaxel = defineProvider<BlaxelCaps, BlaxelRaw, BlaxelOptions>(
  (opts = {}) => {
    let modPromise: Promise<Mod> | undefined;
    const load = (): Promise<Mod> => {
      modPromise ??= import("@blaxel/core").then((mod) => {
        if (opts.apiKey || opts.workspace) {
          mod.initialize({
            ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
            ...(opts.workspace ? { workspace: opts.workspace } : {}),
          });
        }
        return mod;
      });
      return modPromise;
    };
    const tokenTtl = opts.previewTokenTtlMs ?? 24 * 60 * 60 * 1000;

    const makeHandle = (
      mod: Mod,
      inst: SandboxInstance
    ): DriverHandle<SandboxInstance> => {
      const name = inst.metadata.name;
      const procs = new Set<string>();

      const followProcess = (
        procName: string,
        queue: AsyncQueue<OutputEvent>,
        killed: { value: boolean }
      ): void => {
        const stream = inst.process.streamLogs(procName, {
          onError: (e) => queue.fail(mapBlaxelError(e)),
          onStderr: (d) => queue.push({ data: d, type: "stderr" }),
          onStdout: (d) => queue.push({ data: d, type: "stdout" }),
        });
        void stream
          .wait()
          .then(() => inst.process.wait(procName, { maxWait: -1 }))
          .then((p) => {
            procs.delete(procName);
            queue.push({ exitCode: exitCodeOf(p, killed.value), type: "exit" });
            queue.close();
          })
          .catch((error) => queue.fail(mapBlaxelError(error)));
      };

      const exec = (cmd: string, eopts: ExecOptions): DriverExec => {
        const queue = new AsyncQueue<OutputEvent>();
        const procName = `sbox-${Date.now().toString(36)}-${shortId()}`;
        const killed = { value: false };
        const started = Date.now();
        procs.add(procName);
        void inst.process
          .exec({
            command: cmd,
            name: procName,
            onStderr: (d) => queue.push({ data: d, type: "stderr" }),
            onStdout: (d) => queue.push({ data: d, type: "stdout" }),
            waitForCompletion: true,
            ...(eopts.cwd ? { workingDir: eopts.cwd } : {}),
            ...(eopts.env && Object.keys(eopts.env).length > 0
              ? { env: eopts.env }
              : {}),
            ...(eopts.timeoutMs
              ? { timeout: Math.max(1, Math.ceil(eopts.timeoutMs / 1000)) }
              : {}),
          })
          .then((r) => {
            procs.delete(procName);
            if (
              !killed.value &&
              eopts.timeoutMs !== undefined &&
              r.status === "killed" &&
              Date.now() - started >= eopts.timeoutMs
            ) {
              queue.fail(
                new SandboxError(
                  "Timeout",
                  `command timed out after ${eopts.timeoutMs}ms`,
                  { provider: PROVIDER, timedOut: true }
                )
              );
              return;
            }
            queue.push({ exitCode: exitCodeOf(r, killed.value), type: "exit" });
            queue.close();
          })
          .catch((error) => {
            procs.delete(procName);
            queue.fail(mapBlaxelError(error));
          });
        return {
          [Symbol.asyncIterator]: () => queue.iterator(),
          async kill() {
            killed.value = true;
            await inst.process.kill(procName).catch((error) => {
              if (!isNotFound(error)) {
                throw error;
              }
            });
          },
          pid: Promise.resolve(procName),
        };
      };

      const handle: DriverHandle<SandboxInstance> = {
        async connectProcess(processId: string): Promise<DriverProcess> {
          await inst.process.get(processId); // 404 → NotFound
          const queue = new AsyncQueue<OutputEvent>();
          const killed = { value: false };
          followProcess(processId, queue, killed);
          return {
            [Symbol.asyncIterator]: () => queue.iterator(),
            id: processId,
            async kill() {
              killed.value = true;
              await inst.process.kill(processId);
            },
            pid: Promise.resolve(processId),
            async writeStdin(data: Uint8Array) {
              await inst.process.writeStdin(processId, data);
            },
          };
        },

        async deleteSnapshot(ref: string): Promise<void> {
          await mod.Snapshot.delete(ref);
        },

        async destroy(): Promise<void> {
          try {
            await inst.delete();
          } catch (error) {
            if (!isNotFound(error)) {
              throw error;
            }
          }
        },

        exec,

        async exposePort(
          port: number,
          popts: { private?: boolean }
        ): Promise<Preview> {
          const isPrivate = !!popts.private;
          const preview = await inst.previews.createIfNotExists({
            name: `sbox-${port}-${isPrivate ? "private" : "public"}`,
            port,
            public: !isPrivate,
          });
          if (!isPrivate) {
            return { auth: { type: "public" }, port, url: preview.url };
          }
          const expiresAt = new Date(Date.now() + tokenTtl);
          const token = await preview.tokens.create(expiresAt);
          return {
            auth: {
              param: PREVIEW_TOKEN_PARAM,
              token: token.value,
              type: "query",
            },
            expiresAt,
            port,
            url: preview.url,
          };
        },

        async fork(count: number): Promise<DriverHandle<SandboxInstance>[]> {
          const out: DriverHandle<SandboxInstance>[] = [];
          for (let i = 0; i < count; i++) {
            const target = `${name.slice(0, MAX_NAME - 9)}-f${shortId()}`;
            const res = await inst.fork(target);
            out.push(
              makeHandle(mod, await mod.SandboxInstance.get(res.name ?? target))
            );
          }
          return out;
        },

        async getInfo(): Promise<SandboxInfo> {
          try {
            return instanceInfo(await mod.SandboxInstance.get(name));
          } catch (error) {
            if (isNotFound(error)) {
              return {
                id: name,
                metadata: { ...inst.metadata.labels },
                name,
                provider: PROVIDER,
                raw: undefined,
                state: "destroyed",
              };
            }
            throw error;
          }
        },

        id: name,

        async killProcess(processId: string): Promise<void> {
          await inst.process.kill(processId);
        },

        async listDir(path: string): Promise<DirEntry[]> {
          const dir = await inst.fs.ls(path);
          return [
            ...(dir.subdirectories ?? []).map((d) => ({
              name: d.name,
              path: d.path || joinPath(path, d.name),
              type: "dir" as const,
            })),
            ...(dir.files ?? []).map((f) => ({
              name: f.name,
              path: f.path || joinPath(path, f.name),
              type: "file" as const,
            })),
          ];
        },

        async listPorts(): Promise<Preview[]> {
          const out: Preview[] = [];
          for (const p of await inst.previews.list()) {
            const port = p.spec?.port;
            if (port === undefined) {
              continue;
            }
            if (p.spec?.public) {
              out.push({ auth: { type: "public" }, port, url: p.url });
            } else {
              const token = await p.tokens.createIfExpired();
              out.push({
                auth: {
                  param: PREVIEW_TOKEN_PARAM,
                  token: token.value,
                  type: "query",
                },
                expiresAt: new Date(token.expiresAt),
                port,
                url: p.url,
              });
            }
          }
          return out;
        },

        async listProcesses(): Promise<ProcessInfo[]> {
          const list = await inst.process.list();
          return list
            .filter((p) => p.status === "running")
            .map((p) => ({ cmd: p.command, id: p.name || p.pid }));
        },

        async listSnapshots(): Promise<SnapshotRef[]> {
          return (await inst.snapshots.list()).map(snapshotRef);
        },

        async mkdir(path: string): Promise<void> {
          // Blaxel always creates parents; an existing directory is kept.
          await inst.fs.mkdir(path);
        },

        name,

        async proxyFetch(
          port: number,
          path: string | undefined,
          init: RequestInit | undefined
        ): Promise<Response> {
          return inst.fetch(port, path, init);
        },

        raw: inst,

        async readFile(path: string): Promise<Uint8Array> {
          const blob = await inst.fs.readBinary(path);
          return new Uint8Array(await blob.arrayBuffer());
        },

        async remove(path: string, recursive: boolean): Promise<void> {
          try {
            await inst.fs.rm(path, recursive);
          } catch (error) {
            if (!isNotFound(error)) {
              throw error;
            }
          }
        },

        async restoreSnapshot(ref: string): Promise<void> {
          await inst.snapshots.restore(ref);
        },

        async setEgressPolicy(policy: EgressPolicy): Promise<void> {
          const network = toBlaxelNetwork(policy) ?? {};
          const firewall = inst.spec?.network?.firewall;
          await mod.SandboxInstance.updateNetwork(name, {
            network: firewall ? { ...network, firewall } : network,
          });
        },

        async setTimeout(ttlMs: number): Promise<void> {
          await mod.SandboxInstance.updateTtl(name, blaxelDuration(ttlMs, 300));
        },

        async snapshot(sopts: { name?: string }): Promise<SnapshotRef> {
          return snapshotRef(await inst.snapshots.create(sopts.name));
        },

        async spawn(cmd: string, eopts: ExecOptions): Promise<DriverProcess> {
          const procName = `sbox-${Date.now().toString(36)}-${shortId()}`;
          const started = await inst.process.exec({
            command: cmd,
            name: procName,
            stdin: true,
            waitForCompletion: false,
            ...(eopts.cwd ? { workingDir: eopts.cwd } : {}),
            ...(eopts.env && Object.keys(eopts.env).length > 0
              ? { env: eopts.env }
              : {}),
            ...(eopts.timeoutMs
              ? { timeout: Math.max(1, Math.ceil(eopts.timeoutMs / 1000)) }
              : {}),
          });
          const id = started.name || procName;
          procs.add(id);
          const queue = new AsyncQueue<OutputEvent>();
          const killed = { value: false };
          followProcess(id, queue, killed);
          return {
            [Symbol.asyncIterator]: () => queue.iterator(),
            id,
            async kill() {
              killed.value = true;
              await inst.process.kill(id);
            },
            pid: Promise.resolve(id),
            async writeStdin(data: Uint8Array) {
              await inst.process.writeStdin(id, data);
            },
          };
        },

        async stat(path: string): Promise<FileInfo> {
          try {
            const dir = await inst.fs.ls(path);
            return { path: dir.path || path, size: 0, type: "dir" };
          } catch {
            // not a directory (or missing): look it up in its parent
          }
          const clean = path.replace(/\/+$/, "");
          const base = clean.slice(clean.lastIndexOf("/") + 1);
          let parent;
          try {
            parent = await inst.fs.ls(parentOf(clean));
          } catch (error) {
            throw isNotFound(error)
              ? new SandboxError("NotFound", `not found: '${path}'`, {
                  cause: error,
                  provider: PROVIDER,
                })
              : error;
          }
          const file = parent.files?.find((f) => f.name === base);
          if (!file) {
            throw new SandboxError("NotFound", `not found: '${path}'`, {
              provider: PROVIDER,
            });
          }
          return {
            mtime: file.lastModified ? new Date(file.lastModified) : undefined,
            path: file.path || clean,
            size: file.size,
            type: "file",
          };
        },

        async stop(): Promise<void> {
          await inst.archive();
        },

        async resume(): Promise<void> {
          // Brings an archived (stopped) sandbox back; a no-op when running.
          if (inst.status === "ARCHIVED" || inst.status === "ARCHIVING") {
            await inst.unarchive();
          }
        },

        async upload(path: string, data: FileBody): Promise<void> {
          await inst.fs.writeBinary(path, await drain(data));
        },

        watch(
          path: string,
          cb: (e: FsEvent) => void,
          recursive: boolean
        ): () => Promise<void> {
          const target = recursive ? `${path.replace(/\/+$/, "")}/**` : path;
          const w = inst.fs.watch(
            target,
            (ev) => {
              cb({
                path: joinPath(ev.path, ev.name),
                type: fsEventType(ev.op),
              });
            },
            { withContent: false }
          );
          return async () => {
            w.close();
          };
        },

        async writeFile(path: string, data: Uint8Array): Promise<void> {
          await inst.fs.writeBinary(path, data);
        },
      };
      return handle;
    };

    const createConfig = (
      spec: ResolvedSandboxSpec,
      name: string
    ): SandboxCreateConfiguration => {
      const envs: EnvVar[] = Object.entries(spec.env ?? {}).map(([k, v]) => ({
        name: k,
        value: v,
      }));
      const secretEnvs: EnvVar[] = [];
      for (const s of spec.secrets ?? []) {
        if (s.mode === "egress") {
          continue;
        }
        if (s.value === undefined) {
          throw new SandboxError(
            "Validation",
            `secret '${s.name}' needs an inline value: Blaxel has no named secret store for sandboxes`,
            { provider: PROVIDER }
          );
        }
        secretEnvs.push({ name: s.envVar ?? s.name, value: s.value });
      }
      const memory =
        spec.resources?.memoryMB ??
        (spec.resources?.vcpus ? spec.resources.vcpus * 2048 : undefined) ??
        opts.memory;
      const network = toBlaxelNetwork(spec.network, {
        firewall: opts.egressFirewall ?? true,
        secrets: spec.secrets,
      });
      const { ttl, lifecycle } = toBlaxelLifecycle(spec);
      const allEnvs = [...envs, ...secretEnvs];
      return {
        image: spec.template ?? opts.image ?? DEFAULT_IMAGE,
        name,
        ...(memory ? { memory } : {}),
        ...((spec.region ?? opts.region)
          ? { region: spec.region ?? opts.region }
          : {}),
        ...(allEnvs.length > 0 ? { envs: allEnvs } : {}),
        ...(spec.metadata && Object.keys(spec.metadata).length > 0
          ? { labels: { ...spec.metadata } }
          : {}),
        ...(spec.ports?.length
          ? { ports: spec.ports.map((p) => ({ protocol: "HTTP", target: p })) }
          : {}),
        ...(spec.volumes?.length
          ? {
              volumes: spec.volumes.map((v) => ({
                mountPath: v.mountPath,
                name: v.id,
                readOnly: v.readOnly ?? false,
              })),
            }
          : {}),
        ...(ttl ? { ttl } : {}),
        ...(lifecycle ? { lifecycle } : {}),
        ...(network ? { network } : {}),
      };
    };

    /** Boot from a snapshot: fork the workspace snapshot into a new sandbox. */
    const createFromSnapshot = async (
      mod: Mod,
      spec: ResolvedSandboxSpec,
      name: string
    ): Promise<SandboxInstance> => {
      const snap = await mod.Snapshot.get(spec.fromSnapshot!);
      const envs = Object.entries(spec.env ?? {}).map(([k, v]) => ({
        name: k,
        value: v,
      }));
      const res = await snap.fork(name, envs.length > 0 ? { envs } : {});
      const target = res.name ?? name;
      if (spec.metadata && Object.keys(spec.metadata).length > 0) {
        return mod.SandboxInstance.updateMetadata(target, {
          labels: { ...spec.metadata },
        });
      }
      return mod.SandboxInstance.get(target);
    };

    const templates: DriverTemplates = {
      async build(spec, bopts) {
        const mod = await load();
        let img: ImageBuilder;
        let tmpDir: string | undefined;
        let ctxDir: string | undefined;
        const source = spec.source;
        const buildOpts: ImageBuildOptions = {
          name: spec.name,
          onStatusChange: (status) =>
            bopts.onEvent({ line: status, step: "deploy", type: "log" }),
          ...(spec.resources?.memoryMB
            ? { memory: spec.resources.memoryMB }
            : {}),
        };
        try {
          if ("image" in source && source.image !== undefined) {
            img = mod.ImageInstance.fromRegistry(source.image);
            if (source.registryAuth) {
              buildOpts.dockerConfig = dockerConfigFor(
                source.image,
                source.registryAuth
              );
            }
          } else if (
            "dockerfile" in source &&
            source.dockerfile !== undefined
          ) {
            const plan = planDockerfile(source.dockerfile);
            for (const line of plan.skipped) {
              bopts.onEvent({
                line: `skipped (not supported by the Blaxel builder): ${line}`,
                stream: "stderr",
                type: "log",
              });
            }
            if (plan.needsContext) {
              nodeFs ??= await import("node:fs");
              nodePath ??= await import("node:path");
              if (typeof source.context === "string") {
                ctxDir = nodePath.resolve(source.context);
              } else {
                const os = await import("node:os");
                tmpDir = nodeFs.mkdtempSync(
                  nodePath.join(os.tmpdir(), "sbox-blaxel-")
                );
                for (const [rel, data] of await loadTemplateContext(
                  source.context
                )) {
                  const abs = nodePath.join(tmpDir, rel);
                  nodeFs.mkdirSync(nodePath.dirname(abs), { recursive: true });
                  nodeFs.writeFileSync(abs, data);
                }
                ctxDir = tmpDir;
              }
            }
            img = mod.ImageInstance.fromRegistry(plan.base);
            for (const step of plan.steps) {
              img = step(img, ctxDir);
            }
          } else {
            throw new SandboxError(
              "NotSupported",
              "Blaxel templates build from a Dockerfile or a registry image",
              { provider: PROVIDER }
            );
          }
          if (spec.env && Object.keys(spec.env).length > 0) {
            img = img.env(spec.env);
          }
          if (spec.workdir) {
            img = img.workdir(spec.workdir);
          }
          if (spec.user) {
            img = img.user(spec.user);
          }
          img = img.label({ [TEMPLATE_KEY_LABEL]: spec.cacheKey });
          bopts.onEvent({ status: "building", type: "status" });
          const built = await img.build(buildOpts);
          // Tag the backing sandbox so lookup(cacheKey) finds it again.
          try {
            await mod.SandboxInstance.updateMetadata(spec.name, {
              labels: {
                ...built.metadata?.labels,
                [TEMPLATE_KEY_LABEL]: spec.cacheKey,
              },
            });
          } catch {
            // best effort: the name still encodes the cache key by default
          }
          return templateRef(built, spec.name, spec.cacheKey);
        } finally {
          if (tmpDir) {
            nodeFs?.rmSync(tmpDir, { force: true, recursive: true });
          }
        }
      },

      async *list() {
        const mod = await load();
        for await (const sb of await mod.SandboxInstance.list()) {
          const labels = sb.metadata.labels ?? {};
          if (labels[TEMPLATE_KEY_LABEL]) {
            yield templateRef(
              { metadata: sb.metadata, spec: sb.spec },
              sb.metadata.name,
              labels[TEMPLATE_KEY_LABEL]
            );
          }
        }
      },

      async lookup(idOrKey) {
        const mod = await load();
        const bare = idOrKey.replace(/^sandbox\//, "").replace(/:[^/]*$/, "");
        const candidates = [...new Set([bare, defaultTemplateName(idOrKey)])];
        for (const c of candidates) {
          try {
            const sb = await mod.SandboxInstance.get(c);
            const labels = sb.metadata.labels ?? {};
            const isTemplate =
              labels[TEMPLATE_KEY_LABEL] !== undefined ||
              labels[TEMPLATE_AUTO_LABEL] === "true";
            if (isTemplate && sb.status === "DEPLOYED") {
              return templateRef(
                { metadata: sb.metadata, spec: sb.spec },
                c,
                labels[TEMPLATE_KEY_LABEL]
              );
            }
          } catch (error) {
            if (!isNotFound(error)) {
              throw error;
            }
          }
        }
        // Custom-named template: find it by its cache-key label.
        for await (const sb of await mod.SandboxInstance.list(
          idOrKey.length >= 2 ? { q: idOrKey } : {}
        )) {
          const labels = sb.metadata.labels ?? {};
          if (
            labels[TEMPLATE_KEY_LABEL] === idOrKey &&
            sb.status === "DEPLOYED"
          ) {
            return templateRef(
              { metadata: sb.metadata, spec: sb.spec },
              sb.metadata.name,
              idOrKey
            );
          }
        }
        return undefined;
      },
    };

    const volumes: DriverVolumes = {
      async create(spec) {
        const mod = await load();
        return volumeInfo(
          await mod.VolumeInstance.create({
            name: spec.name,
            ...(spec.sizeMB ? { size: spec.sizeMB } : {}),
            ...((spec.region ?? opts.region)
              ? { region: spec.region ?? opts.region }
              : {}),
          })
        );
      },
      async delete(id) {
        const mod = await load();
        await mod.VolumeInstance.delete(id);
      },
      async get(idOrName) {
        const mod = await load();
        try {
          return volumeInfo(await mod.VolumeInstance.get(idOrName));
        } catch (error) {
          if (isNotFound(error)) {
            return undefined;
          }
          throw error;
        }
      },
      async *list() {
        const mod = await load();
        for await (const v of await mod.VolumeInstance.list()) {
          yield volumeInfo(v);
        }
      },
    };

    const unarchiveIfNeeded = async (
      inst: SandboxInstance
    ): Promise<SandboxInstance> => {
      if (inst.status === "ARCHIVED" || inst.status === "ARCHIVING") {
        return inst.unarchive();
      }
      return inst;
    };

    const provider: SandboxProvider<BlaxelCaps, BlaxelRaw> = {
      capabilities: BLAXEL_CAPS,

      async connect(id: string): Promise<DriverHandle<SandboxInstance>> {
        const mod = await load();
        const inst = await unarchiveIfNeeded(await mod.SandboxInstance.get(id));
        return makeHandle(mod, inst);
      },

      async create(
        spec: ResolvedSandboxSpec,
        ctx: CallContext
      ): Promise<DriverHandle<SandboxInstance>> {
        const mod = await load();
        // A deterministic name makes a retried create return the same sandbox.
        const name =
          spec.name ??
          (ctx.idempotencyKey
            ? await nameFromIdempotencyKey(ctx.idempotencyKey)
            : `sbox-${shortId()}${shortId()}`);
        if (spec.fromSnapshot) {
          return makeHandle(mod, await createFromSnapshot(mod, spec, name));
        }
        const config = createConfig(spec, name);
        const inst = spec.name
          ? await mod.SandboxInstance.create(config)
          : await mod.SandboxInstance.createIfNotExists(config);
        return makeHandle(mod, inst);
      },

      flags: BLAXEL_FLAGS,

      async getOrCreate(spec): Promise<DriverHandle<SandboxInstance>> {
        const mod = await load();
        const existing = await mod.SandboxInstance.createIfNotExists(
          createConfig({ ...spec, fromSnapshot: undefined }, spec.name)
        );
        return makeHandle(mod, await unarchiveIfNeeded(existing));
      },

      async *list(filter: ListFilter | undefined): AsyncIterable<SandboxInfo> {
        const mod = await load();
        const wanted = Object.entries(filter?.metadata ?? {});
        const firstValue = wanted[0]?.[1];
        const page = await mod.SandboxInstance.list({
          limit: Math.min(200, Math.max(1, filter?.limit ?? 100)),
          ...(firstValue && firstValue.length >= 2 ? { q: firstValue } : {}),
        });
        let n = 0;
        for await (const inst of page) {
          if (filter?.limit !== undefined && n >= filter.limit) {
            return;
          }
          const info = instanceInfo(inst);
          if (wanted.some(([k, v]) => info.metadata[k] !== v)) {
            continue;
          }
          if (filter?.state && info.state !== filter.state) {
            continue;
          }
          n++;
          yield info;
        }
      },

      mapError: mapBlaxelError,

      name: PROVIDER,

      templates,

      async verify() {
        const mod = await load();
        await mod.SandboxInstance.list({ limit: 1 });
        return opts.workspace ? { account: opts.workspace } : undefined;
      },

      volumes,
    };
    return provider;
  }
);

function exitCodeOf(
  p: { exitCode?: number; status?: string },
  killed: boolean
): number {
  const code = p.exitCode ?? 0;
  if (
    (p.status === "killed" || p.status === "stopped" || killed) &&
    code === 0
  ) {
    return 137;
  }
  if (p.status === "failed" && code === 0) {
    return 1;
  }
  return code;
}

function templateRef(
  built: { metadata?: SandboxModel["metadata"]; spec?: SandboxModel["spec"] },
  name: string,
  cacheKey: string | undefined
): TemplateRef {
  const created = built.metadata?.createdAt;
  return {
    cacheKey,
    createdAt: created ? new Date(created) : undefined,
    id: built.spec?.runtime?.image ?? `${name}:latest`,
    name,
    provider: PROVIDER,
    raw: built,
  };
}
