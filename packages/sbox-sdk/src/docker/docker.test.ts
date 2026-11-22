/**
 * Offline tests for the docker adapter. There is no SDK to mock, so the
 * "fake SDK" is a fake Docker Engine API (`FakeDocker`, a `DockerTransport`)
 * over an in-memory filesystem per container, with exec backed by the memory
 * provider's `MiniShell`. The adapter's real request shapes (paths, query,
 * JSON bodies, tar archives, the multiplexed exec stream, hijacked stdin) go
 * through it, and requests the real daemon would reject are rejected too.
 */
import { describe, expect, it } from "vitest";

import { AsyncQueue, tarContext } from "../adapter/index.js";
import type { CallContext } from "../adapter/index.js";
import { runConformance } from "../conformance/index.js";
import { createSandboxClient } from "../index.js";
import { MiniShell } from "../memory/shell.js";
import type { ShellFs } from "../memory/shell.js";
import { DOCKER_CAPS, docker, mapDockerError } from "./index.js";
import {
  buildCreateBody,
  computeMetrics,
  containerFilters,
  containerNameFor,
  execWrapper,
  killTreeScript,
  mapStatus,
  metadataFromLabels,
  metadataLabels,
  parseImageRef,
  parsePathStat,
  ptyWrapper,
  registryAuthHeader,
  registryOf,
  sanitizeRepo,
  signalName,
  statusFilter,
} from "./mapping.js";
import type {
  ContainerCreateBody,
  ContainerInspect,
  ContainerSummary,
  ImageInspect,
  ImageSummary,
} from "./mapping.js";
import { Demuxer, PidMarker, patchTarHeader, readTar } from "./stream.js";
import {
  DockerApiError,
  discoverEndpoint,
  parseDockerHost,
  socketCandidates,
} from "./transport.js";
import type {
  DockerConn,
  DockerRequest,
  DockerResponse,
  DockerTransport,
} from "./transport.js";

// ===========================================================================
// fake Docker Engine API
// ===========================================================================

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------------------
// in-memory fs
// ---------------------------------------------------------------------------

class MemFs {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>(["/", "/tmp", "/root", "/etc", "/proc"]);

  static norm(p: string): string {
    const parts: string[] = [];
    for (const s of (p.startsWith("/") ? p : `/${p}`).split("/")) {
      if (s === "" || s === ".") {
        continue;
      }
      if (s === "..") {
        parts.pop();
      } else {
        parts.push(s);
      }
    }
    return `/${parts.join("/")}`;
  }
  static parent(p: string): string {
    const n = MemFs.norm(p);
    const i = n.lastIndexOf("/");
    return i <= 0 ? "/" : n.slice(0, i);
  }
  clone(): MemFs {
    const c = new MemFs();
    c.files = new Map(this.files);
    c.dirs = new Set(this.dirs);
    return c;
  }
  mkdirp(p: string): void {
    let cur = MemFs.norm(p);
    const chain: string[] = [];
    while (cur !== "/") {
      chain.unshift(cur);
      cur = MemFs.parent(cur);
    }
    for (const d of chain) {
      this.dirs.add(d);
    }
  }
  write(p: string, d: Uint8Array): void {
    const n = MemFs.norm(p);
    this.mkdirp(MemFs.parent(n));
    this.files.set(n, d);
  }
  shell(): ShellFs {
    const children = (d: string) => {
      const out = new Map<string, "file" | "dir">();
      for (const x of this.dirs) {
        if (x !== d && MemFs.parent(x) === d) {
          out.set(x.slice(x.lastIndexOf("/") + 1), "dir");
        }
      }
      for (const f of this.files.keys()) {
        if (MemFs.parent(f) === d) {
          out.set(f.slice(f.lastIndexOf("/") + 1), "file");
        }
      }
      return out;
    };
    return {
      isDir: (p) => this.dirs.has(MemFs.norm(p)),
      list: (p) => {
        const d = MemFs.norm(p);
        if (!this.dirs.has(d)) {
          return null;
        }
        return [...children(d)]
          .map(([name, type]) => ({ name, type }))
          .toSorted((a, b) => a.name.localeCompare(b.name));
      },
      mkdir: (p, r) => {
        const n = MemFs.norm(p);
        if (this.dirs.has(n) || this.files.has(n)) {
          return r && this.dirs.has(n)
            ? null
            : `mkdir: cannot create directory '${p}': File exists`;
        }
        if (!r && !this.dirs.has(MemFs.parent(n))) {
          return `mkdir: cannot create directory '${p}': No such file or directory`;
        }
        this.mkdirp(n);
        return null;
      },
      read: (p) => this.files.get(MemFs.norm(p)) ?? null,
      remove: (p, r, f) => {
        const n = MemFs.norm(p);
        if (this.files.delete(n)) {
          return null;
        }
        if (this.dirs.has(n)) {
          if (!r) {
            return `rm: cannot remove '${p}': Is a directory`;
          }
          for (const d of [...this.dirs]) {
            if (d === n || d.startsWith(`${n}/`)) {
              this.dirs.delete(d);
            }
          }
          for (const k of [...this.files.keys()]) {
            if (k.startsWith(`${n}/`)) {
              this.files.delete(k);
            }
          }
          return null;
        }
        return f ? null : `rm: cannot remove '${p}': No such file or directory`;
      },
      rename: (a, b) => {
        const x = MemFs.norm(a);
        const y = MemFs.norm(b);
        const data = this.files.get(x);
        if (data) {
          this.files.delete(x);
          this.write(y, data);
          return null;
        }
        return `mv: cannot stat '${a}': No such file or directory`;
      },
      stat: (p) => {
        const n = MemFs.norm(p);
        if (this.dirs.has(n)) {
          return { size: 4096, type: "dir" };
        }
        const f = this.files.get(n);
        return f ? { size: f.length, type: "file" } : null;
      },
      write: (p, d) => this.write(p, d),
    };
  }
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

interface FakeImage {
  Id: string;
  tags: Set<string>;
  labels: Record<string, string>;
  env: string[];
  cmd: string[];
  workdir: string;
  user: string;
  fs: MemFs;
  created: number;
}

interface FakeExec {
  id: string;
  containerId: string;
  cmd: string[];
  env: string[];
  workdir?: string;
  tty: boolean;
  attachStdin: boolean;
  running: boolean;
  exitCode: number | null;
  pid: number;
  abort: AbortController;
  killedWith?: number;
  resizes: [number, number][];
}

interface FakeContainer {
  Id: string;
  Name: string;
  Created: string;
  image: FakeImage;
  imageRef: string;
  body: ContainerCreateBody;
  labels: Record<string, string>;
  env: string[];
  status: "created" | "running" | "paused" | "exited";
  networks: Set<string>;
  ports: Record<string, { HostIp: string; HostPort: string }[]>;
  fs: MemFs;
  nextPid: number;
}

interface FakeVolume {
  Name: string;
  Labels: Record<string, string>;
  CreatedAt: string;
}

class FakeApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "FakeApiError";
    this.status = status;
  }
}

const hex = (n: number): string => {
  let s = "";
  while (s.length < n) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return s;
};

function frame(kind: 1 | 2, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(4, data.length, false);
  out.set(data, 8);
  return out;
}

function labelMatch(
  labels: Record<string, string>,
  filters: string[] | undefined
): boolean {
  return (filters ?? []).every((f) => {
    const eq = f.indexOf("=");
    return eq === -1 ? f in labels : labels[f.slice(0, eq)] === f.slice(eq + 1);
  });
}

// ---------------------------------------------------------------------------
// the fake daemon
// ---------------------------------------------------------------------------

interface FakeDaemonLog {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
}

class FakeDocker implements DockerTransport {
  readonly endpoint = "unix:///fake/docker.sock";
  readonly runtime = "FakeDocker";
  readonly previewHost = "127.0.0.1";
  readonly images = new Map<string, FakeImage>();
  readonly containers = new Map<string, FakeContainer>();
  readonly execs = new Map<string, FakeExec>();
  readonly volumes = new Map<string, FakeVolume>();
  readonly log: FakeDaemonLog[] = [];
  /** Image refs that `POST /images/create` can "pull". */
  readonly registry = new Set<string>(["debian:bookworm-slim", "node:22-slim"]);
  #hostPort = 32_768;

  constructor() {
    this.#addImage("debian:bookworm-slim", new MemFs(), {});
  }

  #addImage(
    tag: string | undefined,
    fs: MemFs,
    labels: Record<string, string>,
    extra: Partial<FakeImage> = {}
  ): FakeImage {
    const img: FakeImage = {
      Id: `sha256:${hex(64)}`,
      cmd: ["bash"],
      created: Math.floor(Date.now() / 1000),
      env: [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      ],
      fs,
      labels,
      tags: new Set(),
      user: "",
      workdir: "",
      ...extra,
    };
    if (tag) {
      this.#tag(img, tag);
    }
    this.images.set(img.Id, img);
    return img;
  }

  #tag(img: FakeImage, tag: string): void {
    const full = tag.includes(":") ? tag : `${tag}:latest`;
    for (const other of this.images.values()) {
      other.tags.delete(full);
    }
    img.tags.add(full);
  }

  #image(ref: string): FakeImage {
    const full =
      ref.includes(":") || ref.startsWith("sha256") ? ref : `${ref}:latest`;
    for (const img of this.images.values()) {
      if (img.Id === ref || img.tags.has(full) || img.Id === `sha256:${ref}`) {
        return img;
      }
    }
    throw new FakeApiError(404, `No such image: ${ref}`);
  }

  #container(idOrName: string): FakeContainer {
    for (const c of this.containers.values()) {
      if (
        c.Id === idOrName ||
        (idOrName.length >= 12 && c.Id.startsWith(idOrName)) ||
        c.Name === `/${idOrName}`
      ) {
        return c;
      }
    }
    throw new FakeApiError(404, `No such container: ${idOrName}`);
  }

  // ---- transport -----------------------------------------------------------

  async request(req: DockerRequest): Promise<DockerResponse> {
    const query = Object.fromEntries(
      Object.entries(req.query ?? {})
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [
          k,
          typeof v === "boolean" ? (v ? "1" : "0") : String(v),
        ])
    );
    const path = req.path.replace(/^\/v\d+\.\d+/, "");
    this.log.push({
      body:
        req.body instanceof Uint8Array
          ? `<${req.body.length} bytes>`
          : req.body,
      method: req.method,
      path,
      query,
    });
    try {
      const r = await this.#route(req.method, path, query, req);
      return r;
    } catch (error) {
      if (error instanceof FakeApiError) {
        return this.#json(error.status, { message: error.message });
      }
      throw error;
    }
  }

  async hijack(req: DockerRequest): Promise<DockerConn> {
    const path = req.path.replace(/^\/v\d+\.\d+/, "");
    this.log.push({ body: req.body, method: req.method, path, query: {} });
    const m = /^\/exec\/([^/]+)\/start$/.exec(path);
    if (!m || req.method !== "POST") {
      throw new FakeApiError(404, `fake: cannot hijack ${req.method} ${path}`);
    }
    if ((req.body as { Detach?: boolean } | undefined)?.Detach !== false) {
      throw new FakeApiError(
        400,
        "fake: hijacked exec/start needs Detach: false"
      );
    }
    const ex = this.execs.get(m[1]!);
    if (!ex) {
      throw new FakeApiError(404, `No such exec instance: ${m[1]}`);
    }
    return this.#startExec(ex);
  }

  // ---- responses -------------------------------------------------------------

  #res(
    status: number,
    body: Uint8Array,
    headers: Record<string, string> = {}
  ): DockerResponse {
    return {
      body: (async function* one() {
        if (body.length > 0) {
          yield body;
        }
      })(),
      headers,
      status,
    };
  }
  #json(status: number, v: unknown): DockerResponse {
    return this.#res(status, enc.encode(JSON.stringify(v)), {
      "content-type": "application/json",
    });
  }
  #lines(lines: unknown[]): DockerResponse {
    return this.#res(
      200,
      enc.encode(lines.map((l) => `${JSON.stringify(l)}\r\n`).join(""))
    );
  }

  // ---- router --------------------------------------------------------------

  // oxlint-disable-next-line complexity
  async #route(
    method: string,
    path: string,
    q: Record<string, string>,
    req: DockerRequest
  ): Promise<DockerResponse> {
    const body = req.body as Record<string, unknown> | undefined;
    let m: RegExpExecArray | null;

    if (method === "GET" && path === "/_ping") {
      return this.#res(200, enc.encode("OK"));
    }
    if (method === "GET" && path === "/version") {
      return this.#json(200, {
        ApiVersion: "1.47",
        Platform: { Name: "Fake Engine" },
        Version: "27.0.0",
      });
    }

    // ---- images ----
    if (method === "GET" && path === "/images/json") {
      const f = q.filters
        ? (JSON.parse(q.filters) as Record<string, string[]>)
        : {};
      const out: ImageSummary[] = [...this.images.values()]
        .filter((i) => labelMatch(i.labels, f.label))
        .map((i) => ({
          Created: i.created,
          Id: i.Id,
          Labels: i.labels,
          RepoTags: [...i.tags],
        }));
      return this.#json(200, out);
    }
    if ((m = /^\/images\/(.+)\/json$/.exec(path)) && method === "GET") {
      const img = this.#image(decodeURIComponent(m[1]!));
      const out: ImageInspect & { Config: { Env: string[] } } = {
        Config: { Env: img.env, Labels: img.labels },
        Created: new Date(img.created * 1000).toISOString(),
        Id: img.Id,
        RepoTags: [...img.tags],
      };
      return this.#json(200, out);
    }
    if (method === "POST" && path === "/images/create") {
      const ref = q.tag ? `${q.fromImage}:${q.tag}` : q.fromImage!;
      if (!this.registry.has(ref)) {
        return this.#lines([
          {
            error: `pull access denied for ${q.fromImage}, repository does not exist`,
          },
        ]);
      }
      this.#addImage(ref, new MemFs(), {});
      return this.#lines([
        { status: `Pulling from library/${q.fromImage}`, id: q.tag },
        { progress: "[=====>   ]", status: "Downloading", id: "abc" },
        { status: `Status: Downloaded newer image for ${ref}` },
      ]);
    }
    if ((m = /^\/images\/(.+)$/.exec(path)) && method === "DELETE") {
      const ref = decodeURIComponent(m[1]!);
      const img = this.#image(ref);
      for (const c of this.containers.values()) {
        if (c.image === img) {
          throw new FakeApiError(
            409,
            `conflict: unable to remove ${ref} (in use)`
          );
        }
      }
      const full = ref.includes(":") ? ref : `${ref}:latest`;
      img.tags.delete(full);
      if (img.tags.size === 0 || ref === img.Id) {
        this.images.delete(img.Id);
      }
      return this.#json(200, [{ Untagged: ref }]);
    }
    if (method === "POST" && path === "/build") {
      return this.#build(q, req.body as Uint8Array);
    }
    if (method === "POST" && path === "/commit") {
      const c = this.#container(q.container!);
      const b = (body ?? {}) as {
        Labels?: Record<string, string>;
        Env?: string[];
      };
      const img = this.#addImage(
        `${q.repo}:${q.tag}`,
        c.fs.clone(),
        b.Labels ?? { ...c.labels },
        {
          cmd: c.body.Cmd ?? c.image.cmd,
          env: b.Env && b.Env.length > 0 ? b.Env : c.env,
        }
      );
      return this.#json(201, { Id: img.Id });
    }

    // ---- containers ----
    if (method === "POST" && path === "/containers/create") {
      return this.#create(q, body as unknown as ContainerCreateBody);
    }
    if (method === "GET" && path === "/containers/json") {
      const f = q.filters
        ? (JSON.parse(q.filters) as Record<string, string[]>)
        : {};
      let out: ContainerSummary[] = [...this.containers.values()]
        .filter((c) => q.all === "1" || c.status === "running")
        .filter((c) => labelMatch(c.labels, f.label))
        .filter((c) => !f.status || f.status.includes(c.status))
        .filter(
          (c) => !f.name || f.name.some((n) => new RegExp(n).test(c.Name))
        )
        .map((c) => ({
          Created: Math.floor(new Date(c.Created).getTime() / 1000),
          Id: c.Id,
          Image: c.imageRef,
          Labels: c.labels,
          Names: [c.Name],
          State: c.status,
        }));
      if (q.limit) {
        out = out.slice(0, Number(q.limit));
      }
      return this.#json(200, out);
    }
    if ((m = /^\/containers\/([^/]+)\/json$/.exec(path)) && method === "GET") {
      return this.#json(200, this.#inspect(this.#container(m[1]!)));
    }
    if (
      (m = /^\/containers\/([^/]+)\/(start|stop|pause|unpause)$/.exec(path))
    ) {
      const c = this.#container(m[1]!);
      const op = m[2]!;
      if (op === "start") {
        if (c.status === "running") {
          return this.#res(304, new Uint8Array());
        }
        if (c.status === "paused") {
          throw new FakeApiError(
            409,
            "cannot start a paused container, try unpause instead"
          );
        }
        c.status = "running";
        this.#bindPorts(c);
      } else if (op === "stop") {
        if (c.status !== "running" && c.status !== "paused") {
          return this.#res(304, new Uint8Array());
        }
        c.status = "exited";
        c.ports = {};
        this.#killAll(c);
      } else if (op === "pause") {
        if (c.status !== "running") {
          throw new FakeApiError(409, `Container ${c.Id} is not running`);
        }
        c.status = "paused";
      } else {
        if (c.status !== "paused") {
          throw new FakeApiError(409, `Container ${c.Id} is not paused`);
        }
        c.status = "running";
      }
      return this.#res(204, new Uint8Array());
    }
    if ((m = /^\/containers\/([^/]+)$/.exec(path)) && method === "DELETE") {
      const c = this.#container(m[1]!);
      if (c.status === "running" && q.force !== "1") {
        throw new FakeApiError(409, "cannot remove a running container");
      }
      this.#killAll(c);
      this.containers.delete(c.Id);
      return this.#res(204, new Uint8Array());
    }
    if ((m = /^\/containers\/([^/]+)\/archive$/.exec(path))) {
      return this.#archive(
        method,
        this.#container(m[1]!),
        q,
        req.body as Uint8Array
      );
    }
    if ((m = /^\/containers\/([^/]+)\/exec$/.exec(path)) && method === "POST") {
      const c = this.#container(m[1]!);
      if (c.status !== "running") {
        throw new FakeApiError(
          409,
          `Container ${c.Id} is ${c.status === "paused" ? "paused, unpause the container before exec" : "not running"}`
        );
      }
      const b = body as {
        Cmd?: string[];
        Env?: string[];
        WorkingDir?: string;
        Tty?: boolean;
        AttachStdin?: boolean;
      };
      if (!Array.isArray(b.Cmd) || b.Cmd.length === 0) {
        throw new FakeApiError(400, "No exec command specified");
      }
      const ex: FakeExec = {
        abort: new AbortController(),
        attachStdin: !!b.AttachStdin,
        cmd: b.Cmd,
        containerId: c.Id,
        env: b.Env ?? [],
        exitCode: null,
        id: hex(64),
        pid: 0,
        resizes: [],
        running: false,
        tty: !!b.Tty,
        workdir: b.WorkingDir,
      };
      this.execs.set(ex.id, ex);
      return this.#json(201, { Id: ex.id });
    }
    if ((m = /^\/exec\/([^/]+)\/start$/.exec(path)) && method === "POST") {
      // Detached start (no hijack): run in the background, discard output.
      const ex = this.execs.get(m[1]!);
      if (!ex) {
        throw new FakeApiError(404, "No such exec instance");
      }
      if ((body as { Detach?: boolean })?.Detach !== true) {
        throw new FakeApiError(
          400,
          "fake: attached exec/start must be hijacked"
        );
      }
      ex.running = true;
      return this.#res(200, new Uint8Array());
    }
    if ((m = /^\/exec\/([^/]+)\/json$/.exec(path)) && method === "GET") {
      const ex = this.execs.get(m[1]!);
      if (!ex) {
        throw new FakeApiError(404, "No such exec instance");
      }
      return this.#json(200, {
        ContainerID: ex.containerId,
        ExitCode: ex.exitCode,
        ID: ex.id,
        // Like real docker: the daemon-namespace pid, not the container's.
        Pid: ex.pid + 100_000,
        Running: ex.running,
      });
    }
    if ((m = /^\/exec\/([^/]+)\/resize$/.exec(path)) && method === "POST") {
      const ex = this.execs.get(m[1]!);
      if (!ex) {
        throw new FakeApiError(404, "No such exec instance");
      }
      ex.resizes.push([Number(q.h), Number(q.w)]);
      return this.#res(201, new Uint8Array());
    }
    if ((m = /^\/containers\/([^/]+)\/stats$/.exec(path)) && method === "GET") {
      const c = this.#container(m[1]!);
      return this.#json(200, {
        cpu_stats: {
          cpu_usage: { total_usage: 2_000_000 },
          online_cpus: 4,
          system_cpu_usage: 20_000_000,
        },
        memory_stats: {
          limit: c.body.HostConfig.Memory ?? 8 * 1_073_741_824,
          stats: { inactive_file: 1_048_576 },
          usage: 11 * 1_048_576,
        },
        precpu_stats: {
          cpu_usage: { total_usage: 1_000_000 },
          system_cpu_usage: 10_000_000,
        },
        read: new Date().toISOString(),
      });
    }

    // ---- networks ----
    if (
      (m = /^\/networks\/([^/]+)\/(connect|disconnect)$/.exec(path)) &&
      method === "POST"
    ) {
      const net = decodeURIComponent(m[1]!);
      const c = this.#container((body as { Container: string }).Container);
      if (m[2] === "connect") {
        if (c.networks.has("none")) {
          throw new FakeApiError(
            400,
            "container cannot be connected to multiple networks with one of the networks in private (none) mode"
          );
        }
        c.networks.add(net);
        this.#bindPorts(c);
      } else {
        if (!c.networks.delete(net)) {
          throw new FakeApiError(
            404,
            `container is not connected to network ${net}`
          );
        }
        if (![...c.networks].some((n) => n !== "none")) {
          c.ports = {};
        }
      }
      return this.#res(200, new Uint8Array());
    }

    // ---- volumes ----
    if (method === "POST" && path === "/volumes/create") {
      const b = body as { Name: string; Labels?: Record<string, string> };
      const v: FakeVolume = this.volumes.get(b.Name) ?? {
        CreatedAt: new Date().toISOString(),
        Labels: b.Labels ?? {},
        Name: b.Name,
      };
      this.volumes.set(v.Name, v);
      return this.#json(201, v);
    }
    if (method === "GET" && path === "/volumes") {
      const f = q.filters
        ? (JSON.parse(q.filters) as Record<string, string[]>)
        : {};
      return this.#json(200, {
        Volumes: [...this.volumes.values()].filter((v) =>
          labelMatch(v.Labels, f.label)
        ),
        Warnings: [],
      });
    }
    if ((m = /^\/volumes\/([^/]+)$/.exec(path))) {
      const name = decodeURIComponent(m[1]!);
      const v = this.volumes.get(name);
      if (!v) {
        throw new FakeApiError(404, `get ${name}: no such volume`);
      }
      if (method === "DELETE") {
        for (const c of this.containers.values()) {
          if (c.body.HostConfig.Mounts?.some((mt) => mt.Source === name)) {
            throw new FakeApiError(409, "volume is in use");
          }
        }
        this.volumes.delete(name);
        return this.#res(204, new Uint8Array());
      }
      return this.#json(200, v);
    }

    throw new FakeApiError(404, `fake: no route ${method} ${path}`);
  }

  // ---- containers ----------------------------------------------------------

  #create(q: Record<string, string>, b: ContainerCreateBody): DockerResponse {
    if (
      typeof b?.Image !== "string" ||
      typeof b.Labels !== "object" ||
      !b.HostConfig
    ) {
      throw new FakeApiError(400, "fake: malformed create body");
    }
    if (q.name && !/^\/?[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(q.name)) {
      throw new FakeApiError(400, `Invalid container name (${q.name})`);
    }
    if (
      q.name &&
      [...this.containers.values()].some((c) => c.Name === `/${q.name}`)
    ) {
      throw new FakeApiError(
        409,
        `Conflict. The container name "/${q.name}" is already in use`
      );
    }
    const img = this.#image(b.Image);
    for (const mt of b.HostConfig.Mounts ?? []) {
      if (mt.Type === "volume" && mt.Source && !this.volumes.has(mt.Source)) {
        this.volumes.set(mt.Source, {
          CreatedAt: new Date().toISOString(),
          Labels: {},
          Name: mt.Source,
        });
      }
    }
    const id = hex(64);
    const env = [...img.env];
    for (const e of b.Env ?? []) {
      const k = e.slice(0, e.indexOf("="));
      const i = env.findIndex((x) => x.startsWith(`${k}=`));
      if (i === -1) {
        env.push(e);
      } else {
        env[i] = e;
      }
    }
    const c: FakeContainer = {
      Created: new Date().toISOString(),
      Id: id,
      Name: `/${q.name ?? `fake_${id.slice(0, 6)}`}`,
      body: b,
      env,
      fs: img.fs.clone(),
      image: img,
      imageRef: b.Image,
      labels: { ...img.labels, ...b.Labels },
      networks: new Set([b.HostConfig.NetworkMode ?? "bridge"]),
      nextPid: 7,
      ports: {},
      status: "created",
    };
    this.containers.set(id, c);
    return this.#json(201, { Id: id, Warnings: [] });
  }

  #bindPorts(c: FakeContainer): void {
    if (c.status !== "running" || ![...c.networks].some((n) => n !== "none")) {
      return;
    }
    c.ports = {};
    for (const [k, binds] of Object.entries(
      c.body.HostConfig.PortBindings ?? {}
    )) {
      c.ports[k] = binds.map((bnd) => ({
        HostIp: bnd.HostIp ?? "0.0.0.0",
        HostPort: bnd.HostPort || String(this.#hostPort++),
      }));
    }
  }

  #killAll(c: FakeContainer): void {
    for (const ex of this.execs.values()) {
      if (ex.containerId === c.Id && ex.running) {
        ex.killedWith = 137;
        ex.abort.abort();
      }
    }
  }

  #inspect(c: FakeContainer): ContainerInspect {
    const nets: Record<string, { IPAddress?: string }> = {};
    for (const n of c.networks) {
      nets[n] = { IPAddress: n === "none" ? "" : "172.17.0.2" };
    }
    return {
      Config: {
        Cmd: c.body.Cmd ?? c.image.cmd,
        Entrypoint: c.body.Entrypoint ?? null,
        Env: c.env,
        ExposedPorts: c.body.ExposedPorts ?? null,
        Image: c.imageRef,
        Labels: c.labels,
        User: c.body.User ?? c.image.user,
        WorkingDir: c.body.WorkingDir ?? c.image.workdir,
      },
      Created: c.Created,
      HostConfig: c.body.HostConfig,
      Id: c.Id,
      Image: c.image.Id,
      Name: c.Name,
      NetworkSettings: { Networks: nets, Ports: c.ports },
      State: {
        Paused: c.status === "paused",
        Running: c.status === "running" || c.status === "paused",
        Status: c.status,
      },
    };
  }

  // ---- archive ---------------------------------------------------------------

  #archive(
    method: string,
    c: FakeContainer,
    q: Record<string, string>,
    body: Uint8Array | undefined
  ): DockerResponse {
    const p = MemFs.norm(q.path ?? "/");
    const isDir = c.fs.dirs.has(p);
    const file = c.fs.files.get(p);
    if (method === "PUT") {
      if (!isDir) {
        throw new FakeApiError(
          404,
          `Could not find the file ${p} in container`
        );
      }
      if (!(body instanceof Uint8Array)) {
        throw new FakeApiError(400, "fake: archive body must be a tar");
      }
      for (const e of readTar(body)) {
        const target = MemFs.norm(`${p}/${e.name}`);
        if (e.type === "dir") {
          c.fs.mkdirp(target);
        } else {
          c.fs.write(target, e.data);
        }
      }
      return this.#res(200, new Uint8Array());
    }
    if (!isDir && !file) {
      throw new FakeApiError(404, `Could not find the file ${p} in container`);
    }
    const name = p.slice(p.lastIndexOf("/") + 1) || "/";
    const stat = {
      linkTarget: "",
      // Go os.FileMode: ModeDir is 1<<31.
      mode: isDir ? 2_147_484_141 : 420,
      mtime: new Date().toISOString(),
      name,
      size: file?.length ?? 4096,
    };
    const header = btoa(JSON.stringify(stat));
    if (method === "HEAD") {
      return this.#res(200, new Uint8Array(), {
        "x-docker-container-path-stat": header,
      });
    }
    // GET: a dir is sent as a single (empty) dir entry here.
    const tar = isDir
      ? (() => {
          const t = tarContext(new Map([[`${name}/`, new Uint8Array()]]));
          t[156] = 0x35; // '5' directory
          return t;
        })()
      : tarContext(new Map([[name, file!]]));
    return this.#res(200, tar, { "x-docker-container-path-stat": header });
  }

  // ---- build -------------------------------------------------------------------

  #build(q: Record<string, string>, body: Uint8Array): DockerResponse {
    if (!(body instanceof Uint8Array)) {
      throw new FakeApiError(400, "fake: build body must be a tar");
    }
    const ctx = new Map(readTar(body).map((e) => [e.name, e.data]));
    const dfName = q.dockerfile ?? "Dockerfile";
    const df = ctx.get(dfName);
    if (!df) {
      return this.#lines([
        { error: `Cannot locate specified Dockerfile: ${dfName}` },
      ]);
    }
    const lines: unknown[] = [];
    let fs = new MemFs();
    let base: FakeImage | undefined;
    const env: string[] = [];
    let workdir = "";
    let user = "";
    const steps = dec
      .decode(df)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    for (const [i, step] of steps.entries()) {
      lines.push(
        { stream: `Step ${i + 1}/${steps.length} : ${step}` },
        { stream: "\n" }
      );
      const [op, ...rest] = step.split(/\s+/);
      const args = rest.join(" ");
      switch (op?.toUpperCase()) {
        case "FROM": {
          try {
            base = this.#image(args);
          } catch {
            return this.#lines([
              ...lines,
              {
                error: `pull access denied for ${args}`,
                errorDetail: { message: "denied" },
              },
            ]);
          }
          fs = base.fs.clone();
          break;
        }
        case "COPY": {
          const [src, dest] = rest;
          const data = src ? ctx.get(src.replace(/^\.\//, "")) : undefined;
          if (!data || !dest) {
            return this.#lines([
              ...lines,
              { error: `COPY failed: ${src} not found` },
            ]);
          }
          fs.write(dest.endsWith("/") ? `${dest}${src}` : dest, data);
          break;
        }
        case "ENV": {
          const m = /^(\w+)="((?:[^"\\]|\\.)*)"$/.exec(args);
          if (m) {
            env.push(`${m[1]}=${m[2]!.replaceAll(/\\(.)/g, "$1")}`);
          }
          break;
        }
        case "WORKDIR": {
          workdir = args;
          fs.mkdirp(args);
          break;
        }
        case "USER": {
          user = args;
          break;
        }
        default: {
          break;
        }
      }
    }
    const labels = {
      ...base?.labels,
      ...(q.labels ? JSON.parse(q.labels) : {}),
    };
    const img = this.#addImage(q.t, fs, labels, {
      env: [...(base?.env ?? []), ...env],
      user,
      workdir,
    });
    lines.push(
      { aux: { ID: img.Id } },
      { stream: `Successfully built ${img.Id.slice(7, 19)}\n` },
      { stream: `Successfully tagged ${q.t}\n` }
    );
    return this.#lines(lines);
  }

  // ---- exec ------------------------------------------------------------------

  #startExec(ex: FakeExec): DockerConn {
    const c = this.containers.get(ex.containerId);
    if (!c || c.status !== "running") {
      throw new FakeApiError(409, "container is not running");
    }
    if (ex.running || ex.exitCode !== null) {
      throw new FakeApiError(409, "exec already started");
    }
    ex.running = true;
    ex.pid = c.nextPid++;
    const out = new AsyncQueue<Uint8Array>();
    const stdin: Uint8Array[] = [];
    const io = {
      closed: !ex.attachStdin,
      wake: undefined as (() => void) | undefined,
    };
    const waitStdin = (ms: number) =>
      new Promise<void>((r) => {
        io.wake = r;
        setTimeout(r, ms);
      });
    const emit = (kind: 1 | 2, d: Uint8Array) => {
      if (d.length > 0) {
        out.push(ex.tty ? d : frame(kind, d));
      }
    };
    const env: Record<string, string> = {};
    for (const e of [...c.env, ...ex.env]) {
      const i = e.indexOf("=");
      env[e.slice(0, i)] = e.slice(i + 1);
    }
    const shell = new MiniShell(c.fs.shell());
    const cwd = ex.workdir || c.body.WorkingDir || c.image.workdir || "/";
    const finish = (code: number) => {
      ex.running = false;
      ex.exitCode = ex.killedWith ?? code;
      out.close();
    };
    const [a0, a1, script, argv0, userCmd] = ex.cmd;
    const isWrapper =
      a0 === "sh" &&
      a1 === "-c" &&
      (argv0 === "sbox-exec" || argv0 === "sbox-pty");

    void (async () => {
      // Kill helper: `kill -SIG $(t PID)` signals another exec by its pid.
      const kill = /kill -([A-Z0-9]+) \$\(t (\d+)\)/.exec(script ?? "");
      if (a0 === "sh" && a1 === "-c" && kill) {
        const pid = Number(kill[2]);
        const target = [...this.execs.values()].find(
          (e) => e.containerId === c.Id && e.pid === pid && e.running
        );
        if (!target && /\|\| exit 3/.test(script ?? "")) {
          finish(3);
          return;
        }
        if (target) {
          target.killedWith = kill[1] === "KILL" || kill[1] === "9" ? 137 : 143;
          target.abort.abort();
        }
        finish(0);
        return;
      }
      if (isWrapper) {
        emit(
          argv0 === "sbox-pty" ? 1 : 2,
          enc.encode(`\u001ESBOXPID:${ex.pid}\u001E`)
        );
      }
      if (argv0 === "sbox-pty") {
        await this.#ptyLoop(
          ex,
          shell,
          cwd,
          env,
          emit,
          stdin,
          () => io.closed,
          waitStdin,
          finish
        );
        return;
      }
      // Wait (briefly) for stdin to close, like `cat` blocking on input.
      const deadline = Date.now() + 30;
      while (!io.closed && Date.now() < deadline) {
        await waitStdin(5);
      }
      const all = new Uint8Array(stdin.reduce((n, x) => n + x.length, 0));
      let off = 0;
      for (const s of stdin) {
        all.set(s, off);
        off += s.length;
      }
      const cmd =
        isWrapper && userCmd !== undefined
          ? userCmd
          : a0 === "sh" && a1 === "-c"
            ? (script ?? "")
            : ex.cmd.map((x) => `'${x.replaceAll("'", `'\\''`)}'`).join(" ");
      const code = await shell.run(cmd, {
        cwd,
        env,
        signal: ex.abort.signal,
        stderr: (d) => emit(2, d),
        stdin: all,
        stdout: (d) => emit(1, d),
      });
      finish(code);
    })();

    return {
      close: () => {
        /* nothing to release */
      },
      async closeWrite() {
        io.closed = true;
        io.wake?.();
      },
      output: { [Symbol.asyncIterator]: () => out.iterator() },
      async write(d) {
        if (io.closed) {
          throw new Error("stdin closed");
        }
        stdin.push(d);
        io.wake?.();
      },
    };
  }

  async #ptyLoop(
    ex: FakeExec,
    shell: MiniShell,
    cwd: string,
    env: Record<string, string>,
    emit: (k: 1 | 2, d: Uint8Array) => void,
    stdin: Uint8Array[],
    closed: () => boolean,
    wait: (ms: number) => Promise<void>,
    finish: (code: number) => void
  ): Promise<void> {
    let line = "";
    for (;;) {
      while (stdin.length > 0) {
        const text = dec.decode(stdin.shift()!);
        emit(1, enc.encode(text.replaceAll("\n", "\r\n")));
        line += text;
        let nl = line.indexOf("\n");
        while (nl !== -1) {
          const cmd = line.slice(0, nl).replace(/\r$/, "");
          line = line.slice(nl + 1);
          const ex2 = /^\s*exit(?:\s+(\d+))?\s*$/.exec(cmd);
          if (ex2) {
            finish(Number(ex2[1] ?? 0));
            return;
          }
          await shell.run(cmd, {
            cwd,
            env,
            signal: ex.abort.signal,
            stderr: (d) => emit(1, d),
            stdin: new Uint8Array(),
            stdout: (d) => emit(1, d),
          });
          nl = line.indexOf("\n");
        }
      }
      if (closed() || ex.abort.signal.aborted) {
        finish(ex.abort.signal.aborted ? 137 : 0);
        return;
      }
      await wait(20);
    }
  }
}

// ===========================================================================
// tests
// ===========================================================================

const fakeCtx = (): CallContext => ({ attempt: 1, fetch: globalThis.fetch });

describe("docker: stream demux", () => {
  it("splits frames across arbitrary chunk boundaries", () => {
    const a = frame(1, enc.encode("hello "));
    const b = frame(2, enc.encode("oops"));
    const c = frame(1, enc.encode("world"));
    const all = new Uint8Array([...a, ...b, ...c]);
    const d = new Demuxer();
    const got: string[] = [];
    // Feed one byte at a time: worst case.
    for (const byte of all) {
      for (const f of d.push(new Uint8Array([byte]))) {
        got.push(`${f.stream}:${dec.decode(f.data)}`);
      }
    }
    expect(got).toEqual(["stdout:hello ", "stderr:oops", "stdout:world"]);
    expect(d.pending).toBe(0);
  });

  it("handles many frames in one chunk, empty frames and large sizes", () => {
    const big = new Uint8Array(70_000).fill(65);
    const all = new Uint8Array([
      ...frame(1, new Uint8Array()),
      ...frame(2, enc.encode("e")),
      ...frame(1, big),
    ]);
    const frames = new Demuxer().push(all);
    expect(frames.map((f) => [f.stream, f.data.length])).toEqual([
      ["stdout", 0],
      ["stderr", 1],
      ["stdout", 70_000],
    ]);
  });

  it("keeps an incomplete frame pending", () => {
    const d = new Demuxer();
    const f = frame(1, enc.encode("abcdef"));
    expect(d.push(f.subarray(0, 10))).toEqual([]);
    expect(d.pending).toBe(10);
    expect(d.push(f.subarray(10)).map((x) => dec.decode(x.data))).toEqual([
      "abcdef",
    ]);
  });
});

describe("docker: pid marker", () => {
  it("strips the marker and reports the pid, even split across chunks", () => {
    let pid = "";
    const m = new PidMarker((p) => {
      pid = p;
    });
    const bytes = enc.encode("\u001ESBOXPID:4242\u001Erest of stderr");
    const out: number[] = [];
    for (let i = 0; i < bytes.length; i += 3) {
      out.push(...m.push(bytes.subarray(i, i + 3)));
    }
    expect(pid).toBe("4242");
    expect(dec.decode(new Uint8Array(out))).toBe("rest of stderr");
  });

  it("passes through output that is not a marker", () => {
    const m = new PidMarker(() => {
      throw new Error("no pid expected");
    });
    expect(dec.decode(m.push(enc.encode("plain")))).toBe("plain");
    expect(dec.decode(m.push(enc.encode("\u001E")))).toBe("\u001E");
  });

  it("gives up on a malformed marker", () => {
    const m = new PidMarker(() => {});
    expect(dec.decode(m.push(enc.encode("\u001ESBOXPID:12x")))).toBe(
      "\u001ESBOXPID:12x"
    );
  });

  it("flushes a partial marker when the stream ends", () => {
    const m = new PidMarker(() => {});
    expect(m.push(enc.encode("\u001ESBOX")).length).toBe(0);
    expect(dec.decode(m.flush())).toBe("\u001ESBOX");
  });
});

describe("docker: tar reader", () => {
  it("round-trips tarContext output, binary safe", () => {
    const bin = new Uint8Array(1000).map((_, i) => i % 256);
    const tar = tarContext(
      new Map([
        ["a.txt", enc.encode("hello")],
        ["dir/b.bin", bin],
      ])
    );
    patchTarHeader(tar, 0, { mode: 0o755, mtime: 1_700_000_000 });
    const entries = readTar(tar);
    expect(entries.map((e) => [e.name, e.type, e.size])).toEqual([
      ["a.txt", "file", 5],
      ["dir/b.bin", "file", 1000],
    ]);
    expect(dec.decode(entries[0]!.data)).toBe("hello");
    expect(entries[0]!.mode).toBe(0o755);
    expect(entries[0]!.mtime?.getTime()).toBe(1_700_000_000_000);
    expect(entries[1]!.data).toEqual(bin);
  });

  it("reads ustar prefix, pax path/size and GNU long names", () => {
    const longDir = `${"d".repeat(120)}`;
    const viaPrefix = readTar(
      tarContext(new Map([[`${longDir}/f.txt`, enc.encode("x")]]))
    );
    expect(viaPrefix[0]!.name).toBe(`${longDir}/f.txt`);

    const paxBody = enc.encode("28 path=some/very/long/name\n");
    const pax = tarContext(new Map([["PaxHeader", paxBody]]));
    pax[156] = 0x78; // 'x'
    const file = tarContext(new Map([["short", enc.encode("pax!")]]));
    const combined = new Uint8Array([...pax.subarray(0, -1024), ...file]);
    const viaPax = readTar(combined);
    expect(viaPax.map((e) => [e.name, dec.decode(e.data)])).toEqual([
      ["some/very/long/name", "pax!"],
    ]);

    const gnu = tarContext(
      new Map([["././@LongLink", enc.encode("gnu/long/name.txt\0")]])
    );
    gnu[156] = 0x4c; // 'L'
    const gnuCombined = new Uint8Array([
      ...gnu.subarray(0, -1024),
      ...tarContext(new Map([["trunc", enc.encode("g")]])),
    ]);
    expect(readTar(gnuCombined)[0]!.name).toBe("gnu/long/name.txt");
  });

  it("detects directories and symlinks", () => {
    const t = tarContext(
      new Map([
        ["d/", new Uint8Array()],
        ["l", new Uint8Array()],
      ])
    );
    t[156] = 0x35; // dir
    t[512 + 156] = 0x32; // symlink
    t.set(enc.encode("target.txt"), 512 + 157);
    const [d, l] = readTar(t);
    expect(d!.type).toBe("dir");
    expect(l!.type).toBe("symlink");
    expect(l!.linkname).toBe("target.txt");
  });
});

describe("docker: socket discovery", () => {
  const home = "/Users/me";
  const exists =
    (paths: Record<string, string>) =>
    async (p: string): Promise<string | undefined> =>
      paths[p];

  it("prefers an explicit socketPath", async () => {
    const ep = await discoverEndpoint({
      env: { DOCKER_HOST: "tcp://1.2.3.4:2375" },
      home,
      probe: exists({}),
      socketPath: "/custom.sock",
    });
    expect(ep).toEqual({
      kind: "unix",
      runtime: "Docker",
      socketPath: "/custom.sock",
    });
  });

  it("honors DOCKER_HOST unix:// and tcp:// (with TLS verify)", async () => {
    expect(
      await discoverEndpoint({
        env: { DOCKER_HOST: `unix://${home}/.colima/default/docker.sock` },
        home,
      })
    ).toMatchObject({ kind: "unix", runtime: "Colima" });
    expect(
      await discoverEndpoint({
        env: { DOCKER_HOST: "tcp://10.0.0.5", DOCKER_TLS_VERIFY: "1" },
        home,
      })
    ).toMatchObject({ host: "10.0.0.5", kind: "tcp", port: 2376, tls: true });
    expect(parseDockerHost("tcp://h:2375")).toMatchObject({
      port: 2375,
      tls: false,
    });
    expect(() => parseDockerHost("ssh://me@host")).toThrow(/not supported/);
  });

  it("probes well-known sockets in order and names the runtime", async () => {
    const order = socketCandidates({ XDG_RUNTIME_DIR: "/run/user/1000" }, home);
    expect(order.map((c) => c.socketPath)).toEqual([
      `${home}/.orbstack/run/docker.sock`,
      "/var/run/docker.sock",
      `${home}/.docker/run/docker.sock`,
      `${home}/.colima/default/docker.sock`,
      `${home}/.rd/docker.sock`,
      "/run/user/1000/podman/podman.sock",
      `${home}/.local/share/containers/podman/machine/podman.sock`,
    ]);
    // /var/run/docker.sock symlinked to OrbStack's socket => "OrbStack".
    expect(
      await discoverEndpoint({
        env: {},
        home,
        probe: exists({
          "/var/run/docker.sock": `${home}/.orbstack/run/docker.sock`,
        }),
      })
    ).toEqual({
      kind: "unix",
      runtime: "OrbStack",
      socketPath: "/var/run/docker.sock",
    });
    expect(
      await discoverEndpoint({
        env: {},
        home,
        probe: exists({
          [`${home}/.rd/docker.sock`]: `${home}/.rd/docker.sock`,
        }),
      })
    ).toMatchObject({ runtime: "Rancher Desktop" });
    expect(
      await discoverEndpoint({
        env: {},
        home,
        probe: exists({
          [`${home}/.local/share/containers/podman/machine/podman.sock`]:
            "/tmp/podman/api.sock",
        }),
      })
    ).toMatchObject({ runtime: "Podman" });
  });

  it("throws a helpful error when nothing is running", async () => {
    await expect(
      discoverEndpoint({ env: {}, home, probe: exists({}) })
    ).rejects.toThrow(/no Docker socket found.*OrbStack/);
  });
});

describe("docker: labels, filters, status", () => {
  it("maps metadata to labels and back", () => {
    expect(metadataLabels({ app: "borat", "a.b": "c" })).toEqual({
      "sbox.meta.a.b": "c",
      "sbox.meta.app": "borat",
    });
    expect(
      metadataFromLabels({
        other: "x",
        "sbox.managed": "true",
        "sbox.meta.app": "borat",
        "sbox.meta.blank": "",
      })
    ).toEqual({ app: "borat" });
    expect(() => metadataLabels({ "a=b": "x" })).toThrow(
      /invalid metadata key/
    );
  });

  it("builds container list filters", () => {
    expect(
      containerFilters({
        idempotencyKey: "k1",
        metadata: { app: "borat" },
        name: "desk",
        state: "stopped",
      })
    ).toEqual({
      label: [
        "sbox.managed=true",
        "sbox.meta.app=borat",
        "sbox.name=desk",
        "sbox.idempotency=k1",
      ],
      status: ["exited", "created"],
    });
    expect(containerFilters({})).toEqual({ label: ["sbox.managed=true"] });
  });

  it("maps every docker status", () => {
    expect(
      Object.fromEntries(
        [
          "created",
          "running",
          "paused",
          "restarting",
          "removing",
          "exited",
          "dead",
          "weird",
        ].map((s) => [s, mapStatus(s)])
      )
    ).toEqual({
      created: "stopped",
      dead: "error",
      exited: "stopped",
      paused: "paused",
      removing: "destroyed",
      restarting: "creating",
      running: "running",
      weird: "unknown",
    });
    expect(statusFilter("archived")).toEqual([]);
    expect(statusFilter("running")).toEqual(["running"]);
  });

  it("derives stable names and image refs", () => {
    expect(containerNameFor("My Desk!", "key")).toMatch(
      /^sbox-My-Desk-[0-9a-f]{12}$/
    );
    expect(containerNameFor(undefined, "key")).toBe(
      containerNameFor(undefined, "key")
    );
    expect(containerNameFor(undefined, "a")).not.toBe(
      containerNameFor(undefined, "b")
    );
    expect(sanitizeRepo("Borat Desktop__v2")).toBe("borat-desktop-v2");
    expect(parseImageRef("debian:bookworm-slim")).toEqual({
      fromImage: "debian",
      tag: "bookworm-slim",
    });
    expect(parseImageRef("localhost:5000/x/y")).toEqual({
      fromImage: "localhost:5000/x/y",
      tag: "latest",
    });
    expect(parseImageRef("x@sha256:abc").tag).toBe("");
    expect(registryOf("ghcr.io/me/img:1")).toBe("ghcr.io");
    expect(registryOf("debian")).toBe("https://index.docker.io/v1/");
    const auth = JSON.parse(
      atob(
        registryAuthHeader("ghcr.io/me/x", { password: "p", username: "u" })
          .replaceAll("-", "+")
          .replaceAll("_", "/")
      )
    );
    expect(auth).toEqual({
      password: "p",
      serveraddress: "ghcr.io",
      username: "u",
    });
  });

  it("decodes the path-stat header (Go FileMode)", () => {
    const enc64 = (o: object) => btoa(JSON.stringify(o));
    expect(
      parsePathStat(
        enc64({
          mode: 2_147_484_141,
          mtime: "2024-01-02T03:04:05Z",
          name: "d",
          size: 4096,
        }),
        "/d"
      )
    ).toEqual({
      mtime: new Date("2024-01-02T03:04:05Z"),
      path: "/d",
      size: 0,
      type: "dir",
    });
    expect(
      parsePathStat(enc64({ mode: 420, name: "f", size: 3 }), "/f")
    ).toMatchObject({
      size: 3,
      type: "file",
    });
    expect(
      parsePathStat(
        enc64({ linkTarget: "/x", mode: 134_218_239, name: "l", size: 2 }),
        "/l"
      ).type
    ).toBe("symlink");
  });

  it("builds kill and exec wrappers safely", () => {
    expect(signalName("sigterm")).toBe("TERM");
    expect(signalName(undefined)).toBe("KILL");
    expect(() => signalName("TERM; rm -rf /")).toThrow(/invalid signal/);
    expect(() => killTreeScript("1; rm", "KILL")).toThrow(/invalid pid/);
    expect(killTreeScript("42", "INT")).toContain("kill -INT $(t 42)");
    expect(execWrapper("echo 'a b'")).toEqual([
      "sh",
      "-c",
      String.raw`printf '\036SBOXPID:%s\036' "$$" >&2; exec sh -c "$1"`,
      "sbox-exec",
      "echo 'a b'",
    ]);
    expect(ptyWrapper(undefined)[4]).toBe("");
  });

  it("computes docker-stats style metrics", () => {
    const m = computeMetrics({
      cpu_stats: {
        cpu_usage: { total_usage: 3000 },
        online_cpus: 2,
        system_cpu_usage: 20_000,
      },
      memory_stats: {
        limit: 512 * 1_048_576,
        stats: { inactive_file: 10 * 1_048_576 },
        usage: 110 * 1_048_576,
      },
      precpu_stats: {
        cpu_usage: { total_usage: 1000 },
        system_cpu_usage: 10_000,
      },
      read: "2025-01-01T00:00:00Z",
    });
    expect(m.cpuPercent).toBeCloseTo(40);
    expect(m.memoryUsedMB).toBe(100);
    expect(m.memoryTotalMB).toBe(512);
    expect(m.timestamp.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    // Paused / first sample: zeroed read time => now.
    expect(
      computeMetrics({ read: "0001-01-01T00:00:00Z" }).timestamp.getFullYear()
    ).toBeGreaterThan(2000);
  });
});

describe("docker: spec -> container create body", () => {
  const base = {
    bindIp: "127.0.0.1",
    defaultCommand: ["sleep", "infinity"] as string[],
    image: "debian:bookworm-slim",
  };

  it("maps a rich desktop spec", () => {
    const body = buildCreateBody(
      {
        env: { DISPLAY: ":1" },
        metadata: { app: "borat" },
        name: "desk",
        network: { mode: "block-all" },
        ports: [6080, 7000],
        resources: { gpuCount: 1, memoryMB: 2048, shmMB: 1024, vcpus: 2 },
        secrets: [
          { name: "API_KEY", value: "s3cret" },
          { envVar: "TOKEN", name: "HOST_TOKEN" },
        ],
        volumes: [
          { id: "borat-home", mountPath: "/home/user" },
          { id: "/Users/me/shared", mountPath: "/mnt/shared", readOnly: true },
        ],
      },
      {
        ...base,
        hostEnv: { HOST_TOKEN: "from-host" },
        idempotencyKey: "idem-1",
      }
    );
    expect(body).toEqual({
      Cmd: ["sleep", "infinity"],
      Env: ["DISPLAY=:1", "API_KEY=s3cret", "TOKEN=from-host"],
      ExposedPorts: { "6080/tcp": {}, "7000/tcp": {} },
      HostConfig: {
        DeviceRequests: [{ Capabilities: [["gpu"]], Count: 1 }],
        Init: true,
        Memory: 2048 * 1_048_576,
        Mounts: [
          {
            ReadOnly: false,
            Source: "borat-home",
            Target: "/home/user",
            Type: "volume",
          },
          {
            ReadOnly: true,
            Source: "/Users/me/shared",
            Target: "/mnt/shared",
            Type: "bind",
          },
        ],
        NanoCpus: 2_000_000_000,
        NetworkMode: "none",
        PortBindings: {
          "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
          "7000/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
        },
        ShmSize: 1024 * 1_048_576,
      },
      Image: "debian:bookworm-slim",
      Labels: {
        "sbox.idempotency": "idem-1",
        "sbox.managed": "true",
        "sbox.meta.app": "borat",
        "sbox.name": "desk",
      },
    });
  });

  it("uses the template's startCmd and default resources", () => {
    const body = buildCreateBody(
      {},
      {
        ...base,
        imageLabels: {
          "sbox.resources": JSON.stringify({ shmMB: 512 }),
          "sbox.startCmd": "/opt/start.sh",
        },
      }
    );
    expect(body.Cmd).toEqual(["sh", "-c", "/opt/start.sh"]);
    expect(body.HostConfig.ShmSize).toBe(512 * 1_048_576);
    expect(body.Labels["sbox.name"]).toBe("");
    expect(body.Labels["sbox.idempotency"]).toBe("");
    expect(
      buildCreateBody({}, { ...base, defaultCommand: "image" }).Cmd
    ).toBeUndefined();
  });

  it("rejects what docker cannot express", () => {
    expect(() =>
      buildCreateBody(
        { network: { domains: ["x.com"], mode: "allow-list" } },
        base
      )
    ).toThrow(/allow-list/);
    expect(() =>
      buildCreateBody(
        { secrets: [{ mode: "egress", name: "K", value: "v" }] },
        base
      )
    ).toThrow(/egress/);
    expect(() =>
      buildCreateBody(
        { secrets: [{ name: "MISSING_X" }] },
        { ...base, hostEnv: {} }
      )
    ).toThrow(/no value/);
    expect(() => buildCreateBody({ ports: [70_000] }, base)).toThrow(
      /invalid port/
    );
  });
});

describe("docker: mapError", () => {
  const map = (status: number, msg = "x") =>
    mapDockerError(new DockerApiError(status, msg))?.code;
  it("maps statuses and socket errors", () => {
    expect(map(401)).toBe("Unauthorized");
    expect(map(403)).toBe("Unauthorized");
    expect(map(404)).toBe("NotFound");
    expect(map(500, "No such container: abc")).toBe("NotFound");
    expect(map(409)).toBe("Conflict");
    expect(map(429)).toBe("QuotaExceeded");
    expect(mapDockerError(new DockerApiError(429, "x"))?.retryable).toBe(true);
    expect(map(400)).toBe("Validation");
    expect(map(500)).toBe("Provider");
    const enoent = Object.assign(new Error("connect ENOENT"), {
      code: "ENOENT",
    });
    expect(mapDockerError(enoent)?.message).toMatch(
      /cannot reach the Docker daemon/
    );
    const timeout = Object.assign(new Error("t"), { code: "ETIMEDOUT" });
    expect(mapDockerError(timeout)?.code).toBe("Timeout");
    expect(mapDockerError(new Error("other"))).toBeUndefined();
  });
});

describe("docker adapter (offline, fake Engine API)", () => {
  it("declares truthful caps", () => {
    const p = docker({ transport: new FakeDocker() });
    expect(p.name).toBe("docker");
    expect(p.capabilities).toBe(DOCKER_CAPS);
    expect(p.flags.previewModel).toBe("ip");
    expect(p.flags.preservesMemoryOnPause).toBe(true);
    expect(p.flags.preservesDiskOnStop).toBe(true);
    expect(p.flags.templateSources).toEqual([
      "dockerfile",
      "image",
      "snapshot",
    ]);
  });

  it("passes the shared conformance suite through the fake daemon", async () => {
    const fake = new FakeDocker();
    const report = await runConformance(docker({ transport: fake }), {
      live: true,
      skip: ["network: set egress policy"],
      spec: { ports: [8080] },
      template: {
        name: "conf-tpl",
        source: {
          context: { "hello.txt": "hi" },
          dockerfile:
            "FROM debian:bookworm-slim\nCOPY hello.txt /app/hello.txt\n",
        },
      },
    });
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(report.checks.length).toBeGreaterThanOrEqual(38);
    // Nothing leaked: every container was removed.
    expect(fake.containers.size).toBe(0);
  }, 30_000);

  it("sends the mapped spec to POST /containers/create and pulls missing images", async () => {
    const fake = new FakeDocker();
    const pulls: string[] = [];
    const p = docker({ onPull: (e) => pulls.push(e.status), transport: fake });
    const client = createSandboxClient({ provider: p, telemetry: false });
    const sb = await client.create({
      env: { A: "1" },
      idempotencyKey: "idem-xyz",
      metadata: { app: "borat" },
      name: "desk",
      ports: [6080],
      resources: { shmMB: 1024 },
      template: "node:22-slim",
    });
    const create = fake.log.find((l) => l.path === "/containers/create")!;
    expect(create.query.name).toMatch(/^sbox-desk-[0-9a-f]{12}$/);
    expect(create.body).toMatchObject({
      Cmd: ["sleep", "infinity"],
      Env: ["A=1"],
      HostConfig: { Init: true, ShmSize: 1024 * 1_048_576 },
      Image: "node:22-slim",
      Labels: {
        "sbox.idempotency": "idem-xyz",
        "sbox.meta.app": "borat",
        "sbox.name": "desk",
      },
    });
    expect(
      fake.log.some(
        (l) => l.path === "/images/create" && l.query.fromImage === "node"
      )
    ).toBe(true);
    expect(pulls.length).toBeGreaterThan(0);
    // Same idempotency key => same container, no second create.
    const again = await client.create({ idempotencyKey: "idem-xyz" });
    expect(again.id).toBe(sb.id);
    expect(
      fake.log.filter((l) => l.path === "/containers/create")
    ).toHaveLength(1);
    const info = await sb.getInfo();
    expect(info).toMatchObject({
      metadata: { app: "borat" },
      name: "desk",
      state: "running",
    });
    await sb.destroy();
    const del = fake.log.find(
      (l) => l.method === "DELETE" && l.path.startsWith("/containers/")
    )!;
    expect(del.query).toEqual({ force: "1", v: "1" });
  });

  it("unknown images surface as NotFound", async () => {
    const client = createSandboxClient({
      provider: docker({ transport: new FakeDocker() }),
      telemetry: false,
    });
    await expect(
      client.create({ template: "nope/missing:1" })
    ).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  it("lists with label filters, state and limit", async () => {
    const fake = new FakeDocker();
    const p = docker({ transport: fake });
    const client = createSandboxClient({ provider: p, telemetry: false });
    const a = await client.create({ metadata: { team: "x" } });
    const b = await client.create({ metadata: { team: "x" } });
    await client.create({ metadata: { team: "y" } });
    await b.stop();
    const ids = async (f: Parameters<typeof client.list>[0]) => {
      const out: string[] = [];
      for await (const i of client.list(f)) {
        out.push(i.id);
      }
      return out;
    };
    expect((await ids({ metadata: { team: "x" } })).toSorted()).toEqual(
      [a.id, b.id].toSorted()
    );
    expect(await ids({ metadata: { team: "x" }, state: "stopped" })).toEqual([
      b.id,
    ]);
    expect(await ids({ metadata: { team: "x" }, state: "running" })).toEqual([
      a.id,
    ]);
    expect(await ids({ limit: 1 })).toHaveLength(1);
    expect(await ids({ state: "archived" })).toEqual([]);
    const listCall = fake.log.findLast((l) => l.path === "/containers/json")!;
    expect(listCall.query.all).toBe("1");
  });

  it("rejects allow-list egress and toggles the network", async () => {
    const fake = new FakeDocker();
    const client = createSandboxClient({
      provider: docker({ transport: fake }),
      telemetry: false,
    });
    const sb = await client.create({
      network: { mode: "block-all" },
      ports: [7000],
    });
    expect(await sb.ports!.list()).toEqual([]);
    await expect(sb.ports!.expose(7000)).rejects.toMatchObject({
      code: "Conflict",
    });
    await sb.network!.setEgressPolicy({ mode: "allow-all" });
    expect((await sb.ports!.expose(7000)).url).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+$/
    );
    await expect(
      sb.network!.setEgressPolicy({ domains: ["a.com"], mode: "allow-list" })
    ).rejects.toMatchObject({ code: "NotSupported" }); // core: flags.egressModes
    await sb.network!.setEgressPolicy({ mode: "block-all" });
    expect(await sb.ports!.list()).toEqual([]);
    await expect(sb.ports!.expose(9999)).rejects.toMatchObject({
      code: "Validation",
    });
  });

  it("builds templates with labels, env and startCmd; image + snapshot sources", async () => {
    const fake = new FakeDocker();
    const client = createSandboxClient({
      provider: docker({ transport: fake }),
      telemetry: false,
    });
    const events: string[] = [];
    const ref = await client.templates!.build(
      {
        env: { GREETING: 'hi "there" $USER' },
        name: "Borat Desktop",
        readyCmd: "true",
        resources: { shmMB: 1024 },
        source: {
          context: { "start.sh": "sleep infinity" },
          dockerfile:
            "FROM debian:bookworm-slim\nCOPY start.sh /opt/start.sh\n",
        },
        startCmd: "sh /opt/start.sh",
      },
      { onEvent: (e) => events.push(e.type === "log" ? e.line : e.status) }
    );
    expect(ref.id).toBe("sbox/borat-desktop:latest");
    expect(ref.cacheKey).toMatch(/^[0-9a-f]{64}$/);
    expect(events).toContain("building");
    expect(events.some((e) => e.includes("Step 2/3 : COPY"))).toBe(true);
    const build = fake.log.find((l) => l.path === "/build")!;
    expect(build.query.t).toBe("sbox/borat-desktop:latest");
    expect(JSON.parse(build.query.labels!)).toMatchObject({
      "sbox.cacheKey": ref.cacheKey,
      "sbox.readyCmd": "true",
      "sbox.resources": '{"shmMB":1024}',
      "sbox.startCmd": "sh /opt/start.sh",
      "sbox.template": "true",
    });
    expect(await client.templates!.get(ref.cacheKey!)).toMatchObject({
      id: ref.id,
    });
    expect(await client.templates!.get("Borat Desktop")).toMatchObject({
      id: ref.id,
    });
    const sb = await client.create({ template: ref });
    const create = fake.log.findLast((l) => l.path === "/containers/create")!;
    expect(create.body).toMatchObject({
      Cmd: ["sh", "-c", "sh /opt/start.sh"],
      HostConfig: { ShmSize: 1024 * 1_048_576 },
    });
    expect((await sb.commands.run("echo $GREETING")).stdout.trim()).toBe(
      'hi "there" $USER'
    );
    expect(await (await sb.files.read("/opt/start.sh")).text()).toBe(
      "sleep infinity"
    );

    const fromImage = await client.templates!.build({
      name: "node",
      source: { image: "node:22-slim" },
    });
    expect(fromImage.id).toBe("sbox/node:latest");
    expect(
      fake.log.some(
        (l) => l.path === "/images/create" && l.query.tag === "22-slim"
      )
    ).toBe(true);
    // Never pushes.
    expect(fake.log.some((l) => l.path.endsWith("/push"))).toBe(false);

    const snap = await sb.snapshots!.create({ name: "s1" });
    const fromSnap = await client.templates!.build({
      name: "from-snap",
      source: { snapshot: snap.id },
    });
    expect(fromSnap.id).toBe("sbox/from-snap:latest");
    const listed: string[] = [];
    for await (const t of client.templates!.list()) {
      listed.push(t.id);
    }
    expect(listed.toSorted()).toEqual(
      [
        "sbox/borat-desktop:latest",
        "sbox/from-snap:latest",
        "sbox/node:latest",
      ].toSorted()
    );
    await sb.destroy();
    await client.templates!.delete(fromSnap);
    expect(
      await client.templates!.get("sbox/from-snap:latest")
    ).toBeUndefined();
  });

  it("snapshots, fromSnapshot, fork cleanup, memory mode rejected", async () => {
    const fake = new FakeDocker();
    const client = createSandboxClient({
      provider: docker({ transport: fake }),
      telemetry: false,
    });
    const sb = await client.create({ metadata: { a: "1" }, name: "parent" });
    await sb.files.write("/root/x.txt", "v1");
    const snap = await sb.snapshots!.create({ name: "first" });
    expect(snap).toMatchObject({
      includesMemory: false,
      name: "first",
      provider: "docker",
    });
    expect(snap.id).toBe(`sbox-snapshot/${sb.id.slice(0, 12)}:first`);
    const commit = fake.log.find((l) => l.path === "/commit")!;
    expect(commit.body).toMatchObject({
      Labels: {
        "sbox.snapshot": "true",
        "sbox.snapshot.kind": "snapshot",
        "sbox.snapshot.meta.a": "1",
      },
    });
    expect((await sb.snapshots!.list()).map((s) => s.id)).toEqual([snap.id]);
    const child = await client.create({ fromSnapshot: snap });
    expect(await (await child.files.read("/root/x.txt")).text()).toBe("v1");
    // Snapshot images don't make the child answer to the parent's name.
    expect((await child.getInfo()).name).toBeUndefined();
    await expect(
      sb.snapshots!.create({ mode: "memory" })
    ).rejects.toMatchObject({ code: "Validation" });

    const [f1, f2] = await sb.fork({ count: 2 });
    expect(f1!.id).not.toBe(f2!.id);
    expect((await f1!.getInfo()).metadata).toEqual({ a: "1" });
    expect(await (await f2!.files.read("/root/x.txt")).text()).toBe("v1");
    const forkImages = () =>
      [...fake.images.values()].filter(
        (i) => i.labels["sbox.snapshot.kind"] === "fork"
      );
    expect(forkImages()).toHaveLength(1);
    await f1!.destroy();
    expect(forkImages()).toHaveLength(1); // still used by f2
    await f2!.destroy();
    expect(forkImages()).toHaveLength(0);

    await child.destroy();
    await sb.snapshots!.delete(snap);
    expect(await sb.snapshots!.list()).toEqual([]);
    await sb.destroy();
  });

  it("stop/resume, pause/resume, getOrCreate by name", async () => {
    const fake = new FakeDocker();
    const client = createSandboxClient({
      provider: docker({ transport: fake }),
      telemetry: false,
    });
    const sb = await client.getOrCreate({ name: "desk" });
    await sb.files.write("/root/keep", "1");
    await sb.stop();
    expect((await sb.getInfo()).state).toBe("stopped");
    // getOrCreate finds the stopped one and resumes it.
    const again = await client.getOrCreate({ name: "desk" });
    expect(again.id).toBe(sb.id);
    expect((await again.getInfo()).state).toBe("running");
    await sb.pause();
    expect((await sb.getInfo()).state).toBe("paused");
    await sb.resume();
    expect(await (await sb.files.read("/root/keep")).text()).toBe("1");
    await sb.setTimeout(60_000);
    expect(
      fake.log.some(
        (l) => l.path.endsWith("/start") && l.path.startsWith("/exec/")
      )
    ).toBe(true);
    await sb.destroy();
  });

  it("files: stat, nested write creates parents, missing => NotFound", async () => {
    const client = createSandboxClient({
      provider: docker({ transport: new FakeDocker() }),
      telemetry: false,
    });
    const sb = await client.create();
    await sb.files.write("/deep/new/dir/f.bin", new Uint8Array([0, 255, 1]));
    expect(await (await sb.files.read("/deep/new/dir/f.bin")).bytes()).toEqual(
      new Uint8Array([0, 255, 1])
    );
    expect(await sb.files.stat("/deep/new/dir/f.bin")).toMatchObject({
      size: 3,
      type: "file",
    });
    expect((await sb.files.stat("/deep/new")).type).toBe("dir");
    await expect(sb.files.read("/deep")).rejects.toMatchObject({
      code: "Validation",
    });
    await expect(sb.files.stat("/nope")).rejects.toMatchObject({
      code: "NotFound",
    });
    await sb.destroy();
  });

  it("volumes CRUD and mounts", async () => {
    const fake = new FakeDocker();
    const client = createSandboxClient({
      provider: docker({ transport: fake }),
      telemetry: false,
    });
    const v = await client.volumes!.create({ name: "home", sizeMB: 100 });
    expect(v).toMatchObject({ id: "home", name: "home", sizeMB: 100 });
    expect(await client.volumes!.get("home")).toMatchObject({ id: "home" });
    expect(await client.volumes!.get("missing")).toBeUndefined();
    const sb = await client.create({
      volumes: [{ id: "home", mountPath: "/home/u" }],
    });
    await expect(client.volumes!.delete(v)).rejects.toMatchObject({
      code: "Conflict",
    });
    await sb.destroy();
    await client.volumes!.delete(v);
    const names: string[] = [];
    for await (const x of client.volumes!.list()) {
      names.push(x.id);
    }
    expect(names).toEqual([]);
  });

  it("pty resize reaches /exec/{id}/resize and metrics are computed", async () => {
    const fake = new FakeDocker();
    const client = createSandboxClient({
      provider: docker({ transport: fake }),
      telemetry: false,
    });
    const sb = await client.create({ resources: { memoryMB: 512 } });
    const t = await sb.pty!.create({ cols: 100, rows: 30 });
    await t.resize(120, 40);
    const ex = [...fake.execs.values()].find((e) => e.tty)!;
    expect(ex.resizes).toEqual([[40, 120]]);
    const created = fake.log.find(
      (l) => l.path.endsWith("/exec") && (l.body as { Tty?: boolean }).Tty
    )!;
    expect(created.body).toMatchObject({ ConsoleSize: [30, 100], Tty: true });
    await t.write("exit 2\n");
    expect((await t.wait()).exitCode).toBe(2);
    const m = await sb.metrics();
    expect(m.cpuPercent).toBeCloseTo(40);
    expect(m.memoryUsedMB).toBe(10);
    expect(m.memoryTotalMB).toBe(512);
    await sb.destroy();
  });

  it("verify pings and reports the engine without creating", async () => {
    const fake = new FakeDocker();
    const p = docker({ transport: fake });
    expect(await p.verify!(fakeCtx())).toEqual({
      account: "FakeDocker (Fake Engine 27.0.0, API 1.47)",
    });
    expect(fake.log.map((l) => l.path)).toEqual(["/_ping", "/version"]);
  });

  it("pins the API version prefix when asked", async () => {
    const fake = new FakeDocker();
    const seen: string[] = [];
    const spy: DockerTransport = {
      ...fake,
      endpoint: fake.endpoint,
      hijack: (r) => fake.hijack(r),
      previewHost: fake.previewHost,
      request: (r) => {
        seen.push(r.path);
        return fake.request(r);
      },
      runtime: fake.runtime,
    };
    await docker({ apiVersion: "1.43", transport: spy }).verify!(fakeCtx());
    expect(seen).toEqual(["/v1.43/_ping", "/v1.43/version"]);
  });
});
