/**
 * `sbox-sdk/morph`: adapter for Morph Cloud (`morphcloud` TypeScript SDK).
 *
 * **Maintenance-only.** The `morphcloud` TypeScript SDK has not had a release
 * since Oct 2025 (the Python SDK is still active). This adapter is kept working
 * and correct, but new Morph features will not be added here.
 *
 * A "sandbox" is a Morph instance booted from a snapshot. Morph is
 * snapshot-first: `create()` boots a snapshot id directly (`template:
 * "snapshot_…"`, `fromSnapshot`, or a built template), or boots from a Morph
 * image id via a base snapshot. The base snapshot is keyed by a digest of
 * `(imageId, vcpus, memory, disk)` and reused, so repeated creates don't mint
 * new snapshots.
 *
 * - exec streams over Morph's SSE endpoint (`instance.exec(cmd, { onStdout,
 *   onStderr, timeout })`). There's no per-call cwd/env, so the core folds those
 *   into the command (`perCommandEnvCwd: false`); `spec.env` is baked into every
 *   exec the same way. `kill()` kills the remote process tree by a per-exec
 *   marker env var.
 * - Files go over exec + base64 (chunked, so large files round-trip).
 * - `pause()`/`resume()` are native (memory preserved), `setTimeout()` is the
 *   instance TTL, `snapshots.create()` is `instance.snapshot()`, `fork()` is
 *   `instance.branch()`. There's no in-place restore: boot a new sandbox with
 *   `fromSnapshot` instead.
 * - Ports are HTTP services. Private previews use `auth_mode: "api_key"`, which
 *   requires `Authorization: Bearer <MORPH_API_KEY>` (header auth).
 * - Templates chain `Snapshot.setup(cmd)`, which Morph caches by chain hash.
 *
 * Requires the optional peer dependency `morphcloud`.
 */
import {
  AsyncQueue,
  base64ToBytes,
  bytesToBase64,
  defineProvider,
  parseDockerfile,
  SandboxError,
  shellQuote as sq,
} from "../adapter/index.js";
import type {
  CallContext,
  CapabilityFlags,
  CapabilityMap,
  DriverExec,
  DriverHandle,
  DriverTemplates,
  ExecOptions,
  OutputEvent,
  Preview,
  ResolvedSandboxSpec,
  SandboxInfo,
  SandboxProvider,
  SandboxState,
  SnapshotRef,
  SshCredentials,
  TemplateRef,
} from "../adapter/index.js";

type Mod = typeof import("morphcloud");
type MorphClient = InstanceType<Mod["MorphCloudClient"]>;
/** The SDK's live instance object (`raw()` on a Morph sandbox). */
export type MorphInstance = import("morphcloud").Instance;
type MorphSnapshot = import("morphcloud").Snapshot;
type TtlAction = NonNullable<
  import("morphcloud").InstanceStartOptions["ttlAction"]
>;

export interface MorphOptions {
  /** Morph API key. Defaults to `MORPH_API_KEY`. */
  apiKey?: string;
  baseUrl?: string;
  /** Morph image used when no template/snapshot is given. Default `morphvm-minimal`. */
  imageId?: string;
  /** vCPUs for the base snapshot built from an image. */
  vcpus?: number;
  /** Memory (MB) for the base snapshot built from an image. */
  memory?: number;
  /** Disk (MB) for the base snapshot built from an image. */
  diskSize?: number;
  /** Seconds to wait for a new instance to become ready. Default 300. */
  readyTimeoutSeconds?: number;
  /** SSH gateway host returned by `ssh.create()`. Default `ssh.cloud.morph.so`. */
  sshHost?: string;
}

export const MORPH_CAPS = {
  background: "unsupported",
  codeInterpreter: "unsupported",
  egressControl: "unsupported",
  exposePort: "native",
  filesUpload: "emulated",
  filesWatch: "unsupported",
  fork: "native",
  gpu: "unsupported",
  killProcess: "unsupported",
  list: "native",
  metrics: "unsupported",
  pause: "native",
  privatePreview: "native",
  proxiedFetch: "unsupported",
  pty: "unsupported",
  region: "unsupported",
  secretsVault: "unsupported",
  setTimeout: "native",
  snapshot: "native",
  ssh: "native",
  statefulKernel: "unsupported",
  stdin: "unsupported",
  stop: "unsupported",
  streaming: "native",
  volumes: "unsupported",
  templateBuild: "native",
} as const satisfies CapabilityMap;

export type MorphCaps = typeof MORPH_CAPS;

const MORPH_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: false, // instance.exec(cmd) has no cwd/env
  preservesDiskOnStop: false,
  preservesMemoryOnPause: true, // pause snapshots the running VM
  previewBrowserAuth: false, // private previews need an Authorization header
  previewModel: "subdomain",
  resumeChangesId: false,
  templateSources: ["dockerfile", "image", "snapshot"],
};

const PROVIDER = "morph";
const DEFAULT_IMAGE = "morphvm-minimal";
const META_NAME = "sbox-name";
const META_IDEM = "sbox-idempotency-key";
const META_SOURCE = "sbox-source-instance";
const META_SNAP_NAME = "sbox-snapshot-name";
const META_TPL_KEY = "sbox-template";
const META_TPL_NAME = "sbox-template-name";
/** Raw bytes per write chunk; a multiple of 3 so base64 chunks concatenate. */
const WRITE_CHUNK = 48 * 1024;

let cached: Mod | null = null;
async function loadMorph(): Promise<Mod> {
  cached ??= await import("morphcloud");
  return cached;
}

/** Morph instance status -> SandboxState (pending|ready|paused|saving|error). */
export function mapMorphState(status: string | undefined): SandboxState {
  switch (status) {
    case "pending": {
      return "creating";
    }
    case "ready": {
      return "running";
    }
    case "paused": {
      return "paused";
    }
    case "saving": {
      return "suspending";
    }
    case "error": {
      return "error";
    }
    default: {
      return "unknown";
    }
  }
}

/**
 * Morph SDK errors are plain `Error`s: `HTTP <status> <text> for <url> ...`,
 * or `Command execution timed out after N seconds`.
 */
export function mapMorphError(err: unknown): SandboxError | undefined {
  if (err instanceof SandboxError) {
    return err;
  }
  if (!(err instanceof Error)) {
    return undefined;
  }
  const opts = { cause: err, provider: PROVIDER };
  if (
    err.name === "AbortError" ||
    err.name === "TimeoutError" ||
    /timed out|timeout/i.test(err.message)
  ) {
    return new SandboxError("Timeout", err.message, opts);
  }
  const m = /^HTTP (\d{3})\b/.exec(err.message);
  if (!m) {
    return undefined;
  }
  const status = Number(m[1]);
  const withStatus = { ...opts, status };
  if (status === 401 || status === 403) {
    return new SandboxError("Unauthorized", err.message, withStatus);
  }
  if (status === 404) {
    return new SandboxError("NotFound", err.message, withStatus);
  }
  if (status === 409) {
    return new SandboxError("Conflict", err.message, withStatus);
  }
  if (status === 429 || status === 402) {
    return new SandboxError("QuotaExceeded", err.message, {
      ...withStatus,
      retryable: true,
    });
  }
  if (status === 400 || status === 422) {
    return new SandboxError("Validation", err.message, withStatus);
  }
  return new SandboxError("Provider", err.message, withStatus);
}

const wrap = (e: unknown): SandboxError =>
  mapMorphError(e) ?? SandboxError.wrap(e, PROVIDER);

async function sha256Hex(text: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isSnapshotId(s: string): boolean {
  return s.startsWith("snapshot_");
}

function usableSnapshot(s: MorphSnapshot): boolean {
  return (
    s.status !== "failed" && s.status !== "deleting" && s.status !== "deleted"
  );
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function invalid(message: string): SandboxError {
  return new SandboxError("Validation", message, { provider: PROVIDER });
}

function ttlAction(
  onIdle: ResolvedSandboxSpec["onIdle"]
): TtlAction | undefined {
  if (onIdle === "pause") {
    return "pause";
  }
  // Morph "stop" deletes the instance, so it covers both stop and destroy.
  return onIdle ? "stop" : undefined;
}

/** Reject spec fields Morph cannot honor instead of silently dropping them. */
function envFromSpec(spec: ResolvedSandboxSpec): Record<string, string> {
  if (spec.volumes?.length) {
    throw invalid("volumes are not supported");
  }
  if (spec.network && spec.network.mode !== "allow-all") {
    throw invalid("egress policies are not supported");
  }
  if (spec.resources?.gpu || spec.resources?.gpuCount) {
    throw invalid("GPUs are not supported");
  }
  const env: Record<string, string> = { ...spec.env };
  for (const s of spec.secrets ?? []) {
    if (s.mode === "egress" || s.value === undefined) {
      throw invalid(
        `secret '${s.name}': only inline env secrets ({ value }) are supported`
      );
    }
    env[s.envVar ?? s.name] = s.value;
  }
  return env;
}

function snapshotRef(snap: MorphSnapshot): SnapshotRef {
  return {
    createdAt: snap.created ? new Date(snap.created * 1000) : undefined,
    id: snap.id,
    includesMemory: true, // Morph snapshots capture the full VM state
    name: snap.metadata?.[META_SNAP_NAME],
    provider: PROVIDER,
    raw: snap,
  };
}

function templateRef(snap: MorphSnapshot): TemplateRef {
  return {
    cacheKey: snap.metadata?.[META_TPL_KEY],
    createdAt: snap.created ? new Date(snap.created * 1000) : undefined,
    id: snap.id,
    name: snap.metadata?.[META_TPL_NAME],
    provider: PROVIDER,
    raw: snap,
  };
}

function info(inst: MorphInstance): SandboxInfo {
  const metadata = { ...inst.metadata };
  return {
    createdAt: inst.created ? new Date(inst.created * 1000) : undefined,
    id: inst.id,
    metadata,
    name: metadata[META_NAME],
    provider: PROVIDER,
    raw: inst,
    state: mapMorphState(inst.status),
  };
}

export const morph = defineProvider<MorphCaps, MorphInstance, MorphOptions>(
  (opts = {}) => {
    let clientP: Promise<MorphClient> | null = null;
    const getClient = (): Promise<MorphClient> => {
      clientP ??= loadMorph().then(
        (mod) =>
          new mod.MorphCloudClient({
            apiKey: opts.apiKey,
            baseUrl: opts.baseUrl,
          })
      );
      return clientP;
    };
    const readyTimeout = opts.readyTimeoutSeconds ?? 300;

    /** Find-or-create the base snapshot for an image, keyed by digest. */
    const inflight = new Map<string, Promise<string>>();
    const baseSnapshot = async (
      client: MorphClient,
      imageId: string,
      res: { vcpus?: number; memory?: number; diskSize?: number }
    ): Promise<string> => {
      const digest = `sbox-base-${await sha256Hex(
        [imageId, res.vcpus ?? "", res.memory ?? "", res.diskSize ?? ""].join(
          "|"
        )
      )}`;
      let p = inflight.get(digest);
      if (!p) {
        p = (async () => {
          const existing = (await client.snapshots.list({ digest })).find(
            usableSnapshot
          );
          if (existing) {
            return existing.id;
          }
          const snap = await client.snapshots.create({
            diskSize: res.diskSize,
            digest,
            imageId,
            memory: res.memory,
            vcpus: res.vcpus,
          });
          return snap.id;
        })().finally(() => inflight.delete(digest));
        inflight.set(digest, p);
      }
      return p;
    };

    const makeHandle = (
      client: MorphClient,
      initial: MorphInstance,
      env: Record<string, string>
    ): DriverHandle<MorphInstance> => {
      // Replaced by getInfo() so status/ttl/services never go stale.
      let inst = initial;
      const envPrefix = Object.entries(env)
        .map(([k, v]) => `export ${k}=${sq(v)} && `)
        .join("");

      /** Buffered one-shot exec for internal plumbing (files, kill). */
      const run = (cmd: string) => inst.exec(cmd);

      /** Kill every process carrying this exec's marker in its environment. */
      const remoteKill = async (execId: string): Promise<void> => {
        await run(
          `for f in /proc/[0-9]*/environ; do if grep -qz 'SBOX_EXEC_ID=${execId}' "$f" 2>/dev/null; then p=\${f#/proc/}; kill -9 "\${p%/environ}" 2>/dev/null; fi; done; true`
        ).catch(() => {
          /* best effort */
        });
      };

      const handle: DriverHandle<MorphInstance> = {
        async createSsh(): Promise<SshCredentials> {
          const key = await inst.sshKey();
          return {
            host: opts.sshHost ?? "ssh.cloud.morph.so",
            port: 22,
            privateKey: key.private_key,
            user: inst.id,
          };
        },
        async deleteSnapshot(ref: string): Promise<void> {
          const snap = await client.snapshots.get({ snapshotId: ref });
          await snap.delete();
        },
        async destroy(): Promise<void> {
          // Morph "stop" deletes the instance.
          await inst.stop();
        },
        exec(cmd: string, eopts: ExecOptions, ctx: CallContext): DriverExec {
          const execId = globalThis.crypto.randomUUID().replaceAll("-", "");
          const queue = new AsyncQueue<OutputEvent>();
          let settled = false;
          const settle = (): boolean => {
            if (settled) {
              return false;
            }
            settled = true;
            return true;
          };
          const kill = async (): Promise<void> => {
            if (settle()) {
              queue.push({ exitCode: 137, signal: "SIGKILL", type: "exit" });
              queue.close();
            }
            await remoteKill(execId);
          };
          const signal = eopts.signal ?? ctx.signal;
          signal?.addEventListener("abort", () => void kill(), { once: true });

          const wrapped = `SBOX_EXEC_ID=${execId} sh -c ${sq(envPrefix + cmd)}`;
          void inst
            .exec(wrapped, {
              onStderr: (data) => {
                if (!settled && data) {
                  queue.push({ data, type: "stderr" });
                }
              },
              onStdout: (data) => {
                if (!settled && data) {
                  queue.push({ data, type: "stdout" });
                }
              },
              timeout:
                eopts.timeoutMs && eopts.timeoutMs > 0
                  ? Math.ceil(eopts.timeoutMs / 1000)
                  : undefined,
            })
            .then((r) => {
              if (settle()) {
                queue.push({ exitCode: r.exit_code, type: "exit" });
                queue.close();
              }
            })
            .catch((error: unknown) => {
              const err = wrap(error);
              if (err.code === "Timeout") {
                void remoteKill(execId);
              }
              if (settle()) {
                queue.fail(err);
              }
            });
          return {
            [Symbol.asyncIterator]: () => queue.iterator(),
            kill,
            pid: Promise.resolve(execId),
          };
        },
        async exposePort(
          port: number,
          popts: { private?: boolean }
        ): Promise<Preview> {
          const svc = await inst.exposeHttpService(
            `sbox-${port}`,
            port,
            popts.private ? "api_key" : "none"
          );
          return {
            auth: popts.private
              ? {
                  headers: { Authorization: `Bearer ${client.apiKey}` },
                  type: "header",
                }
              : { type: "public" },
            port,
            url: svc.url,
          };
        },
        async fork(count: number): Promise<DriverHandle<MorphInstance>[]> {
          const { snapshot, instances } = await inst.branch(count);
          try {
            await Promise.all(
              instances.map((i) => i.waitUntilReady(readyTimeout))
            );
          } catch (error) {
            await Promise.allSettled(instances.map((i) => i.stop()));
            await snapshot.delete().catch(() => {});
            throw error;
          }
          // The intermediate snapshot branch() makes would otherwise leak.
          await snapshot.delete().catch(() => {
            /* still referenced or already gone: nothing else we can do */
          });
          return instances.map((i) => makeHandle(client, i, env));
        },
        async getInfo(): Promise<SandboxInfo> {
          inst = await client.instances.get({ instanceId: inst.id });
          return info(inst);
        },
        id: inst.id,
        async listSnapshots(): Promise<SnapshotRef[]> {
          const snaps = await client.snapshots.list({
            metadata: { [META_SOURCE]: inst.id },
          });
          return snaps.filter(usableSnapshot).map(snapshotRef);
        },
        name: inst.metadata?.[META_NAME],
        async pause(): Promise<void> {
          await inst.pause();
        },
        get raw() {
          return inst;
        },
        async readFile(path: string): Promise<Uint8Array> {
          const r = await run(`base64 ${sq(path)}`);
          if (r.exit_code !== 0) {
            throw new SandboxError("NotFound", `no such file: '${path}'`, {
              provider: PROVIDER,
            });
          }
          return base64ToBytes(r.stdout);
        },
        async resume(): Promise<void> {
          await inst.resume();
        },
        async setTimeout(ttlMs: number): Promise<void> {
          await inst.setTTL(
            Math.max(1, Math.ceil(ttlMs / 1000)),
            inst.ttl?.ttlAction ?? "stop"
          );
        },
        async snapshot({ name }: { name?: string }): Promise<SnapshotRef> {
          const metadata: Record<string, string> = { [META_SOURCE]: inst.id };
          if (name) {
            metadata[META_SNAP_NAME] = name;
          }
          const snap = await inst.snapshot({ metadata });
          return { ...snapshotRef(snap), name };
        },
        async unexposePort(port: number): Promise<void> {
          await inst.hideHttpService(`sbox-${port}`);
        },
        async writeFile(path: string, data: Uint8Array): Promise<void> {
          const tmp = `${path}.sbox-${globalThis.crypto.randomUUID().slice(0, 8)}`;
          const steps: string[] = [];
          for (
            let off = 0;
            off === 0 || off < data.length;
            off += WRITE_CHUNK
          ) {
            const b64 = bytesToBase64(data.subarray(off, off + WRITE_CHUNK));
            steps.push(
              off === 0
                ? `mkdir -p ${sq(dirname(path))} && printf %s ${sq(b64)} | base64 -d > ${sq(tmp)}`
                : `printf %s ${sq(b64)} | base64 -d >> ${sq(tmp)}`
            );
          }
          steps.push(`mv ${sq(tmp)} ${sq(path)}`);
          for (const step of steps) {
            const r = await run(step);
            if (r.exit_code !== 0) {
              await run(`rm -f ${sq(tmp)}`).catch(() => {});
              throw new SandboxError(
                "Provider",
                `write failed: '${path}': ${r.stderr.trim()}`,
                { provider: PROVIDER }
              );
            }
          }
        },
      };
      return handle;
    };

    const resolveSnapshot = async (
      client: MorphClient,
      spec: ResolvedSandboxSpec
    ): Promise<string> => {
      if (spec.fromSnapshot) {
        return spec.fromSnapshot;
      }
      const tpl = spec.templateRef?.id ?? spec.template;
      if (tpl && isSnapshotId(tpl)) {
        return tpl;
      }
      return baseSnapshot(client, tpl ?? opts.imageId ?? DEFAULT_IMAGE, {
        diskSize: spec.resources?.diskMB ?? opts.diskSize,
        memory: spec.resources?.memoryMB ?? opts.memory,
        vcpus: spec.resources?.vcpus ?? opts.vcpus,
      });
    };

    const templates: DriverTemplates = {
      async build(spec, bopts) {
        const client = await getClient();
        const { source } = spec;
        if (spec.startCmd || spec.readyCmd || spec.user || spec.workdir) {
          throw invalid(
            "templates support only RUN steps (no startCmd/readyCmd/user/workdir)"
          );
        }
        if (spec.env && Object.keys(spec.env).length > 0) {
          throw invalid("template env is not supported; pass env at create()");
        }
        let base: string;
        const steps: string[] = [];
        if ("dockerfile" in source && source.dockerfile !== undefined) {
          const ins = parseDockerfile(source.dockerfile);
          const from = ins[0];
          if (from?.op !== "FROM" || !from.args || /\s/.test(from.args)) {
            throw invalid(
              "Dockerfile must start with `FROM <morph-image-id|snapshot_id>`"
            );
          }
          for (const i of ins.slice(1)) {
            if (i.op !== "RUN" || i.args.startsWith("[")) {
              throw invalid(
                `unsupported Dockerfile instruction for morph: ${i.raw} (only shell-form RUN after FROM)`
              );
            }
            steps.push(i.args);
          }
          base = from.args;
        } else if ("image" in source && source.image !== undefined) {
          if ("registryAuth" in source && source.registryAuth) {
            throw invalid(
              "registry images are not supported; use a Morph image id"
            );
          }
          base = source.image;
        } else {
          base = source.snapshot;
        }
        bopts.onEvent({ status: "building", type: "status" });
        const baseId = isSnapshotId(base)
          ? base
          : await baseSnapshot(client, base, {
              diskSize: spec.resources?.diskMB ?? opts.diskSize,
              memory: spec.resources?.memoryMB ?? opts.memory,
              vcpus: spec.resources?.vcpus ?? opts.vcpus,
            });
        let snap = await client.snapshots.get({ snapshotId: baseId });
        for (const step of steps) {
          bopts.signal?.throwIfAborted();
          bopts.onEvent({ line: `RUN ${step}`, step: "RUN", type: "log" });
          // setup() is cached by Morph's chain hash: unchanged prefixes are reused.
          snap = await snap.setup(step);
        }
        await snap.setMetadata({
          [META_TPL_KEY]: spec.cacheKey,
          [META_TPL_NAME]: spec.name,
        });
        return templateRef(snap);
      },
      async delete(id) {
        const client = await getClient();
        const snap = await client.snapshots.get({ snapshotId: id });
        await snap.delete();
      },
      async *list() {
        const client = await getClient();
        for (const s of await client.snapshots.list()) {
          if (s.metadata?.[META_TPL_KEY] && usableSnapshot(s)) {
            yield templateRef(s);
          }
        }
      },
      async lookup(idOrKey) {
        const client = await getClient();
        if (isSnapshotId(idOrKey)) {
          try {
            return templateRef(
              await client.snapshots.get({ snapshotId: idOrKey })
            );
          } catch (error) {
            if (wrap(error).code === "NotFound") {
              return undefined;
            }
            throw error;
          }
        }
        for (const key of [META_TPL_KEY, META_TPL_NAME]) {
          const hit = (
            await client.snapshots.list({ metadata: { [key]: idOrKey } })
          ).find(usableSnapshot);
          if (hit) {
            return templateRef(hit);
          }
        }
        return undefined;
      },
    };

    const provider: SandboxProvider<MorphCaps, MorphInstance> = {
      capabilities: MORPH_CAPS,
      async connect(id: string): Promise<DriverHandle<MorphInstance>> {
        const client = await getClient();
        return makeHandle(
          client,
          await client.instances.get({ instanceId: id }),
          {}
        );
      },
      async create(spec, ctx): Promise<DriverHandle<MorphInstance>> {
        const client = await getClient();
        const env = envFromSpec(spec);
        const idem = ctx.idempotencyKey;

        // Retries (or a caller-supplied key) must not boot a second VM.
        if (idem && (spec.idempotencyKey || ctx.attempt > 1)) {
          const prior = (
            await client.instances.list({ metadata: { [META_IDEM]: idem } })
          ).find((i) => i.status !== "error");
          if (prior) {
            await prior.waitUntilReady(readyTimeout);
            return makeHandle(client, prior, env);
          }
        }

        const snapshotId = await resolveSnapshot(client, spec);
        const metadata: Record<string, string> = { ...spec.metadata };
        if (spec.name) {
          metadata[META_NAME] = spec.name;
        }
        if (idem) {
          metadata[META_IDEM] = idem;
        }
        const maxAge = spec.lifecycle?.maxAgeMs;
        const ttlSeconds = maxAge
          ? Math.max(1, Math.ceil(maxAge / 1000))
          : undefined;
        // start() polls until ready and stops the instance itself on failure.
        const inst = await client.instances.start({
          metadata,
          snapshotId,
          timeout: readyTimeout,
          ttlAction: ttlSeconds ? ttlAction(spec.lifecycle?.onIdle) : undefined,
          ttlSeconds,
        });
        try {
          if (spec.lifecycle?.autoResume) {
            await inst.setWakeOn(true, true);
          }
          for (const port of spec.ports ?? []) {
            await inst.exposeHttpService(`sbox-${port}`, port, "none");
          }
        } catch (error) {
          await inst.stop().catch(() => {});
          throw error;
        }
        return makeHandle(client, inst, env);
      },
      flags: MORPH_FLAGS,
      async *list(filter): AsyncIterable<SandboxInfo> {
        const client = await getClient();
        // Morph returns every instance in one response (no pagination).
        const all = await client.instances.list(
          filter?.metadata ? { metadata: filter.metadata } : {}
        );
        let n = 0;
        for (const inst of all) {
          const i = info(inst);
          if (filter?.state && i.state !== filter.state) {
            continue;
          }
          if (
            filter?.metadata &&
            !Object.entries(filter.metadata).every(
              ([k, v]) => i.metadata[k] === v
            )
          ) {
            continue;
          }
          if (filter?.limit !== undefined && n >= filter.limit) {
            return;
          }
          n++;
          yield i;
        }
      },
      mapError: mapMorphError,
      name: PROVIDER,
      templates,
      async verify() {
        const client = await getClient();
        // Authenticated, never creates, and returns (almost) nothing.
        await client.snapshots.list({ digest: "sbox-verify" });
        return undefined;
      },
    };
    return provider;
  }
);
