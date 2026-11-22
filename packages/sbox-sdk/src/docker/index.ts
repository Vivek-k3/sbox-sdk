/**
 * `sbox-sdk/docker` — local containers through the Docker Engine API, with no
 * npm dependency: it speaks HTTP over the daemon's unix socket (or tcp://)
 * with `node:http`. Works with OrbStack, Docker Desktop, Colima, Rancher
 * Desktop, Podman (compat API) and plain dockerd.
 *
 * - exec        `POST /containers/{id}/exec` + a hijacked `exec/start`, with
 *               the 8-byte-header stream demultiplexed into stdout/stderr
 * - files       `PUT`/`GET`/`HEAD /containers/{id}/archive` (tar)
 * - pty         exec with `Tty: true` + `POST /exec/{id}/resize`
 * - snapshots   `POST /commit` -> `sbox-snapshot/<id>:<name>` images
 * - templates   `POST /build` -> `sbox/<name>:latest`, labelled with the cache key
 *
 * `node:*` modules are imported lazily on first use, so importing this subpath
 * stays cheap (and safe in non-Node bundles that never call it).
 */
import { AsyncQueue, SandboxError, tarContext } from "../adapter/index.js";
import type {
  CallContext,
  CapabilityFlags,
  CapabilityMap,
  DriverExec,
  DriverHandle,
  DriverProcess,
  DriverPty,
  DriverTemplates,
  DriverVolumes,
  EgressPolicy,
  ExecOptions,
  FileBody,
  FileInfo,
  ListFilter,
  OutputEvent,
  Preview,
  ProcessInfo,
  PtyOptions,
  ResolvedSandboxSpec,
  SandboxInfo,
  SandboxMetrics,
  SandboxProvider,
  SnapshotRef,
  TemplateRef,
  TemplateSpec,
  VolumeInfo,
} from "../adapter/index.js";
import {
  LABEL,
  buildCreateBody,
  computeMetrics,
  containerFilters,
  containerNameFor,
  dirnameOf,
  basenameOf,
  execWrapper,
  imageRefId,
  killTreeScript,
  mapStatus,
  metadataFromLabels,
  normalizePath,
  parseImageRef,
  parsePathStat,
  ptyWrapper,
  registryAuthHeader,
  sanitizeRepo,
  sanitizeTag,
  shortHash,
  statusFilter,
} from "./mapping.js";
import type {
  ContainerCreateBody,
  ContainerInspect,
  ContainerStats,
  ContainerSummary,
  ImageInspect,
  ImageSummary,
} from "./mapping.js";
import { Demuxer, PidMarker, patchTarHeader, readTar } from "./stream.js";
import {
  DockerApiError,
  apiErrorFrom,
  createNodeTransport,
  discoverEndpoint,
  nodeSocketProbe,
} from "./transport.js";
import type {
  DockerConn,
  DockerRequest,
  DockerResponse,
  DockerTransport,
} from "./transport.js";

export type { DockerTransport, DockerConn, DockerRequest, DockerResponse };
export {
  discoverEndpoint,
  parseDockerHost,
  socketCandidates,
} from "./transport.js";

export interface DockerOptions {
  /**
   * Unix socket of the Docker (or Podman) daemon. Default: `DOCKER_HOST`, then
   * OrbStack, `/var/run/docker.sock`, Docker Desktop, Colima, Rancher Desktop
   * and Podman sockets, first one that exists.
   */
  socketPath?: string;
  /** Daemon URL (`unix:///path` or `tcp://host:2375`). Overrides `DOCKER_HOST`. */
  host?: string;
  /** Image used when `create()` gets no `template`. Default `debian:bookworm-slim`. */
  image?: string;
  /**
   * Keep-alive command for images without an sbox `startCmd`. Default
   * `["sleep", "infinity"]`; pass `"image"` to run the image's own CMD.
   */
  command?: string[] | "image";
  /** Network that `setEgressPolicy({ mode: "allow-all" })` (re)connects. Default `bridge`. */
  network?: string;
  /** Host IP that published ports bind to. Default `127.0.0.1` (never the LAN). */
  bindIp?: string;
  /** Pin the Engine API version, e.g. `"1.43"`. Default: the daemon's own. */
  apiVersion?: string;
  /** Max wait for a template's `readyCmd` after start. Default 120 000 ms. */
  readyTimeoutMs?: number;
  /** Progress of image pulls that `create()` triggers. */
  onPull?: (event: { status: string; id?: string; progress?: string }) => void;
  /** Inject a transport (tests, custom tunnels). Default: `node:http`. */
  transport?: DockerTransport;
}

export const DOCKER_CAPS = {
  background: "native",
  codeInterpreter: "unsupported",
  egressControl: "native",
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "unsupported",
  fork: "native",
  gpu: "native",
  killProcess: "native",
  list: "native",
  metrics: "native",
  pause: "native",
  privatePreview: "unsupported",
  proxiedFetch: "native",
  pty: "native",
  region: "unsupported",
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

export type DockerCaps = typeof DOCKER_CAPS;

export const DOCKER_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true,
  preservesDiskOnStop: true,
  preservesMemoryOnPause: true,
  previewBrowserAuth: false,
  previewModel: "ip",
  templateSources: ["dockerfile", "image", "snapshot"],
  egressModes: ["allow-all", "block-all"],
};

/** What `sandbox.raw()` returns. */
export interface DockerRaw {
  /** Full container id. */
  readonly id: string;
  /** Engine API transport bound to the daemon. */
  readonly transport: DockerTransport;
  /** Latest `GET /containers/{id}/json` result. */
  inspect(): Promise<ContainerInspect>;
}

const PROVIDER = "docker";
const DEFAULT_IMAGE = "debian:bookworm-slim";
const DEFAULT_COMMAND = ["sleep", "infinity"];
const DOCKERFILE_NAME = "Dockerfile.sbox";
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

function errCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const c = (err as { code?: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

/** Normalize Engine API / socket errors onto the sbox taxonomy. */
export function mapDockerError(err: unknown): SandboxError | undefined {
  if (err instanceof SandboxError) {
    return err;
  }
  if (err instanceof DockerApiError) {
    const init = { cause: err, provider: PROVIDER, status: err.status };
    const msg = err.message;
    if (err.status === 401 || err.status === 403) {
      return new SandboxError("Unauthorized", msg, init);
    }
    if (
      err.status === 404 ||
      /no such (container|image|exec|volume)/i.test(msg)
    ) {
      return new SandboxError("NotFound", msg, init);
    }
    if (err.status === 409) {
      return new SandboxError("Conflict", msg, { ...init, retryable: false });
    }
    if (err.status === 429 || /toomanyrequests|rate limit/i.test(msg)) {
      return new SandboxError("QuotaExceeded", msg, init);
    }
    if (err.status === 400) {
      return new SandboxError("Validation", msg, init);
    }
    return new SandboxError("Provider", msg, init);
  }
  const code = errCode(err);
  if (code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES") {
    return new SandboxError(
      code === "EACCES" ? "Unauthorized" : "Provider",
      `cannot reach the Docker daemon (${code}); is OrbStack / Docker Desktop / Colima running?`,
      { cause: err, provider: PROVIDER, retryable: code !== "EACCES" }
    );
  }
  if (
    code === "ETIMEDOUT" ||
    (err instanceof Error && err.name === "AbortError")
  ) {
    return new SandboxError(
      "Timeout",
      err instanceof Error ? err.message : String(err),
      { cause: err, provider: PROVIDER }
    );
  }
  return undefined;
}

function sbErr(
  code: ConstructorParameters<typeof SandboxError>[0],
  message: string
): SandboxError {
  return new SandboxError(code, message, { provider: PROVIDER });
}

// ---------------------------------------------------------------------------
// HTTP helpers over a transport
// ---------------------------------------------------------------------------

async function readAll(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const c of body) {
    chunks.push(c);
    total += c.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function bodyBytes(body: FileBody): Promise<Uint8Array> {
  if (typeof body === "string") {
    return enc.encode(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  return new Uint8Array(await new Response(body).arrayBuffer());
}

interface Api {
  transport(): Promise<DockerTransport>;
  /** Buffered request; throws `DockerApiError` on >= 400 unless allowed. */
  call(
    req: DockerRequest,
    allow?: number[]
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: Uint8Array;
  }>;
  json<T>(req: DockerRequest): Promise<T>;
  /** JSON-lines progress stream (pull/build); throws on an `error` line. */
  progress(
    req: DockerRequest,
    onLine: (line: Record<string, unknown>) => void
  ): Promise<void>;
  hijack(req: DockerRequest): Promise<DockerConn>;
}

function makeApi(opts: DockerOptions): Api {
  let tp: Promise<DockerTransport> | undefined;
  const prefix = opts.apiVersion
    ? `/v${opts.apiVersion.replace(/^v/, "")}`
    : "";
  const transport = (): Promise<DockerTransport> => {
    if (opts.transport) {
      return Promise.resolve(opts.transport);
    }
    tp ??= (async () => {
      const os = await import("node:os");
      const endpoint = await discoverEndpoint({
        env: globalThis.process?.env ?? {},
        home: os.homedir(),
        host: opts.host,
        probe: nodeSocketProbe,
        socketPath: opts.socketPath,
      });
      return createNodeTransport(endpoint);
    })();
    tp.catch(() => {
      tp = undefined;
    });
    return tp;
  };
  const withPrefix = (req: DockerRequest): DockerRequest => ({
    ...req,
    path: `${prefix}${req.path}`,
  });
  const call: Api["call"] = async (req, allow = []) => {
    const t = await transport();
    const res = await t.request(withPrefix(req));
    const body =
      req.method === "HEAD" ? new Uint8Array() : await readAll(res.body);
    if (req.method === "HEAD") {
      // Release the connection.
      void readAll(res.body).catch(() => {});
    }
    if (res.status >= 400 && !allow.includes(res.status)) {
      throw apiErrorFrom(res.status, dec.decode(body));
    }
    return { body, headers: res.headers, status: res.status };
  };
  return {
    call,
    async hijack(req) {
      const t = await transport();
      return t.hijack(withPrefix(req));
    },
    async json<T>(req: DockerRequest): Promise<T> {
      const r = await call(req);
      return JSON.parse(dec.decode(r.body)) as T;
    },
    async progress(req, onLine) {
      const t = await transport();
      const res = await t.request(withPrefix(req));
      if (res.status >= 400) {
        throw apiErrorFrom(res.status, dec.decode(await readAll(res.body)));
      }
      let buf = "";
      let failure: string | undefined;
      const handle = (line: string) => {
        if (!line.trim()) {
          return;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (typeof parsed.error === "string" && !failure) {
          failure = parsed.error;
        }
        onLine(parsed);
      };
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl !== -1) {
          handle(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
        }
      }
      handle(buf);
      if (failure) {
        const status =
          /not found|manifest unknown|does not exist|pull access denied/i.test(
            failure
          )
            ? 404
            : 500;
        throw new DockerApiError(status, failure);
      }
    },
    transport,
  };
}

const filtersParam = (f: Record<string, string[]>): string => JSON.stringify(f);

// ---------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------

/** Per-container in-process state shared by every handle to it. */
interface LiveState {
  ptys: Map<string, DriverPty>;
  procs: Map<string, DriverProcess>;
}

export function docker(
  opts: DockerOptions = {}
): SandboxProvider<DockerCaps, DockerRaw> {
  const api = makeApi(opts);
  const bindIp = opts.bindIp ?? "127.0.0.1";
  const defaultImage = opts.image ?? DEFAULT_IMAGE;
  const defaultNetwork = opts.network ?? "bridge";
  const states = new Map<string, LiveState>();
  const stateOf = (id: string): LiveState => {
    let s = states.get(id);
    if (!s) {
      s = { procs: new Map(), ptys: new Map() };
      states.set(id, s);
    }
    return s;
  };

  // ---- images ------------------------------------------------------------

  const inspectImage = async (
    ref: string,
    signal?: AbortSignal
  ): Promise<ImageInspect | undefined> => {
    const r = await api.call(
      {
        method: "GET",
        path: `/images/${encodeURIComponent(ref)}/json`,
        signal,
      },
      [404]
    );
    return r.status === 404
      ? undefined
      : (JSON.parse(dec.decode(r.body)) as ImageInspect);
  };

  const pullImage = async (
    ref: string,
    onLine: (line: Record<string, unknown>) => void,
    auth?: { username: string; password: string },
    signal?: AbortSignal
  ): Promise<void> => {
    const { fromImage, tag } = parseImageRef(ref);
    await api.progress(
      {
        headers: auth
          ? { "X-Registry-Auth": registryAuthHeader(ref, auth) }
          : {},
        method: "POST",
        path: "/images/create",
        query: { fromImage, tag: tag || undefined },
        signal,
      },
      onLine
    );
  };

  const ensureImage = async (
    ref: string,
    signal?: AbortSignal
  ): Promise<ImageInspect> => {
    const found = await inspectImage(ref, signal);
    if (found) {
      return found;
    }
    await pullImage(
      ref,
      (l) => {
        if (typeof l.status === "string") {
          opts.onPull?.({
            id: typeof l.id === "string" ? l.id : undefined,
            progress: typeof l.progress === "string" ? l.progress : undefined,
            status: l.status,
          });
        }
      },
      undefined,
      signal
    );
    const pulled = await inspectImage(ref, signal);
    if (!pulled) {
      throw sbErr("NotFound", `image '${ref}' not found after pull`);
    }
    return pulled;
  };

  const removeImageQuietly = async (ref: string): Promise<void> => {
    try {
      await api.call(
        { method: "DELETE", path: `/images/${encodeURIComponent(ref)}` },
        [404, 409]
      );
    } catch {
      // best effort
    }
  };

  // ---- containers ----------------------------------------------------------

  const inspect = (
    id: string,
    signal?: AbortSignal
  ): Promise<ContainerInspect> =>
    api.json<ContainerInspect>({
      method: "GET",
      path: `/containers/${encodeURIComponent(id)}/json`,
      signal,
    });

  const listContainers = (
    filters: Record<string, string[]>,
    limit?: number
  ): Promise<ContainerSummary[]> =>
    api.json<ContainerSummary[]>({
      method: "GET",
      path: "/containers/json",
      query: { all: true, filters: filtersParam(filters), limit },
    });

  const startContainer = async (id: string, signal?: AbortSignal) => {
    // 304 = already started.
    await api.call(
      { method: "POST", path: `/containers/${id}/start`, signal },
      [304]
    );
  };

  const infoFrom = (c: ContainerInspect): SandboxInfo => {
    const labels = c.Config.Labels ?? {};
    const created = new Date(c.Created);
    return {
      createdAt: Number.isNaN(created.getTime()) ? undefined : created,
      id: c.Id,
      metadata: metadataFromLabels(labels),
      name: labels[LABEL.name] || undefined,
      provider: PROVIDER,
      raw: c,
      state: mapStatus(c.State.Status),
    };
  };

  // ---- exec ----------------------------------------------------------------

  interface ExecRun {
    exec: DriverExec;
    pidP: Promise<string>;
  }

  /** Run a short command to completion and buffer its output (internal use). */
  const quickExec = async (
    id: string,
    cmd: string[],
    user?: string,
    signal?: AbortSignal
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const created = await api.json<{ Id: string }>({
      body: { AttachStderr: true, AttachStdout: true, Cmd: cmd, User: user },
      method: "POST",
      path: `/containers/${id}/exec`,
      signal,
    });
    const conn = await api.hijack({
      body: { Detach: false, Tty: false },
      method: "POST",
      path: `/exec/${created.Id}/start`,
      signal,
    });
    const demux = new Demuxer();
    let stdout = "";
    let stderr = "";
    try {
      for await (const chunk of conn.output) {
        for (const f of demux.push(chunk)) {
          if (f.stream === "stderr") {
            stderr += dec.decode(f.data);
          } else {
            stdout += dec.decode(f.data);
          }
        }
      }
    } finally {
      conn.close();
    }
    const exitCode = await execExitCode(created.Id);
    return { exitCode, stderr, stdout };
  };

  const execExitCode = async (execId: string): Promise<number> => {
    for (let i = 0; i < 40; i++) {
      const info = await api.json<{
        Running: boolean;
        ExitCode: number | null;
      }>({
        method: "GET",
        path: `/exec/${execId}/json`,
      });
      if (!info.Running && info.ExitCode !== null) {
        return info.ExitCode;
      }
      await new Promise((r) => setTimeout(r, i < 10 ? 25 : 100));
    }
    throw sbErr("Provider", `exec ${execId} ended without an exit code`);
  };

  const killTree = async (id: string, pid: string, signal?: string) => {
    await quickExec(
      id,
      ["sh", "-c", killTreeScript(pid, signal ?? "KILL")],
      "0"
    );
  };

  /**
   * Start a command through a hijacked exec. The command is wrapped so its
   * in-container pid is reported on stderr first (stripped from the output).
   * `stdinMode`: "auto" closes stdin right after start unless `writeStdin` was
   * already called; "open" keeps it open (spawned background processes).
   * A zero-length `writeStdin` sends EOF.
   */
  const startExec = (
    id: string,
    cmd: string,
    eopts: ExecOptions,
    stdinMode: "auto" | "open",
    ctx: CallContext
  ): ExecRun => {
    const q = new AsyncQueue<OutputEvent>();
    let resolvePid!: (pid: string) => void;
    let rejectPid!: (e: unknown) => void;
    const pidP = new Promise<string>((res, rej) => {
      resolvePid = res;
      rejectPid = rej;
    });
    pidP.catch(() => {});
    let wroteStdin = false;
    let finished = false;
    let killed: SandboxError | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const env = Object.entries(eopts.env ?? {}).map(([k, v]) => `${k}=${v}`);
    const connP = (async () => {
      const created = await api.json<{ Id: string }>({
        body: {
          AttachStderr: true,
          AttachStdin: true,
          AttachStdout: true,
          Cmd: execWrapper(cmd),
          ...(env.length > 0 ? { Env: env } : {}),
          ...(eopts.cwd ? { WorkingDir: eopts.cwd } : {}),
          ...(eopts.user ? { User: eopts.user } : {}),
        },
        method: "POST",
        path: `/containers/${id}/exec`,
        signal: ctx.signal,
      });
      const conn = await api.hijack({
        body: { Detach: false, Tty: false },
        method: "POST",
        path: `/exec/${created.Id}/start`,
        signal: ctx.signal,
      });
      return { conn, execId: created.Id };
    })();
    connP.catch(() => {});

    const stopWith = async (sig: string | undefined, err?: SandboxError) => {
      if (finished) {
        return;
      }
      if (err) {
        killed ??= err;
      }
      try {
        const pid = await pidP;
        await killTree(id, pid, sig);
      } catch {
        // process may already be gone
      }
    };

    void (async () => {
      let execId: string | undefined;
      let conn: DockerConn | undefined;
      try {
        const c = await connP;
        conn = c.conn;
        execId = c.execId;
        if (stdinMode === "auto" && !wroteStdin) {
          await conn.closeWrite();
        }
        const demux = new Demuxer();
        const marker = new PidMarker(resolvePid);
        const decOut = new TextDecoder();
        const decErr = new TextDecoder();
        for await (const chunk of conn.output) {
          for (const f of demux.push(chunk)) {
            if (f.stream === "stderr") {
              const data = marker.push(f.data);
              if (data.length > 0) {
                q.push({
                  data: decErr.decode(data, { stream: true }),
                  type: "stderr",
                });
              }
            } else if (f.stream === "stdout") {
              q.push({
                data: decOut.decode(f.data, { stream: true }),
                type: "stdout",
              });
            }
          }
        }
        const rest = marker.flush();
        if (rest.length > 0) {
          q.push({ data: decErr.decode(rest), type: "stderr" });
        }
        rejectPid(sbErr("Provider", "process exited before reporting its pid"));
        if (killed) {
          finished = true;
          q.fail(killed);
          return;
        }
        const exitCode = await execExitCode(execId);
        finished = true;
        q.push({ exitCode, type: "exit" });
        q.close();
      } catch (error) {
        finished = true;
        rejectPid(error);
        q.fail(killed ?? error);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
        conn?.close();
      }
    })();

    if (eopts.timeoutMs !== undefined && eopts.timeoutMs > 0) {
      const ms = eopts.timeoutMs;
      timer = setTimeout(() => {
        void stopWith(
          "KILL",
          new SandboxError("Timeout", `command timed out after ${ms}ms`, {
            provider: PROVIDER,
            timedOut: true,
          })
        );
      }, ms);
    }
    const abortSignal = eopts.signal ?? ctx.signal;
    abortSignal?.addEventListener(
      "abort",
      () => {
        void stopWith(
          "KILL",
          new SandboxError("Timeout", "command aborted", {
            aborted: true,
            provider: PROVIDER,
          })
        );
      },
      { once: true }
    );

    let writes = Promise.resolve();
    const exec: DriverExec = {
      [Symbol.asyncIterator]: () => q.iterator(),
      async kill(signal) {
        await stopWith(signal);
      },
      pid: pidP,
      writeStdin(data: Uint8Array) {
        wroteStdin = true;
        writes = writes.then(async () => {
          const { conn } = await connP;
          await (data.length === 0 ? conn.closeWrite() : conn.write(data));
        });
        return writes;
      },
    };
    return { exec, pidP };
  };

  // ---- pty -------------------------------------------------------------------

  const startPty = async (
    id: string,
    popts: PtyOptions,
    ctx: CallContext
  ): Promise<DriverPty> => {
    const rows = popts.rows ?? 24;
    const cols = popts.cols ?? 80;
    const env = [
      "TERM=xterm-256color",
      ...Object.entries(popts.env ?? {}).map(([k, v]) => `${k}=${v}`),
    ];
    const created = await api.json<{ Id: string }>({
      body: {
        AttachStderr: true,
        AttachStdin: true,
        AttachStdout: true,
        Cmd: ptyWrapper(popts.cmd),
        ConsoleSize: [rows, cols],
        Env: env,
        Tty: true,
        ...(popts.cwd ? { WorkingDir: popts.cwd } : {}),
        ...(popts.user ? { User: popts.user } : {}),
      },
      method: "POST",
      path: `/containers/${id}/exec`,
      signal: ctx.signal,
    });
    const execId = created.Id;
    const conn = await api.hijack({
      body: { ConsoleSize: [rows, cols], Detach: false, Tty: true },
      method: "POST",
      path: `/exec/${execId}/start`,
      signal: ctx.signal,
    });
    const out = new AsyncQueue<Uint8Array>();
    let pid: string | undefined;
    const marker = new PidMarker((p) => {
      pid = p;
    });
    const state = stateOf(id);
    const exited = (async () => {
      try {
        for await (const chunk of conn.output) {
          const data = marker.push(chunk);
          if (data.length > 0) {
            out.push(data);
          }
        }
        const rest = marker.flush();
        if (rest.length > 0) {
          out.push(rest);
        }
        out.close();
        return await execExitCode(execId);
      } catch (error) {
        out.fail(error);
        throw error;
      } finally {
        conn.close();
        state.ptys.delete(execId);
      }
    })();
    exited.catch(() => {});
    const resize = async (c: number, r: number) => {
      await api.call(
        {
          method: "POST",
          path: `/exec/${execId}/resize`,
          query: { h: r, w: c },
        },
        // The process may have exited between calls.
        [404, 409, 500]
      );
    };
    const pty: DriverPty = {
      id: execId,
      async kill() {
        if (pid) {
          await killTree(id, pid, "KILL").catch(() => {});
        }
        conn.close();
      },
      output: { [Symbol.asyncIterator]: () => out.iterator() },
      resize,
      wait: () => exited,
      write: (data) => conn.write(data),
    };
    state.ptys.set(execId, pty);
    return pty;
  };

  // ---- files -----------------------------------------------------------------

  const statPath = async (id: string, path: string): Promise<FileInfo> => {
    const p = normalizePath(path);
    const r = await api.call(
      { method: "HEAD", path: `/containers/${id}/archive`, query: { path: p } },
      [404]
    );
    if (r.status === 404) {
      throw sbErr("NotFound", `no such file or directory: '${path}'`);
    }
    const header = r.headers["x-docker-container-path-stat"];
    if (!header) {
      throw sbErr("Provider", `daemon returned no path stat for '${path}'`);
    }
    return parsePathStat(header, p);
  };

  const readPath = async (
    id: string,
    path: string,
    depth = 0
  ): Promise<Uint8Array> => {
    const p = normalizePath(path);
    const r = await api.call(
      { method: "GET", path: `/containers/${id}/archive`, query: { path: p } },
      [404]
    );
    if (r.status === 404) {
      throw sbErr("NotFound", `no such file: '${path}'`);
    }
    const entries = readTar(r.body);
    const first = entries[0];
    if (!first) {
      throw sbErr("Provider", `empty archive for '${path}'`);
    }
    if (first.type === "dir") {
      throw sbErr("Validation", `'${path}' is a directory`);
    }
    if (first.type === "symlink" && first.linkname && depth < 8) {
      const target = first.linkname.startsWith("/")
        ? first.linkname
        : `${dirnameOf(p)}/${first.linkname}`;
      return readPath(id, target, depth + 1);
    }
    return first.data;
  };

  const writePath = async (
    id: string,
    path: string,
    data: Uint8Array,
    ctx: CallContext
  ): Promise<void> => {
    const p = normalizePath(path);
    const dir = dirnameOf(p);
    const tar = tarContext(new Map([[basenameOf(p), data]]));
    patchTarHeader(tar, 0, { mtime: Date.now() / 1000 });
    const put = () =>
      api.call(
        {
          body: tar,
          method: "PUT",
          path: `/containers/${id}/archive`,
          query: { copyUIDGID: true, path: dir },
          signal: ctx.signal,
        },
        [404]
      );
    let r = await put();
    if (r.status === 404) {
      const mk = await quickExec(id, ["mkdir", "-p", dir]);
      if (mk.exitCode !== 0) {
        throw sbErr("Provider", `cannot create '${dir}': ${mk.stderr.trim()}`);
      }
      r = await put();
      if (r.status === 404) {
        throw sbErr("NotFound", `cannot write '${path}': parent missing`);
      }
    }
  };

  // ---- networking ------------------------------------------------------------

  const hostPortOf = (
    c: ContainerInspect,
    port: number
  ): string | undefined => {
    const bindings = c.NetworkSettings.Ports?.[`${port}/tcp`];
    const b = bindings?.find((x) => x.HostIp === bindIp) ?? bindings?.[0];
    return b?.HostPort || undefined;
  };

  const previewFor = (
    host: string,
    port: number,
    hostPort: string
  ): Preview => ({
    auth: { type: "public" },
    port,
    url: `http://${host}:${hostPort}`,
    wsUrl: `ws://${host}:${hostPort}`,
  });

  const setEgress = async (id: string, policy: EgressPolicy) => {
    if (policy.mode === "allow-list") {
      throw sbErr(
        "Validation",
        "docker cannot enforce an egress allow-list (it only has network on/off); use mode 'block-all' or 'allow-all', or a proxy you control"
      );
    }
    if (policy.deny || (policy.inject && policy.inject.length > 0)) {
      throw sbErr(
        "Validation",
        "docker does not support egress deny rules or credential injection"
      );
    }
    const c = await inspect(id);
    const nets = Object.keys(c.NetworkSettings.Networks ?? {});
    if (policy.mode === "block-all") {
      for (const n of nets) {
        if (n === "none") {
          continue;
        }
        await api.call(
          {
            body: { Container: id, Force: true },
            method: "POST",
            path: `/networks/${encodeURIComponent(n)}/disconnect`,
          },
          [404]
        );
      }
      return;
    }
    if (nets.includes("none")) {
      await api.call(
        {
          body: { Container: id, Force: true },
          method: "POST",
          path: "/networks/none/disconnect",
        },
        [404]
      );
    }
    if (!nets.some((n) => n !== "none")) {
      await api.call({
        body: { Container: id },
        method: "POST",
        path: `/networks/${encodeURIComponent(defaultNetwork)}/connect`,
      });
    }
  };

  // ---- lifecycle helpers -----------------------------------------------------

  /** Stop the container from inside after `ttlMs` (re-arming replaces the timer). */
  const armTimeout = async (id: string, ttlMs: number) => {
    const secs = Math.max(1, Math.ceil(ttlMs / 1000));
    const pidFile = "/tmp/.sbox-ttl.pid";
    const script = [
      `[ -f ${pidFile} ] && kill "$(cat ${pidFile})" 2>/dev/null`,
      `echo $$ > ${pidFile}`,
      `sleep ${secs}`,
      "kill -TERM 1",
      "sleep 10",
      "kill -KILL -1",
    ].join("; ");
    const created = await api.json<{ Id: string }>({
      body: { Cmd: ["sh", "-c", script], User: "0" },
      method: "POST",
      path: `/containers/${id}/exec`,
    });
    await api.call({
      body: { Detach: true, Tty: false },
      method: "POST",
      path: `/exec/${created.Id}/start`,
    });
  };

  const waitReady = async (
    id: string,
    readyCmd: string,
    signal?: AbortSignal
  ) => {
    const deadline = Date.now() + (opts.readyTimeoutMs ?? 120_000);
    for (;;) {
      const r = await quickExec(id, ["sh", "-c", readyCmd], undefined, signal);
      if (r.exitCode === 0) {
        return;
      }
      if (Date.now() > deadline) {
        throw sbErr("Timeout", `readyCmd did not succeed: ${readyCmd}`);
      }
      await new Promise((res) => setTimeout(res, 500));
    }
  };

  const destroyContainer = async (id: string) => {
    let forkImage: string | undefined;
    try {
      const c = await inspect(id);
      forkImage = c.Config.Labels?.[LABEL.forkImage] || undefined;
    } catch {
      // already gone
    }
    await api.call(
      {
        method: "DELETE",
        path: `/containers/${id}`,
        query: { force: true, v: true },
      },
      [404]
    );
    states.delete(id);
    if (forkImage) {
      await removeImageQuietly(forkImage);
    }
  };

  // ---- snapshots ---------------------------------------------------------------

  const commit = async (
    c: ContainerInspect,
    kind: "snapshot" | "fork",
    name: string | undefined
  ): Promise<{ ref: string; image: ImageInspect | undefined; tag: string }> => {
    const repo = `sbox-snapshot/${c.Id.slice(0, 12)}`;
    const tag = sanitizeTag(
      name ??
        `${kind === "fork" ? "fork" : "snap"}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    );
    const parentLabels = c.Config.Labels ?? {};
    const labels: Record<string, string> = {
      [LABEL.snapshot]: "true",
      [LABEL.snapshotKind]: kind,
      [LABEL.snapshotSource]: c.Id,
    };
    if (name) {
      labels[LABEL.snapshotName] = name;
    }
    for (const k of [
      LABEL.startCmd,
      LABEL.readyCmd,
      LABEL.resources,
      LABEL.templateName,
    ]) {
      if (parentLabels[k]) {
        labels[k] = parentLabels[k];
      }
    }
    // Carry metadata under a non-inherited prefix (for cleanup / listing).
    for (const [k, v] of Object.entries(metadataFromLabels(parentLabels))) {
      labels[`sbox.snapshot.meta.${k}`] = v;
    }
    const base = await inspectImage(c.Image);
    const baseEnv = (base as { Config?: { Env?: string[] | null } } | undefined)
      ?.Config?.Env;
    await api.json<{ Id: string }>({
      body: {
        // Keep the image's env, not the sandbox's (which may carry secrets).
        Env:
          baseEnv && baseEnv.length > 0
            ? baseEnv
            : [
                "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
              ],
        Labels: labels,
      },
      method: "POST",
      path: "/commit",
      query: { container: c.Id, pause: true, repo, tag },
    });
    const ref = `${repo}:${tag}`;
    return { image: await inspectImage(ref), ref, tag };
  };

  const snapshotRef = (
    ref: string,
    img: ImageInspect | ImageSummary | undefined
  ): SnapshotRef => {
    const labels =
      (img as ImageSummary | undefined)?.Labels ??
      (img as ImageInspect | undefined)?.Config?.Labels ??
      {};
    const createdRaw = (img as ImageInspect | undefined)?.Created;
    const createdNum = (img as ImageSummary | undefined)?.Created;
    const createdAt =
      typeof createdNum === "number"
        ? new Date(createdNum * 1000)
        : createdRaw
          ? new Date(createdRaw)
          : undefined;
    return {
      createdAt,
      id: ref,
      includesMemory: false,
      name: labels[LABEL.snapshotName] || undefined,
      provider: PROVIDER,
      raw: img,
    };
  };

  // ---- handle --------------------------------------------------------------

  const makeHandle = async (id: string): Promise<DriverHandle<DockerRaw>> => {
    const t = await api.transport();
    const raw: DockerRaw = { id, inspect: () => inspect(id), transport: t };
    const state = stateOf(id);
    const first = await inspect(id);
    const name = first.Config.Labels?.[LABEL.name] || undefined;

    const forkChildren = async (
      count: number
    ): Promise<DriverHandle<DockerRaw>[]> => {
      const parent = await inspect(id);
      const { ref } = await commit(parent, "fork", undefined);
      const out: DriverHandle<DockerRaw>[] = [];
      try {
        for (let i = 0; i < count; i++) {
          const pl = parent.Config.Labels ?? {};
          const labels: Record<string, string> = {
            [LABEL.forkImage]: ref,
            [LABEL.forkOf]: parent.Id,
            [LABEL.idempotency]: "",
            [LABEL.managed]: "true",
            [LABEL.name]: "",
          };
          for (const [k, v] of Object.entries(pl)) {
            if (k.startsWith(LABEL.meta)) {
              labels[k] = v;
            }
          }
          const hc = parent.HostConfig;
          const body: ContainerCreateBody = {
            Cmd: parent.Config.Cmd ?? undefined,
            Entrypoint: parent.Config.Entrypoint ?? null,
            Env: parent.Config.Env ?? undefined,
            ExposedPorts: parent.Config.ExposedPorts ?? undefined,
            HostConfig: {
              DeviceRequests: hc.DeviceRequests,
              Init: hc.Init ?? true,
              Memory: hc.Memory || undefined,
              Mounts: hc.Mounts,
              NanoCpus: hc.NanoCpus || undefined,
              NetworkMode: hc.NetworkMode,
              PortBindings: hc.PortBindings
                ? Object.fromEntries(
                    Object.entries(hc.PortBindings).map(([k, v]) => [
                      k,
                      v.map((b) => ({ HostIp: b.HostIp, HostPort: "" })),
                    ])
                  )
                : undefined,
              ShmSize: hc.ShmSize || undefined,
            },
            Image: ref,
            Labels: labels,
            User: parent.Config.User || undefined,
            WorkingDir: parent.Config.WorkingDir || undefined,
          };
          const childName = `${parent.Name.replace(/^\//, "").slice(0, 40)}-fork-${shortHash(`${ref}:${i}:${Math.random()}`).slice(0, 8)}`;
          const created = await api.json<{ Id: string }>({
            body,
            method: "POST",
            path: "/containers/create",
            query: { name: childName },
          });
          await startContainer(created.Id);
          out.push(await makeHandle(created.Id));
        }
      } catch (error) {
        for (const h of out) {
          await destroyContainer(h.id).catch(() => {});
        }
        await removeImageQuietly(ref);
        throw error;
      }
      return out;
    };

    const handle: DriverHandle<DockerRaw> = {
      connectProcess(processId) {
        const p = state.procs.get(processId);
        if (!p) {
          throw sbErr(
            "NotFound",
            `no process ${processId} started by this client (docker cannot re-attach to another client's exec)`
          );
        }
        return p;
      },
      connectPty(ptyId) {
        const p = state.ptys.get(ptyId);
        if (!p) {
          throw sbErr("NotFound", `no pty ${ptyId} owned by this client`);
        }
        return p;
      },
      createPty: (popts, ctx) => startPty(id, popts, ctx),
      async deleteSnapshot(ref) {
        await api.call({
          method: "DELETE",
          path: `/images/${encodeURIComponent(ref)}`,
        });
      },
      destroy: () => destroyContainer(id),
      exec: (cmd, eopts, ctx) => startExec(id, cmd, eopts, "auto", ctx).exec,
      async exposePort(port) {
        const c = await inspect(id);
        const hostPort = hostPortOf(c, port);
        if (!hostPort) {
          if (c.HostConfig.PortBindings?.[`${port}/tcp`]) {
            throw sbErr(
              "Conflict",
              c.State.Status === "running"
                ? `port ${port} is declared but the network is blocked; setEgressPolicy({ mode: "allow-all" }) publishes it (on a new host port)`
                : `container is ${c.State.Status}; resume it to publish port ${port}`
            );
          }
          throw sbErr(
            "Validation",
            `port ${port} is not published; docker cannot publish ports on a running container — declare it in create({ ports: [${port}] })`
          );
        }
        return previewFor(t.previewHost, port, hostPort);
      },
      fork: (count) => forkChildren(count),
      async getInfo() {
        return infoFrom(await inspect(id));
      },
      async getMetrics(): Promise<SandboxMetrics> {
        const stats = await api.json<ContainerStats>({
          method: "GET",
          path: `/containers/${id}/stats`,
          query: { stream: false },
        });
        return computeMetrics(stats);
      },
      id,
      async killProcess(processId, signal) {
        if (!/^\d+$/.test(processId)) {
          throw sbErr("NotFound", `no process ${processId}`);
        }
        const r = await quickExec(
          id,
          [
            "sh",
            "-c",
            `[ -d /proc/${processId} ] || exit 3; ${killTreeScript(processId, signal ?? "KILL")}`,
          ],
          "0"
        );
        if (r.exitCode === 3) {
          throw sbErr("NotFound", `no process ${processId}`);
        }
      },
      async listPorts() {
        const c = await inspect(id);
        const out: Preview[] = [];
        for (const key of Object.keys(c.NetworkSettings.Ports ?? {})) {
          const [p, proto] = key.split("/");
          const port = Number(p);
          const hostPort = hostPortOf(c, port);
          if (proto === "tcp" && hostPort) {
            out.push(previewFor(t.previewHost, port, hostPort));
          }
        }
        return out;
      },
      async listProcesses(): Promise<ProcessInfo[]> {
        const r = await quickExec(id, [
          "sh",
          "-c",
          String.raw`for d in /proc/[0-9]*; do p=${"$"}{d#/proc/}; [ "$p" = "$$" ] && continue; c=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null); [ -n "$c" ] && printf '%s\t%s\n' "$p" "$c"; done; true`,
        ]);
        return r.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const tab = line.indexOf("\t");
            return { cmd: line.slice(tab + 1).trim(), id: line.slice(0, tab) };
          })
          .filter((p) => !p.cmd.startsWith("sh -c for d in /proc/"));
      },
      async listSnapshots() {
        const imgs = await api.json<ImageSummary[]>({
          method: "GET",
          path: "/images/json",
          query: {
            filters: filtersParam({
              label: [
                `${LABEL.snapshotSource}=${id}`,
                `${LABEL.snapshotKind}=snapshot`,
              ],
            }),
          },
        });
        return imgs.map((img) => snapshotRef(imageRefId(img), img));
      },
      name,
      async pause() {
        await api.call({ method: "POST", path: `/containers/${id}/pause` });
      },
      async proxyFetch(port, path, init, ctx) {
        const c = await inspect(id);
        const hostPort = hostPortOf(c, port);
        let base: string;
        if (hostPort) {
          base = `http://${t.previewHost}:${hostPort}`;
        } else {
          const ip = Object.values(c.NetworkSettings.Networks ?? {}).find(
            (n) => n.IPAddress
          )?.IPAddress;
          if (!ip) {
            throw sbErr(
              "Validation",
              `port ${port} is not published and the container has no IP (network blocked?)`
            );
          }
          base = `http://${ip}:${port}`;
        }
        try {
          return await ctx.fetch(new URL(path ?? "/", base).toString(), init);
        } catch (error) {
          throw new SandboxError(
            "Provider",
            hostPort
              ? `fetch to port ${port} failed: ${error instanceof Error ? error.message : String(error)}`
              : `port ${port} is not published and the container IP is not reachable from this host (works on Linux and OrbStack); declare it in create({ ports: [${port}] })`,
            { cause: error, provider: PROVIDER }
          );
        }
      },
      raw,
      async readFile(path) {
        return readPath(id, path);
      },
      async resume() {
        const c = await inspect(id);
        if (c.State.Status === "paused") {
          await api.call({ method: "POST", path: `/containers/${id}/unpause` });
        } else if (c.State.Status !== "running") {
          await startContainer(id);
          const ready = c.Config.Labels?.[LABEL.readyCmd];
          if (ready) {
            await waitReady(id, ready);
          }
        }
      },
      setEgressPolicy: (policy) => setEgress(id, policy),
      async setTimeout(ttlMs) {
        await armTimeout(id, ttlMs);
      },
      async snapshot(sopts) {
        if (sopts.mode === "memory") {
          throw sbErr(
            "Validation",
            "docker snapshots capture the filesystem only (commit); use mode 'filesystem' or pause() to keep memory"
          );
        }
        const c = await inspect(id);
        const { ref, image } = await commit(c, "snapshot", sopts.name);
        return { ...snapshotRef(ref, image), name: sopts.name };
      },
      async spawn(cmd, eopts, ctx) {
        const run = startExec(id, cmd, eopts, "open", ctx);
        const pid = await run.pidP;
        const proc: DriverProcess = Object.assign(run.exec, { id: pid });
        state.procs.set(pid, proc);
        void (async () => {
          try {
            for await (const _ev of run.exec) {
              // drain to learn when it ends
            }
          } catch {
            // surfaced to the caller's own iterator
          } finally {
            state.procs.delete(pid);
          }
        })();
        return proc;
      },
      stat: (path) => statPath(id, path),
      async stop() {
        await api.call(
          { method: "POST", path: `/containers/${id}/stop` },
          [304]
        );
      },
      async upload(path, body, ctx) {
        await writePath(id, path, await bodyBytes(body), ctx);
      },
      writeFile: (path, data, ctx) => writePath(id, path, data, ctx),
    };
    return handle;
  };

  // ---- create ----------------------------------------------------------------

  const findOne = async (
    filters: Record<string, string[]>
  ): Promise<ContainerSummary | undefined> => {
    const found = await listContainers(filters);
    return found.find((c) => c.State !== "removing" && c.State !== "dead");
  };

  const reuse = async (
    c: ContainerSummary,
    ctx: CallContext
  ): Promise<DriverHandle<DockerRaw>> => {
    const h = await makeHandle(c.Id);
    if (c.State !== "running") {
      await h.resume?.(ctx);
    }
    return h;
  };

  const createContainer = async (
    spec: ResolvedSandboxSpec,
    ctx: CallContext,
    key: string | undefined
  ): Promise<DriverHandle<DockerRaw>> => {
    if (key) {
      const existing = await findOne(containerFilters({ idempotencyKey: key }));
      if (existing) {
        return reuse(existing, ctx);
      }
    }
    const imageRef = spec.fromSnapshot ?? spec.template ?? defaultImage;
    const image = await ensureImage(imageRef, ctx.signal);
    const imageLabels = image.Config?.Labels ?? {};
    const body = buildCreateBody(spec, {
      bindIp,
      defaultCommand: opts.command ?? DEFAULT_COMMAND,
      hostEnv: globalThis.process?.env ?? {},
      idempotencyKey: key ?? "",
      image: imageRef,
      imageLabels,
    });
    if (spec.lifecycle?.maxAgeMs !== undefined) {
      body.Labels["sbox.expiresAt"] = new Date(
        Date.now() + spec.lifecycle.maxAgeMs
      ).toISOString();
    }
    const containerName = containerNameFor(
      spec.name,
      key ?? `${Date.now()}:${Math.random()}`
    );
    const res = await api.call(
      {
        body,
        method: "POST",
        path: "/containers/create",
        query: { name: containerName },
        signal: ctx.signal,
      },
      [409]
    );
    if (res.status === 409) {
      // Lost a race for the same idempotency key / name.
      const existing = await findOne({ name: [`^/${containerName}$`] });
      if (existing) {
        return reuse(existing, ctx);
      }
      throw apiErrorFrom(409, dec.decode(res.body));
    }
    const { Id } = JSON.parse(dec.decode(res.body)) as { Id: string };
    try {
      await startContainer(Id, ctx.signal);
      if (spec.lifecycle?.maxAgeMs !== undefined) {
        await armTimeout(Id, spec.lifecycle.maxAgeMs);
      }
      const ready = imageLabels[LABEL.readyCmd];
      if (ready) {
        await waitReady(Id, ready, ctx.signal);
      }
    } catch (error) {
      await destroyContainer(Id).catch(() => {});
      throw error;
    }
    return makeHandle(Id);
  };

  // ---- templates -------------------------------------------------------------

  const templateRefFrom = (
    img: ImageInspect | ImageSummary,
    id?: string
  ): TemplateRef => {
    const labels =
      (img as ImageSummary).Labels ??
      (img as ImageInspect).Config?.Labels ??
      {};
    const created =
      (img as ImageSummary).Created ?? (img as ImageInspect).Created;
    const createdAt =
      typeof created === "number"
        ? new Date(created * 1000)
        : created
          ? new Date(created)
          : undefined;
    return {
      cacheKey: labels[LABEL.cacheKey] || undefined,
      createdAt,
      id: id ?? imageRefId(img),
      name: labels[LABEL.templateName] || undefined,
      provider: PROVIDER,
      raw: img,
    };
  };

  /** Dockerfile lines that bake a template's env/workdir/user into the image. */
  const extraInstructions = (spec: TemplateSpec): string => {
    const lines: string[] = [];
    for (const [k, v] of Object.entries(spec.env ?? {})) {
      const escaped = v
        .replaceAll("\\", "\\\\")
        .replaceAll('"', '\\"')
        .replaceAll("$", "\\$");
      lines.push(`ENV ${k}="${escaped}"`);
    }
    if (spec.workdir) {
      lines.push(`WORKDIR ${spec.workdir}`);
    }
    if (spec.user) {
      lines.push(`USER ${spec.user}`);
    }
    return lines.length > 0 ? `\n${lines.join("\n")}\n` : "\n";
  };

  const rawTemplates: DriverTemplates = {
    async build(spec, bopts, ctx) {
      const { source } = spec;
      const repo = `sbox/${sanitizeRepo(spec.name)}`;
      const tag = `${repo}:latest`;
      const emitLog = (
        line: string,
        stream: "stdout" | "stderr" = "stdout"
      ) => {
        const trimmed = line.replace(/\n+$/, "");
        if (trimmed) {
          bopts.onEvent({ line: trimmed, stream, type: "log" });
        }
      };
      const onProgress = (l: Record<string, unknown>) => {
        if (typeof l.stream === "string") {
          emitLog(l.stream);
        } else if (typeof l.status === "string") {
          emitLog(
            [l.id, l.status, l.progress]
              .filter((x) => typeof x === "string")
              .join(" ")
          );
        } else if (typeof l.error === "string") {
          emitLog(l.error, "stderr");
        }
      };
      const labels: Record<string, string> = {
        [LABEL.cacheKey]: spec.cacheKey,
        [LABEL.managed]: "true",
        // Blank labels a snapshot base image would otherwise pass down, so
        // the template never shows up as that container's snapshot.
        [LABEL.snapshot]: "",
        [LABEL.snapshotKind]: "",
        [LABEL.snapshotName]: "",
        [LABEL.snapshotSource]: "",
        [LABEL.template]: "true",
        [LABEL.templateName]: spec.name,
      };
      if (spec.startCmd) {
        labels[LABEL.startCmd] = spec.startCmd;
      }
      if (spec.readyCmd) {
        labels[LABEL.readyCmd] = spec.readyCmd;
      }
      if (spec.resources) {
        labels[LABEL.resources] = JSON.stringify(spec.resources);
      }

      let dockerfile: string;
      let context = new Map<string, Uint8Array>();
      if ("dockerfile" in source && source.dockerfile !== undefined) {
        const { loadTemplateContext } = await import("../adapter/index.js");
        context = await loadTemplateContext(source.context);
        dockerfile = source.dockerfile;
      } else if ("image" in source && source.image !== undefined) {
        bopts.onEvent({
          message: `pulling ${source.image}`,
          status: "building",
          type: "status",
        });
        await pullImage(
          source.image,
          onProgress,
          source.registryAuth,
          bopts.signal
        );
        dockerfile = `FROM ${source.image}`;
      } else if ("snapshot" in source && source.snapshot !== undefined) {
        if (!(await inspectImage(source.snapshot, bopts.signal))) {
          throw sbErr(
            "NotFound",
            `snapshot image '${source.snapshot}' not found`
          );
        }
        dockerfile = `FROM ${source.snapshot}`;
      } else {
        throw sbErr(
          "Validation",
          "template source needs dockerfile | image | snapshot"
        );
      }
      context.set(
        DOCKERFILE_NAME,
        enc.encode(
          `${dockerfile.replace(/\s+$/, "")}\n${extraInstructions(spec)}`
        )
      );
      bopts.onEvent({ status: "building", type: "status" });
      let imageId: string | undefined;
      await api.progress(
        {
          body: tarContext(context),
          method: "POST",
          path: "/build",
          query: {
            dockerfile: DOCKERFILE_NAME,
            forcerm: true,
            labels: JSON.stringify(labels),
            rm: true,
            t: tag,
          },
          signal: bopts.signal ?? ctx.signal,
        },
        (l) => {
          const aux = l.aux as { ID?: string } | undefined;
          if (aux?.ID) {
            imageId = aux.ID;
          }
          onProgress(l);
        }
      );
      const img = await inspectImage(tag);
      if (!img) {
        throw sbErr(
          "Provider",
          `build finished but ${tag} is missing${imageId ? ` (${imageId})` : ""}`
        );
      }
      return templateRefFrom(img, tag);
    },
    async delete(ref) {
      await api.call(
        { method: "DELETE", path: `/images/${encodeURIComponent(ref)}` },
        [404]
      );
    },
    async *list() {
      const imgs = await api.json<ImageSummary[]>({
        method: "GET",
        path: "/images/json",
        query: { filters: filtersParam({ label: [`${LABEL.template}=true`] }) },
      });
      for (const img of imgs) {
        yield templateRefFrom(img);
      }
    },
    async lookup(idOrKey) {
      const byKey = await api.json<ImageSummary[]>({
        method: "GET",
        path: "/images/json",
        query: {
          filters: filtersParam({ label: [`${LABEL.cacheKey}=${idOrKey}`] }),
        },
      });
      const hit = byKey.toSorted((a, b) => b.Created - a.Created)[0];
      if (hit) {
        return templateRefFrom(hit);
      }
      if (/^[a-f0-9]{64}$/.test(idOrKey)) {
        return undefined; // a cache key that isn't built yet
      }
      for (const ref of [`sbox/${sanitizeRepo(idOrKey)}:latest`, idOrKey]) {
        const img = await inspectImage(ref);
        if (img) {
          return templateRefFrom(img, ref);
        }
      }
      return undefined;
    },
  };

  // ---- volumes -----------------------------------------------------------------

  interface VolumeJson {
    Name: string;
    CreatedAt?: string;
    Labels?: Record<string, string> | null;
  }
  const volumeInfo = (v: VolumeJson): VolumeInfo => {
    const size = v.Labels?.["sbox.sizeMB"];
    return {
      createdAt: v.CreatedAt ? new Date(v.CreatedAt) : undefined,
      id: v.Name,
      name: v.Name,
      raw: v,
      sizeMB: size ? Number(size) : undefined,
    };
  };
  const rawVolumes: DriverVolumes = {
    async create(spec) {
      const labels: Record<string, string> = { [LABEL.managed]: "true" };
      if (spec.sizeMB !== undefined) {
        labels["sbox.sizeMB"] = String(spec.sizeMB);
      }
      const v = await api.json<VolumeJson>({
        body: { Labels: labels, Name: spec.name },
        method: "POST",
        path: "/volumes/create",
      });
      return volumeInfo(v);
    },
    async delete(volId) {
      await api.call(
        { method: "DELETE", path: `/volumes/${encodeURIComponent(volId)}` },
        [404]
      );
    },
    async get(idOrName) {
      const r = await api.call(
        { method: "GET", path: `/volumes/${encodeURIComponent(idOrName)}` },
        [404]
      );
      return r.status === 404
        ? undefined
        : volumeInfo(JSON.parse(dec.decode(r.body)) as VolumeJson);
    },
    async *list() {
      const r = await api.json<{ Volumes: VolumeJson[] | null }>({
        method: "GET",
        path: "/volumes",
        query: { filters: filtersParam({ label: [`${LABEL.managed}=true`] }) },
      });
      for (const v of r.Volumes ?? []) {
        yield volumeInfo(v);
      }
    },
  };

  // ---- error mapping -------------------------------------------------------------
  // The core does not route create/connect/list or the template/volume
  // registries through `mapError`, so normalize errors at this boundary.

  const toSbx = (e: unknown): SandboxError =>
    mapDockerError(e) ?? SandboxError.wrap(e, PROVIDER);
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      throw toSbx(error);
    }
  };
  async function* guardIter<T>(
    make: () => AsyncIterable<T>
  ): AsyncGenerator<T> {
    try {
      yield* make();
    } catch (error) {
      throw toSbx(error);
    }
  }

  const templates: DriverTemplates = {
    build: (spec, bopts, ctx) =>
      guard(async () => rawTemplates.build(spec, bopts, ctx)),
    delete: (tid, ctx) => guard(async () => rawTemplates.delete!(tid, ctx)),
    list: (ctx) => guardIter(() => rawTemplates.list!(ctx)),
    lookup: (key, ctx) => guard(async () => rawTemplates.lookup(key, ctx)),
  };
  const volumes: DriverVolumes = {
    create: (spec, ctx) => guard(async () => rawVolumes.create(spec, ctx)),
    delete: (vid, ctx) => guard(async () => rawVolumes.delete(vid, ctx)),
    get: (key, ctx) => guard(async () => rawVolumes.get(key, ctx)),
    list: (ctx) => guardIter(() => rawVolumes.list(ctx)),
  };

  async function* listSandboxes(
    filter?: ListFilter
  ): AsyncGenerator<SandboxInfo> {
    if (filter?.state && statusFilter(filter.state).length === 0) {
      return;
    }
    if (filter?.limit !== undefined && filter.limit <= 0) {
      return;
    }
    const found = await listContainers(
      containerFilters({ metadata: filter?.metadata, state: filter?.state })
    );
    let n = 0;
    for (const c of found.toSorted((a, b) => b.Created - a.Created)) {
      const labels = c.Labels ?? {};
      const state = mapStatus(c.State);
      if (filter?.state && state !== filter.state) {
        continue;
      }
      yield {
        createdAt: new Date(c.Created * 1000),
        id: c.Id,
        metadata: metadataFromLabels(labels),
        name: labels[LABEL.name] || undefined,
        provider: PROVIDER,
        raw: c,
        state,
      };
      n++;
      if (filter?.limit !== undefined && n >= filter.limit) {
        return;
      }
    }
  }

  // ---- provider ------------------------------------------------------------------

  return {
    capabilities: DOCKER_CAPS,
    connect: (id) =>
      guard(async () => {
        const c = await inspect(id);
        return makeHandle(c.Id);
      }),
    create: (spec, ctx) =>
      guard(() => createContainer(spec, ctx, ctx.idempotencyKey)),
    async dispose() {
      if (!opts.transport) {
        const t = await api.transport().catch(() => undefined);
        t?.dispose?.();
      }
    },
    flags: DOCKER_FLAGS,
    getOrCreate: (spec, ctx) =>
      guard(async () => {
        const existing = await findOne(containerFilters({ name: spec.name }));
        if (existing) {
          return reuse(existing, ctx);
        }
        return createContainer(
          spec,
          ctx,
          ctx.idempotencyKey ?? `sbox-name:${spec.name}`
        );
      }),
    list: (filter) => guardIter(() => listSandboxes(filter)),
    mapError: mapDockerError,
    name: PROVIDER,
    templates,
    verify: (ctx) =>
      guard(async () => {
        const ping = await api.call({
          method: "GET",
          path: "/_ping",
          signal: ctx.signal,
        });
        if (dec.decode(ping.body).trim() !== "OK") {
          throw sbErr("Provider", "unexpected /_ping response");
        }
        const v = await api.json<{
          Version?: string;
          ApiVersion?: string;
          Platform?: { Name?: string };
        }>({ method: "GET", path: "/version", signal: ctx.signal });
        const t = await api.transport();
        const engine = v.Platform?.Name ?? "Docker Engine";
        return {
          account: `${t.runtime} (${engine} ${v.Version ?? "?"}, API ${v.ApiVersion ?? "?"})`,
        };
      }),
    volumes,
  };
}
