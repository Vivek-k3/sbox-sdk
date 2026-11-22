/**
 * Offline tests for the Blaxel adapter. `@blaxel/core` is replaced by a fake
 * modelled on the real 0.3.x method names and argument shapes (typed against
 * the SDK's own types); exec runs through MiniShell over an in-memory fs, so
 * the full conformance suite runs offline.
 */
import { readFileSync, statSync } from "node:fs";

import type {
  PaginatedList,
  SandboxCreateConfiguration,
  SandboxSnapshot,
  SandboxInstance as RealSandboxInstance,
} from "@blaxel/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runConformance } from "../conformance/index.js";
import { MiniShell } from "../memory/shell.js";
import type { ShellFs } from "../memory/shell.js";
import {
  BLAXEL_CAPS,
  blaxel,
  blaxelDuration,
  mapBlaxelError,
  mapBlaxelState,
  nameFromIdempotencyKey,
  planDockerfile,
  toBlaxelLifecycle,
  toBlaxelNetwork,
} from "./index.js";

type Mod = typeof import("@blaxel/core");
type ProcessApi = RealSandboxInstance["process"];
type ExecRequest = Parameters<ProcessApi["exec"]>[0];
type ProcessResponse = Awaited<ReturnType<ProcessApi["get"]>>;
type Directory = Awaited<ReturnType<RealSandboxInstance["fs"]["ls"]>>;
type WatchEvent = Parameters<
  Parameters<RealSandboxInstance["fs"]["watch"]>[1]
>[0];
type PreviewCreate = Parameters<
  RealSandboxInstance["previews"]["createIfNotExists"]
>[0];
type SnapshotModel = SandboxSnapshot;
type ListQuery = NonNullable<Parameters<Mod["SandboxInstance"]["list"]>[0]>;
type NetworkUpdate = Parameters<Mod["SandboxInstance"]["updateNetwork"]>[1];
type MetadataUpdate = Parameters<Mod["SandboxInstance"]["updateMetadata"]>[1];
type ImageBuildOptions = Parameters<
  ReturnType<Mod["ImageInstance"]["fromRegistry"]>["build"]
>[0];
type VolumeCreate = Parameters<Mod["VolumeInstance"]["create"]>[0];
type InitConfig = Parameters<Mod["initialize"]>[0];

// ---------------------------------------------------------------------------
// fake @blaxel/core
// ---------------------------------------------------------------------------

class ResponseError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ResponseError";
    this.status = status;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function norm(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return `/${parts.join("/")}`;
}
function parent(p: string): string {
  const n = norm(p);
  const i = n.lastIndexOf("/");
  return i <= 0 ? "/" : n.slice(0, i);
}
function base(p: string): string {
  const n = norm(p);
  return n.slice(n.lastIndexOf("/") + 1);
}

class FakeFs {
  files = new Map<string, Uint8Array>();
  dirs = new Set(["/", "/tmp", "/app", "/home"]);
  watchers = new Set<{
    dir: string;
    deep: boolean;
    cb: (e: WatchEvent) => void;
  }>();

  clone(): FakeFs {
    const f = new FakeFs();
    f.files = new Map(this.files);
    f.dirs = new Set(this.dirs);
    return f;
  }
  mkdirp(p: string): void {
    let cur = norm(p);
    const chain: string[] = [];
    while (cur !== "/") {
      chain.unshift(cur);
      cur = parent(cur);
    }
    for (const d of chain) {
      this.dirs.add(d);
    }
  }
  write(p: string, data: Uint8Array): void {
    const n = norm(p);
    const existed = this.files.has(n);
    this.mkdirp(parent(n));
    this.files.set(n, data);
    this.emit(n, existed ? "WRITE" : "CREATE");
  }
  emit(path: string, op: WatchEvent["op"]): void {
    for (const w of this.watchers) {
      const dir = parent(path);
      if (dir === w.dir || (w.deep && dir.startsWith(`${w.dir}/`))) {
        w.cb({ name: base(path), op, path: dir });
      }
    }
  }
  shell(): ShellFs {
    return {
      isDir: (p) => this.dirs.has(norm(p)),
      list: (d) => {
        const dir = norm(d);
        if (!this.dirs.has(dir)) {
          return null;
        }
        const out: { name: string; type: "file" | "dir" }[] = [];
        for (const s of this.dirs) {
          if (s !== dir && parent(s) === dir) {
            out.push({ name: base(s), type: "dir" });
          }
        }
        for (const f of this.files.keys()) {
          if (parent(f) === dir) {
            out.push({ name: base(f), type: "file" });
          }
        }
        return out.toSorted((a, b) => a.name.localeCompare(b.name));
      },
      mkdir: (p, r) => {
        const n = norm(p);
        if (this.dirs.has(n) || this.files.has(n)) {
          return r ? null : `mkdir: cannot create '${p}': File exists`;
        }
        if (!r && !this.dirs.has(parent(n))) {
          return `mkdir: cannot create '${p}': No such file or directory`;
        }
        this.mkdirp(n);
        return null;
      },
      read: (p) => this.files.get(norm(p)) ?? null,
      remove: (p, r, force) => {
        const n = norm(p);
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
          for (const f of [...this.files.keys()]) {
            if (f.startsWith(`${n}/`)) {
              this.files.delete(f);
            }
          }
          return null;
        }
        return force
          ? null
          : `rm: cannot remove '${p}': No such file or directory`;
      },
      rename: (a, b) => {
        const from = norm(a);
        const to = norm(b);
        const data = this.files.get(from);
        if (data) {
          this.files.delete(from);
          this.write(to, data);
          return null;
        }
        if (this.dirs.has(from)) {
          this.mkdirp(to);
          for (const f of [...this.files.keys()]) {
            if (f.startsWith(`${from}/`)) {
              this.write(to + f.slice(from.length), this.files.get(f)!);
              this.files.delete(f);
            }
          }
          for (const d of [...this.dirs]) {
            if (d === from || d.startsWith(`${from}/`)) {
              this.dirs.delete(d);
            }
          }
          return null;
        }
        return `mv: cannot stat '${a}': No such file or directory`;
      },
      stat: (p) => {
        const n = norm(p);
        if (this.dirs.has(n)) {
          return { size: 0, type: "dir" };
        }
        const f = this.files.get(n);
        return f ? { size: f.length, type: "file" } : null;
      },
      write: (p, d) => this.write(p, d),
    };
  }
}

interface ProcRec {
  name: string;
  pid: string;
  command: string;
  workingDir: string;
  status: ProcessResponse["status"];
  exitCode: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  completedAt: string;
  done: Promise<void>;
  ac: AbortController;
  stdin: Uint8Array[];
  listeners: Set<{ out?: (s: string) => void; err?: (s: string) => void }>;
}

interface SandboxRec {
  name: string;
  labels: Record<string, string>;
  status: NonNullable<RealSandboxInstance["status"]>;
  createdAt: string;
  config: SandboxCreateConfiguration;
  fs: FakeFs;
  procs: Map<string, ProcRec>;
  previews: Map<string, { name: string; port: number; public: boolean }>;
  network: SandboxCreateConfiguration["network"];
  ttl?: string;
}

interface SnapRec {
  model: SnapshotModel;
  fs: FakeFs;
}

class World {
  sandboxes = new Map<string, SandboxRec>();
  snapshots = new Map<string, SnapRec>();
  images = new Map<string, Map<string, Uint8Array>>();
  volumes = new Map<string, { name: string; size?: number; region?: string }>();
  pageSize = 2;
  calls: { method: string; args: unknown[] }[] = [];
  initialize = vi.fn((_cfg: InitConfig) => {});
  counter = 0;

  reset(): void {
    this.sandboxes.clear();
    this.snapshots.clear();
    this.images.clear();
    this.volumes.clear();
    this.calls = [];
    this.initialize.mockClear();
  }

  record(method: string, ...args: unknown[]): void {
    this.calls.push({ args, method });
  }

  callsOf(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  mustGet(name: string): SandboxRec {
    const rec = this.sandboxes.get(name);
    if (!rec || rec.status === "TERMINATED") {
      throw new ResponseError(404, `Sandbox ${name} not found`);
    }
    return rec;
  }

  spawnRecord(config: SandboxCreateConfiguration, fs?: FakeFs): SandboxRec {
    const name = config.name ?? `auto-${++this.counter}`;
    const seeded = fs ?? new FakeFs();
    const tpl = config.image ? this.images.get(config.image) : undefined;
    if (config.image && config.image.startsWith("sandbox/") && !tpl) {
      throw new ResponseError(400, `image ${config.image} not found`);
    }
    for (const [p, d] of tpl ?? []) {
      seeded.write(p, d);
    }
    const rec: SandboxRec = {
      config,
      createdAt: new Date().toISOString(),
      fs: seeded,
      labels: { ...config.labels },
      name,
      network: config.network,
      previews: new Map(),
      procs: new Map(),
      status: "DEPLOYED",
      ttl: config.ttl,
    };
    this.sandboxes.set(name, rec);
    return rec;
  }

  module(): Mod {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const world = this;

    class FakeSandboxInstance {
      readonly rec: SandboxRec;
      constructor(rec: SandboxRec) {
        this.rec = rec;
      }
      get metadata() {
        return {
          createdAt: this.rec.createdAt,
          labels: { ...this.rec.labels },
          name: this.rec.name,
        };
      }
      get status() {
        return this.rec.status;
      }
      get spec() {
        return {
          network: this.rec.network,
          runtime: { image: this.rec.config.image, ttl: this.rec.ttl },
        };
      }

      fs = {
        ls: async (path: string): Promise<Directory> => {
          const fs = this.rec.fs;
          const n = norm(path);
          if (fs.files.has(n)) {
            throw new ResponseError(400, `${path} is not a directory`);
          }
          const listed = fs.shell().list(n);
          if (!listed) {
            throw new ResponseError(404, `no such file or directory: ${path}`);
          }
          const now = new Date().toUTCString();
          return {
            files: listed
              .filter((e) => e.type === "file")
              .map((e) => ({
                group: "root",
                lastModified: now,
                name: e.name,
                owner: "root",
                path: `${n === "/" ? "" : n}/${e.name}`,
                permissions: "0644",
                size: fs.files.get(`${n === "/" ? "" : n}/${e.name}`)!.length,
              })),
            name: base(n),
            path: n,
            subdirectories: listed
              .filter((e) => e.type === "dir")
              .map((e) => ({
                name: e.name,
                path: `${n === "/" ? "" : n}/${e.name}`,
              })),
          };
        },
        mkdir: async (path: string, _permissions?: string) => {
          this.rec.fs.mkdirp(path);
          return { message: "ok", path };
        },
        readBinary: async (path: string): Promise<Blob> => {
          const data = this.rec.fs.files.get(norm(path));
          if (!data) {
            throw new ResponseError(404, `file not found: ${path}`);
          }
          return new Blob([new Uint8Array(data)]);
        },
        rm: async (path: string, recursive?: boolean) => {
          const err = this.rec.fs
            .shell()
            .remove(path, recursive ?? false, false);
          if (err) {
            throw new ResponseError(err.includes("No such") ? 404 : 400, err);
          }
          this.rec.fs.emit(norm(path), "REMOVE");
          return { message: "ok" };
        },
        watch: (
          path: string,
          callback: (e: WatchEvent) => void | Promise<void>,
          _options?: { withContent: boolean }
        ) => {
          const deep = path.endsWith("/**");
          const w = {
            cb: (e: WatchEvent) => void callback(e),
            deep,
            dir: norm(deep ? path.slice(0, -3) : path),
          };
          this.rec.fs.watchers.add(w);
          return { close: () => this.rec.fs.watchers.delete(w) };
        },
        writeBinary: async (
          path: string,
          content: Buffer | Blob | File | Uint8Array | string
        ) => {
          let bytes: Uint8Array;
          if (typeof content === "string") {
            throw new TypeError("fake: local-path uploads not modelled");
          } else if (content instanceof Uint8Array) {
            bytes = new Uint8Array(content);
          } else {
            bytes = new Uint8Array(await content.arrayBuffer());
          }
          this.rec.fs.write(path, bytes);
          return { message: "ok", path };
        },
      };

      process = {
        closeStdin: async (_id: string) => {},
        exec: async (req: ExecRequest) => {
          world.record("process.exec", this.rec.name, req);
          const procName = req.name ?? `proc-${++world.counter}`;
          const existing = this.rec.procs.get(procName);
          if (existing && existing.status === "running") {
            throw new ResponseError(400, `process ${procName} already running`);
          }
          const p = this.start(procName, req);
          const withLog = req as ExecRequest & {
            onStdout?: (s: string) => void;
            onStderr?: (s: string) => void;
          };
          let close = () => {};
          if (withLog.onStdout || withLog.onStderr) {
            const l = { err: withLog.onStderr, out: withLog.onStdout };
            p.listeners.add(l);
            close = () => p.listeners.delete(l);
          }
          if (req.waitForCompletion) {
            await p.done;
            return { ...this.response(p), close };
          }
          return { ...this.response(p), close };
        },
        get: async (id: string) => this.response(this.proc(id)),
        kill: async (id: string) => {
          const p = this.proc(id);
          if (p.status === "running") {
            p.status = "killed";
            p.ac.abort();
          }
          return { message: "killed" };
        },
        list: async () =>
          [...this.rec.procs.values()].map((p) => this.response(p)),
        streamLogs: (
          id: string,
          o: {
            onStdout?: (s: string) => void;
            onStderr?: (s: string) => void;
            onError?: (e: Error) => void;
          } = {}
        ) => {
          const p = this.proc(id);
          if (p.stdout) {
            o.onStdout?.(p.stdout);
          }
          if (p.stderr) {
            o.onStderr?.(p.stderr);
          }
          const l = { err: o.onStderr, out: o.onStdout };
          p.listeners.add(l);
          let stop!: () => void;
          const closed = new Promise<void>((r) => {
            stop = r;
          });
          return {
            close: () => {
              p.listeners.delete(l);
              stop();
            },
            wait: () => Promise.race([p.done, closed]),
          };
        },
        wait: async (id: string, _o?: { maxWait?: number }) => {
          const p = this.proc(id);
          await p.done;
          return this.response(p);
        },
        writeStdin: async (id: string, data: string | Uint8Array) => {
          this.proc(id).stdin.push(
            typeof data === "string" ? enc.encode(data) : data
          );
        },
      };

      previews = {
        createIfNotExists: async (cfg: PreviewCreate) => {
          world.record("previews.createIfNotExists", this.rec.name, cfg);
          const c = cfg as { name?: string; port: number; public?: boolean };
          const name = c.name ?? `preview-${c.port}`;
          const existing =
            this.rec.previews.get(name) ??
            ({ name, port: c.port, public: c.public ?? false } as const);
          this.rec.previews.set(name, existing);
          return this.preview(existing);
        },
        delete: async (name: string) => {
          this.rec.previews.delete(name);
          return {};
        },
        list: async () =>
          [...this.rec.previews.values()].map((p) => this.preview(p)),
      };

      snapshots = {
        create: async (name?: string) => {
          const id = `snap-${++world.counter}`;
          const model: SnapshotModel = {
            createdAt: new Date().toISOString(),
            id,
            name: name ?? id,
            sandboxName: this.rec.name,
            status: "READY",
            workspace: "ws",
          };
          world.snapshots.set(id, { fs: this.rec.fs.clone(), model });
          return model;
        },
        delete: async (id: string) => {
          world.snapshots.delete(id);
        },
        list: async () =>
          [...world.snapshots.values()]
            .filter((s) => s.model.sandboxName === this.rec.name)
            .map((s) => s.model),
        restore: async (id: string) => {
          const snap = world.snapshots.get(id);
          if (!snap) {
            throw new ResponseError(404, `snapshot ${id} not found`);
          }
          this.rec.fs = snap.fs.clone();
          return { name: this.rec.name, snapshotId: id };
        },
      };

      async fetch(port: number, path?: string, init?: RequestInit) {
        world.record("fetch", this.rec.name, port, path, init);
        return new Response(`port ${port} ${path ?? "/"}`);
      }

      async fork(targetName: string, options?: { snapshotId?: string }) {
        world.record("fork", this.rec.name, targetName, options);
        world.spawnRecord(
          { ...this.rec.config, labels: this.rec.labels, name: targetName },
          this.rec.fs.clone()
        );
        return { name: targetName, snapshotId: "", type: "sandbox" as const };
      }

      async delete() {
        world.mustGet(this.rec.name);
        for (const p of this.rec.procs.values()) {
          p.ac.abort();
        }
        this.rec.status = "TERMINATED";
        world.sandboxes.delete(this.rec.name);
        return { metadata: this.metadata, spec: {} };
      }

      async archive() {
        this.rec.status = "ARCHIVED";
        return this;
      }

      async unarchive() {
        this.rec.status = "DEPLOYED";
        return this;
      }

      // ---- statics ----
      static async create(config?: SandboxCreateConfiguration) {
        world.record("create", config);
        if (config?.name && world.sandboxes.has(config.name)) {
          throw new ResponseError(409, `sandbox ${config.name} already exists`);
        }
        return new FakeSandboxInstance(world.spawnRecord(config ?? {}));
      }
      static async createIfNotExists(config: SandboxCreateConfiguration) {
        world.record("createIfNotExists", config);
        const existing = config.name
          ? world.sandboxes.get(config.name)
          : undefined;
        if (existing && existing.status !== "FAILED") {
          return new FakeSandboxInstance(existing);
        }
        return new FakeSandboxInstance(world.spawnRecord(config));
      }
      static async get(name: string) {
        world.record("get", name);
        return new FakeSandboxInstance(world.mustGet(name));
      }
      static async list(query?: ListQuery) {
        world.record("list", query);
        const all = [...world.sandboxes.values()].map(
          (r) => new FakeSandboxInstance(r)
        );
        const size = Math.min(query?.limit ?? 50, world.pageSize);
        const page = (start: number): PaginatedList<FakeSandboxInstance> => {
          const data = all.slice(start, start + size);
          const hasMore = start + size < all.length;
          const nextPage = async () => {
            world.record("list.nextPage", start + size);
            return hasMore ? page(start + size) : null;
          };
          return {
            async *[Symbol.asyncIterator]() {
              let cur: PaginatedList<FakeSandboxInstance> | null = page(start);
              while (cur) {
                yield* cur.data;
                cur = cur.hasMore ? await cur.nextPage() : null;
              }
            },
            async autoPagingEach() {},
            async autoPagingToArray() {
              return all;
            },
            data,
            hasMore,
            meta: { hasMore },
            nextPage,
          };
        };
        return page(0);
      }
      static async delete(name: string) {
        return new FakeSandboxInstance(world.mustGet(name)).delete();
      }
      static async updateTtl(name: string, ttl: string | null) {
        world.record("updateTtl", name, ttl);
        world.mustGet(name).ttl = ttl ?? undefined;
        return FakeSandboxInstance.get(name);
      }
      static async updateNetwork(name: string, network: NetworkUpdate) {
        world.record("updateNetwork", name, network);
        world.mustGet(name).network = network.network;
        return FakeSandboxInstance.get(name);
      }
      static async updateMetadata(name: string, metadata: MetadataUpdate) {
        world.record("updateMetadata", name, metadata);
        const rec = world.mustGet(name);
        if (metadata.labels) {
          rec.labels = { ...metadata.labels };
        }
        return FakeSandboxInstance.get(name);
      }

      // ---- helpers ----
      proc(id: string): ProcRec {
        const p =
          this.rec.procs.get(id) ??
          [...this.rec.procs.values()].find((x) => x.pid === id);
        if (!p) {
          throw new ResponseError(404, `process ${id} not found`);
        }
        return p;
      }
      response(p: ProcRec): ProcessResponse {
        return {
          command: p.command,
          completedAt: p.completedAt,
          exitCode: p.exitCode,
          logs: p.stdout + p.stderr,
          name: p.name,
          pid: p.pid,
          startedAt: p.startedAt,
          status: p.status,
          stderr: p.stderr,
          stdout: p.stdout,
          workingDir: p.workingDir,
        };
      }
      start(name: string, req: ExecRequest): ProcRec {
        const ac = new AbortController();
        const p: ProcRec = {
          ac,
          command: req.command,
          completedAt: "",
          done: Promise.resolve(),
          exitCode: 0,
          listeners: new Set(),
          name,
          pid: String(++world.counter),
          startedAt: new Date().toUTCString(),
          status: "running",
          stderr: "",
          stdin: [],
          stdout: "",
          workingDir: req.workingDir ?? "/",
        };
        this.rec.procs.set(name, p);
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (req.timeout) {
          timer = setTimeout(() => {
            p.status = "killed";
            ac.abort();
          }, req.timeout * 1000);
        }
        const fs = this.rec.fs;
        const env: Record<string, string> = {};
        for (const e of this.rec.config.envs ?? []) {
          env[e.name] = e.value;
        }
        p.done = (async () => {
          await new Promise((r) => setTimeout(r, 0));
          let total = 0;
          for (const c of p.stdin) {
            total += c.length;
          }
          const stdin = new Uint8Array(total);
          let off = 0;
          for (const c of p.stdin) {
            stdin.set(c, off);
            off += c.length;
          }
          const code = await new MiniShell(fs.shell()).run(req.command, {
            cwd: req.workingDir ?? "/",
            env: { ...env, ...req.env },
            signal: ac.signal,
            stderr: (d) => {
              const s = dec.decode(d);
              p.stderr += s;
              for (const l of p.listeners) {
                l.err?.(s);
              }
            },
            stdin,
            stdout: (d) => {
              const s = dec.decode(d);
              p.stdout += s;
              for (const l of p.listeners) {
                l.out?.(s);
              }
            },
          });
          clearTimeout(timer);
          p.exitCode = code;
          if (p.status === "running") {
            p.status = code === 0 ? "completed" : "failed";
          }
          p.completedAt = new Date().toUTCString();
        })();
        return p;
      }
      preview(p: { name: string; port: number; public: boolean }) {
        const url = `https://${p.name}-${this.rec.name}.us-pdx-1.preview.bl.run`;
        const token = (expiresAt: Date) => ({
          expired: false,
          expiresAt,
          name: `token-${Date.now()}`,
          value: `tok_${this.rec.name}_${p.port}`,
        });
        return {
          metadata: { name: p.name },
          name: p.name,
          spec: { port: p.port, public: p.public, url },
          tokens: {
            create: async (expiresAt: Date) => token(expiresAt),
            createIfExpired: async (expiresAt?: Date) =>
              token(expiresAt ?? new Date(Date.now() + 86_400_000)),
          },
          url,
        };
      }
    }

    class FakeImageInstance {
      readonly baseImage: string;
      readonly instructions: string[];
      readonly files: { src: string; dest: string; dir: boolean }[];
      constructor(
        baseImage: string,
        instructions: string[] = [],
        files: { src: string; dest: string; dir: boolean }[] = []
      ) {
        this.baseImage = baseImage;
        this.instructions = instructions;
        this.files = files;
      }
      static fromRegistry(tag: string) {
        return new FakeImageInstance(tag);
      }
      private with(
        line: string,
        file?: { src: string; dest: string; dir: boolean }
      ) {
        return new FakeImageInstance(
          this.baseImage,
          [...this.instructions, line],
          file ? [...this.files, file] : this.files
        );
      }
      runCommands(...c: string[]) {
        let img: FakeImageInstance = this;
        for (const x of c) {
          img = img.with(`RUN ${x}`);
        }
        return img;
      }
      env(v: Record<string, string>) {
        return this.with(`ENV ${JSON.stringify(v)}`);
      }
      label(v: Record<string, string>) {
        return this.with(`LABEL ${JSON.stringify(v)}`);
      }
      workdir(p: string) {
        return this.with(`WORKDIR ${p}`);
      }
      user(u: string) {
        return this.with(`USER ${u}`);
      }
      expose(...ports: number[]) {
        return this.with(`EXPOSE ${ports.join(" ")}`);
      }
      arg(n: string, d?: string) {
        return this.with(`ARG ${n}${d === undefined ? "" : `=${d}`}`);
      }
      addLocalFile(src: string, dest: string, _ctx?: string) {
        return this.with(`COPY ${src} ${dest}`, { dest, dir: false, src });
      }
      addLocalDir(src: string, dest: string, _ctx?: string) {
        return this.with(`COPY ${src} ${dest}`, { dest, dir: true, src });
      }
      async build(options: ImageBuildOptions) {
        world.record("image.build", options, this.baseImage, this.instructions);
        const files = new Map<string, Uint8Array>();
        for (const f of this.files) {
          if (statSync(f.src).isDirectory()) {
            throw new Error("fake: directory COPY not modelled");
          }
          files.set(f.dest, new Uint8Array(readFileSync(f.src)));
        }
        const image = `sandbox/${options.name}:${++world.counter}`;
        world.images.set(image, files);
        options.onStatusChange?.("DEPLOYING");
        const rec = world.spawnRecord({
          image,
          labels: { "x-blaxel-auto-generated": "true" },
          name: options.name,
        });
        options.onStatusChange?.("DEPLOYED");
        return {
          metadata: {
            createdAt: rec.createdAt,
            labels: { ...rec.labels },
            name: rec.name,
          },
          spec: { runtime: { image } },
          status: rec.status,
        };
      }
    }

    class FakeVolumeInstance {
      readonly v: { name: string; size?: number; region?: string };
      constructor(v: { name: string; size?: number; region?: string }) {
        this.v = v;
      }
      get name() {
        return this.v.name;
      }
      get displayName() {
        return undefined;
      }
      get size() {
        return this.v.size;
      }
      get region() {
        return this.v.region;
      }
      get metadata() {
        return { name: this.v.name };
      }
      static async create(cfg: VolumeCreate) {
        const c = cfg as { name: string; size?: number; region?: string };
        world.volumes.set(c.name, {
          name: c.name,
          region: c.region,
          size: c.size,
        });
        return new FakeVolumeInstance(world.volumes.get(c.name)!);
      }
      static async get(name: string) {
        const v = world.volumes.get(name);
        if (!v) {
          throw new ResponseError(404, `volume ${name} not found`);
        }
        return new FakeVolumeInstance(v);
      }
      static async list() {
        const all = [...world.volumes.values()].map(
          (v) => new FakeVolumeInstance(v)
        );
        return {
          async *[Symbol.asyncIterator]() {
            yield* all;
          },
        };
      }
      static async delete(name: string) {
        world.volumes.delete(name);
        return {};
      }
    }

    class FakeSnapshot {
      readonly s: SnapRec;
      constructor(s: SnapRec) {
        this.s = s;
      }
      static async get(id: string) {
        const s = world.snapshots.get(id);
        if (!s) {
          throw new ResponseError(404, `snapshot ${id} not found`);
        }
        return new FakeSnapshot(s);
      }
      static async delete(id: string) {
        world.record("Snapshot.delete", id);
        world.snapshots.delete(id);
      }
      async fork(
        targetName: string,
        options?: { envs?: { name?: string; value?: string }[] }
      ) {
        world.record("Snapshot.fork", this.s.model.id, targetName, options);
        world.spawnRecord({ name: targetName }, this.s.fs.clone());
        return {
          name: targetName,
          snapshotId: this.s.model.id,
          type: "sandbox" as const,
        };
      }
    }

    const fake = {
      ImageInstance: FakeImageInstance,
      SandboxInstance: FakeSandboxInstance,
      Snapshot: FakeSnapshot,
      VolumeInstance: FakeVolumeInstance,
      initialize: world.initialize,
    };
    // The real classes carry private fields no fake can satisfy structurally;
    // everything the adapter calls is typed above against the real signatures.
    return fake as unknown as Mod;
  }
}

const world = new World();

vi.mock("@blaxel/core", () => world.module());

beforeEach(() => {
  world.reset();
});

const ctx = (idempotencyKey?: string) => ({
  attempt: 1,
  fetch: globalThis.fetch,
  idempotencyKey,
});

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("blaxel adapter (offline, fake SDK)", () => {
  it("declares truthful capabilities", () => {
    const p = blaxel({ apiKey: "k", workspace: "w" });
    expect(p.name).toBe("blaxel");
    expect(p.capabilities).toBe(BLAXEL_CAPS);
    expect(p.flags.perCommandEnvCwd).toBe(true);
    expect(p.flags.previewBrowserAuth).toBe(true);
    expect(p.flags.templateSources).toEqual(["dockerfile", "image"]);
  });

  it("passes the full conformance suite offline", async () => {
    const report = await runConformance(
      blaxel({ apiKey: "k", workspace: "w" }),
      {
        live: true,
        template: {
          source: {
            context: { "hello.txt": "hi from template" },
            dockerfile:
              'FROM node:22-slim\nRUN apt-get update\nENV A=1 B="two words"\nCOPY hello.txt /app/hello.txt\nCMD ["node"]\n',
          },
        },
      }
    );
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed).toEqual([]);
    const names = report.checks.map((c) => c.name);
    expect(names).toContain("templates: build, cache hit, boot from template");
    expect(names).toContain("exec: timeoutMs rejects with Timeout");
    expect(names).toContain("fork: clone sees parent files");
    console.info(
      `blaxel offline conformance: ${report.checks.length} checks passed`
    );
  }, 60_000);

  it("configures auth via initialize() without touching process.env", async () => {
    const before = {
      key: process.env.BL_API_KEY,
      ws: process.env.BL_WORKSPACE,
    };
    const p = blaxel({ apiKey: "bl_key", workspace: "acme" });
    await p.verify!(ctx());
    expect(world.initialize).toHaveBeenCalledWith({
      apiKey: "bl_key",
      workspace: "acme",
    });
    expect(process.env.BL_API_KEY).toBe(before.key);
    expect(process.env.BL_WORKSPACE).toBe(before.ws);
    expect(world.callsOf("list")[0]?.[0]).toEqual({ limit: 1 });
  });

  it("maps a rich create spec onto SandboxInstance.createIfNotExists", async () => {
    const p = blaxel({ region: "us-pdx-1" });
    const h = await p.create(
      {
        env: { NODE_ENV: "test" },
        lifecycle: {
          idleTimeoutMs: 120_000,
          maxAgeMs: 3_600_000,
          onIdle: "destroy",
        },
        metadata: { team: "a" },
        network: {
          domains: ["api.github.com"],
          inject: [
            {
              domains: ["api.github.com"],
              headers: { Authorization: { name: "gh", value: "Bearer x" } },
            },
          ],
          mode: "allow-list",
        },
        ports: [3000],
        resources: { vcpus: 2 },
        secrets: [{ envVar: "API_KEY", name: "api", value: "s3cret" }],
        template: "my-image:latest",
        volumes: [{ id: "data", mountPath: "/data" }],
      },
      ctx("retry-key")
    );
    const [config] = world.callsOf("createIfNotExists")[0] as [
      SandboxCreateConfiguration,
    ];
    expect(h.id).toBe(await nameFromIdempotencyKey("retry-key"));
    expect(config).toMatchObject({
      envs: [
        { name: "NODE_ENV", value: "test" },
        { name: "API_KEY", value: "s3cret" },
      ],
      image: "my-image:latest",
      labels: { team: "a" },
      lifecycle: {
        expirationPolicies: [
          { action: "delete", type: "ttl-idle", value: "120s" },
        ],
      },
      memory: 4096,
      name: h.id,
      ports: [{ protocol: "HTTP", target: 3000 }],
      region: "us-pdx-1",
      ttl: "3600s",
      volumes: [{ mountPath: "/data", name: "data", readOnly: false }],
    });
    expect(config.network).toEqual({
      firewall: { rulesets: ["proxy"] },
      proxy: {
        allowedDomains: ["api.github.com"],
        routing: [
          {
            destinations: ["api.github.com"],
            headers: { Authorization: "{{SECRET:gh}}" },
            secrets: { gh: "Bearer x" },
          },
        ],
      },
    });
  });

  it("derives the same name for a retried create (idempotency)", async () => {
    const p = blaxel({});
    const a = await p.create({}, ctx("same"));
    const b = await p.create({}, ctx("same"));
    expect(a.id).toBe(b.id);
    expect(world.sandboxes.size).toBe(1);
    const [config] = world.callsOf("createIfNotExists")[0] as [
      SandboxCreateConfiguration,
    ];
    expect(config.image).toBe("blaxel/base-image:latest");
  });

  it("uses create() (409 → Conflict) for an explicit name", async () => {
    const p = blaxel({});
    await p.create({ name: "fixed" }, ctx("k1"));
    let code: string | undefined;
    try {
      await p.create({ name: "fixed" }, ctx("k2"));
    } catch (error) {
      code = p.mapError!(error)?.code;
    }
    expect(code).toBe("Conflict");
  });

  it("boots fromSnapshot by forking the workspace snapshot", async () => {
    const p = blaxel({});
    const src = await p.create({}, ctx("src"));
    await src.writeFile("/tmp/x.txt", enc.encode("snap"), ctx());
    const snap = await src.snapshot!({ name: "s1" }, ctx());
    expect(snap.includesMemory).toBe(true);
    const child = await p.create(
      { fromSnapshot: snap.id, metadata: { from: "snap" } },
      ctx("child")
    );
    expect(dec.decode(await child.readFile("/tmp/x.txt", ctx()))).toBe("snap");
    expect(world.callsOf("Snapshot.fork")).toHaveLength(1);
    expect((await child.getInfo(ctx())).metadata).toEqual({ from: "snap" });
  });

  it("restores a snapshot in place and deletes it", async () => {
    const p = blaxel({});
    const h = await p.create({}, ctx("r"));
    await h.writeFile("/tmp/a", enc.encode("1"), ctx());
    const snap = await h.snapshot!({}, ctx());
    await h.writeFile("/tmp/a", enc.encode("2"), ctx());
    await h.restoreSnapshot!(snap.id, ctx());
    expect(dec.decode(await h.readFile("/tmp/a", ctx()))).toBe("1");
    expect((await h.listSnapshots!(ctx())).map((s) => s.id)).toEqual([snap.id]);
    await h.deleteSnapshot!(snap.id, ctx());
    expect(world.callsOf("Snapshot.delete")).toEqual([[snap.id]]);
  });

  it("returns private previews with a bl_preview_token query token", async () => {
    const p = blaxel({});
    const h = await p.create({}, ctx("pv"));
    const pv = await h.exposePort!(3000, { private: true }, ctx());
    expect(pv.auth).toEqual({
      param: "bl_preview_token",
      token: `tok_${h.id}_3000`,
      type: "query",
    });
    expect(pv.expiresAt).toBeInstanceOf(Date);
    const pub = await h.exposePort!(3000, {}, ctx());
    expect(pub.auth).toEqual({ type: "public" });
    expect(
      (await h.listPorts!(ctx())).map((x) => x.auth?.type).toSorted()
    ).toEqual(["public", "query"]);
    const res = await h.proxyFetch!(3000, "/health", undefined, ctx());
    expect(await res.text()).toBe("port 3000 /health");
  });

  it("archives on stop and unarchives on connect", async () => {
    const p = blaxel({});
    const h = await p.create({}, ctx("arch"));
    await h.stop!(ctx());
    expect((await h.getInfo(ctx())).state).toBe("archived");
    const again = await p.connect(h.id, ctx());
    expect((await again.getInfo(ctx())).state).toBe("running");
  });

  it("maps fs.watch events", async () => {
    const p = blaxel({});
    const h = await p.create({}, ctx("w"));
    const events: { type: string; path: string }[] = [];
    const stop = await h.watch!("/tmp", (e) => events.push(e), true, ctx());
    await h.writeFile("/tmp/sub/a.txt", enc.encode("1"), ctx());
    await h.writeFile("/tmp/sub/a.txt", enc.encode("2"), ctx());
    await h.remove!("/tmp/sub/a.txt", false, ctx());
    await stop();
    await h.writeFile("/tmp/after.txt", enc.encode("x"), ctx());
    expect(events).toEqual([
      { path: "/tmp/sub/a.txt", type: "create" },
      { path: "/tmp/sub/a.txt", type: "modify" },
      { path: "/tmp/sub/a.txt", type: "delete" },
    ]);
  });

  it("passes env/cwd/timeout natively to process.exec", async () => {
    const p = blaxel({});
    const h = await p.create({}, ctx("ex"));
    const out: string[] = [];
    for await (const ev of h.exec(
      "echo $X; pwd",
      { cwd: "/tmp", env: { X: "y" }, timeoutMs: 1500 },
      ctx()
    )) {
      if (ev.type === "stdout") {
        out.push(ev.data);
      }
    }
    expect(out.join("")).toBe("y\n/tmp\n");
    const req = world.callsOf("process.exec").at(-1)?.[1] as ExecRequest;
    expect(req).toMatchObject({
      env: { X: "y" },
      timeout: 2,
      waitForCompletion: true,
      workingDir: "/tmp",
    });
  });

  it("updates egress at runtime with updateNetwork, keeping the firewall", async () => {
    const p = blaxel({});
    const h = await p.create({ network: { mode: "block-all" } }, ctx("net"));
    await h.setEgressPolicy!(
      { deny: { domains: ["evil.com"] }, mode: "allow-all" },
      ctx()
    );
    const [, upd] = world.callsOf("updateNetwork")[0] as [
      string,
      NetworkUpdate,
    ];
    expect(upd.network).toEqual({
      firewall: { rulesets: ["proxy"] },
      proxy: { forbiddenDomains: ["evil.com"], routing: [] },
    });
  });

  it("paginates list fully and honors metadata/state/limit filters", async () => {
    const p = blaxel({});
    for (let i = 0; i < 5; i++) {
      await p.create(
        { metadata: { group: i % 2 === 0 ? "even" : "odd" } },
        ctx(`l${i}`)
      );
    }
    const even: string[] = [];
    for await (const info of p.list!({ metadata: { group: "even" } }, ctx())) {
      even.push(info.id);
    }
    expect(even).toHaveLength(3);
    expect(world.callsOf("list.nextPage").length).toBeGreaterThanOrEqual(2);
    const limited: string[] = [];
    for await (const info of p.list!({ limit: 2 }, ctx())) {
      limited.push(info.id);
    }
    expect(limited).toHaveLength(2);
    const archived: string[] = [];
    for await (const info of p.list!({ state: "archived" }, ctx())) {
      archived.push(info.id);
    }
    expect(archived).toEqual([]);
  });

  it("manages volumes", async () => {
    const p = blaxel({});
    const v = await p.volumes!.create(
      { name: "vol1", region: "us-pdx-1", sizeMB: 1024 },
      ctx()
    );
    expect(v).toMatchObject({ id: "vol1", region: "us-pdx-1", sizeMB: 1024 });
    expect((await p.volumes!.get("vol1", ctx()))?.id).toBe("vol1");
    expect(await p.volumes!.get("nope", ctx())).toBeUndefined();
    await p.volumes!.delete("vol1", ctx());
    const all: string[] = [];
    for await (const x of p.volumes!.list(ctx())) {
      all.push(x.id);
    }
    expect(all).toEqual([]);
  });

  it("builds a registry-image template and finds it by cache key", async () => {
    const p = blaxel({});
    const events: string[] = [];
    const ref = await p.templates!.build(
      {
        cacheKey: "abc123",
        env: { FOO: "bar" },
        name: "sbox-abc123",
        source: {
          image: "ghcr.io/acme/img:1",
          registryAuth: { password: "p", username: "u" },
        },
      },
      { onEvent: (e) => events.push(e.type === "status" ? e.status : e.line) },
      ctx()
    );
    expect(ref.id).toMatch(/^sandbox\/sbox-abc123:/);
    const [opts, baseImage] = world.callsOf("image.build")[0] as [
      ImageBuildOptions,
      string,
    ];
    expect(baseImage).toBe("ghcr.io/acme/img:1");
    expect(opts.dockerConfig).toEqual({
      auths: { "ghcr.io": { auth: btoa("u:p") } },
    });
    expect(events).toContain("DEPLOYED");
    expect((await p.templates!.lookup("abc123", ctx()))?.id).toBe(ref.id);
    expect((await p.templates!.lookup("sbox-abc123", ctx()))?.id).toBe(ref.id);
    expect(await p.templates!.lookup("missing", ctx())).toBeUndefined();
  });
});

describe("blaxel pure mapping", () => {
  it("maps every Blaxel status", () => {
    const table: Record<string, string> = {
      ARCHIVED: "archived",
      ARCHIVING: "suspending",
      BUILDING: "creating",
      BUILT: "creating",
      DEACTIVATED: "stopped",
      DEACTIVATING: "suspending",
      DELETING: "destroyed",
      DEPLOYED: "running",
      DEPLOYING: "creating",
      FAILED: "error",
      TERMINATED: "destroyed",
      UNARCHIVING: "creating",
      UPLOADING: "creating",
    };
    for (const [status, state] of Object.entries(table)) {
      expect(mapBlaxelState(status)).toBe(state);
    }
    expect(mapBlaxelState(undefined)).toBe("unknown");
  });

  it("maps errors to the sbox taxonomy", () => {
    const code = (e: unknown) => mapBlaxelError(e)?.code;
    expect(code(new ResponseError(401, "nope"))).toBe("Unauthorized");
    expect(code(new ResponseError(403, "nope"))).toBe("Unauthorized");
    expect(code(new ResponseError(404, "x"))).toBe("NotFound");
    expect(code(new ResponseError(409, "x"))).toBe("Conflict");
    expect(code(new ResponseError(429, "x"))).toBe("QuotaExceeded");
    expect(mapBlaxelError(new ResponseError(429, "x"))?.retryable).toBe(true);
    expect(code({ code: 404, error: "Sandbox not found" })).toBe("NotFound");
    expect(
      code({ code: "QUOTA_EXCEEDED", message: "m", status_code: 400 })
    ).toBe("QuotaExceeded");
    expect(
      code({
        error: { code: "AUTHENTICATION_FAILED", message: "m", status: 401 },
      })
    ).toBe("Unauthorized");
    expect(
      code(
        Object.assign(new Error("c"), { code: "CREATION_TIMEOUT", status: 408 })
      )
    ).toBe("Timeout");
    expect(code(new Error("boom"))).toBe("Provider");
  });

  it("clamps durations to Blaxel minimums", () => {
    expect(blaxelDuration(1000, 300)).toBe("300s");
    expect(blaxelDuration(1500)).toBe("2s");
    expect(toBlaxelLifecycle({ lifecycle: { maxAgeMs: 60_000 } }).ttl).toBe(
      "300s"
    );
    expect(
      toBlaxelLifecycle({ lifecycle: { idleTimeoutMs: 1000, onIdle: "pause" } })
        .lifecycle
    ).toBeUndefined();
    expect(
      toBlaxelLifecycle({
        lifecycle: { idleTimeoutMs: 1000, onIdle: "destroy" },
      }).lifecycle
    ).toEqual({
      expirationPolicies: [
        { action: "delete", type: "ttl-idle", value: "60s" },
      ],
    });
  });

  it("maps egress policies and rejects CIDRs", () => {
    expect(toBlaxelNetwork({ mode: "block-all" }, { firewall: true })).toEqual({
      firewall: { rulesets: ["proxy"] },
      proxy: { forbiddenDomains: ["*"], routing: [] },
    });
    expect(() =>
      toBlaxelNetwork({ cidrs: ["10.0.0.0/8"], mode: "allow-list" })
    ).toThrow(/CIDR/);
    expect(toBlaxelNetwork(undefined)).toBeUndefined();
  });

  it("translates Dockerfiles and rejects multi-stage builds", () => {
    const plan = planDockerfile(
      'FROM python:3.12\nWORKDIR /app\nRUN pip install x\nENTRYPOINT ["python"]\n'
    );
    expect(plan.base).toBe("python:3.12");
    expect(plan.steps).toHaveLength(2);
    expect(plan.skipped).toEqual(['ENTRYPOINT ["python"]']);
    expect(() => planDockerfile("FROM a AS b\nFROM c\n")).toThrow(
      /multi-stage/
    );
  });
});
