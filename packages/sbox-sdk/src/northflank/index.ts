/**
 * `sbox-sdk/northflank` — adapter for Northflank (`@northflank/js-client`).
 *
 * A "sandbox" is a Northflank deployment service running an external image
 * with a `sleep infinity` keep-alive command.
 *
 * - exec streams over `apiClient.exec.execServiceSession` (separate stdout and
 *   stderr streams, real exit code, live stdin). Each command records its shell
 *   pid in `/tmp/.sbox-<id>.pid` so `kill()` can SIGKILL the process tree.
 * - PTYs are tty exec sessions (`sendInputToCurrentCommand`, `resizeTerminal`).
 * - Files use the SDK's streaming copy (`upload/download.serviceStream.files`),
 *   which needs `tar` and `cat` in the image.
 * - `pause()` scales to zero (`pause.service`); memory AND the ephemeral disk are
 *   lost (attach a volume to keep data). `resume()` scales back to 1.
 * - Snapshots are Northflank container snapshots (filesystem only; requires a
 *   Kata-backed cluster). `fromSnapshot` and `fork()` use `restoreFrom`.
 * - Metadata is kept in the service description (`sbox:{json}`) so `list()`
 *   can return and filter it without one request per service.
 *
 * Node-only (the SDK uses Node streams and HTTP/2). Requires the optional peer
 * dependency `@northflank/js-client`.
 */
import type {
  CreateServiceDeploymentData,
  ExecCommand,
  GetServiceResult,
  ListServicesResult,
} from "@northflank/js-client";

import {
  AsyncQueue,
  defineProvider,
  SandboxError,
  shellQuote as sq,
} from "../adapter/index.js";
import type {
  CallContext,
  CapabilityFlags,
  CapabilityMap,
  DriverExec,
  DriverHandle,
  DriverPty,
  DriverTemplates,
  ExecOptions,
  OutputEvent,
  Preview,
  PtyOptions,
  ResolvedSandboxSpec,
  SandboxErrorCode,
  SandboxInfo,
  SandboxProvider,
  SandboxState,
  SnapshotRef,
  TemplateRef,
} from "../adapter/index.js";

type NfModule = typeof import("@northflank/js-client");
/** The typed Northflank API client (`new ApiClient(...)`). */
export type NorthflankClient = InstanceType<NfModule["ApiClient"]>;

export interface NorthflankOptions {
  /** Northflank API token. */
  token: string;
  /** Project the sandbox services live in (required). */
  projectId: string;
  /** Team id, for team-scoped tokens that need it. */
  teamId?: string;
  /**
   * Compute plan for new sandboxes. When unset, the smallest known plan that
   * fits `spec.resources` is picked (default "nf-compute-200").
   */
  deploymentPlan?: string;
  /** Default base image (default "ubuntu:22.04"). */
  image?: string;
  /** Saved registry credentials id for private images (`external.credentials`). */
  registryCredentials?: string;
  /** Ephemeral storage in MB when `spec.resources.diskMB` is unset (default 2048). */
  ephemeralStorageMB?: number;
  /** API host override (default: the SDK's https://api.northflank.com). */
  host?: string;
  /** How long `create()` waits for the service to come up (default 300 000). */
  createTimeoutMs?: number;
  /** Poll interval while waiting on deployments/snapshots (default 2000). */
  pollIntervalMs?: number;
}

/** What `sandbox.raw()` returns: the typed client plus the service address. */
export interface NorthflankRaw {
  client: NorthflankClient;
  projectId: string;
  serviceId: string;
}

export const NORTHFLANK_CAPS = {
  background: "unsupported",
  codeInterpreter: "unsupported",
  egressControl: "unsupported",
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "unsupported",
  fork: "native",
  gpu: "native",
  killProcess: "unsupported",
  list: "native",
  metrics: "native",
  pause: "native",
  privatePreview: "native",
  proxiedFetch: "unsupported",
  pty: "native",
  region: "unsupported", // region is fixed by the project's cluster
  secretsVault: "unsupported",
  setTimeout: "unsupported",
  snapshot: "native",
  ssh: "unsupported",
  statefulKernel: "unsupported",
  stdin: "native",
  stop: "unsupported",
  streaming: "native",
  volumes: "unsupported",
  templateBuild: "native",
} as const satisfies CapabilityMap;

export type NorthflankCaps = typeof NORTHFLANK_CAPS;

const NORTHFLANK_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: false, // exec sessions have no cwd/env; the core wraps
  preservesDiskOnStop: false,
  preservesMemoryOnPause: false, // scale-to-zero: memory and ephemeral disk lost
  previewBrowserAuth: false, // private previews use HTTP basic auth (a header)
  previewModel: "subdomain",
  templateSources: ["image"],
};

const P = "northflank";
const META_PREFIX = "sbox:";

let cached: NfModule | null = null;
async function loadNorthflank(): Promise<NfModule> {
  cached ??= await import("@northflank/js-client");
  return cached;
}

// ---------------------------------------------------------------------------
// pure helpers (exported for tests)
// ---------------------------------------------------------------------------

type DeployStatus = NonNullable<
  ListServicesResult["services"][number]["status"]["deployment"]
>;

/**
 * Map a service's deployment status (+ instance count when known) to a
 * `SandboxState`.
 */
export function mapNorthflankState(
  status: DeployStatus | undefined,
  instances?: number
): SandboxState {
  if (instances === 0) {
    return status?.status === "IN_PROGRESS" || status?.status === "PENDING"
      ? "suspending"
      : "paused";
  }
  switch (status?.status) {
    case "COMPLETED": {
      return "running";
    }
    case "PENDING":
    case "IN_PROGRESS": {
      return "creating";
    }
    case "FAILED": {
      return "error";
    }
    default: {
      return status === undefined ? "creating" : "unknown";
    }
  }
}

/** Known Northflank compute plans: [id, vCPU, memory MB]. */
const PLANS: [string, number, number][] = [
  ["nf-compute-10", 0.1, 256],
  ["nf-compute-20", 0.2, 512],
  ["nf-compute-50", 0.5, 1024],
  ["nf-compute-100-1", 1, 1024],
  ["nf-compute-100-2", 1, 2048],
  ["nf-compute-100-4", 1, 4096],
  ["nf-compute-200", 2, 4096],
  ["nf-compute-200-8", 2, 8192],
  ["nf-compute-200-16", 2, 16_384],
  ["nf-compute-400", 4, 8192],
  ["nf-compute-400-16", 4, 16_384],
  ["nf-compute-800-16", 8, 16_384],
  ["nf-compute-800-32", 8, 32_768],
];

/** Smallest known plan with at least `vcpus` and `memoryMB`. */
export function pickPlan(vcpus?: number, memoryMB?: number): string {
  if (vcpus === undefined && memoryMB === undefined) {
    return "nf-compute-200";
  }
  const fit = PLANS.find(
    ([, c, m]) => c >= (vcpus ?? 0) && m >= (memoryMB ?? 0)
  );
  return fit?.[0] ?? PLANS.at(-1)![0];
}

function encodeMeta(meta: Record<string, string> | undefined): string {
  return meta && Object.keys(meta).length > 0
    ? `${META_PREFIX}${JSON.stringify(meta)}`
    : "";
}

function decodeMeta(desc: string | undefined): Record<string, string> {
  if (!desc?.startsWith(META_PREFIX)) {
    return {};
  }
  try {
    return JSON.parse(desc.slice(META_PREFIX.length)) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Service ids are lowercase slugs; keep names id-shaped so name === id. */
function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]+/g, "-")
      .replaceAll(/^-+|-+$/g, "")
      .slice(0, 39) || "sandbox"
  );
}

async function idemName(key: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key)
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sbox-${hex.slice(0, 16)}`;
}

/** Template ids: the image path, plus `#sbox:<b64url json>` for extras. */
interface TemplateExtras {
  env?: Record<string, string>;
  startCmd?: string;
  workdir?: string;
}
const TPL_SEP = "#sbox:";

function encodeTemplate(image: string, extras: TemplateExtras): string {
  const clean = Object.fromEntries(
    Object.entries(extras).filter(([, v]) => v !== undefined)
  );
  if (Object.keys(clean).length === 0) {
    return image;
  }
  const b64 = btoa(
    String.fromCodePoint(...new TextEncoder().encode(JSON.stringify(clean)))
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `${image}${TPL_SEP}${b64}`;
}

export function decodeTemplate(id: string): {
  image: string;
  extras: TemplateExtras;
} {
  const i = id.indexOf(TPL_SEP);
  if (i === -1) {
    return { extras: {}, image: id };
  }
  const b64 = id
    .slice(i + TPL_SEP.length)
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.codePointAt(0) ?? 0);
    return {
      extras: JSON.parse(new TextDecoder().decode(bytes)) as TemplateExtras,
      image: id.slice(0, i),
    };
  } catch {
    return { extras: {}, image: id.slice(0, i) };
  }
}

function errStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status?: unknown }).status;
    return typeof s === "number" ? s : undefined;
  }
  return undefined;
}

/** Normalize Northflank SDK errors (NorthflankApiCallError has `status`). */
export function mapNorthflankError(err: unknown): SandboxError | undefined {
  if (err instanceof SandboxError) {
    return err;
  }
  if (!(err instanceof Error) && errStatus(err) === undefined) {
    return undefined;
  }
  const status = errStatus(err);
  const message = err instanceof Error ? err.message : String(err);
  let code: SandboxErrorCode = "Provider";
  if (status === 401 || status === 403) {
    code = "Unauthorized";
  } else if (status === 404 || /must be a file|does not exist/i.test(message)) {
    code = "NotFound";
  } else if (status === 409 || /already exists/i.test(message)) {
    code = "Conflict";
  } else if (status === 429 || /quota|limit reached/i.test(message)) {
    code = "QuotaExceeded";
  } else if (status === 408 || /timed out/i.test(message)) {
    code = "Timeout";
  } else if (status === 400 || status === 422) {
    code = "Validation";
  }
  return new SandboxError(code, message, {
    cause: err,
    provider: P,
    retryable:
      code === "QuotaExceeded" ||
      code === "Timeout" ||
      (code === "Provider" && (status === undefined || status >= 500)),
    status,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deploymentOf(
  svc: GetServiceResult
): { instances: number; status?: DeployStatus } | undefined {
  if (svc.serviceType === "build") {
    return undefined;
  }
  return { instances: svc.deployment.instances, status: svc.status.deployment };
}

const KILL_TREE = (pidFile: string, signal = "KILL") =>
  `k(){ for c in $(cat /proc/$1/task/*/children 2>/dev/null); do k $c; done; kill -s ${signal} $1 2>/dev/null; }; p=$(cat ${sq(pidFile)} 2>/dev/null) && k $p; rm -f ${sq(pidFile)}`;

// ---------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------

export const northflank = defineProvider<
  NorthflankCaps,
  NorthflankRaw,
  NorthflankOptions
>((opts) => {
  const { projectId } = opts;
  const team = opts.teamId ? { teamId: opts.teamId } : {};
  const pollMs = opts.pollIntervalMs ?? 2000;

  let clientP: Promise<NorthflankClient> | null = null;
  const getClient = (): Promise<NorthflankClient> => {
    clientP ??= (async () => {
      const mod = await loadNorthflank();
      const ctx = new mod.ApiClientInMemoryContextProvider();
      ctx.addContext({
        name: "sbox",
        token: opts.token,
        ...(opts.host ? { host: opts.host } : {}),
      });
      return new mod.ApiClient(ctx, { throwErrorOnHttpErrorCode: true });
    })();
    clientP.catch(() => {
      clientP = null;
    });
    return clientP;
  };

  const svcParams = (serviceId: string) => ({ ...team, projectId, serviceId });

  async function waitRunning(
    client: NorthflankClient,
    serviceId: string,
    timeoutMs = opts.createTimeoutMs ?? 300_000
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await client.get.service({
        parameters: svcParams(serviceId),
      });
      const d = deploymentOf(res.data);
      const state = mapNorthflankState(d?.status, d?.instances);
      if (state === "running") {
        return;
      }
      if (state === "error") {
        throw new SandboxError(
          "Provider",
          `service ${serviceId} failed to deploy`,
          { provider: P }
        );
      }
      if (Date.now() > deadline) {
        throw new SandboxError(
          "Timeout",
          `service ${serviceId} not running after ${timeoutMs}ms`,
          { provider: P }
        );
      }
      await sleep(pollMs);
    }
  }

  function buildData(
    spec: ResolvedSandboxSpec,
    name: string
  ): CreateServiceDeploymentData {
    if (spec.network && spec.network.mode !== "allow-all") {
      throw new SandboxError(
        "Validation",
        "northflank has no per-service egress policy",
        { provider: P }
      );
    }
    const env: Record<string, string> = {};
    const tpl = decodeTemplate(spec.template ?? opts.image ?? "ubuntu:22.04");
    Object.assign(env, tpl.extras.env, spec.env);
    for (const s of spec.secrets ?? []) {
      if (s.value === undefined || s.mode === "egress") {
        throw new SandboxError(
          "Validation",
          "northflank secrets must be inline values (mode 'env'); use a Northflank secret group for vault-managed secrets",
          { provider: P }
        );
      }
      env[s.envVar ?? s.name] = s.value;
    }
    const r = spec.resources;
    const keepAlive = tpl.extras.startCmd
      ? `${tpl.extras.workdir ? `cd ${sq(tpl.extras.workdir)} && ` : ""}${tpl.extras.startCmd}`
      : "sleep infinity";
    const maxAgeSec = spec.lifecycle?.maxAgeMs
      ? Math.min(
          Math.max(Math.ceil(spec.lifecycle.maxAgeMs / 1000), 300),
          604_800
        )
      : undefined;
    const gpu = r?.gpu
      ? {
          configuration: { gpuCount: r.gpuCount ?? 1, gpuType: r.gpu },
          enabled: true,
        }
      : undefined;
    return {
      billing: {
        deploymentPlan: opts.deploymentPlan ?? pickPlan(r?.vcpus, r?.memoryMB),
        ...(gpu ? { gpu } : {}),
      },
      ...(spec.volumes?.length || maxAgeSec
        ? {
            createOptions: {
              ...(maxAgeSec ? { expiryTime: maxAgeSec } : {}),
              ...(spec.volumes?.length
                ? { volumesToAttach: spec.volumes.map((v) => v.id) }
                : {}),
            },
          }
        : {}),
      deployment: {
        ...(spec.fromSnapshot
          ? { containerSnapshot: { restoreFrom: spec.fromSnapshot } }
          : {}),
        docker: { configType: "customCommand", customCommand: keepAlive },
        external: {
          imagePath: tpl.image,
          ...(opts.registryCredentials
            ? { credentials: opts.registryCredentials }
            : {}),
        },
        instances: 1,
        storage: {
          ephemeralStorage: {
            storageSize: r?.diskMB ?? opts.ephemeralStorageMB ?? 2048,
          },
          ...(r?.shmMB ? { shmSize: r.shmMB } : {}),
        },
      },
      description: encodeMeta(spec.metadata),
      name,
      ...(spec.ports?.length
        ? {
            ports: spec.ports.map((port) => ({
              internalPort: port,
              name: `p${port}`,
              protocol: "HTTP" as const,
              public: true,
            })),
          }
        : {}),
      runtimeEnvironment: env,
    };
  }

  async function mountVolumes(
    client: NorthflankClient,
    spec: ResolvedSandboxSpec
  ): Promise<void> {
    // Northflank mount paths live on the volume, so point it at mountPath.
    for (const v of spec.volumes ?? []) {
      await client.update.volume({
        data: { mounts: [{ containerMountPath: v.mountPath }] },
        parameters: { ...team, projectId, volumeId: v.id },
      });
    }
  }

  async function createService(
    spec: ResolvedSandboxSpec,
    name: string,
    reuseOnConflict: boolean
  ): Promise<DriverHandle<NorthflankRaw>> {
    const client = await getClient();
    const data = buildData(spec, name);
    await mountVolumes(client, spec);
    let serviceId = name;
    try {
      const res = await client.create.service.deployment({
        data,
        parameters: { ...team, projectId },
      });
      serviceId = res.data.id ?? name;
    } catch (error) {
      const mapped = mapNorthflankError(error);
      if (!(reuseOnConflict && mapped?.code === "Conflict")) {
        throw error;
      }
    }
    await waitRunning(client, serviceId);
    return makeHandle(client, serviceId);
  }

  const makeHandle = (
    client: NorthflankClient,
    serviceId: string
  ): DriverHandle<NorthflankRaw> => {
    const params = svcParams(serviceId);
    const ptys = new Map<string, DriverPty>();

    const runOnce = (cmd: string) =>
      client.exec.execServiceCommand(params, { command: ["sh", "-c", cmd] });

    /** Start a session; `wrapped` records the shell pid in `pidFile`. */
    const session = (
      cmd: string,
      pidFile: string,
      extra: { tty?: boolean; cols?: number; rows?: number } = {}
    ): Promise<ExecCommand> =>
      client.exec.execServiceSession(params, {
        command: [
          "sh",
          "-c",
          extra.tty
            ? `echo $$ > ${sq(pidFile)}; ${cmd}`
            : `echo $$ > ${sq(pidFile)}; sh -c "$1"; rc=$?; rm -f ${sq(pidFile)}; exit $rc`,
          "sbox",
          cmd,
        ],
        shell: "none",
        tty: extra.tty ?? false,
        ...(extra.tty ? { ttyColumns: extra.cols, ttyRows: extra.rows } : {}),
      });

    const getInfo = async (): Promise<SandboxInfo> => {
      const res = await client.get.service({ parameters: params });
      const d = deploymentOf(res.data);
      const metadata = decodeMeta(res.data.description);
      return {
        createdAt: res.data.createdAt
          ? new Date(res.data.createdAt)
          : undefined,
        id: serviceId,
        metadata,
        name: metadata["sbox-name"] ?? res.data.name,
        provider: P,
        raw: res.data,
        state: mapNorthflankState(d?.status, d?.instances),
      };
    };

    const portsFor = async () =>
      (await client.get.service.ports({ parameters: params })).data.ports;

    const toPreview = (
      p: Awaited<ReturnType<typeof portsFor>>[number]
    ): Preview => {
      const cred = p.security?.credentials?.[0];
      return {
        auth: cred
          ? {
              headers: {
                authorization: `Basic ${btoa(`${cred.username}:${cred.password}`)}`,
              },
              type: "header",
            }
          : { type: "public" },
        port: p.internalPort,
        url: p.dns ? `https://${p.dns}` : "",
      };
    };

    const snapshotOnce = async (name?: string): Promise<SnapshotRef> => {
      const created = await client.create.containerSnapshot({
        data: {},
        parameters: params,
      });
      const snapId = (created.data as { id: string }).id;
      for (;;) {
        const got = await client.get.containerSnapshot({
          parameters: { ...team, snapshotId: snapId },
        });
        if (got.data.state === "succeeded") {
          return {
            createdAt: new Date(got.data.createdAt),
            id: snapId,
            includesMemory: false,
            name,
            provider: P,
            raw: got.data,
          };
        }
        if (got.data.state === "failed" || got.data.state === "cancelled") {
          throw new SandboxError(
            "Provider",
            `snapshot ${snapId} ${got.data.state}: ${got.data.error?.message ?? ""}`,
            { provider: P }
          );
        }
        await sleep(pollMs);
      }
    };

    return {
      id: serviceId,
      raw: { client, projectId, serviceId },

      getInfo,
      async destroy() {
        await client.delete.service({
          options: { delete_child_objects: true },
          parameters: params,
        });
      },
      async pause() {
        await client.pause.service({ parameters: params });
      },
      async resume() {
        await client.resume.service({
          data: { instances: 1 },
          parameters: params,
        });
        await waitRunning(client, serviceId);
      },

      exec(cmd: string, options: ExecOptions): DriverExec {
        const queue = new AsyncQueue<OutputEvent>();
        const pidFile = `/tmp/.sbox-${globalThis.crypto.randomUUID().slice(0, 12)}.pid`;
        let done = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (fn: () => void) => {
          if (!done) {
            done = true;
            if (timer) {
              clearTimeout(timer);
            }
            fn();
          }
        };
        const killRemote = () => runOnce(KILL_TREE(pidFile)).catch(() => {});
        const sessP = session(cmd, pidFile);
        sessP
          .then(async (s) => {
            s.stdOut.on("data", (d: Buffer | string) =>
              queue.push({ data: d.toString(), type: "stdout" })
            );
            s.stdErr.on("data", (d: Buffer | string) =>
              queue.push({ data: d.toString(), type: "stderr" })
            );
            const result = await s.waitForCommandResult();
            await sleep(0); // let trailing stream chunks flush
            finish(() => {
              queue.push({ exitCode: result.exitCode, type: "exit" });
              queue.close();
            });
          })
          .catch((error: unknown) =>
            finish(() => queue.fail(mapNorthflankError(error) ?? error))
          );
        if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
          const ms = options.timeoutMs;
          timer = setTimeout(() => {
            finish(() =>
              queue.fail(
                new SandboxError("Timeout", `command timed out after ${ms}ms`, {
                  provider: P,
                  timedOut: true,
                })
              )
            );
            void killRemote();
          }, ms);
        }
        return {
          async kill() {
            await killRemote();
          },
          pid: Promise.resolve(pidFile),
          async writeStdin(data: Uint8Array) {
            const s = await sessP;
            s.stdIn.write(Buffer.from(data));
          },
          [Symbol.asyncIterator]: () => queue.iterator(),
        };
      },

      async createPty(popts: PtyOptions): Promise<DriverPty> {
        const id = `pty-${globalThis.crypto.randomUUID().slice(0, 12)}`;
        const pidFile = `/tmp/.sbox-${id}.pid`;
        const prefix = [
          popts.cwd ? `cd ${sq(popts.cwd)}` : "",
          ...Object.entries(popts.env ?? {}).map(
            ([k, v]) => `export ${k}=${sq(v)}`
          ),
        ]
          .filter(Boolean)
          .join(" && ");
        const program = popts.cmd
          ? `exec ${popts.cmd}`
          : "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi";
        const s = await session(
          prefix ? `${prefix} && ${program}` : program,
          pidFile,
          {
            cols: popts.cols ?? 80,
            rows: popts.rows ?? 24,
            tty: true,
          }
        );
        const out = new AsyncQueue<Uint8Array>();
        s.stdOut.on("data", (d: Buffer | string) =>
          out.push(
            typeof d === "string"
              ? new TextEncoder().encode(d)
              : new Uint8Array(d)
          )
        );
        const exited = s.waitForCommandResult().then(
          (r) => r.exitCode,
          () => -1
        );
        void exited.finally(() => {
          out.close();
          ptys.delete(id);
        });
        const pty: DriverPty = {
          id,
          async kill() {
            await runOnce(KILL_TREE(pidFile)).catch(() => {});
          },
          output: { [Symbol.asyncIterator]: () => out.iterator() },
          async resize(cols, rows) {
            await s.resizeTerminal({ columns: cols, rows });
          },
          wait: () => exited,
          async write(data) {
            await s.sendInputToCurrentCommand(new TextDecoder().decode(data));
          },
        };
        ptys.set(id, pty);
        return pty;
      },
      connectPty(id: string): DriverPty {
        const p = ptys.get(id);
        if (!p) {
          throw new SandboxError("NotFound", `no pty ${id} in this process`, {
            provider: P,
          });
        }
        return p;
      },

      async readFile(path: string): Promise<Uint8Array> {
        const { fileStream, completionPromise } =
          await client.download.serviceStream.files(params, {
            remotePath: path,
          });
        const chunks: Buffer[] = [];
        for await (const c of fileStream) {
          chunks.push(
            typeof c === "string" ? Buffer.from(c, "latin1") : (c as Buffer)
          );
        }
        if (!(await completionPromise)) {
          throw new SandboxError("NotFound", `cannot read '${path}'`, {
            provider: P,
          });
        }
        return new Uint8Array(Buffer.concat(chunks));
      },
      async writeFile(path: string, data: Uint8Array): Promise<void> {
        await client.upload.serviceStream.files(params, {
          remotePath: path,
          source: Buffer.from(data),
        });
      },

      async exposePort(
        port: number,
        eo: { private?: boolean }
      ): Promise<Preview> {
        const existing = await portsFor();
        const others = existing.filter((p) => p.internalPort !== port);
        const security = eo.private
          ? {
              credentials: [
                {
                  password: globalThis.crypto.randomUUID().replaceAll("-", ""),
                  type: "basic-auth" as const,
                  username: "sbox",
                },
              ],
            }
          : undefined;
        await client.update.service.ports({
          data: {
            ports: [
              // Keep every other port exactly as it is (the call replaces the list).
              ...others.map((p) => ({
                domains: p.domains.map((d) => d.name),
                id: p.id,
                internalPort: p.internalPort,
                name: p.name,
                protocol: p.protocol,
                public: p.public,
                ...(p.security ? { security: p.security } : {}),
              })),
              {
                internalPort: port,
                name: `p${port}`,
                protocol: "HTTP" as const,
                public: true,
                ...(security ? { security } : {}),
              },
            ],
          },
          parameters: params,
        });
        const got = (await portsFor()).find((p) => p.internalPort === port);
        if (!got) {
          throw new SandboxError("Provider", `port ${port} was not added`, {
            provider: P,
          });
        }
        return toPreview(got);
      },
      async unexposePort(port: number) {
        const existing = await portsFor();
        await client.update.service.ports({
          data: {
            ports: existing
              .filter((p) => p.internalPort !== port)
              .map((p) => ({
                domains: p.domains.map((d) => d.name),
                id: p.id,
                internalPort: p.internalPort,
                name: p.name,
                protocol: p.protocol,
                public: p.public,
                ...(p.security ? { security: p.security } : {}),
              })),
          },
          parameters: params,
        });
      },
      async listPorts() {
        return (await portsFor()).filter((p) => p.public).map(toPreview);
      },

      async getMetrics() {
        const mod = await loadNorthflank();
        const res = await client.metrics.getServiceMetrics({
          options: { metricTypes: [mod.MetricType.Cpu, mod.MetricType.Memory] },
          parameters: params,
        });
        const latest = (
          key: NfModule["MetricType"][keyof NfModule["MetricType"]]
        ) => {
          const entry = res.data[key];
          const point = entry?.values?.[0]?.data?.at(-1);
          return point === undefined
            ? undefined
            : { unit: entry.metricInfo.metricUnit, value: Number(point.value) };
        };
        const cpu = latest(mod.MetricType.Cpu);
        const mem = latest(mod.MetricType.Memory);
        return {
          cpuPercent: cpu
            ? cpu.unit === "vCPU"
              ? cpu.value * 100
              : cpu.value
            : undefined,
          memoryUsedMB: mem?.value,
          raw: res.data,
          timestamp: new Date(),
        };
      },

      async snapshot(sopts) {
        return snapshotOnce(sopts.name);
      },
      async listSnapshots() {
        const out: SnapshotRef[] = [];
        let cursor: string | undefined;
        do {
          const res = await client.list.containerSnapshots({
            options: { cursor, per_page: 100, projectId, serviceId },
            ...(opts.teamId ? { parameters: { teamId: opts.teamId } } : {}),
          });
          for (const s of res.data.containerSnapshots) {
            if (s.state === "succeeded") {
              out.push({
                createdAt: new Date(s.createdAt),
                id: s.id,
                includesMemory: false,
                provider: P,
                raw: s,
              });
            }
          }
          cursor = res.pagination?.hasNextPage
            ? res.pagination.cursor
            : undefined;
        } while (cursor);
        return out;
      },
      async deleteSnapshot(ref) {
        await client.delete.containerSnapshot({
          parameters: { ...team, snapshotId: ref },
        });
      },
      async restoreSnapshot(ref) {
        await client.patch.service.deployment({
          data: {
            deployment: {
              containerSnapshot: { restoreFrom: ref },
              instances: 1,
            },
          },
          parameters: params,
        });
        await waitRunning(client, serviceId);
      },
      async fork(count, ctx: CallContext) {
        const snap = await snapshotOnce();
        const info = await getInfo();
        const svc = info.raw as GetServiceResult;
        const image =
          svc.serviceType !== "build" && "external" in svc.deployment
            ? svc.deployment.external?.imagePath
            : undefined;
        const handles: DriverHandle<NorthflankRaw>[] = [];
        for (let i = 0; i < count; i++) {
          const key = `${ctx.idempotencyKey ?? globalThis.crypto.randomUUID()}:fork:${serviceId}:${i}`;
          handles.push(
            await createService(
              {
                fromSnapshot: snap.id,
                metadata: info.metadata,
                template: image,
              },
              await idemName(key),
              true
            )
          );
        }
        return handles;
      },
    };
  };

  // In-process memo so `lookup(cacheKey)` finds image templates built here.
  const templateMemo = new Map<string, TemplateRef>();
  const templates: DriverTemplates = {
    build(spec) {
      const { source } = spec;
      if (!("image" in source) || source.image === undefined) {
        throw new SandboxError(
          "NotSupported",
          "northflank templates are image-only (no Dockerfile upload)",
          { provider: P }
        );
      }
      if (source.registryAuth) {
        throw new SandboxError(
          "Validation",
          "save the registry login in Northflank and pass its id as the registryCredentials option",
          { provider: P }
        );
      }
      const ref: TemplateRef = {
        cacheKey: spec.cacheKey,
        createdAt: new Date(),
        id: encodeTemplate(source.image, {
          env: spec.env,
          startCmd: spec.startCmd,
          workdir: spec.workdir,
        }),
        name: spec.name,
        provider: P,
        raw: { image: source.image },
      };
      templateMemo.set(spec.cacheKey, ref);
      return ref;
    },
    delete(id) {
      for (const [k, v] of templateMemo) {
        if (v.id === id || v.name === id) {
          templateMemo.delete(k);
        }
      }
    },
    async *list() {
      yield* templateMemo.values();
    },
    lookup(idOrKey) {
      const hit =
        templateMemo.get(idOrKey) ??
        [...templateMemo.values()].find(
          (t) => t.id === idOrKey || t.name === idOrKey
        );
      if (hit) {
        return hit;
      }
      // A template id is self-describing (image + encoded extras).
      if (idOrKey.includes(TPL_SEP) || /[/:]/.test(idOrKey)) {
        return {
          id: idOrKey,
          provider: P,
          raw: decodeTemplate(idOrKey),
        };
      }
      return undefined;
    },
  };

  const provider: SandboxProvider<NorthflankCaps, NorthflankRaw> = {
    capabilities: NORTHFLANK_CAPS,
    flags: NORTHFLANK_FLAGS,
    mapError: mapNorthflankError,
    name: P,
    templates,

    async create(spec, ctx) {
      if (spec.name) {
        return createService(spec, slug(spec.name), false);
      }
      // Deterministic name from the idempotency key: a retried create hits a
      // name conflict and reuses the service instead of making a second one.
      const key = ctx.idempotencyKey ?? globalThis.crypto.randomUUID();
      return createService(spec, await idemName(key), true);
    },

    async getOrCreate(spec) {
      return createService(
        { ...spec, metadata: { ...spec.metadata, "sbox-name": spec.name } },
        slug(spec.name),
        true
      );
    },

    async connect(id) {
      const client = await getClient();
      await client.get.service({ parameters: svcParams(id) }); // 404 -> NotFound
      return makeHandle(client, id);
    },

    async *list(filter) {
      const client = await getClient();
      let cursor: string | undefined;
      let n = 0;
      do {
        const res = await client.list.services({
          options: { cursor, per_page: 100 },
          parameters: { ...team, projectId },
        });
        for (const s of res.data.services) {
          const metadata = decodeMeta(s.description);
          if (
            filter?.metadata &&
            !Object.entries(filter.metadata).every(
              ([k, v]) => metadata[k] === v
            )
          ) {
            continue;
          }
          let state = mapNorthflankState(s.status.deployment);
          let raw: unknown = s;
          // A scaling deployment may be paused (0 instances): ask the service.
          if (s.status.deployment?.reason === "SCALING") {
            const full = await client.get.service({
              parameters: svcParams(s.id),
            });
            const d = deploymentOf(full.data);
            state = mapNorthflankState(d?.status, d?.instances);
            raw = full.data;
          }
          if (filter?.state && state !== filter.state) {
            continue;
          }
          if (filter?.limit !== undefined && n >= filter.limit) {
            return;
          }
          n++;
          yield {
            id: s.id,
            metadata,
            name: metadata["sbox-name"] ?? s.name,
            provider: P,
            raw,
            state,
          };
        }
        cursor = res.pagination?.hasNextPage
          ? res.pagination.cursor
          : undefined;
      } while (cursor);
    },

    async verify() {
      const client = await getClient();
      const res = await client.get.project({
        parameters: { ...team, projectId },
      });
      return { account: res.data.name ?? projectId };
    },
  };
  return provider;
});
