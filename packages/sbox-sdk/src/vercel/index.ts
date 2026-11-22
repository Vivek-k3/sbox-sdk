/**
 * `sbox-sdk/vercel` — adapter for `@vercel/sandbox` 4.x (Firecracker microVMs).
 *
 * Vercel sandboxes are named and persistent: the sandbox `name` is its id, a
 * stopped sandbox keeps its filesystem (auto-snapshot) and resumes on the next
 * call. Requires Node >= 22.19 and the optional peer dependency
 * `@vercel/sandbox`. Auth: pass `token` + `teamId` + `projectId`, or omit all
 * three to let the SDK use `VERCEL_OIDC_TOKEN`.
 */
import type {
  APIError,
  Command,
  Drive,
  NetworkPolicy,
  NetworkPolicyRule,
  Sandbox as VercelSandbox,
  SandboxRegion,
} from "@vercel/sandbox";

import { AsyncQueue, defineProvider, SandboxError } from "../adapter/index.js";
import type {
  CallContext,
  CapabilityFlags,
  CapabilityMap,
  DirEntry,
  DriverExec,
  DriverHandle,
  DriverProcess,
  DriverPty,
  DriverVolumes,
  EgressPolicy,
  ExecOptions,
  FileInfo,
  ListFilter,
  OutputEvent,
  Preview,
  PtyOptions,
  ResolvedSandboxSpec,
  SandboxInfo,
  SandboxMetrics,
  SandboxProvider,
  SandboxState,
  SecretRef,
  SnapshotOptions,
  SnapshotRef,
  VolumeInfo,
} from "../adapter/index.js";

type VercelModule = typeof import("@vercel/sandbox");
type CreateParams = NonNullable<
  Parameters<VercelModule["Sandbox"]["create"]>[0]
>;
type ForkParams = Parameters<VercelModule["Sandbox"]["fork"]>[0];
type ListedSandbox = Awaited<
  ReturnType<VercelModule["Sandbox"]["list"]>
>["sandboxes"][number];
type KillSignal = Parameters<Command["kill"]>[0];
type Mounts = NonNullable<CreateParams["mounts"]>;
type SandboxStatus = ListedSandbox["status"];

export interface VercelOptions {
  /** Vercel access token. Omit token/teamId/projectId to use OIDC. */
  token?: string;
  teamId?: string;
  projectId?: string;
  /**
   * Delete the sandbox's snapshots that no other sandbox uses when
   * `destroy()` runs. Default `true`, so destroy leaves nothing billable.
   */
  deleteSnapshotsOnDestroy?: boolean;
  /**
   * Auto-snapshot the filesystem on stop and restore it on resume. Default
   * `true` (Vercel's default). `lifecycle.onIdle: "destroy"` turns it off.
   */
  persistent?: boolean;
  /** Called once after a sandbox is freshly created (create/getOrCreate). */
  onCreate?: (sandbox: VercelSandbox) => Promise<void>;
  /** Called whenever a stopped sandbox resumes into a new session. */
  onResume?: (sandbox: VercelSandbox) => Promise<void>;
}

export const VERCEL_CAPS = {
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
  metrics: "native",
  // No memory pause: pause() stops the session and the filesystem is
  // auto-snapshotted (persistent sandboxes); resume() boots a new session.
  pause: "emulated",
  privatePreview: "unsupported",
  proxiedFetch: "unsupported",
  pty: "native",
  region: "native",
  secretsVault: "unsupported",
  setTimeout: "native",
  snapshot: "native",
  ssh: "unsupported",
  statefulKernel: "unsupported",
  stdin: "native",
  stop: "native",
  streaming: "native",
  templateBuild: "unsupported",
  volumes: "native",
} as const satisfies CapabilityMap;

export type VercelCaps = typeof VERCEL_CAPS;

const VERCEL_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true,
  preservesDiskOnStop: true,
  preservesMemoryOnPause: false,
  previewBrowserAuth: false,
  previewModel: "declaredPorts",
  resumeChangesId: false,
};

/** Vercel accepts at most 5 tags per sandbox. */
const MAX_TAGS = 5;
/** Vercel exposes at most 15 ports per sandbox. */
const MAX_PORTS = 15;

/** Legacy 1.x/2.x `runtime` names mapped to their managed images. */
const LEGACY_RUNTIME_IMAGES: Readonly<Record<string, string>> = {
  node22: "vercel/sandbox/node:22",
  node24: "vercel/sandbox/node:24",
  node26: "vercel/sandbox/node:26",
};

let cached: VercelModule | null = null;
async function loadVercel(): Promise<VercelModule> {
  cached ??= await import("@vercel/sandbox");
  return cached;
}

const PROVIDER = "vercel";
const enc = new TextEncoder();

function vErr(
  code: ConstructorParameters<typeof SandboxError>[0],
  message: string,
  cause?: unknown
): SandboxError {
  return new SandboxError(code, message, { cause, provider: PROVIDER });
}

// --------------------------------------------------------------------------
// status + errors
// --------------------------------------------------------------------------

/** Map every Vercel session status onto `SandboxState`. */
export function mapVercelStatus(
  status: SandboxStatus | undefined
): SandboxState {
  switch (status) {
    case "pending": {
      return "creating";
    }
    case "running": {
      return "running";
    }
    // Shutting down while the filesystem is snapshotted for the next session.
    case "stopping":
    case "snapshotting": {
      return "suspending";
    }
    case "stopped": {
      return "stopped";
    }
    case "failed":
    case "aborted": {
      return "error";
    }
    default: {
      return "unknown";
    }
  }
}

function isApiError(e: unknown): e is APIError<unknown> {
  return (
    e instanceof Error &&
    "response" in e &&
    typeof (e as { response?: { status?: unknown } }).response?.status ===
      "number"
  );
}

function errorCodeOf(e: unknown): string | undefined {
  if (e && typeof e === "object" && "code" in e) {
    const { code } = e as { code?: unknown };
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** Normalize `@vercel/sandbox` errors (APIError, fs errors, auth errors). */
export function mapVercelError(e: unknown): SandboxError | undefined {
  if (e instanceof SandboxError) {
    return e;
  }
  const msg = e instanceof Error ? e.message : String(e);
  const init = (status?: number, retryable?: boolean) => ({
    cause: e,
    provider: PROVIDER,
    retryable,
    status,
  });
  if (isApiError(e)) {
    const { status } = e.response;
    if (status === 401 || status === 403) {
      return new SandboxError("Unauthorized", msg, init(status));
    }
    // 410 = session stopped / snapshot gone.
    if (status === 404 || status === 410) {
      return new SandboxError("NotFound", msg, init(status));
    }
    if (status === 409 || status === 422) {
      return new SandboxError("Conflict", msg, init(status));
    }
    if (status === 402 || status === 429) {
      return new SandboxError("QuotaExceeded", msg, init(status, true));
    }
    if (status === 408 || status === 504) {
      return new SandboxError("Timeout", msg, init(status));
    }
    if (status === 400) {
      return new SandboxError("Validation", msg, init(status));
    }
    return new SandboxError("Provider", msg, init(status, status >= 500));
  }
  const code = errorCodeOf(e);
  if (code === "ENOENT") {
    return new SandboxError("NotFound", msg, init());
  }
  if (e instanceof Error && e.name.endsWith("OidcContextError")) {
    return new SandboxError("Unauthorized", msg, init());
  }
  if (
    /missing credentials|invalid vercel oidc|unauthori[sz]ed|forbidden/i.test(
      msg
    )
  ) {
    return new SandboxError("Unauthorized", msg, init());
  }
  if (/no route for port/i.test(msg)) {
    return new SandboxError("NotFound", msg, init());
  }
  if (/timed? ?out/i.test(msg)) {
    return new SandboxError("Timeout", msg, init());
  }
  return undefined;
}

const wrap = (e: unknown): SandboxError =>
  mapVercelError(e) ?? SandboxError.wrap(e, PROVIDER);

// --------------------------------------------------------------------------
// spec mapping
// --------------------------------------------------------------------------

/** A deterministic, URL-safe sandbox name from the core's idempotency key. */
export function nameFromIdempotencyKey(key: string): string {
  const slug = key
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return `sbox-${slug}`.slice(0, 63);
}

function secretValue(
  ref: SecretRef | string,
  secrets: readonly SecretRef[] | undefined
): string {
  if (typeof ref === "string") {
    return ref;
  }
  const value = ref.value ?? secrets?.find((s) => s.name === ref.name)?.value;
  if (value === undefined) {
    throw vErr(
      "Validation",
      `secret '${ref.name}' needs a value: Vercel has no secret vault`
    );
  }
  return value;
}

/**
 * Translate an `EgressPolicy` into Vercel's `networkPolicy`. Denied domains
 * become proxy `response` rules (403) and `inject` becomes request transforms,
 * both of which need the record form of `allow`.
 */
export function toNetworkPolicy(
  policy: EgressPolicy,
  secrets?: readonly SecretRef[]
): NetworkPolicy {
  if (policy.mode === "block-all") {
    return "deny-all";
  }
  const denyDomains = policy.deny?.domains ?? [];
  const denyCidrs = policy.deny?.cidrs ?? [];
  const inject = policy.inject ?? [];
  const allowCidrs = policy.mode === "allow-list" ? (policy.cidrs ?? []) : [];
  if (
    policy.mode === "allow-all" &&
    denyDomains.length === 0 &&
    denyCidrs.length === 0 &&
    inject.length === 0
  ) {
    return "allow-all";
  }
  const subnets =
    allowCidrs.length > 0 || denyCidrs.length > 0
      ? {
          ...(allowCidrs.length > 0 ? { allow: allowCidrs } : {}),
          ...(denyCidrs.length > 0 ? { deny: denyCidrs } : {}),
        }
      : undefined;
  const baseDomains =
    policy.mode === "allow-all" ? ["*"] : (policy.domains ?? []);
  if (denyDomains.length === 0 && inject.length === 0) {
    return { allow: baseDomains, ...(subnets ? { subnets } : {}) };
  }
  const allow: Record<string, NetworkPolicyRule[]> = {};
  for (const d of baseDomains) {
    allow[d] = [];
  }
  for (const rule of inject) {
    const headers: Record<string, string> = {};
    for (const [name, ref] of Object.entries(rule.headers)) {
      headers[name] = secretValue(ref, secrets);
    }
    for (const d of rule.domains) {
      allow[d] = [...(allow[d] ?? []), { transform: [{ headers }] }];
    }
  }
  for (const d of denyDomains) {
    allow[d] = [
      {
        response: {
          body: "blocked by sbox egress policy",
          contentType: "text/plain",
          statusCode: 403,
        },
      },
    ];
  }
  return { allow, ...(subnets ? { subnets } : {}) };
}

function toVcpus(spec: ResolvedSandboxSpec): number | undefined {
  const r = spec.resources;
  if (r?.vcpus !== undefined) {
    return r.vcpus;
  }
  // Vercel gives 2048 MB per vCPU; round memory up to whole vCPUs.
  return r?.memoryMB === undefined ? undefined : Math.ceil(r.memoryMB / 2048);
}

function toMounts(spec: ResolvedSandboxSpec): Mounts | undefined {
  if (!spec.volumes?.length) {
    return undefined;
  }
  const mounts: Mounts = {};
  for (const v of spec.volumes) {
    mounts[v.mountPath] = {
      drive: v.id,
      mode: v.readOnly ? "snapshot" : "read-write",
    };
  }
  return mounts;
}

/** Build `Sandbox.create` params (minus credentials) from a resolved spec. */
export function toCreateParams(
  spec: ResolvedSandboxSpec,
  opts: { persistent?: boolean; name?: string } = {}
): CreateParams {
  if (spec.resources?.gpu || spec.resources?.gpuCount) {
    throw vErr("Validation", "Vercel sandboxes have no GPUs");
  }
  const tags = spec.metadata ?? {};
  if (Object.keys(tags).length > MAX_TAGS) {
    throw vErr(
      "Validation",
      `Vercel allows at most ${MAX_TAGS} tags (metadata keys); got ${Object.keys(tags).length}`
    );
  }
  if ((spec.ports?.length ?? 0) > MAX_PORTS) {
    throw vErr("Validation", `Vercel exposes at most ${MAX_PORTS} ports`);
  }
  const env: Record<string, string> = { ...spec.env };
  for (const s of spec.secrets ?? []) {
    if ((s.mode ?? "env") === "env") {
      env[s.envVar ?? s.name] = secretValue(s, undefined);
    }
  }
  const lc = spec.lifecycle;
  const timeout = lc?.maxAgeMs ?? lc?.idleTimeoutMs ?? spec.ttlMs;
  const persistent =
    lc?.onIdle === "destroy" ? false : (opts.persistent ?? undefined);
  const vcpus = toVcpus(spec);
  const base = {
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(Object.keys(tags).length > 0 ? { tags } : {}),
    ...(opts.name ? { name: opts.name } : {}),
    ...(spec.ports?.length ? { ports: spec.ports } : {}),
    ...(spec.region ? { region: spec.region as SandboxRegion } : {}),
    ...(vcpus === undefined ? {} : { resources: { vcpus } }),
    ...(timeout === undefined ? {} : { timeout }),
    ...(persistent === undefined ? {} : { persistent }),
    ...(spec.network
      ? { networkPolicy: toNetworkPolicy(spec.network, spec.secrets) }
      : {}),
    ...(toMounts(spec) ? { mounts: toMounts(spec) } : {}),
    ...(spec.signal ? { signal: spec.signal } : {}),
  };
  if (spec.fromSnapshot) {
    if (spec.template) {
      throw vErr(
        "Validation",
        "`template` and `fromSnapshot` are mutually exclusive on Vercel"
      );
    }
    return {
      ...base,
      source: { snapshotId: spec.fromSnapshot, type: "snapshot" },
    };
  }
  if (spec.template) {
    const legacy = LEGACY_RUNTIME_IMAGES[spec.template];
    if (spec.template === "python3.13") {
      // No managed image pins 3.13; keep the deprecated runtime selector.
      return { ...base, runtime: "python3.13" };
    }
    return { ...base, image: legacy ?? spec.template };
  }
  return base;
}

function toSignal(signal: string | undefined): KillSignal {
  if (signal === undefined) {
    return undefined;
  }
  if (/^\d+$/.test(signal)) {
    return Number(signal);
  }
  const name = signal.toUpperCase().startsWith("SIG")
    ? signal.toUpperCase()
    : `SIG${signal.toUpperCase()}`;
  switch (name) {
    case "SIGHUP":
    case "SIGINT":
    case "SIGQUIT":
    case "SIGKILL":
    case "SIGTERM":
    case "SIGCONT":
    case "SIGSTOP": {
      return name;
    }
    default: {
      throw vErr("Validation", `unsupported signal '${signal}'`);
    }
  }
}

function snapshotRef(
  s: { id: string; createdAt: number | Date },
  raw: unknown,
  name?: string
): SnapshotRef {
  return {
    createdAt:
      s.createdAt instanceof Date ? s.createdAt : new Date(s.createdAt),
    id: s.id,
    includesMemory: false,
    provider: PROVIDER,
    raw,
    ...(name === undefined ? {} : { name }),
  };
}

function listedInfo(s: ListedSandbox): SandboxInfo {
  return {
    createdAt: new Date(s.createdAt),
    id: s.name,
    metadata: s.tags ?? {},
    name: s.name,
    provider: PROVIDER,
    raw: s,
    state: mapVercelStatus(s.status),
  };
}

function driveInfo(d: Drive): VolumeInfo {
  return {
    createdAt: d.createdAt,
    // Mounts reference drives by name, so the name is the id users pass on.
    id: d.name,
    name: d.name,
    raw: d,
    region: d.region,
    sizeMB: Math.round(d.maxSize / 1_048_576),
  };
}

// --------------------------------------------------------------------------
// PTY over the interactive WebSocket
// --------------------------------------------------------------------------

/** The login shell the `sandbox` CLI starts for `exec --interactive`. */
const DEFAULT_SHELL = [
  "sh",
  "-ic",
  [
    'shell="$SHELL"',
    '[ -x "$shell" ] || shell=sh',
    'case "$(basename "$shell")" in',
    '  bash) exec "$shell" --norc -i ;;',
    '  *) exec "$shell" -i ;;',
    "esac",
  ].join("\n"),
];

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const onOpen = () => {
      ws.removeEventListener("error", onError);
      resolve(ws);
    };
    const onError = () => {
      ws.removeEventListener("open", onOpen);
      reject(vErr("Provider", "interactive WebSocket failed to connect"));
    };
    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onError, { once: true });
  });
}

async function connectSocket(url: string): Promise<WebSocket> {
  let last: Error = vErr("Provider", "interactive WebSocket failed");
  // The controller may need a moment after `openInteractive()`; the CLI
  // health-checks with retries before connecting, we retry the connect.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await openSocket(url);
    } catch (error) {
      last = error instanceof Error ? error : last;
      await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
    }
  }
  throw last;
}

async function openVercelPty(
  sb: VercelSandbox,
  o: PtyOptions,
  signal?: AbortSignal
): Promise<DriverPty> {
  const { token, url } = await sb.openInteractive({ signal });
  const ws = await connectSocket(`${url}?token=${encodeURIComponent(token)}`);
  const out = new AsyncQueue<Uint8Array>();
  let exitCode: number | undefined;
  let killed = false;
  let resolveExit!: (n: number) => void;
  const exited = new Promise<number>((r) => {
    resolveExit = r;
  });
  const finish = (code: number) => {
    if (exitCode === undefined) {
      exitCode = code;
      out.close();
      resolveExit(code);
    }
  };
  ws.addEventListener("message", (ev: MessageEvent) => {
    const { data } = ev;
    if (typeof data === "string") {
      let msg: unknown;
      try {
        msg = JSON.parse(data);
      } catch {
        out.push(enc.encode(data));
        return;
      }
      if (msg && typeof msg === "object") {
        const m = msg as { type?: unknown; code?: unknown };
        if (m.type === "exit") {
          finish(typeof m.code === "number" ? m.code : 1);
        }
        return; // other control messages
      }
      out.push(enc.encode(data));
      return;
    }
    if (data instanceof ArrayBuffer) {
      out.push(new Uint8Array(data));
    } else if (ArrayBuffer.isView(data)) {
      out.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
  });
  ws.addEventListener("close", () => finish(killed ? 130 : 1));
  const env = { TERM: "xterm-256color", ...o.env };
  const argv = o.cmd ? ["sh", "-c", o.cmd] : DEFAULT_SHELL;
  const full = o.user === "root" ? ["sudo", ...argv] : argv;
  let cwd = o.cwd;
  if (!cwd) {
    try {
      cwd = sb.cwd;
    } catch {
      cwd = undefined;
    }
  }
  ws.send(
    JSON.stringify({
      args: full.slice(1),
      cols: o.cols ?? 80,
      command: full[0],
      cwd,
      env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      rows: o.rows ?? 24,
      type: "start",
    })
  );
  return {
    id: globalThis.crypto.randomUUID(),
    async kill() {
      killed = true;
      ws.close();
      finish(130);
    },
    output: { [Symbol.asyncIterator]: () => out.iterator() },
    async resize(cols: number, rows: number) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ cols, rows, type: "resize" }));
      }
    },
    wait: () => exited,
    async write(data: Uint8Array) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(new Uint8Array(data));
      }
    },
  };
}

// --------------------------------------------------------------------------
// provider
// --------------------------------------------------------------------------

export const vercel = defineProvider<VercelCaps, VercelSandbox, VercelOptions>(
  (opts = {}) => {
    const creds =
      opts.token && opts.teamId && opts.projectId
        ? { projectId: opts.projectId, teamId: opts.teamId, token: opts.token }
        : undefined;
    const call = (ctx: CallContext) => ({
      ...creds,
      fetch: ctx.fetch,
    });

    const getSandbox = async (
      name: string,
      ctx: CallContext,
      resume?: boolean
    ): Promise<VercelSandbox> => {
      const { Sandbox } = await loadVercel();
      return Sandbox.get({
        ...call(ctx),
        name,
        ...(resume ? { resume } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(opts.onResume ? { onResume: opts.onResume } : {}),
      });
    };

    const makeHandle = (
      initial: VercelSandbox
    ): DriverHandle<VercelSandbox> => {
      let sb = initial;
      const name = initial.name;

      /** Start a command; `stdin` opens it for writeStdin (spawn only). */
      const start = (
        cmd: string,
        o: ExecOptions,
        stdin: boolean
      ): Promise<Command> => {
        const target = o.user && o.user !== "root" ? sb.asUser(o.user) : sb;
        return target.runCommand({
          args: ["-c", cmd],
          cmd: "sh",
          detached: true,
          ...(o.cwd ? { cwd: o.cwd } : {}),
          ...(o.env ? { env: o.env } : {}),
          ...(o.user === "root" ? { sudo: true } : {}),
          ...(stdin ? { stdin: true } : {}),
          ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
        });
      };

      /** Pump logs + exit code of a started command into a queue. */
      const drive = (
        cmdP: Promise<Command>,
        timeoutMs?: number
      ): AsyncQueue<OutputEvent> => {
        const queue = new AsyncQueue<OutputEvent>();
        const startedAt = Date.now();
        void (async () => {
          try {
            const c = await cmdP;
            for await (const line of c.logs()) {
              queue.push({
                data: line.data,
                type: line.stream === "stderr" ? "stderr" : "stdout",
              });
            }
            const fin = await c.wait();
            // Vercel enforces `timeoutMs` with SIGKILL (exit 137); surface it
            // as a Timeout like every other provider.
            const slack = timeoutMs
              ? Math.min(50, Math.floor(timeoutMs / 4))
              : 0;
            if (
              timeoutMs &&
              fin.exitCode === 137 &&
              Date.now() - startedAt >= timeoutMs - slack
            ) {
              queue.fail(
                new SandboxError(
                  "Timeout",
                  `command timed out after ${timeoutMs}ms`,
                  { provider: PROVIDER, timedOut: true }
                )
              );
              return;
            }
            queue.push({ exitCode: fin.exitCode, type: "exit" });
            queue.close();
          } catch (error) {
            queue.fail(wrap(error));
          }
        })();
        return queue;
      };

      const asProcess = (
        cmdP: Promise<Command>,
        queue: AsyncQueue<OutputEvent>,
        id: string,
        stdin: boolean
      ): DriverProcess => ({
        id,
        async kill(signal?: string) {
          await (await cmdP).kill(toSignal(signal));
        },
        pid: Promise.resolve(id),
        [Symbol.asyncIterator]: () => queue.iterator(),
        ...(stdin
          ? {
              async writeStdin(data: Uint8Array) {
                await (await cmdP).writeStdin(data);
              },
            }
          : {}),
      });

      const ports = (): number[] => sb.routes.map((r) => r.port);

      const handle: DriverHandle<VercelSandbox> = {
        async connectProcess(processId: string): Promise<DriverProcess> {
          const cmdP = sb.getCommand(processId);
          await cmdP;
          return asProcess(cmdP, drive(cmdP), processId, false);
        },

        async createPty(o: PtyOptions, ctx: CallContext): Promise<DriverPty> {
          return openVercelPty(sb, o, ctx.signal);
        },

        async deleteSnapshot(ref: string, ctx: CallContext): Promise<void> {
          const { Snapshot } = await loadVercel();
          const snap = await Snapshot.get({ ...call(ctx), snapshotId: ref });
          await snap.delete();
        },

        async destroy(ctx: CallContext): Promise<void> {
          await sb.delete({
            deleteOrphanSnapshots: opts.deleteSnapshotsOnDestroy ?? true,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
        },

        exec(cmd: string, o: ExecOptions): DriverExec {
          // stdin stays closed for run(): a command that reads stdin would
          // otherwise block forever. Interactive stdin is on spawn().
          const cmdP = start(cmd, o, false);
          cmdP.catch(() => {
            /* surfaced through the queue */
          });
          const queue = drive(cmdP, o.timeoutMs);
          o.signal?.addEventListener(
            "abort",
            () => {
              void cmdP.then((c) => c.kill("SIGKILL")).catch(() => {});
            },
            { once: true }
          );
          return {
            async kill(signal?: string) {
              await (await cmdP).kill(toSignal(signal));
            },
            pid: cmdP.then((c) => c.cmdId).catch(() => ""),
            [Symbol.asyncIterator]: () => queue.iterator(),
          };
        },

        async exposePort(port: number): Promise<Preview> {
          if (!ports().includes(port)) {
            if (ports().length >= MAX_PORTS) {
              throw vErr(
                "QuotaExceeded",
                `Vercel exposes at most ${MAX_PORTS} ports`
              );
            }
            await sb.update({ ports: [...ports(), port] });
          }
          return { auth: { type: "public" }, port, url: sb.domain(port) };
        },

        async fork(count: number, ctx: CallContext) {
          const { Sandbox } = await loadVercel();
          const out: DriverHandle<VercelSandbox>[] = [];
          for (let i = 0; i < count; i++) {
            const params: ForkParams = {
              ...call(ctx),
              sourceSandbox: name,
              ...(opts.onResume ? { onResume: opts.onResume } : {}),
            };
            out.push(makeHandle(await Sandbox.fork(params)));
          }
          return out;
        },

        async getInfo(ctx: CallContext): Promise<SandboxInfo> {
          const fresh = await getSandbox(name, ctx);
          let status: SandboxStatus | undefined;
          try {
            status = fresh.status;
          } catch {
            status = "stopped"; // no session yet / any more
          }
          return {
            createdAt: fresh.createdAt,
            id: fresh.name,
            metadata: fresh.tags ?? {},
            name: fresh.name,
            provider: PROVIDER,
            raw: fresh,
            state: mapVercelStatus(status),
          };
        },

        async getMetrics(ctx: CallContext): Promise<SandboxMetrics> {
          const fresh = await getSandbox(name, ctx);
          const cpu = fresh.totalActiveCpuDurationMs;
          const wall = fresh.totalDurationMs;
          const vcpus = fresh.vcpus;
          return {
            // Lifetime average utilization; Vercel reports cumulative usage,
            // not point-in-time samples.
            ...(cpu !== undefined && wall && vcpus
              ? { cpuPercent: (cpu / (wall * vcpus)) * 100 }
              : {}),
            ...(fresh.memory === undefined
              ? {}
              : { memoryTotalMB: fresh.memory }),
            raw: {
              totalActiveCpuDurationMs: cpu,
              totalDurationMs: wall,
              totalEgressBytes: fresh.totalEgressBytes,
              totalIngressBytes: fresh.totalIngressBytes,
              vcpus,
            },
            timestamp: new Date(),
          };
        },

        id: name,

        async killProcess(processId: string, signal: string | undefined) {
          const c = await sb.getCommand(processId);
          await c.kill(toSignal(signal));
        },

        async listDir(path: string): Promise<DirEntry[]> {
          const entries = await sb.fs.readdir(path, { withFileTypes: true });
          const base = path.replace(/\/+$/, "");
          return entries.map((d) => ({
            name: d.name,
            path: `${base}/${d.name}`,
            type: d.isDirectory()
              ? "dir"
              : d.isSymbolicLink()
                ? "symlink"
                : "file",
          }));
        },

        listPorts(): Preview[] {
          return sb.routes.map((r) => ({
            auth: { type: "public" },
            port: r.port,
            url: sb.domain(r.port),
          }));
        },

        async listSnapshots(): Promise<SnapshotRef[]> {
          const out: SnapshotRef[] = [];
          const pages = await sb.listSnapshots();
          for await (const s of pages) {
            if (s.status !== "deleted") {
              out.push(snapshotRef(s, s));
            }
          }
          return out;
        },

        async mkdir(path: string, recursive: boolean): Promise<void> {
          await sb.fs.mkdir(path, { recursive });
        },

        name,

        async pause(ctx: CallContext): Promise<void> {
          if (!sb.persistent) {
            throw vErr(
              "Conflict",
              "pause() needs a persistent sandbox; this one discards its filesystem on stop"
            );
          }
          await sb.stop(ctx.signal ? { signal: ctx.signal } : undefined);
        },

        get raw() {
          return sb;
        },

        async readFile(path: string, ctx: CallContext): Promise<Uint8Array> {
          const buf = await sb.readFileToBuffer(
            { path },
            ctx.signal ? { signal: ctx.signal } : undefined
          );
          if (!buf) {
            throw vErr("NotFound", `no such file: '${path}'`);
          }
          return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        },

        async remove(path: string, recursive: boolean): Promise<void> {
          await sb.fs.rm(path, { force: true, recursive });
        },

        async rename(from: string, to: string): Promise<void> {
          await sb.fs.rename(from, to);
        },

        async resume(ctx: CallContext): Promise<void> {
          sb = await getSandbox(name, ctx, true);
        },

        async setEgressPolicy(policy: EgressPolicy): Promise<void> {
          await sb.update({ networkPolicy: toNetworkPolicy(policy) });
        },

        async setTimeout(ttlMs: number): Promise<void> {
          await sb.update({ timeout: ttlMs });
        },

        async snapshot(
          o: SnapshotOptions,
          ctx: CallContext
        ): Promise<SnapshotRef> {
          // Vercel snapshots are filesystem-only, and taking one stops the
          // session; the next call resumes it automatically.
          const snap = await sb.snapshot(
            ctx.signal ? { signal: ctx.signal } : undefined
          );
          return snapshotRef(
            { createdAt: snap.createdAt, id: snap.snapshotId },
            snap,
            o.name
          );
        },

        async spawn(cmd: string, o: ExecOptions): Promise<DriverProcess> {
          const cmdP = start(cmd, o, true);
          const c = await cmdP;
          return asProcess(cmdP, drive(cmdP, o.timeoutMs), c.cmdId, true);
        },

        async stat(path: string): Promise<FileInfo> {
          const s = await sb.fs.stat(path);
          return {
            mtime: s.mtime,
            path,
            size: s.size,
            type: s.isDirectory() ? "dir" : "file",
          };
        },

        async stop(ctx: CallContext): Promise<void> {
          await sb.stop(ctx.signal ? { signal: ctx.signal } : undefined);
        },

        async unexposePort(port: number): Promise<void> {
          if (ports().includes(port)) {
            await sb.update({ ports: ports().filter((p) => p !== port) });
          }
        },

        async writeFile(path: string, data: Uint8Array, ctx: CallContext) {
          await sb.writeFiles(
            [{ content: data, path }],
            ctx.signal ? { signal: ctx.signal } : undefined
          );
        },
      };
      return handle;
    };

    const createParams = (
      spec: ResolvedSandboxSpec,
      ctx: CallContext,
      name?: string
    ) => ({
      ...toCreateParams(spec, { name, persistent: opts.persistent }),
      ...call(ctx),
      ...(opts.onResume ? { onResume: opts.onResume } : {}),
    });

    const volumes: DriverVolumes = {
      async create(spec, ctx) {
        const { Drive } = await loadVercel();
        const d = await Drive.getOrCreate({
          ...call(ctx),
          name: spec.name,
          ...(spec.region ? { region: spec.region } : {}),
          ...(spec.sizeMB ? { maxSize: spec.sizeMB * 1_048_576 } : {}),
        });
        return driveInfo(d);
      },
      async delete(id, ctx) {
        const { Drive } = await loadVercel();
        const d = await Drive.get({ ...call(ctx), name: id });
        await d.delete();
      },
      async get(idOrName, ctx) {
        const { Drive } = await loadVercel();
        try {
          return driveInfo(await Drive.get({ ...call(ctx), name: idOrName }));
        } catch (error) {
          if (wrap(error).code === "NotFound") {
            return undefined;
          }
          throw error;
        }
      },
      async *list(ctx) {
        const { Drive } = await loadVercel();
        const pages = await Drive.list({ ...call(ctx) });
        for await (const d of pages) {
          yield driveInfo(d);
        }
      },
    };

    const provider: SandboxProvider<VercelCaps, VercelSandbox> = {
      capabilities: VERCEL_CAPS,

      async connect(id: string, ctx: CallContext) {
        return makeHandle(await getSandbox(id, ctx));
      },

      async create(spec: ResolvedSandboxSpec, ctx: CallContext) {
        const { Sandbox } = await loadVercel();
        const name =
          spec.name ??
          (ctx.idempotencyKey
            ? nameFromIdempotencyKey(ctx.idempotencyKey)
            : undefined);
        let sb: VercelSandbox;
        try {
          sb = await Sandbox.create(createParams(spec, ctx, name));
        } catch (error) {
          // A retried create whose first attempt landed: the name is taken
          // by our own sandbox, so hand that back instead of a duplicate.
          if (
            name &&
            !spec.name &&
            ctx.attempt > 1 &&
            wrap(error).code === "Conflict"
          ) {
            return makeHandle(await getSandbox(name, ctx));
          }
          throw error;
        }
        await opts.onCreate?.(sb);
        return makeHandle(sb);
      },

      flags: VERCEL_FLAGS,

      async getOrCreate(spec, ctx: CallContext) {
        const { Sandbox } = await loadVercel();
        const sb = await Sandbox.getOrCreate({
          ...createParams(spec, ctx, spec.name),
          resume: true,
          ...(opts.onCreate ? { onCreate: opts.onCreate } : {}),
        });
        return makeHandle(sb);
      },

      async *list(filter: ListFilter | undefined, ctx: CallContext) {
        const { Sandbox } = await loadVercel();
        const entries = Object.entries(filter?.metadata ?? {});
        const first = entries[0];
        // The API filters on a single tag; the rest are checked here.
        const tags: Record<string, string> | undefined = first
          ? Object.fromEntries([first])
          : undefined;
        const pages = await Sandbox.list({
          ...call(ctx),
          ...(tags ? { tags } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        let n = 0;
        for await (const s of pages) {
          if (filter?.limit !== undefined && n >= filter.limit) {
            return;
          }
          const info = listedInfo(s);
          if (filter?.state && info.state !== filter.state) {
            continue;
          }
          if (!entries.every(([k, v]) => info.metadata[k] === v)) {
            continue;
          }
          n++;
          yield info;
        }
      },

      mapError: mapVercelError,
      name: PROVIDER,

      async verify(ctx: CallContext) {
        const { Sandbox } = await loadVercel();
        await Sandbox.list({ ...call(ctx), limit: 1 });
        return creds ? { account: creds.teamId } : undefined;
      },

      volumes,
    };
    return provider;
  }
);
