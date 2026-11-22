import type {
  CreateFirewallRuleOptions,
  CreateTlsRuleOptions,
  CreateVmOptions,
  FirewallRuleData,
  Freestyle,
  PtySession,
  PtySessionEvents,
  SnapshotData,
  TlsRuleData,
  Vm,
  VmData,
  VmResources,
  VmState,
} from "freestyle";

/**
 * `sbox-sdk/freestyle` — adapter for Freestyle (KVM VMs on bare metal). Backed
 * by the optional peer `freestyle` (the old `freestyle-sandboxes` package is
 * deprecated), lazy-imported on first use so importing this subpath stays cheap.
 *
 * Freestyle's model differs from container sandboxes in a few ways the adapter
 * bridges:
 * - `vm.exec()` is request/response (no streaming) with no `cwd`; the core
 *   bakes `cd` into the command, and output arrives when the command ends.
 *   `kill()` works by recording the shell's pid and killing its process tree.
 * - There are no env vars at create: the adapter keeps them in
 *   `/etc/sbox-env.json` inside the VM and passes them to every exec.
 * - Templates are snapshots. `templates.build({ dockerfile })` is an emulated
 *   build: boot a base VM, run the steps, snapshot it.
 */
import {
  AsyncQueue,
  defaultTemplateName,
  loadTemplateContext,
  NotSupportedError,
  parseDockerfile,
  SandboxError,
  shellQuote,
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
  DirEntry,
  DriverExec,
  DriverHandle,
  DriverPty,
  DriverTemplates,
  EgressPolicy,
  ExecOptions,
  FileBody,
  FileInfo,
  LifecyclePolicy,
  ListFilter,
  OutputEvent,
  Preview,
  PtyOptions,
  ResolvedSandboxSpec,
  ResourceSpec,
  SandboxInfo,
  SandboxProvider,
  SandboxState,
  SnapshotRef,
  TemplateBuildEvent,
  TemplateRef,
  TemplateSpec,
} from "../adapter/index.js";

const NAME = "freestyle";

export interface FreestyleOptions {
  /** API key. Defaults to the `FREESTYLE_API_KEY` env var. */
  apiKey?: string;
  /** API base URL override. */
  baseUrl?: string;
  /** Custom transport (proxy, retries). Defaults to the SDK's HTTP/2 client. */
  fetch?: typeof fetch;
  /**
   * Exec timeout used when a command passes none, ms. Freestyle's own default
   * is 30 s; this adapter defaults to 300 000 (the platform's five-minute cap
   * on VMs without the native agent).
   */
  execTimeoutMs?: number;
  /** Domain previews are published under. Default `style.dev` (free, no DNS). */
  previewDomain?: string;
}

export const FREESTYLE_CAPS = {
  background: "unsupported",
  codeInterpreter: "unsupported",
  egressControl: "native",
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "unsupported",
  fork: "native",
  gpu: "unsupported",
  killProcess: "unsupported",
  list: "native",
  metrics: "unsupported",
  pause: "native",
  privatePreview: "unsupported",
  proxiedFetch: "unsupported",
  pty: "native",
  region: "unsupported",
  secretsVault: "unsupported",
  setTimeout: "native",
  snapshot: "native",
  ssh: "native",
  statefulKernel: "unsupported",
  stdin: "unsupported",
  stop: "unsupported",
  streaming: "emulated",
  templateBuild: "native",
  volumes: "unsupported",
} as const satisfies CapabilityMap;

export type FreestyleCaps = typeof FREESTYLE_CAPS;

const FREESTYLE_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: false,
  preservesDiskOnStop: true,
  preservesMemoryOnPause: true,
  previewBrowserAuth: false,
  previewModel: "subdomain",
  templateSources: ["snapshot", "dockerfile"],
};

/** Where the adapter keeps a VM's env vars (readable while paused). */
export const ENV_FILE = "/etc/sbox-env.json";
/** Description on the firewall rules this adapter owns for egress. */
const EGRESS_TAG = "sbox:egress";
/** Metadata key holding a hash of the create idempotency key. */
const IDEM_KEY = "sbox-idempotency-key";
const SSH_HOST = "beta-ssh.freestyle.sh";
const PAGE = 100;

/** Public base snapshots, smallest first (cpu, MiB memory, MiB disk). */
const BASES: { id: string; cpu: number; memory: number; storage: number }[] = [
  { cpu: 2, id: "freestyle/ubuntu-sm", memory: 4096, storage: 16_384 },
  { cpu: 4, id: "freestyle/ubuntu", memory: 8192, storage: 32_768 },
  { cpu: 8, id: "freestyle/ubuntu-lg", memory: 16_384, storage: 65_536 },
  { cpu: 16, id: "freestyle/ubuntu-xl", memory: 32_768, storage: 131_072 },
  { cpu: 32, id: "freestyle/ubuntu-2xl", memory: 65_536, storage: 131_072 },
];

// --------------------------------------------------------------------------
// pure helpers (exported for tests)
// --------------------------------------------------------------------------

const STATUS: Record<VmState, SandboxState> = {
  paused: "paused",
  pausing: "suspending",
  running: "running",
  starting: "creating",
  stopped: "stopped",
};

/** Every Freestyle VM state, mapped onto `SandboxState`. */
export function mapFreestyleState(state: string): SandboxState {
  return (
    (STATUS as Record<string, SandboxState | undefined>)[state] ?? "unknown"
  );
}

const STATE_FILTER: Partial<Record<SandboxState, VmState>> = {
  creating: "starting",
  paused: "paused",
  running: "running",
  stopped: "stopped",
  suspending: "pausing",
};

/** Smallest Ubuntu base snapshot that satisfies `resources`. */
export function pickBaseSnapshot(
  r: ResourceSpec | undefined
): string | undefined {
  if (
    !r ||
    (r.vcpus === undefined &&
      r.memoryMB === undefined &&
      r.diskMB === undefined)
  ) {
    return undefined;
  }
  const fit = BASES.find(
    (b) =>
      (r.vcpus ?? 0) <= b.cpu &&
      (r.memoryMB ?? 0) <= b.memory &&
      (r.diskMB ?? 0) <= b.storage
  );
  if (!fit) {
    throw new SandboxError(
      "Validation",
      "requested resources exceed the largest Freestyle VM (32 vCPU, 64 GiB)",
      { provider: NAME }
    );
  }
  return fit.id;
}

/** `LifecyclePolicy` → Freestyle VM deadlines. */
export function lifecycleOptions(
  l: LifecyclePolicy | undefined
): Pick<
  CreateVmOptions,
  "idleTimeoutSeconds" | "ttlSeconds" | "maxRunSeconds" | "autoDeleteSeconds"
> {
  const out: Pick<
    CreateVmOptions,
    "idleTimeoutSeconds" | "ttlSeconds" | "maxRunSeconds" | "autoDeleteSeconds"
  > = {};
  if (!l) {
    return out;
  }
  if (l.idleTimeoutMs !== undefined) {
    out.idleTimeoutSeconds = Math.max(1, Math.ceil(l.idleTimeoutMs / 1000));
  }
  if (l.maxAgeMs !== undefined) {
    const s = Math.max(1, Math.ceil(l.maxAgeMs / 1000));
    if (l.onIdle === "destroy") {
      out.ttlSeconds = s;
    } else {
      out.maxRunSeconds = s;
    }
  }
  if (l.onIdle === "destroy" && l.idleTimeoutMs !== undefined) {
    // Ephemeral: deleted as soon as it stops running (an idle pause included).
    out.autoDeleteSeconds = 0;
  }
  return out;
}

function resolveHeader(name: string, v: unknown): string {
  if (typeof v === "string") {
    return v;
  }
  const ref = v as { name: string; value?: string };
  if (ref.value === undefined) {
    throw new SandboxError(
      "Validation",
      `inject header '${name}': Freestyle has no secret store, so SecretRef '${ref.name}' needs a value`,
      { provider: NAME }
    );
  }
  return ref.value;
}

/**
 * `EgressPolicy` → firewall rules (IP level) plus TLS rules (domain allows and
 * header injection at the edge). `self` is `{}` inside a create (the new VM)
 * or `{ vmId }` for a running VM.
 */
export function egressRules(
  policy: EgressPolicy | undefined,
  self: { vmId?: string }
): { firewall: CreateFirewallRuleOptions[]; tls: CreateTlsRuleOptions[] } {
  const p: EgressPolicy = policy ?? { mode: "allow-all" };
  if (p.deny?.cidrs?.length || p.deny?.domains?.length) {
    throw new NotSupportedError(
      NAME,
      "EgressPolicy.deny (Freestyle firewall rules are allow-only)"
    );
  }
  const firewall: CreateFirewallRuleOptions[] = [];
  const domains = new Map<string, Record<string, string> | undefined>();
  if (p.mode === "allow-all") {
    firewall.push({
      action: "allow",
      description: EGRESS_TAG,
      destination: { public: true },
      source: { ...self },
    });
  } else if (p.mode === "allow-list") {
    for (const cidr of p.cidrs ?? []) {
      firewall.push({
        action: "allow",
        description: EGRESS_TAG,
        destination: { cidr },
        source: { ...self },
      });
    }
    for (const d of p.domains ?? []) {
      domains.set(d, undefined);
    }
  } else if (p.mode !== "block-all") {
    throw new SandboxError(
      "Validation",
      `unknown egress mode '${String((p as { mode: unknown }).mode)}'`,
      { provider: NAME }
    );
  }
  for (const inj of p.inject ?? []) {
    const headers: Record<string, string> = {};
    for (const [h, v] of Object.entries(inj.headers)) {
      headers[h] = resolveHeader(h, v);
    }
    for (const d of inj.domains) {
      domains.set(d, { ...domains.get(d), ...headers });
    }
  }
  const tls: CreateTlsRuleOptions[] = [...domains].map(([domain, headers]) => ({
    action: "allow",
    destination: { public: true },
    domain,
    source: { ...self },
    ...(headers ? { transform: [{ headers }] } : {}),
  }));
  return { firewall, tls };
}

function isEgressTls(r: TlsRuleData, vmId: string): boolean {
  return r.source.vmId === vmId && r.destination.public === true;
}

function isIngressTls(r: TlsRuleData, vmId: string): boolean {
  return (
    r.source.public === true &&
    r.destination.vmId === vmId &&
    typeof r.destination.port === "number"
  );
}

/** A valid Freestyle slug for a sandbox name (deterministic). */
export async function slugForName(name: string): Promise<string> {
  if (
    name.length <= 63 &&
    /^[a-z0-9]([a-z0-9]|-(?!-))*$/.test(name) &&
    !name.endsWith("-")
  ) {
    return name;
  }
  const clean =
    name
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "sbox";
  return `${clean}-${(await sha256Hex(name)).slice(0, 8)}`;
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

function randomLabel(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 10);
}

function stripInternal(meta: Record<string, string>): Record<string, string> {
  const { [IDEM_KEY]: _drop, ...rest } = meta;
  return rest;
}

function toInfo(d: VmData): SandboxInfo {
  const name = d.displayName ?? d.slug ?? undefined;
  return {
    createdAt: new Date(d.createdAt),
    id: d.id,
    metadata: stripInternal(d.metadata ?? {}),
    provider: NAME,
    raw: d,
    state: mapFreestyleState(d.state),
    ...(name ? { name } : {}),
  };
}

function errStatus(err: unknown): number | undefined {
  const s = (err as { status?: unknown }).status;
  return typeof s === "number" ? s : undefined;
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && errStatus(err) === 404;
}

function isConflict(err: unknown): boolean {
  return err instanceof Error && errStatus(err) === 409;
}

/** Normalize Freestyle SDK errors into the sbox taxonomy. */
export function mapFreestyleError(err: unknown): SandboxError | undefined {
  if (err instanceof SandboxError) {
    return err;
  }
  if (!(err instanceof Error)) {
    return undefined;
  }
  if (
    err.name === "FirewallRuleValidationError" ||
    err.name === "TlsRuleValidationError" ||
    err.name === "TlsForwardAuthValidationError"
  ) {
    return new SandboxError("Validation", err.message, {
      cause: err,
      provider: NAME,
    });
  }
  if (err.name === "FreestyleTransportError") {
    return new SandboxError("Provider", err.message, {
      cause: err,
      provider: NAME,
      retryable: true,
    });
  }
  const status = errStatus(err);
  if (status === undefined) {
    return undefined;
  }
  const code = String((err as { code?: unknown }).code ?? "");
  const init = { cause: err, provider: NAME, status };
  if (status === 401 || status === 403) {
    return new SandboxError("Unauthorized", err.message, init);
  }
  if (status === 404) {
    return new SandboxError("NotFound", err.message, init);
  }
  if (status === 409) {
    return new SandboxError("Conflict", err.message, init);
  }
  if (status === 429 || /QUOTA|LIMIT/.test(code)) {
    return new SandboxError("QuotaExceeded", err.message, {
      ...init,
      retryable: status === 429,
    });
  }
  if (status === 408 || status === 504 || /TIMEOUT/.test(code)) {
    return new SandboxError("Timeout", err.message, init);
  }
  if (status === 400 || status === 422) {
    return new SandboxError("Validation", err.message, init);
  }
  return undefined;
}

function wrap(err: unknown): SandboxError {
  return mapFreestyleError(err) ?? SandboxError.wrap(err, NAME);
}

async function toUploadBody(
  body: FileBody
): Promise<string | Uint8Array | Blob> {
  if (typeof body === "string" || body instanceof Uint8Array) {
    return body;
  }
  return new Response(body).blob();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
}

/** `cd`/`export` prefix plus a command (or a login shell) for a PTY `exec`. */
export function ptyCommand(
  o: Pick<PtyOptions, "cmd" | "cwd" | "env">,
  baseEnv: Record<string, string>
): string | undefined {
  const env = { ...baseEnv, ...o.env };
  const prefix: string[] = [];
  if (o.cwd) {
    prefix.push(`cd ${shellQuote(o.cwd)}`);
  }
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      throw new SandboxError("Validation", `invalid env var name '${k}'`, {
        provider: NAME,
      });
    }
    prefix.push(`export ${k}=${shellQuote(v)}`);
  }
  if (prefix.length === 0) {
    return o.cmd;
  }
  return `${prefix.join(" && ")} && exec ${o.cmd ?? `"\${SHELL:-/bin/sh}" -l`}`;
}

/**
 * Map a Dockerfile `FROM` onto a Freestyle snapshot. Freestyle boots VM
 * snapshots, not OCI images: `freestyle/*` and your own snapshot ids/slugs are
 * used as-is, `ubuntu`/`ubuntu:24.04` map to the Ubuntu base (sized by
 * `resources`), `busybox` to `freestyle/busybox`. Anything else is refused.
 */
export function resolveFrom(
  image: string,
  resources?: ResourceSpec
): string | undefined {
  const ref = image.trim();
  if (
    ref.startsWith("freestyle/") ||
    /^sh-[\w-]+$/.test(ref) ||
    ref.startsWith("sbox-")
  ) {
    return ref;
  }
  const [repoRaw, tag] = ref.split(":");
  const repo = (repoRaw ?? "").replace(/^(docker\.io\/)?(library\/)?/, "");
  if (
    repo === "ubuntu" &&
    (!tag || ["latest", "24.04", "noble"].includes(tag))
  ) {
    return pickBaseSnapshot(resources) ?? "freestyle/ubuntu";
  }
  if (repo === "busybox") {
    return "freestyle/busybox";
  }
  throw new NotSupportedError(
    NAME,
    `templates.build({ dockerfile }) with FROM ${image} (Freestyle boots VM snapshots, not OCI images; use FROM ubuntu:24.04, busybox, freestyle/<base> or a snapshot id)`
  );
}

// --------------------------------------------------------------------------
// provider
// --------------------------------------------------------------------------

export function freestyle(
  opts: FreestyleOptions = {}
): SandboxProvider<FreestyleCaps, Vm> {
  const execTimeout = opts.execTimeoutMs ?? 300_000;
  const previewDomain = opts.previewDomain ?? "style.dev";
  let clientPromise: Promise<Freestyle> | undefined;
  const client = (): Promise<Freestyle> => {
    clientPromise ??= import("freestyle").then(
      (m) =>
        new m.Freestyle({
          ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
          ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
        })
    );
    return clientPromise;
  };

  const readEnv = async (vm: Vm): Promise<Record<string, string>> => {
    try {
      const parsed: unknown = JSON.parse(await vm.fs.readTextFile(ENV_FILE));
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  };

  const pageAll = async <T>(
    fetchPage: (offset: number) => Promise<{ items: T[]; total: number }>
  ): Promise<T[]> => {
    const out: T[] = [];
    for (let offset = 0; ; ) {
      const { items, total } = await fetchPage(offset);
      out.push(...items);
      offset += items.length;
      if (items.length === 0 || offset >= total) {
        return out;
      }
    }
  };

  const vmRules = async (fs: Freestyle, vmId: string) => {
    const [firewall, tls] = await Promise.all([
      pageAll<FirewallRuleData>(async (offset) => {
        const r = await fs.firewall.rules.list({ limit: PAGE, offset, vmId });
        return { items: r.rules, total: r.totalCount };
      }),
      pageAll<TlsRuleData>(async (offset) => {
        const r = await fs.tls.rules.list({ limit: PAGE, offset, vmId });
        return { items: r.rules, total: r.totalCount };
      }),
    ]);
    return { firewall, tls };
  };

  const previewOf = (r: TlsRuleData): Preview => ({
    auth: { type: "public" },
    port: r.destination.port!,
    url: `https://${r.domain}`,
  });

  const makeHandle = (
    vm: Vm,
    initial: VmData,
    envInit: Record<string, string>,
    policyInit: EgressPolicy | undefined
  ): DriverHandle<Vm> => {
    const id = initial.id;
    const env = envInit;
    let policy = policyInit;
    const identities: string[] = [];

    const killTree = async (pidFile: string): Promise<void> => {
      let pid = "";
      for (let i = 0; i < 20 && !pid; i++) {
        try {
          pid = (await vm.fs.readTextFile(pidFile)).trim();
        } catch {
          await sleep(100);
        }
      }
      if (!/^\d+$/.test(pid)) {
        return;
      }
      await vm.exec({
        command: `__k(){ for __c in $(pgrep -P "$1"); do __k "$__c"; done; kill -9 "$1"; }; __k ${pid} 2>/dev/null; rm -f ${pidFile}; true`,
        linuxUser: "root",
        timeoutMs: 15_000,
      });
    };

    const exec = (cmd: string, o: ExecOptions): DriverExec => {
      const tag = globalThis.crypto.randomUUID().slice(0, 12);
      const pidFile = `/tmp/.sbox-exec-${tag}.pid`;
      const queue = new AsyncQueue<OutputEvent>();
      let killed = false;
      let done = false;
      const runEnv = { ...env, ...o.env };
      const timeoutMs = o.timeoutMs ?? execTimeout;
      void vm
        .exec({
          command: `echo $$ > ${pidFile}; sh -c ${shellQuote(cmd)}; __r=$?; rm -f ${pidFile}; exit $__r`,
          timeoutMs,
          ...(Object.keys(runEnv).length > 0 ? { env: runEnv } : {}),
          ...(o.user ? { linuxUser: o.user } : {}),
        })
        .then((r) => {
          done = true;
          if (r.stdout) {
            queue.push({ data: r.stdout, type: "stdout" });
          }
          if (r.stderr) {
            queue.push({ data: r.stderr, type: "stderr" });
          }
          if (r.statusCode === null || r.statusCode === undefined) {
            if (killed) {
              queue.push({ exitCode: 137, signal: "SIGKILL", type: "exit" });
            } else {
              queue.fail(
                new SandboxError(
                  "Timeout",
                  `command timed out after ${timeoutMs}ms`,
                  { provider: NAME, timedOut: true }
                )
              );
              return;
            }
          } else {
            queue.push({ exitCode: r.statusCode, type: "exit" });
          }
          queue.close();
        })
        .catch((error: unknown) => {
          done = true;
          queue.fail(wrap(error));
        });
      return {
        [Symbol.asyncIterator]: () => queue.iterator(),
        async kill() {
          if (done || killed) {
            return;
          }
          killed = true;
          await killTree(pidFile);
        },
        pid: Promise.resolve(tag),
      };
    };

    const wrapPty = (
      session: PtySession,
      out: AsyncQueue<Uint8Array>,
      exited: Promise<number>,
      settle: (code: number) => void
    ): DriverPty => ({
      id: session.slug ?? String(session.sessionId),
      async kill() {
        const res = await vm.pty.close(session.sessionId);
        settle(res.exitCode ?? 137);
      },
      output: { [Symbol.asyncIterator]: () => out.iterator() },
      async resize(cols, rows) {
        session.resize({ cols, rows });
      },
      wait: () => exited,
      async write(data) {
        session.write(data);
      },
    });

    const ptyEvents = (): {
      events: PtySessionEvents;
      out: AsyncQueue<Uint8Array>;
      exited: Promise<number>;
      settle: (code: number) => void;
    } => {
      const out = new AsyncQueue<Uint8Array>();
      let resolve!: (n: number) => void;
      let finished = false;
      const exited = new Promise<number>((r) => {
        resolve = r;
      });
      const settle = (code: number): void => {
        if (!finished) {
          finished = true;
          resolve(code);
          out.close();
        }
      };
      return {
        events: {
          onClose: () => out.close(),
          onData: (data) => out.push(data),
          onExit: (code) => settle(code),
        },
        exited,
        out,
        settle,
      };
    };

    const handle: DriverHandle<Vm> = {
      async connectPty(ptyId) {
        const { events, exited, out, settle } = ptyEvents();
        const session = await vm.pty.attach({
          session: /^\d+$/.test(ptyId) ? Number(ptyId) : ptyId,
          ...events,
        });
        return wrapPty(session, out, exited, settle);
      },
      async createPty(o) {
        const { events, exited, out, settle } = ptyEvents();
        const command = ptyCommand(o, env);
        const target = o.user ? vm.linuxUser(o.user).pty : vm.pty;
        const session = await target.open({
          ...(o.cols ? { cols: o.cols } : {}),
          ...(o.rows ? { rows: o.rows } : {}),
          ...(command ? { exec: command } : {}),
          ...events,
        });
        return wrapPty(session, out, exited, settle);
      },
      async createSsh() {
        const fs = await client();
        const { identity, identityId } = await fs.identities.create();
        identities.push(identityId);
        await identity.permissions.vm.grant({ vmId: id });
        const { token } = await identity.tokens.create();
        // Freestyle SSH authenticates with a scoped token in the username,
        // not a key pair: `ssh <vm>:<token>@beta-ssh.freestyle.sh`.
        return {
          host: SSH_HOST,
          port: 22,
          privateKey: "",
          user: `${id}:${token}`,
        };
      },
      async deleteSnapshot(ref) {
        const fs = await client();
        await fs.vms.snapshots.delete(ref);
      },
      async destroy() {
        await vm.delete();
        if (identities.length > 0) {
          const fs = await client();
          await Promise.all(
            identities.map((i) => fs.identities.delete(i).catch(() => {}))
          );
        }
      },
      async download(path, ctx) {
        return vm.fs.readFileStream(
          path,
          ctx.signal ? { signal: ctx.signal } : {}
        );
      },
      exec: (cmd, o) => exec(cmd, o),
      async exposePort(port) {
        const fs = await client();
        const { tls } = await vmRules(fs, id);
        const existing = tls.find(
          (r) => isIngressTls(r, id) && r.destination.port === port
        );
        if (existing) {
          return previewOf(existing);
        }
        const rule = await fs.tls.rules.create({
          action: "allow",
          destination: { port, vmId: id },
          domain: `sbox-${port}-${randomLabel()}.${previewDomain}`,
          source: { public: true },
        });
        return previewOf(rule);
      },
      async fork(count) {
        const fs = await client();
        const data = await vm.data();
        const childPolicy = policy ?? (await currentPolicy(fs, id));
        const snap = await vm.snapshot({ displayName: `sbox fork of ${id}` });
        try {
          const results = await Promise.allSettled(
            Array.from({ length: count }, () =>
              createVm(
                {
                  fromSnapshot: snap.snapshotId,
                  metadata: stripInternal(data.metadata ?? {}),
                  network: childPolicy,
                },
                undefined,
                undefined,
                env
              )
            )
          );
          const failed = results.find((r) => r.status === "rejected");
          if (failed) {
            for (const r of results) {
              if (r.status === "fulfilled") {
                await Promise.resolve(
                  r.value.destroy({ attempt: 1, fetch: globalThis.fetch })
                ).catch(() => {});
              }
            }
            throw (failed as PromiseRejectedResult).reason;
          }
          return results.map(
            (r) => (r as PromiseFulfilledResult<DriverHandle<Vm>>).value
          );
        } finally {
          await fs.vms.snapshots.delete(snap.snapshotId).catch(() => {});
        }
      },
      async getInfo() {
        return toInfo(await vm.data());
      },
      id,
      async listDir(path) {
        const entries = await vm.fs.readDir(path);
        return entries.map(
          (e): DirEntry => ({
            name: e.name,
            path: joinPath(path, e.name),
            type:
              e.kind === "directory"
                ? "dir"
                : e.kind === "symlink"
                  ? "symlink"
                  : "file",
          })
        );
      },
      async listPorts() {
        const fs = await client();
        const { tls } = await vmRules(fs, id);
        return tls.filter((r) => isIngressTls(r, id)).map(previewOf);
      },
      async listSnapshots() {
        const fs = await client();
        const all = await pageAll<SnapshotData>(async (offset) => {
          const r = await fs.vms.snapshots.list({
            limit: PAGE,
            offset,
            sourceVmId: id,
          });
          return { items: r.snapshots, total: r.totalCount };
        });
        return all.map(toSnapRef);
      },
      async mkdir(path) {
        await vm.fs.mkdir(path);
      },
      ...(initial.displayName ? { name: initial.displayName } : {}),
      async pause() {
        await vm.pause();
      },
      raw: vm,
      readFile(path, ctx) {
        return vm.fs.readFile(path, ctx.signal ? { signal: ctx.signal } : {});
      },
      async remove(path, recursive) {
        try {
          if (!recursive && (await vm.fs.stat(path)).isDirectory) {
            throw new SandboxError(
              "Validation",
              `'${path}' is a directory (pass recursive: true)`,
              { provider: NAME }
            );
          }
          await vm.fs.remove(path);
        } catch (error) {
          if (!isNotFound(error)) {
            throw error;
          }
        }
      },
      async resume() {
        await vm.start();
      },
      async setEgressPolicy(next) {
        const rules = egressRules(next, { vmId: id });
        const fs = await client();
        const current = await vmRules(fs, id);
        for (const r of current.firewall) {
          if (r.description === EGRESS_TAG) {
            await fs.firewall.rules.delete(r.id);
          }
        }
        for (const r of current.tls) {
          if (isEgressTls(r, id)) {
            await fs.tls.rules.delete(r.id);
          }
        }
        for (const r of rules.firewall) {
          await fs.firewall.rules.create(r);
        }
        for (const r of rules.tls) {
          await fs.tls.rules.create(r);
        }
        policy = next;
      },
      async setTimeout(ttlMs) {
        const { createdAt } = await vm.data();
        await vm.update({
          ttlSeconds: Math.max(
            1,
            Math.ceil((Date.now() + ttlMs - Date.parse(createdAt)) / 1000)
          ),
        });
      },
      async snapshot(o) {
        const created = await vm.snapshot(
          o.name ? { displayName: o.name } : {}
        );
        return toSnapRef(created.snapshot);
      },
      async stat(path): Promise<FileInfo> {
        const s = await vm.fs.stat(path);
        return {
          path,
          size: s.size,
          type: s.isDirectory ? "dir" : s.isSymlink ? "symlink" : "file",
          ...(s.modified ? { mtime: new Date(s.modified) } : {}),
        };
      },
      async unexposePort(port) {
        const fs = await client();
        const { tls } = await vmRules(fs, id);
        for (const r of tls) {
          if (isIngressTls(r, id) && r.destination.port === port) {
            await fs.tls.rules.delete(r.id);
          }
        }
      },
      async upload(path, body, ctx) {
        await vm.fs.writeFile(
          path,
          await toUploadBody(body),
          ctx.signal ? { signal: ctx.signal } : {}
        );
      },
      async writeFile(path, data, ctx) {
        await vm.fs.writeFile(
          path,
          data,
          ctx.signal ? { signal: ctx.signal } : {}
        );
      },
    };
    return handle;
  };

  /** Rebuild the egress policy of a VM this handle didn't create. */
  const currentPolicy = async (
    fs: Freestyle,
    vmId: string
  ): Promise<EgressPolicy> => {
    const { firewall, tls } = await vmRules(fs, vmId);
    const mine = firewall.filter((r) => r.description === EGRESS_TAG);
    if (mine.some((r) => r.destination.public)) {
      return { mode: "allow-all" };
    }
    const cidrs = mine.flatMap((r) =>
      r.destination.cidr ? [r.destination.cidr] : []
    );
    // Injected header values read back redacted, so only plain allows carry over.
    const domains = tls
      .filter((r) => isEgressTls(r, vmId) && !r.transform?.length)
      .map((r) => r.domain);
    return cidrs.length || domains.length
      ? { cidrs, domains, mode: "allow-list" }
      : { mode: "block-all" };
  };

  const toSnapRef = (s: SnapshotData): SnapshotRef => {
    const name = s.displayName ?? s.slug ?? undefined;
    return {
      createdAt: new Date(s.createdAt),
      id: s.id,
      includesMemory: true,
      provider: NAME,
      raw: s,
      ...(name ? { name } : {}),
    };
  };

  /** Validate, translate and create one VM. */
  const createVm = async (
    spec: ResolvedSandboxSpec,
    ctx: CallContext | undefined,
    slug: string | undefined,
    inheritedEnv?: Record<string, string>
  ): Promise<DriverHandle<Vm>> => {
    if (spec.volumes?.length) {
      throw new NotSupportedError(NAME, "volumes");
    }
    if (spec.region) {
      throw new NotSupportedError(NAME, "region");
    }
    if (spec.resources?.gpu || spec.resources?.gpuCount) {
      throw new NotSupportedError(NAME, "GPUs");
    }
    if (spec.template && spec.fromSnapshot) {
      throw new SandboxError(
        "Validation",
        "template and fromSnapshot are mutually exclusive",
        { provider: NAME }
      );
    }
    const secretEnv: Record<string, string> = {};
    for (const s of spec.secrets ?? []) {
      if (s.value === undefined) {
        throw new NotSupportedError(
          NAME,
          `stored secrets ('${s.name}'): Freestyle has no secret store; pass a value, or inject it at the edge with network.inject`
        );
      }
      if ((s.mode ?? "env") === "egress") {
        throw new SandboxError(
          "Validation",
          `secret '${s.name}' has mode "egress": declare where it goes with network.inject instead`,
          { provider: NAME }
        );
      }
      secretEnv[s.envVar ?? s.name] = s.value;
    }
    const egress = egressRules(spec.network, {});
    const portRules: CreateTlsRuleOptions[] = (spec.ports ?? []).map(
      (port) => ({
        action: "allow",
        destination: { port },
        domain: `sbox-${port}-${randomLabel()}.${previewDomain}`,
        source: { public: true },
      })
    );
    const tlsRules = [...egress.tls, ...portRules];
    const fs = await client();
    const idem = ctx?.idempotencyKey
      ? (await sha256Hex(ctx.idempotencyKey)).slice(0, 32)
      : undefined;
    if (idem && ctx && ctx.attempt > 1) {
      const { vms } = await fs.vms.list({
        limit: 1,
        metadata: `${IDEM_KEY}:${idem}`,
      });
      const found = vms[0];
      if (found) {
        const ref = fs.vms.ref(found.id);
        return makeHandle(ref, found, await readEnv(ref), spec.network);
      }
    }
    const base =
      spec.fromSnapshot ?? spec.template ?? pickBaseSnapshot(spec.resources);
    const createOpts: CreateVmOptions = {
      firewall: { rules: egress.firewall },
      metadata: { ...spec.metadata, ...(idem ? { [IDEM_KEY]: idem } : {}) },
      ...(tlsRules.length > 0 ? { tls: { rules: tlsRules } } : {}),
      ...(base ? { snapshotId: base } : {}),
      ...(slug ? { slug } : {}),
      ...(spec.name ? { displayName: spec.name } : {}),
      ...lifecycleOptions(spec.lifecycle),
    };
    const created = await fs.vms.create(createOpts);
    const { vm } = created;
    try {
      let data = created.data;
      const fromImage = spec.fromSnapshot ?? spec.template;
      if (fromImage && spec.resources) {
        const grow: Partial<VmResources> = {};
        const r = spec.resources;
        if (r.vcpus && r.vcpus > data.resources.cpu) {
          grow.cpu = r.vcpus;
        }
        if (r.memoryMB && r.memoryMB > data.resources.memory) {
          grow.memory = r.memoryMB;
        }
        if (r.diskMB && r.diskMB > data.resources.storage) {
          grow.storage = r.diskMB;
        }
        if (Object.keys(grow).length > 0) {
          data = await vm.resize(grow);
        }
      }
      const own = { ...spec.env, ...secretEnv };
      const baseEnv = inheritedEnv ?? (fromImage ? await readEnv(vm) : {});
      const env = { ...baseEnv, ...own };
      if (Object.keys(own).length > 0) {
        await vm.fs.writeFile(ENV_FILE, JSON.stringify(env));
      }
      return makeHandle(vm, data, env, spec.network);
    } catch (error) {
      await vm.delete().catch(() => {});
      throw error;
    }
  };

  const templates: DriverTemplates = {
    async build(spec, { onEvent, signal }) {
      const fs = await client();
      const slug = defaultTemplateName(spec.cacheKey);
      const existing = await fs.vms.snapshots
        .get(slug)
        .catch((error: unknown) => {
          if (isNotFound(error)) {
            return undefined;
          }
          throw error;
        });
      if (existing) {
        return toTemplateRef(existing, spec.cacheKey, spec.name);
      }
      return emulatedBuild(fs, spec, slug, onEvent, signal);
    },
    async delete(id) {
      const fs = await client();
      await fs.vms.snapshots.delete(id);
    },
    async *list() {
      const fs = await client();
      for (let offset = 0; ; ) {
        const { snapshots, totalCount } = await fs.vms.snapshots.list({
          limit: PAGE,
          offset,
        });
        for (const s of snapshots) {
          if (s.slug && /^sbox-[0-9a-f]{16}$/.test(s.slug)) {
            yield toTemplateRef(s, undefined, undefined);
          }
        }
        offset += snapshots.length;
        if (snapshots.length === 0 || offset >= totalCount) {
          return;
        }
      }
    },
    async lookup(idOrKey) {
      const fs = await client();
      const isKey = /^[0-9a-f]{64}$/.test(idOrKey);
      try {
        const s = await fs.vms.snapshots.get(
          isKey ? defaultTemplateName(idOrKey) : idOrKey
        );
        return toTemplateRef(s, isKey ? idOrKey : undefined, undefined);
      } catch (error) {
        if (isNotFound(error)) {
          return undefined;
        }
        throw error;
      }
    },
  };

  const toTemplateRef = (
    s: SnapshotData,
    cacheKey: string | undefined,
    name: string | undefined
  ): TemplateRef => {
    const label = name ?? s.displayName ?? s.slug ?? undefined;
    return {
      createdAt: new Date(s.createdAt),
      id: s.id,
      provider: NAME,
      raw: s,
      ...(label ? { name: label } : {}),
      ...(cacheKey ? { cacheKey } : {}),
    };
  };

  /**
   * Emulated build: boot a base VM, apply the Dockerfile steps through exec
   * and the filesystem API, start `startCmd`, wait for `readyCmd`, snapshot
   * (memory included, so the started process is live in every sandbox), and
   * delete the build VM.
   */
  const emulatedBuild = async (
    fs: Freestyle,
    spec: TemplateSpec & { cacheKey: string; name: string },
    slug: string,
    onEvent: (e: TemplateBuildEvent) => void,
    signal: AbortSignal | undefined
  ): Promise<TemplateRef> => {
    if (spec.resources?.gpu || spec.resources?.gpuCount) {
      throw new NotSupportedError(NAME, "GPU templates");
    }
    const src = spec.source;
    let base: string | undefined;
    let instructions: ReturnType<typeof parseDockerfile> = [];
    let context = new Map<string, Uint8Array>();
    if ("snapshot" in src && src.snapshot !== undefined) {
      base = src.snapshot;
    } else if ("dockerfile" in src && src.dockerfile !== undefined) {
      instructions = parseDockerfile(src.dockerfile);
      const from = instructions.filter((i) => i.op === "FROM");
      if (from.length !== 1) {
        throw new NotSupportedError(
          NAME,
          from.length === 0
            ? "a Dockerfile without FROM"
            : "multi-stage Dockerfiles"
        );
      }
      const [image] = tokenize(splitFlags(from[0]!.args).rest);
      base = resolveFrom(image ?? "", spec.resources);
      context = await loadTemplateContext(src.context);
    } else {
      throw new NotSupportedError(NAME, "templates.build({ image })");
    }
    onEvent({ status: "building", type: "status" });
    const { vm, data } = await fs.vms.create({
      displayName: `sbox template build ${spec.name}`.slice(0, 63),
      firewall: {
        rules: [{ action: "allow", destination: { public: true }, source: {} }],
      },
      metadata: { "sbox-template-build": slug },
      ttlSeconds: 6 * 3600,
      ...(base ? { snapshotId: base } : {}),
    });
    const log = (line: string, step?: string, stream?: "stdout" | "stderr") => {
      for (const l of line.split("\n")) {
        if (l) {
          onEvent({
            line: l,
            type: "log",
            ...(step ? { step } : {}),
            ...(stream ? { stream } : {}),
          });
        }
      }
    };
    try {
      const r = spec.resources;
      const grow: Partial<VmResources> = {};
      if (r?.vcpus && r.vcpus > data.resources.cpu) {
        grow.cpu = r.vcpus;
      }
      if (r?.memoryMB && r.memoryMB > data.resources.memory) {
        grow.memory = r.memoryMB;
      }
      if (r?.diskMB && r.diskMB > data.resources.storage) {
        grow.storage = r.diskMB;
      }
      if (Object.keys(grow).length > 0) {
        await vm.resize(grow);
      }
      const env: Record<string, string> = await readEnv(vm);
      const args = new Map<string, string>();
      let workdir = "/";
      let user = "root";
      let cmd: string | undefined;
      let entrypoint: string | undefined;
      const run = async (command: string, step: string) => {
        if (signal?.aborted) {
          throw new SandboxError("Timeout", "template build aborted", {
            aborted: true,
            provider: NAME,
          });
        }
        const res = await vm.exec({
          command: `cd ${shellQuote(workdir)} && ${command}`,
          linuxUser: user,
          timeoutMs: execTimeout,
          ...(Object.keys(env).length > 0 ? { env } : {}),
        });
        if (res.stdout) {
          log(res.stdout, step, "stdout");
        }
        if (res.stderr) {
          log(res.stderr, step, "stderr");
        }
        if (res.statusCode !== 0) {
          throw new SandboxError(
            "Provider",
            `template build step failed (${res.statusCode === null || res.statusCode === undefined ? "timed out" : `exit ${res.statusCode}`}): ${command.slice(0, 200)}`,
            { provider: NAME, retryable: false }
          );
        }
      };
      const madeDirs = new Set<string>();
      for (const ins of instructions) {
        const text = substituteArgs(ins.args, args);
        if (ins.op !== "FROM") {
          log(ins.raw, ins.op);
        }
        switch (ins.op) {
          case "FROM": {
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
            await run(shellForm(rest), "RUN");
            break;
          }
          case "ENV": {
            for (const [k, v] of parseEnvArgs(text)) {
              env[k] = v;
            }
            break;
          }
          case "WORKDIR": {
            workdir = joinPath(text.startsWith("/") ? "/" : workdir, text);
            await vm.fs.mkdir(workdir);
            madeDirs.add(workdir);
            break;
          }
          case "USER": {
            user = text.split(":")[0] || user;
            break;
          }
          case "COPY":
          case "ADD": {
            const res = resolveCopy(ins.op, text, context, workdir, NAME);
            for (const f of res.files) {
              const dir = f.path.slice(0, f.path.lastIndexOf("/")) || "/";
              if (!madeDirs.has(dir)) {
                await vm.fs.mkdir(dir);
                madeDirs.add(dir);
              }
              await vm.fs.writeFile(
                f.path,
                f.data,
                res.chmod ? { mode: Number.parseInt(res.chmod, 8) } : {}
              );
            }
            if (res.chown && res.files.length > 0) {
              await run(
                `chown ${shellQuote(res.chown)} ${res.files.map((f) => shellQuote(f.path)).join(" ")}`,
                ins.op
              );
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
            log(`ignored Dockerfile instruction: ${ins.op}`);
            break;
          }
        }
      }
      Object.assign(env, spec.env);
      if (spec.workdir) {
        workdir = spec.workdir;
        await vm.fs.mkdir(workdir);
      }
      if (spec.user) {
        user = spec.user;
      }
      if (Object.keys(env).length > 0) {
        await vm.fs.writeFile(ENV_FILE, JSON.stringify(env));
      }
      const start =
        spec.startCmd ??
        (entrypoint && cmd ? `${entrypoint} ${cmd}` : (entrypoint ?? cmd));
      if (start) {
        await run(
          `nohup sh -c ${shellQuote(start)} > /tmp/sbox-start.log 2>&1 &`,
          "startCmd"
        );
      }
      if (spec.readyCmd) {
        const deadline = Date.now() + 10 * 60_000;
        for (;;) {
          const res = await vm.exec({
            command: `cd ${shellQuote(workdir)} && ${spec.readyCmd}`,
            linuxUser: user,
            timeoutMs: 30_000,
            ...(Object.keys(env).length > 0 ? { env } : {}),
          });
          if (res.statusCode === 0) {
            break;
          }
          if (Date.now() > deadline) {
            throw new SandboxError(
              "Timeout",
              "readyCmd did not succeed in 10 minutes",
              {
                provider: NAME,
              }
            );
          }
          await sleep(2000);
        }
      }
      const snap = await vm.snapshot({ displayName: spec.name, slug });
      return toTemplateRef(snap.snapshot, spec.cacheKey, spec.name);
    } finally {
      await vm.delete().catch(() => {});
    }
  };

  const provider: SandboxProvider<FreestyleCaps, Vm> = {
    capabilities: FREESTYLE_CAPS,
    async connect(id) {
      const fs = await client();
      const data = await fs.vms.get(id);
      const vm = fs.vms.ref(data.id);
      return makeHandle(vm, data, await readEnv(vm), undefined);
    },
    create: (spec, ctx) => createVm(spec, ctx, undefined),
    flags: FREESTYLE_FLAGS,
    async getOrCreate(spec, ctx) {
      const fs = await client();
      const slug = await slugForName(spec.name);
      const attach = async (): Promise<DriverHandle<Vm> | undefined> => {
        try {
          let data = await fs.vms.get(slug);
          const vm = fs.vms.ref(data.id);
          if (data.state === "paused" || data.state === "stopped") {
            data = await vm.start();
          }
          return makeHandle(vm, data, await readEnv(vm), undefined);
        } catch (error) {
          if (isNotFound(error)) {
            return undefined;
          }
          throw error;
        }
      };
      const found = await attach();
      if (found) {
        return found;
      }
      try {
        return await createVm(spec, ctx, slug);
      } catch (error) {
        if (isConflict(error)) {
          const raced = await attach();
          if (raced) {
            return raced;
          }
        }
        throw error;
      }
    },
    async *list(filter: ListFilter | undefined) {
      const fs = await client();
      const state = filter?.state ? STATE_FILTER[filter.state] : undefined;
      if (filter?.state && !state) {
        return;
      }
      const metadata = filter?.metadata
        ? Object.entries(filter.metadata)
            .map(([k, v]) => `${k}:${v}`)
            .join(",")
        : undefined;
      let yielded = 0;
      for (let offset = 0; ; ) {
        const page = await fs.vms.list({
          limit: PAGE,
          offset,
          ...(state ? { state } : {}),
          ...(metadata ? { metadata } : {}),
        });
        for (const d of page.vms) {
          if (state && d.state !== state) {
            continue;
          }
          if (
            filter?.metadata &&
            !Object.entries(filter.metadata).every(
              ([k, v]) => d.metadata?.[k] === v
            )
          ) {
            continue;
          }
          if (filter?.limit !== undefined && yielded >= filter.limit) {
            return;
          }
          yielded++;
          yield toInfo(d);
        }
        offset += page.vms.length;
        if (page.vms.length === 0 || offset >= page.totalCount) {
          return;
        }
      }
    },
    mapError: mapFreestyleError,
    name: NAME,
    templates,
    async verify() {
      const fs = await client();
      await fs.vms.list({ limit: 1 });
      return {};
    },
  };
  return provider;
}
