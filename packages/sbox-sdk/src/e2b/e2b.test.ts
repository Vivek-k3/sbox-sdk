/**
 * Offline tests for the E2B adapter. `@e2b/code-interpreter` is mocked with a
 * fake `E2B` client whose method names and option shapes follow the real SDK
 * (`.d.ts` of e2b@2.64 / @e2b/code-interpreter@2.9). The real SDK error
 * classes are kept, and exec runs on `MiniShell` over an in-memory filesystem,
 * so the full conformance suite runs through the adapter.
 */
import fs from "node:fs";
import path from "node:path";

import type {
  CommandResult,
  CommandStartOpts,
  EntryInfo,
  FilesystemEvent,
  Pty,
  SandboxInfo as E2BSandboxInfo,
  SandboxListOpts,
  SandboxMetrics as E2BSandboxMetrics,
  SandboxNetworkUpdate,
  SandboxOpts,
  SnapshotInfo,
  TemplateInfo,
  UploadData,
  VolumeInfo as E2BVolumeInfo,
} from "@e2b/code-interpreter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runConformance } from "../conformance/index.js";
import { createSandboxClient } from "../internal/client.js";
import { MiniShell } from "../memory/shell.js";
import type { ShellFs } from "../memory/shell.js";
import {
  E2B_CAPS,
  E2B_TRAFFIC_TOKEN_HEADER,
  e2b,
  e2bIdempotencyKey,
  e2bTemplateName,
  mapE2BError,
  mapE2BState,
  mapEgress,
  mapLifecycle,
} from "./index.js";

type Mod = typeof import("@e2b/code-interpreter");
const actual = await vi.importActual<Mod>("@e2b/code-interpreter");

vi.mock("@e2b/code-interpreter", async (importOriginal) => ({
  ...(await importOriginal<Mod>()),
  E2B: FakeE2B,
}));

// ---------------------------------------------------------------------------
// in-memory filesystem
// ---------------------------------------------------------------------------

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
const parent = (p: string) => norm(p).slice(0, norm(p).lastIndexOf("/")) || "/";
const base = (p: string) => norm(p).slice(norm(p).lastIndexOf("/") + 1);

class MemFs implements ShellFs {
  files = new Map<string, Uint8Array>();
  dirs = new Set(["/", "/tmp", "/home", "/home/user"]);
  watchers: { dir: string; cb: (e: FilesystemEvent) => void }[] = [];

  clone(): MemFs {
    const c = new MemFs();
    c.files = new Map(this.files);
    c.dirs = new Set(this.dirs);
    return c;
  }
  #ensureDirs(dir: string): void {
    let cur = norm(dir);
    while (cur !== "/") {
      this.dirs.add(cur);
      cur = parent(cur);
    }
  }
  read(p: string) {
    return this.files.get(norm(p)) ?? null;
  }
  write(p: string, data: Uint8Array) {
    const n = norm(p);
    const existed = this.files.has(n);
    this.#ensureDirs(parent(n));
    this.files.set(n, data);
    for (const w of this.watchers) {
      if (parent(n) === w.dir) {
        w.cb({
          name: base(n),
          type: existed
            ? actual.FilesystemEventType.WRITE
            : actual.FilesystemEventType.CREATE,
        });
      }
    }
  }
  list(d: string) {
    const dir = norm(d);
    if (!this.dirs.has(dir)) {
      return null;
    }
    const out = new Map<string, "file" | "dir">();
    for (const s of this.dirs) {
      if (s !== dir && parent(s) === dir) {
        out.set(base(s), "dir");
      }
    }
    for (const f of this.files.keys()) {
      if (parent(f) === dir) {
        out.set(base(f), "file");
      }
    }
    return [...out].map(([name, type]) => ({ name, type }));
  }
  mkdir(p: string) {
    this.#ensureDirs(p);
    return null;
  }
  remove(p: string, _recursive: boolean, force: boolean) {
    const n = norm(p);
    if (this.files.delete(n)) {
      return null;
    }
    if (this.dirs.has(n)) {
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
    return force ? null : `rm: cannot remove '${p}'`;
  }
  rename(a: string, b: string) {
    const data = this.files.get(norm(a));
    if (!data) {
      return `mv: cannot stat '${a}'`;
    }
    this.write(b, data);
    this.files.delete(norm(a));
    return null;
  }
  stat(p: string) {
    const n = norm(p);
    if (this.dirs.has(n)) {
      return { size: 0, type: "dir" as const };
    }
    const f = this.files.get(n);
    return f ? { size: f.length, type: "file" as const } : null;
  }
  isDir(p: string) {
    return this.dirs.has(norm(p));
  }
}

async function uploadBytes(data: UploadData): Promise<Uint8Array> {
  if (typeof data === "string") {
    return enc.encode(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (data instanceof Blob || data instanceof ReadableStream) {
    return new Uint8Array(await new Response(data).arrayBuffer());
  }
  let out = new Uint8Array();
  for await (const c of data) {
    const next = new Uint8Array(out.length + c.length);
    next.set(out);
    next.set(c, out.length);
    out = next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// fake world
// ---------------------------------------------------------------------------

interface Proc {
  pid: number;
  cmd: string;
  envs: Record<string, string>;
  abort: AbortController;
  stdin: Uint8Array[];
  done: Promise<number>;
}

interface FakeTemplate {
  info: TemplateInfo;
  fs: MemFs;
}

const world = {
  buildCalls: [] as {
    name: string;
    opts: Record<string, unknown>;
    steps: unknown[];
  }[],
  clientOpts: [] as Record<string, unknown>[],
  commandHook: undefined as
    | ((cmd: string, opts?: CommandStartOpts) => number | undefined)
    | undefined,
  createCalls: [] as { template?: string; opts?: SandboxOpts }[],
  forkFail: false,
  idempotency: new Map<string, FakeSandbox>(),
  listCalls: [] as (SandboxListOpts | undefined)[],
  networkUpdates: [] as SandboxNetworkUpdate[],
  pageSize: 100,
  sandboxes: new Map<string, FakeSandbox>(),
  secrets: new Map<string, string>(),
  seq: 0,
  snapshots: new Map<
    string,
    { fs: MemFs; sandboxId: string; info: SnapshotInfo }
  >(),
  templates: new Map<string, FakeTemplate>(),
  volumes: new Map<string, E2BVolumeInfo>(),
};

function resetWorld(): void {
  world.buildCalls = [];
  world.clientOpts = [];
  world.commandHook = undefined;
  world.createCalls = [];
  world.forkFail = false;
  world.idempotency.clear();
  world.listCalls = [];
  world.networkUpdates = [];
  world.pageSize = 100;
  world.sandboxes.clear();
  world.secrets.clear();
  world.snapshots.clear();
  world.templates.clear();
  world.volumes.clear();
}

/** E2B's `Secret.fill` placeholder format (mirrored by the fake). */
const fill = (name: string) => `\${e2b.secrets.${name}}`;

function apiError(message: string, status: number) {
  const e = new actual.SandboxError(message);
  e.statusCode = status;
  return e;
}

class Paginator<T> {
  #items: T[];
  #size: number;
  hasNext = true;
  constructor(items: T[], size: number) {
    this.#items = items;
    this.#size = Math.max(1, Math.min(size, world.pageSize));
  }
  async nextItems(): Promise<T[]> {
    if (!this.hasNext) {
      throw new Error("No more items to fetch");
    }
    const page = this.#items.splice(0, this.#size);
    this.hasNext = this.#items.length > 0;
    return page;
  }
}

/** Mirrors the real CommandHandle's public surface. */
class FakeCommandHandle {
  readonly pid: number;
  #proc: Proc;
  #sandbox: FakeSandbox;
  #result: Promise<CommandResult<undefined>>;
  constructor(sandbox: FakeSandbox, proc: Proc, timedOut: () => boolean) {
    this.pid = proc.pid;
    this.#proc = proc;
    this.#sandbox = sandbox;
    this.#result = proc.done.then((exitCode) => {
      if (timedOut()) {
        throw new actual.TimeoutError(
          "[deadline_exceeded] the operation timed out"
        );
      }
      const res = { exitCode, stderr: undefined, stdout: undefined };
      if (exitCode !== 0) {
        throw new actual.CommandExitError(res);
      }
      return res;
    });
    this.#result.catch(() => {});
  }
  wait() {
    return this.#result;
  }
  async kill() {
    return this.#sandbox.commands.kill(this.pid);
  }
  async sendStdin(data: string | Uint8Array) {
    this.#proc.stdin.push(typeof data === "string" ? enc.encode(data) : data);
  }
  async closeStdin() {}
  async disconnect() {}
}

class FakeSandbox {
  readonly sandboxId: string;
  readonly sandboxDomain = "e2b.test";
  trafficAccessToken?: string;
  fs: MemFs;
  state: "running" | "paused" = "running";
  metadata: Record<string, string>;
  envs: Record<string, string>;
  timeoutMs?: number;
  readonly startedAt = new Date();
  procs = new Map<number, Proc>();
  #pid = 100;
  ptyInput: { pid: number; data: string }[] = [];
  ptyResizes: { pid: number; cols: number; rows: number }[] = [];

  constructor(opts: SandboxOpts | undefined, fsys: MemFs) {
    this.sandboxId = `sbx${++world.seq}`;
    this.fs = fsys;
    this.metadata = { ...opts?.metadata };
    this.envs = { ...opts?.envs };
    this.timeoutMs = opts?.timeoutMs;
    if (opts?.network?.allowPublicTraffic === false) {
      this.trafficAccessToken = `tok-${this.sandboxId}`;
    }
    world.sandboxes.set(this.sandboxId, this);
  }

  #assertRunning(): void {
    if (!world.sandboxes.has(this.sandboxId) || this.state !== "running") {
      throw new actual.SandboxNotRunningError(
        `sandbox ${this.sandboxId} is not running`
      );
    }
  }

  #startProc(
    cmd: string,
    opts: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number },
    io: { out: (s: string) => void; err: (s: string) => void }
  ): { proc: Proc; timedOut: () => boolean } {
    const abort = new AbortController();
    let timedOut = false;
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            abort.abort();
          }, timeoutMs)
        : undefined;
    const pid = ++this.#pid;
    const envs = { ...this.envs, ...opts.envs };
    const done = (async () => {
      await Promise.resolve();
      const code = await new MiniShell(this.fs).run(cmd, {
        cwd: opts.cwd ?? "/home/user",
        env: { HOME: "/home/user", ...envs },
        signal: abort.signal,
        stderr: (d) => io.err(dec.decode(d)),
        stdin: new Uint8Array(),
        stdout: (d) => io.out(dec.decode(d)),
      });
      clearTimeout(timer);
      this.procs.delete(pid);
      return abort.signal.aborted && !timedOut ? 137 : code;
    })();
    const proc: Proc = { abort, cmd, done, envs, pid, stdin: [] };
    this.procs.set(pid, proc);
    return { proc, timedOut: () => timedOut };
  }

  commands = {
    connect: async (
      pid: number,
      opts?: Parameters<FakeSandbox["realCommands"]["connect"]>[1]
    ) => {
      const proc = this.procs.get(pid);
      if (!proc) {
        throw new actual.NotFoundError(`process ${pid} not found`);
      }
      void opts;
      return new FakeCommandHandle(this, proc, () => false);
    },
    kill: async (pid: number) => {
      const proc = this.procs.get(pid);
      if (!proc) {
        return false;
      }
      proc.abort.abort();
      return true;
    },
    list: async () =>
      [...this.procs.values()].map((p) => ({
        args: ["-l", "-c", p.cmd],
        cmd: "/bin/bash",
        envs: p.envs,
        pid: p.pid,
      })),
    run: async (cmd: string, opts?: CommandStartOpts) => {
      this.#assertRunning();
      const hooked = world.commandHook?.(cmd, opts);
      const { proc, timedOut } =
        hooked === undefined
          ? this.#startProc(cmd, opts ?? {}, {
              err: (s) => void opts?.onStderr?.(s),
              out: (s) => void opts?.onStdout?.(s),
            })
          : {
              proc: {
                abort: new AbortController(),
                cmd,
                done: Promise.resolve(hooked),
                envs: {},
                pid: ++this.#pid,
                stdin: [],
              },
              timedOut: () => false,
            };
      const handle = new FakeCommandHandle(this, proc, timedOut);
      return opts?.background ? handle : handle.wait();
    },
    sendStdin: async (pid: number, data: string | Uint8Array) => {
      this.procs
        .get(pid)
        ?.stdin.push(typeof data === "string" ? enc.encode(data) : data);
    },
  };

  /** Type anchor so the fake's parameter types follow the real SDK. */
  declare realCommands: InstanceType<Mod["Sandbox"]>["commands"];

  files = {
    getInfo: async (p: string) => {
      const st = this.fs.stat(p);
      if (!st) {
        throw new actual.FileNotFoundError(`path '${p}' does not exist`);
      }
      return this.#entry(p, st.type, st.size);
    },
    list: async (p: string) => {
      const entries = this.fs.list(p);
      if (!entries) {
        throw new actual.FileNotFoundError(`directory '${p}' does not exist`);
      }
      return entries.map((e) => this.#entry(`${norm(p)}/${e.name}`, e.type, 0));
    },
    makeDir: async (p: string) => {
      const existed = this.fs.isDir(p);
      this.fs.mkdir(p);
      return !existed;
    },
    read: async (
      p: string,
      opts?: { format?: "text" | "bytes" | "stream" }
    ) => {
      const data = this.fs.read(p);
      if (!data) {
        throw new actual.FileNotFoundError(`file '${p}' does not exist`);
      }
      if (opts?.format === "bytes") {
        return data;
      }
      if (opts?.format === "stream") {
        return new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(data);
            c.close();
          },
        });
      }
      return dec.decode(data);
    },
    remove: async (p: string) => {
      this.fs.remove(p, true, true);
    },
    rename: async (a: string, b: string) => {
      const err = this.fs.rename(a, b);
      if (err) {
        throw new actual.FileNotFoundError(err);
      }
      return this.#entry(b, "file", this.fs.read(b)?.length ?? 0);
    },
    watchDir: async (
      p: string,
      cb: (e: FilesystemEvent) => void,
      opts?: { recursive?: boolean; timeoutMs?: number }
    ) => {
      const w = { cb, dir: norm(p), opts };
      this.fs.watchers.push(w);
      return {
        stop: async () => {
          this.fs.watchers = this.fs.watchers.filter((x) => x !== w);
        },
      };
    },
    write: async (p: string, data: UploadData) => {
      this.fs.write(p, await uploadBytes(data));
      return this.#entry(p, "file", this.fs.read(p)?.length ?? 0);
    },
  };

  #entry(p: string, type: "file" | "dir", size: number): EntryInfo {
    return {
      mode: 0o644,
      modifiedTime: new Date(0),
      name: base(p),
      owner: "user",
      group: "user",
      path: norm(p),
      permissions: "-rw-r--r--",
      size,
      type: type === "dir" ? actual.FileType.DIR : actual.FileType.FILE,
    };
  }

  pty = {
    connect: async (
      pid: number,
      opts?: Parameters<Pty["connect"]>[1]
    ): Promise<FakeCommandHandle> => {
      const session = this.#ptys.get(pid);
      if (!session) {
        throw new actual.NotFoundError(`pty ${pid} not found`);
      }
      if (opts?.onData) {
        session.listeners.push(opts.onData);
      }
      return session.handle;
    },
    create: async (opts: Parameters<Pty["create"]>[0]) => {
      this.#assertRunning();
      const pid = ++this.#pid;
      let finish!: (code: number) => void;
      const done = new Promise<number>((r) => {
        finish = r;
      });
      const proc: Proc = {
        abort: new AbortController(),
        cmd: "/bin/bash -i -l",
        done,
        envs: { ...opts.envs },
        pid,
        stdin: [],
      };
      proc.abort.signal.addEventListener("abort", () => finish(137));
      this.procs.set(pid, proc);
      const session = {
        cwd: opts.cwd ?? "/home/user",
        finish,
        handle: new FakeCommandHandle(this, proc, () => false),
        line: "",
        listeners: [opts.onData],
        size: { cols: opts.cols, rows: opts.rows },
        timeoutMs: opts.timeoutMs,
      };
      this.#ptys.set(pid, session);
      done.then(() => {
        this.procs.delete(pid);
        this.#ptys.delete(pid);
      });
      this.ptyCreates.push(opts);
      return session.handle;
    },
    kill: async (pid: number) => this.commands.kill(pid),
    resize: async (pid: number, size: { cols: number; rows: number }) => {
      this.ptyResizes.push({ pid, ...size });
    },
    sendInput: async (pid: number, data: Uint8Array) => {
      const s = this.#ptys.get(pid);
      if (!s) {
        throw new actual.NotFoundError(`pty ${pid} not found`);
      }
      const text = dec.decode(data);
      this.ptyInput.push({ data: text, pid });
      const emit = (d: Uint8Array) => {
        for (const l of s.listeners) {
          void l(d);
        }
      };
      emit(enc.encode(text.replaceAll("\n", "\r\n")));
      s.line += text;
      let nl = s.line.indexOf("\n");
      while (nl !== -1) {
        const cmd = s.line.slice(0, nl);
        s.line = s.line.slice(nl + 1);
        const exit = /^\s*exit(?:\s+(\d+))?\s*$/.exec(cmd);
        if (exit) {
          s.finish(Number(exit[1] ?? 0));
          return;
        }
        if (!cmd.startsWith("exec ")) {
          await new MiniShell(this.fs).run(cmd, {
            cwd: s.cwd,
            env: { ...this.envs },
            signal: new AbortController().signal,
            stderr: emit,
            stdin: new Uint8Array(),
            stdout: emit,
          });
        }
        nl = s.line.indexOf("\n");
      }
    },
  };

  ptyCreates: Parameters<Pty["create"]>[0][] = [];
  #ptys = new Map<
    number,
    {
      cwd: string;
      finish: (code: number) => void;
      handle: FakeCommandHandle;
      line: string;
      listeners: ((d: Uint8Array) => void | Promise<void>)[];
      size: { cols: number; rows: number };
      timeoutMs?: number;
    }
  >();

  getHost(port: number): string {
    return `${port}-${this.sandboxId}.${this.sandboxDomain}`;
  }

  info(): E2BSandboxInfo {
    return {
      cpuCount: 2,
      endAt: new Date(Date.now() + 300_000),
      envdVersion: "0.4.0",
      memoryMB: 1024,
      metadata: this.metadata,
      name: "code-interpreter-v1",
      sandboxId: this.sandboxId,
      startedAt: this.startedAt,
      state: this.state,
      templateId: "tpl-ci",
    };
  }

  async getInfo(): Promise<E2BSandboxInfo> {
    if (!world.sandboxes.has(this.sandboxId)) {
      throw new actual.SandboxNotFoundError(
        `sandbox ${this.sandboxId} not found`
      );
    }
    return this.info();
  }

  async getMetrics(): Promise<E2BSandboxMetrics[]> {
    return [
      {
        cpuCount: 2,
        cpuUsedPct: 12.5,
        diskTotal: 10 * 1024 * 1024 * 1024,
        diskUsed: 1024 * 1024 * 1024,
        memCache: 0,
        memTotal: 1024 * 1024 * 1024,
        memUsed: 256 * 1024 * 1024,
        timestamp: new Date(1000),
      },
    ];
  }

  async kill(): Promise<boolean> {
    for (const p of this.procs.values()) {
      p.abort.abort();
    }
    return world.sandboxes.delete(this.sandboxId);
  }

  async pause(): Promise<boolean> {
    const was = this.state;
    this.state = "paused";
    return was === "running";
  }

  async setTimeout(ms: number): Promise<void> {
    this.timeoutMs = ms;
  }

  async updateNetwork(network: SandboxNetworkUpdate): Promise<void> {
    world.networkUpdates.push(network);
  }

  async createSnapshot(opts?: {
    name?: string;
    mode?: "full" | "filesystem";
  }): Promise<SnapshotInfo> {
    const id = `${opts?.name ?? "snapshot"}-${++world.seq}:default`;
    const info = { names: [`proj/${id}`], snapshotId: id };
    world.snapshots.set(id, {
      fs: this.fs.clone(),
      info,
      sandboxId: this.sandboxId,
    });
    this.snapshotModes.push(opts?.mode);
    return info;
  }
  snapshotModes: (string | undefined)[] = [];

  listSnapshots() {
    return new Paginator(
      [...world.snapshots.values()]
        .filter((s) => s.sandboxId === this.sandboxId)
        .map((s) => s.info),
      100
    );
  }

  async fork(opts?: { count?: number }): Promise<(FakeSandbox | Error)[]> {
    const out: (FakeSandbox | Error)[] = [];
    for (let i = 0; i < (opts?.count ?? 1); i++) {
      out.push(
        world.forkFail && i > 0
          ? new actual.RateLimitError("fork quota")
          : new FakeSandbox(
              { envs: this.envs, metadata: this.metadata },
              this.fs.clone()
            )
      );
    }
    return out;
  }

  async createCodeContext(opts?: { cwd?: string; language?: string }) {
    return {
      cwd: opts?.cwd ?? "/home/user",
      id: `ctx${++world.seq}`,
      language: opts?.language ?? "python",
    };
  }

  async runCode(
    code: string,
    opts?: { onStdout?: (m: { line: string }) => void }
  ) {
    opts?.onStdout?.({ line: `ran:${code}` });
    return {
      error: undefined,
      logs: { stderr: [], stdout: [`ran:${code}`] },
      results: [{ isMainResult: true, raw: {}, text: "42" }],
    };
  }
}

// ---- Template fake ---------------------------------------------------------

class FakeBuilder {
  steps: unknown[] = [];
  copies: { src: string; dest: string }[] = [];
  base?: string;
  readonly contextPath?: string;
  constructor(contextPath?: string) {
    this.contextPath = contextPath;
  }
  #step(name: string, ...args: unknown[]) {
    this.steps.push([name, ...args]);
    return this;
  }
  fromDockerfile(content: string) {
    for (const line of content.split("\n")) {
      const [op, ...args] = line.trim().split(/\s+/);
      if (op?.toUpperCase() === "FROM") {
        this.base = args[0];
      }
      if (op?.toUpperCase() === "COPY" && args.length === 2) {
        this.copies.push({ dest: args[1]!, src: args[0]! });
      }
    }
    return this.#step("fromDockerfile", content);
  }
  fromImage(image: string, creds?: { username: string; password: string }) {
    this.base = image;
    return this.#step("fromImage", image, creds);
  }
  fromTemplate(t: string) {
    this.base = t;
    return this.#step("fromTemplate", t);
  }
  setUser(u: string) {
    return this.#step("setUser", u);
  }
  setWorkdir(w: string) {
    return this.#step("setWorkdir", w);
  }
  setEnvs(e: Record<string, string>) {
    return this.#step("setEnvs", e);
  }
  setStartCmd(cmd: string, ready: string | { getCmd(): string }) {
    return this.#step(
      "setStartCmd",
      cmd,
      typeof ready === "string" ? ready : ready.getCmd()
    );
  }
  setReadyCmd(ready: string) {
    return this.#step("setReadyCmd", ready);
  }
}

function templateInfo(name: string, id: string): TemplateInfo {
  return {
    buildCount: 1,
    buildId: `b-${id}`,
    buildStatus: "ready",
    cpuCount: 2,
    createdAt: new Date(),
    diskSizeMB: 10_000,
    envdVersion: "0.4.0",
    isDefault: false,
    memoryMB: 1024,
    names: [`proj/${name}`],
    public: false,
    spawnCount: 0,
    templateId: id,
    updatedAt: new Date(),
  };
}

const FakeTemplate = Object.assign(
  (options?: { fileContextPath?: string }) =>
    new FakeBuilder(options?.fileContextPath),
  {
    async build(
      tpl: FakeBuilder,
      name: string,
      opts: {
        onBuildLogs?: (e: InstanceType<Mod["LogEntry"]>) => void;
        [k: string]: unknown;
      } = {}
    ) {
      // COPY sources are read from the context dir at build time, like the
      // real SDK's upload step.
      const fsys = new MemFs();
      const from =
        tpl.base && world.templates.get(tpl.base)
          ? world.templates.get(tpl.base)?.fs.clone()
          : tpl.base && world.snapshots.get(tpl.base)
            ? world.snapshots.get(tpl.base)?.fs.clone()
            : undefined;
      const target = from ?? fsys;
      for (const c of tpl.copies) {
        const src = path.join(tpl.contextPath ?? "/nonexistent", c.src);
        target.write(c.dest, new Uint8Array(fs.readFileSync(src)));
        opts.onBuildLogs?.(
          new actual.LogEntry(new Date(), "info", `COPY ${c.src} ${c.dest}`)
        );
      }
      opts.onBuildLogs?.(new actual.LogEntry(new Date(), "error", "warn-ish"));
      const id = `tpl${++world.seq}`;
      world.templates.set(name, { fs: target, info: templateInfo(name, id) });
      world.buildCalls.push({ name, opts, steps: tpl.steps });
      return {
        alias: name,
        buildId: `b-${id}`,
        name,
        tags: ["default"],
        templateId: id,
      };
    },
    async delete(nameOrId: string) {
      for (const [k, t] of world.templates) {
        if (k === nameOrId || t.info.templateId === nameOrId) {
          return world.templates.delete(k);
        }
      }
      return false;
    },
    list() {
      return new Paginator(
        [
          {
            ...templateInfo("base", "tpl-base"),
            isDefault: true,
            names: ["base"],
          },
          ...[...world.templates.values()].map((t) => t.info),
        ],
        100
      );
    },
  }
);

// ---- the client ------------------------------------------------------------

function resolveBase(name: string | undefined): MemFs {
  if (!name || name === "code-interpreter-v1" || name === "base") {
    return new MemFs();
  }
  const snap = world.snapshots.get(name);
  if (snap) {
    return snap.fs.clone();
  }
  const tpl = world.templates.get(name.split(":")[0] ?? name);
  if (tpl) {
    return tpl.fs.clone();
  }
  throw apiError(`template '${name}' not found`, 404);
}

class FakeE2B {
  readonly Sandbox = {
    connect: async (id: string, _opts?: { signal?: AbortSignal }) => {
      const sb = world.sandboxes.get(id);
      if (!sb) {
        throw new actual.SandboxNotFoundError(`sandbox ${id} not found`);
      }
      sb.state = "running"; // connect resumes a paused sandbox
      return sb;
    },
    create: async (a?: string | SandboxOpts, b?: SandboxOpts) => {
      const template = typeof a === "string" ? a : undefined;
      const opts = typeof a === "string" ? b : a;
      world.createCalls.push({ opts, template });
      const key = opts?.idempotencyKey;
      if (key !== undefined && !/^[a-z0-9-]{1,255}$/.test(key)) {
        throw new actual.InvalidArgumentError(`invalid idempotency key`);
      }
      const seen = key ? world.idempotency.get(key) : undefined;
      if (seen) {
        return seen;
      }
      const sb = new FakeSandbox(opts, resolveBase(template));
      if (key) {
        world.idempotency.set(key, sb);
      }
      return sb;
    },
    deleteSnapshot: async (id: string) => world.snapshots.delete(id),
    list: (opts?: SandboxListOpts) => {
      world.listCalls.push(opts);
      const q = opts?.query;
      const items = [...world.sandboxes.values()]
        .filter(
          (s) =>
            !q?.metadata ||
            Object.entries(q.metadata).every(([k, v]) => s.metadata[k] === v)
        )
        .filter((s) => !q?.state || q.state.includes(s.state))
        .map((s) => s.info());
      return new Paginator(items, opts?.limit ?? 100);
    },
  };

  readonly Template = FakeTemplate;

  readonly Volume = {
    create: async (name: string) => {
      const v = { name, token: "vol-token", volumeId: `vol${++world.seq}` };
      world.volumes.set(v.volumeId, { name, volumeId: v.volumeId });
      return v;
    },
    destroy: async (id: string) => world.volumes.delete(id),
    list: async () => [...world.volumes.values()],
  };

  readonly Secret = {
    create: async (name: string, value: string) => {
      world.secrets.set(name, value);
    },
    exists: async (name: string) => world.secrets.has(name),
    fill,
    update: async (name: string, value: string) => {
      world.secrets.set(name, value);
    },
  };

  constructor(opts?: Record<string, unknown>) {
    world.clientOpts.push({ ...opts });
  }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

beforeEach(() => resetWorld());
afterEach(() => vi.restoreAllMocks());

const TEMPLATE = {
  source: {
    context: { "hello.txt": "from template" },
    dockerfile: "FROM e2bdev/base\nCOPY hello.txt /app/hello.txt\n",
  },
};

describe("e2b adapter: offline conformance", () => {
  it("passes the full suite (live checks on) through the fake SDK", async () => {
    const report = await runConformance(
      e2b({ allowPublicTraffic: false, apiKey: "test-key" }),
      {
        expectedCaps: {
          egressControl: "native",
          fork: "native",
          privatePreview: "native",
          pty: "native",
          templateBuild: "native",
          volumes: "native",
        },
        live: true,
        template: TEMPLATE,
      }
    );
    const failed = report.checks.filter((c) => !c.ok);
    expect(JSON.stringify(failed, null, 2)).toBe("[]");
    expect(report.checks.length).toBeGreaterThan(40);
    expect(report.passed).toBe(true);
  }, 30_000);
});

describe("e2b adapter: create spec mapping", () => {
  it("maps a rich spec onto Sandbox.create options", async () => {
    const vol = { name: "data", volumeId: "vol-abc" };
    world.volumes.set(vol.volumeId, vol);
    world.templates.set("borat-desktop", {
      fs: new MemFs(),
      info: templateInfo("borat-desktop", "tpl-borat"),
    });
    const rootCmds: string[] = [];
    world.commandHook = (cmd, opts) => {
      if (cmd.startsWith("mount ")) {
        rootCmds.push(`${opts?.user}:${cmd}`);
        return 0;
      }
      return undefined;
    };
    const provider = e2b({
      allowPublicTraffic: false,
      apiKey: "k",
      domain: "e2b.example.internal",
    });
    const client = createSandboxClient({ provider, telemetry: false });
    const sb = await client.create({
      env: { A: "1" },
      idempotencyKey: "sbox-name:Desk Top",
      lifecycle: { autoResume: true, maxAgeMs: 600_000, onIdle: "pause" },
      metadata: { team: "borat" },
      name: "desk",
      network: {
        domains: ["api.github.com"],
        inject: [
          {
            domains: ["api.github.com"],
            headers: {
              Authorization: { mode: "egress", name: "gh", value: "ghp_x" },
            },
          },
        ],
        mode: "allow-list",
      },
      resources: { shmMB: 1024, vcpus: 4 },
      secrets: [{ envVar: "TOKEN", name: "tok", value: "s3cret" }],
      template: "borat-desktop",
      volumes: [
        { id: "vol-abc", mountPath: "/data" },
        { id: "cache", mountPath: "/cache" },
      ],
    });
    expect(sb.id).toMatch(/^sbx/);
    const call = world.createCalls.at(-1)!;
    expect(call.template).toBe("borat-desktop");
    const o = call.opts!;
    expect(world.clientOpts[0]).toEqual({
      apiKey: "k",
      domain: "e2b.example.internal",
    });
    expect(o.envs).toEqual({ A: "1", TOKEN: "s3cret" });
    expect(o.metadata).toEqual({ "sbox-name": "desk", team: "borat" });
    expect(o.timeoutMs).toBe(600_000);
    expect(o.lifecycle).toEqual({ autoResume: true, onTimeout: "pause" });
    expect(o.cpuCount).toBe(4);
    expect(o.volumeMounts).toEqual({ "/cache": "cache", "/data": "data" });
    expect(o.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(o.idempotencyKey).toBe(
      await e2bIdempotencyKey("sbox-name:Desk Top")
    );
    expect(o.network).toEqual({
      allowOut: ["api.github.com"],
      allowPublicTraffic: false,
      denyOut: ["0.0.0.0/0"],
      rules: {
        "api.github.com": [
          {
            transform: { headers: { Authorization: fill("gh") } },
          },
        ],
      },
    });
    expect(world.secrets.get("gh")).toBe("ghp_x");
    expect(rootCmds).toEqual(["root:mount -o remount,size=1024m /dev/shm"]);
    expect((await sb.getInfo()).name).toBe("desk");
  });

  it("passes a valid idempotency key through unchanged", async () => {
    const client = createSandboxClient({
      provider: e2b({ apiKey: "k" }),
      telemetry: false,
    });
    await client.create({ idempotencyKey: "job-123-abc" });
    expect(world.createCalls[0]!.opts!.idempotencyKey).toBe("job-123-abc");
    // The core generates a lowercase UUID when none is given.
    await client.create();
    expect(world.createCalls[1]!.opts!.idempotencyKey).toMatch(
      /^[0-9a-f-]{36}$/
    );
  });

  it("boots fromSnapshot via Sandbox.create(snapshotId)", async () => {
    const client = createSandboxClient({
      provider: e2b({ apiKey: "k" }),
      telemetry: false,
    });
    const a = await client.create();
    await a.files.write("/tmp/s.txt", "snap");
    const snap = await a.snapshots.create({ name: "s1" });
    const b = await client.create({ fromSnapshot: snap });
    expect(world.createCalls.at(-1)!.template).toBe(snap.id);
    expect(await (await b.files.read("/tmp/s.txt")).text()).toBe("snap");
    await expect(
      client.create({ fromSnapshot: snap.id, template: "x" })
    ).rejects.toMatchObject({ code: "Validation" });
  });

  it("rejects env-mode secrets without a value and GPUs", async () => {
    const client = createSandboxClient({
      provider: e2b({ apiKey: "k" }),
      retry: { retries: 0 },
      telemetry: false,
    });
    await expect(
      client.create({ secrets: [{ name: "stored" }] })
    ).rejects.toMatchObject({ code: "Validation" });
    await expect(
      client.create({ resources: { gpu: "A10G" } })
    ).rejects.toMatchObject({ code: "Validation" });
    await expect(
      client.create({ volumes: [{ id: "v", mountPath: "/v", readOnly: true }] })
    ).rejects.toMatchObject({ code: "Validation" });
    expect(world.sandboxes.size).toBe(0);
  });

  it("kills the sandbox when /dev/shm can't be resized", async () => {
    world.commandHook = (cmd) => (cmd.startsWith("mount ") ? 32 : undefined);
    const client = createSandboxClient({
      provider: e2b({ apiKey: "k" }),
      retry: { retries: 0 },
      telemetry: false,
    });
    await expect(
      client.create({ resources: { shmMB: 2048 } })
    ).rejects.toMatchObject({ code: "Provider" });
    expect(world.sandboxes.size).toBe(0);
  });
});

describe("e2b adapter: mapping helpers", () => {
  it("maps lifecycle policies", () => {
    expect(mapLifecycle(undefined)).toBeUndefined();
    expect(mapLifecycle({ maxAgeMs: 5 })).toBeUndefined();
    expect(mapLifecycle({ onIdle: "destroy" })).toEqual({ onTimeout: "kill" });
    expect(mapLifecycle({ onIdle: "stop" })).toEqual({
      onTimeout: { action: "pause", mode: "filesystem" },
    });
    expect(mapLifecycle({ autoResume: true })).toEqual({
      autoResume: true,
      onTimeout: "pause",
    });
    expect(() => mapLifecycle({ autoResume: true, onIdle: "stop" })).toThrow(
      /autoResume/
    );
  });

  it("maps egress policies", () => {
    // The fake mirrors the real placeholder format.
    expect(actual.Secret.fill("gh")).toBe(fill("gh"));
    const mark = (n: string) => `<${n}>`;
    expect(mapEgress({ mode: "allow-all" }, mark)).toEqual({});
    expect(
      mapEgress({ deny: { cidrs: ["1.2.3.4/32"] }, mode: "allow-all" }, mark)
    ).toEqual({ denyOut: ["1.2.3.4/32"] });
    expect(mapEgress({ mode: "block-all" }, mark)).toEqual({
      denyOut: ["0.0.0.0/0"],
    });
    expect(
      mapEgress(
        { cidrs: ["8.8.8.8"], domains: ["*.example.com"], mode: "allow-list" },
        mark
      )
    ).toEqual({
      allowOut: ["*.example.com", "8.8.8.8"],
      denyOut: ["0.0.0.0/0"],
    });
    expect(
      mapEgress(
        {
          inject: [{ domains: ["a.com", "b.com"], headers: { "X-K": "key" } }],
          mode: "allow-all",
        },
        mark
      ).rules
    ).toEqual({
      "a.com": [{ transform: { headers: { "X-K": "<key>" } } }],
      "b.com": [{ transform: { headers: { "X-K": "<key>" } } }],
    });
    expect(() =>
      mapEgress({ deny: { domains: ["x.com"] }, mode: "allow-all" }, mark)
    ).toThrow(/CIDR/);
  });

  it("maps every E2B state", () => {
    expect(mapE2BState("running")).toBe("running");
    expect(mapE2BState("paused")).toBe("paused");
    expect(mapE2BState("pausing")).toBe("suspending");
    expect(mapE2BState("snapshotting")).toBe("suspending");
    expect(mapE2BState("killed")).toBe("destroyed");
    expect(mapE2BState("creating")).toBe("creating");
    expect(mapE2BState("error")).toBe("error");
    expect(mapE2BState("weird")).toBe("unknown");
    expect(mapE2BState(undefined)).toBe("unknown");
  });

  it("derives cache-keyed template names", () => {
    const key = "0123456789abcdef".repeat(4);
    expect(e2bTemplateName("sbox-0123456789abcdef", key)).toBe(
      "sbox-0123456789abcdef"
    );
    expect(e2bTemplateName("Borat Desktop", key)).toBe(
      "borat-desktop-0123456789abcdef"
    );
    expect(e2bTemplateName("x".repeat(200), key)).toHaveLength(128);
  });

  it("normalizes E2B errors", () => {
    const code = (e: unknown) => mapE2BError(e)?.code;
    expect(code(new actual.AuthenticationError("bad key"))).toBe(
      "Unauthorized"
    );
    expect(code(apiError("nope", 403))).toBe("Unauthorized");
    expect(code(new actual.SandboxNotFoundError("gone"))).toBe("NotFound");
    expect(code(new actual.FileNotFoundError("gone"))).toBe("NotFound");
    expect(code(apiError("missing", 404))).toBe("NotFound");
    const rl = mapE2BError(new actual.RateLimitError("slow down"));
    expect(rl?.code).toBe("QuotaExceeded");
    expect(rl?.retryable).toBe(true);
    expect(code(apiError("idempotency_request_mismatch", 409))).toBe(
      "Conflict"
    );
    expect(code(new actual.TimeoutError("deadline"))).toBe("Timeout");
    expect(code(new actual.InvalidArgumentError("bad"))).toBe("Validation");
    expect(code(new actual.SandboxNotRunningError("paused"))).toBe("Conflict");
    const busy = mapE2BError(new actual.ServiceBusyError("busy"));
    expect(busy?.code).toBe("Provider");
    expect(busy?.retryable).toBe(true);
    expect(mapE2BError(new actual.BuildError("failed"))?.retryable).toBe(false);
    expect(code(new Error("Invalid API key provided"))).toBe("Unauthorized");
    expect(mapE2BError(new Error("weird"))).toBeUndefined();
  });
});

describe("e2b adapter: lifecycle, list, verify", () => {
  const make = () =>
    createSandboxClient({ provider: e2b({ apiKey: "k" }), telemetry: false });

  it("reports live state and paginates list with server-side filters", async () => {
    world.pageSize = 2;
    const client = make();
    const made = [];
    for (let i = 0; i < 5; i++) {
      made.push(await client.create({ metadata: { run: "r1" } }));
    }
    await client.create({ metadata: { run: "other" } });
    await made[0]!.pause();
    expect((await made[0]!.getInfo()).state).toBe("paused");

    const all = [];
    for await (const i of client.list({ metadata: { run: "r1" } })) {
      all.push(i);
    }
    expect(all.map((i) => i.id).toSorted()).toEqual(
      made.map((s) => s.id).toSorted()
    );
    expect(world.listCalls.at(-1)).toEqual({
      limit: 100,
      query: { metadata: { run: "r1" } },
    });

    const limited = [];
    for await (const i of client.list({ limit: 3 })) {
      limited.push(i);
    }
    expect(limited).toHaveLength(3);

    const paused = [];
    for await (const i of client.list({ state: "paused" })) {
      paused.push(i);
    }
    expect(paused.map((i) => i.id)).toEqual([made[0]!.id]);
    expect(world.listCalls.at(-1)?.query).toEqual({ state: ["paused"] });

    const stopped = [];
    for await (const i of client.list({ state: "stopped" })) {
      stopped.push(i);
    }
    expect(stopped).toEqual([]);
  });

  it("resumes via connect and keeps the id", async () => {
    const client = make();
    const sb = await client.create();
    await sb.pause();
    await sb.resume();
    expect((await sb.getInfo()).state).toBe("running");
    expect(client.capabilities.flags.resumeChangesId).toBe(false);
  });

  it("verifies with a single list call and never creates", async () => {
    const res = await make().verify();
    expect(res.ok).toBe(true);
    expect(world.listCalls).toEqual([{ limit: 1 }]);
    expect(world.createCalls).toEqual([]);
  });

  it("maps metrics from the latest sample", async () => {
    const sb = await make().create();
    const m = await sb.metrics();
    expect(m).toMatchObject({
      cpuPercent: 12.5,
      diskTotalMB: 10_240,
      diskUsedMB: 1024,
      memoryTotalMB: 1024,
      memoryUsedMB: 256,
    });
    expect(m.timestamp).toEqual(new Date(1000));
  });

  it("snapshots in filesystem mode without memory", async () => {
    const sb = await make().create();
    const full = await sb.snapshots.create({ name: "a" });
    const disk = await sb.snapshots.create({ mode: "filesystem", name: "b" });
    expect(full.includesMemory).toBe(true);
    expect(disk.includesMemory).toBe(false);
    const raw = sb.raw() as unknown as FakeSandbox;
    expect(raw.snapshotModes).toEqual([undefined, "filesystem"]);
    expect((await sb.snapshots.list()).map((s) => s.id)).toEqual([
      full.id,
      disk.id,
    ]);
    await sb.snapshots.delete(full);
    expect(world.snapshots.has(full.id)).toBe(false);
    await expect(sb.snapshots.restore(disk)).rejects.toMatchObject({
      code: "NotSupported",
    });
  });

  it("cleans up successful forks when one fails", async () => {
    world.forkFail = true;
    const sb = await make().create();
    await expect(sb.fork({ count: 3 })).rejects.toMatchObject({
      code: "QuotaExceeded",
    });
    expect([...world.sandboxes.keys()]).toEqual([sb.id]);
  });
});

describe("e2b adapter: exec, stdin, pty, previews, network", () => {
  it("passes user/cwd/env natively and writes stdin to spawned processes", async () => {
    const client = createSandboxClient({
      provider: e2b({ apiKey: "k" }),
      telemetry: false,
    });
    const sb = await client.create();
    const raw = sb.raw() as unknown as FakeSandbox;
    const spy = vi.spyOn(raw.commands, "run");
    await sb.commands.run("pwd", { cwd: "/tmp", user: "root" });
    expect(spy.mock.calls[0]![1]).toMatchObject({
      background: true,
      cwd: "/tmp",
      timeoutMs: 0,
      user: "root",
    });
    expect(spy.mock.calls[0]![1]).not.toHaveProperty("stdin");
    const p = await sb.commands.spawn("sleep 5");
    expect(spy.mock.calls[1]![1]).toMatchObject({ stdin: true });
    await p.writeStdin("hello");
    expect(dec.decode(raw.procs.get(Number(p.id))!.stdin[0])).toBe("hello");
    await p.kill();
  });

  it("opens a PTY with no SDK timeout and runs an initial cmd", async () => {
    const sb = await createSandboxClient({
      provider: e2b({ apiKey: "k" }),
      telemetry: false,
    }).create();
    const raw = sb.raw() as unknown as FakeSandbox;
    const t = await sb.pty.create({ cmd: "htop", cols: 90, rows: 20 });
    expect(raw.ptyCreates[0]).toMatchObject({
      cols: 90,
      rows: 20,
      timeoutMs: 0,
    });
    expect(raw.ptyInput[0]).toEqual({ data: "exec htop\n", pid: Number(t.id) });
    const again = await sb.pty.connect(t.id);
    expect(again.id).toBe(t.id);
    await t.kill();
  });

  it("returns header auth for private previews and never fakes privacy", async () => {
    const fetchSpy = vi.fn(async () => new Response("ok"));
    const priv = await createSandboxClient({
      fetch: fetchSpy,
      provider: e2b({ allowPublicTraffic: false, apiKey: "k" }),
      telemetry: false,
    }).create();
    const p = await priv.ports.expose(6080, { visibility: "private" });
    expect(p.url).toBe(`https://6080-${priv.id}.e2b.test`);
    expect(p.wsUrl).toBe(`wss://6080-${priv.id}.e2b.test/`);
    expect(p.auth).toEqual({
      headers: { [E2B_TRAFFIC_TOKEN_HEADER]: `tok-${priv.id}` },
      type: "header",
    });
    await priv.ports.fetch(6080, "/vnc.html");
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`https://6080-${priv.id}.e2b.test/vnc.html`);
    expect(new Headers(init.headers).get(E2B_TRAFFIC_TOKEN_HEADER)).toBe(
      `tok-${priv.id}`
    );

    const pub = await createSandboxClient({
      provider: e2b({ apiKey: "k" }),
      telemetry: false,
    }).create();
    expect((await pub.ports.expose(3000)).auth).toEqual({ type: "public" });
    await expect(
      pub.ports.expose(3000, { visibility: "private" })
    ).rejects.toMatchObject({ code: "Validation" });
  });

  it("updates egress at runtime and stores injected secrets", async () => {
    const sb = await createSandboxClient({
      provider: e2b({ apiKey: "k" }),
      telemetry: false,
    }).create();
    await sb.network.setEgressPolicy({
      inject: [
        {
          domains: ["api.openai.com"],
          headers: { Authorization: { name: "oai", value: "sk-1" } },
        },
      ],
      mode: "allow-all",
    });
    expect(world.networkUpdates.at(-1)).toEqual({
      rules: {
        "api.openai.com": [
          { transform: { headers: { Authorization: fill("oai") } } },
        ],
      },
    });
    expect(world.secrets.get("oai")).toBe("sk-1");
  });

  it("runs code with stateful contexts", async () => {
    const sb = await createSandboxClient({
      provider: e2b({ apiKey: "k" }),
      telemetry: false,
    }).create();
    const ctx = await sb.code.createContext({ language: "python" });
    const out: string[] = [];
    const r = await sb.code.runCode("6*7", {
      context: ctx,
      onStdout: (s) => out.push(s),
    });
    expect(r.results[0]?.mime["text/plain"]).toBe("42");
    expect(out).toEqual(["ran:6*7"]);
  });
});

describe("e2b adapter: templates and volumes", () => {
  it("builds from a Dockerfile + context, tags by cache key, and finds it again", async () => {
    const client = createSandboxClient({
      provider: e2b({ apiKey: "k" }),
      telemetry: false,
    });
    const events: string[] = [];
    const ref = await client.templates.build(
      {
        ...TEMPLATE,
        env: { DISPLAY: ":1" },
        name: "Borat Desktop",
        readyCmd: "curl -sf localhost:6080",
        resources: { diskMB: 4096, memoryMB: 4096, vcpus: 2 },
        startCmd: "/start-vnc.sh",
        user: "root",
        workdir: "/app",
      },
      {
        onEvent: (e) =>
          events.push(e.type === "status" ? e.status : `log:${e.stream}`),
      }
    );
    expect(ref.id).toMatch(/^borat-desktop-[0-9a-f]{16}$/);
    expect(ref.cacheKey).toHaveLength(64);
    expect(events).toEqual([
      "queued",
      "building",
      "log:stdout",
      "log:stderr",
      "ready",
    ]);
    const call = world.buildCalls[0]!;
    expect(call.name).toBe(ref.id);
    expect(call.opts).toMatchObject({
      cpuCount: 2,
      memoryMB: 4096,
      minFreeDiskMb: 4096,
    });
    expect(call.steps).toEqual([
      ["fromDockerfile", TEMPLATE.source.dockerfile],
      ["setUser", "root"],
      ["setWorkdir", "/app"],
      ["setEnvs", { DISPLAY: ":1" }],
      ["setStartCmd", "/start-vnc.sh", "curl -sf localhost:6080"],
    ]);
    // The temp context dir is gone after the build.
    const fake = world.templates.get(ref.id)!;
    expect(dec.decode(fake.fs.read("/app/hello.txt")!)).toBe("from template");

    const again: string[] = [];
    const ref2 = await createSandboxClient({
      provider: e2b({ apiKey: "k" }),
      telemetry: false,
    }).templates.build(
      {
        ...TEMPLATE,
        env: { DISPLAY: ":1" },
        name: "Borat Desktop",
        readyCmd: "curl -sf localhost:6080",
        resources: { diskMB: 4096, memoryMB: 4096, vcpus: 2 },
        startCmd: "/start-vnc.sh",
        user: "root",
        workdir: "/app",
      },
      { onEvent: (e) => again.push(e.type === "status" ? e.status : "log") }
    );
    expect(ref2.id).toBe(ref.id);
    expect(again).toEqual(["cached"]);
    expect(world.buildCalls).toHaveLength(1);

    expect((await client.templates.get(ref.id))?.id).toBe(ref.id);
    expect((await client.templates.get(fake.info.templateId))?.id).toBe(ref.id);
    expect(await client.templates.get("nope")).toBeUndefined();
    const listed = [];
    for await (const t of client.templates.list()) {
      listed.push(t.id);
    }
    expect(listed).toEqual([ref.id]);
    await client.templates.delete(ref);
    expect(world.templates.size).toBe(0);
  });

  it("builds from an image (with registry auth) and from a snapshot", async () => {
    const client = createSandboxClient({
      provider: e2b({ apiKey: "k" }),
      telemetry: false,
    });
    const creds = { password: "p", username: "u" };
    await client.templates.build({
      source: { image: "debian:bookworm-slim", registryAuth: creds },
      startCmd: "sleep infinity",
    });
    expect(world.buildCalls[0]!.steps).toEqual([
      ["fromImage", "debian:bookworm-slim", creds],
      ["setStartCmd", "sleep infinity", "sleep 20"],
    ]);
    await client.templates.build({ source: { snapshot: "snap-1:default" } });
    expect(world.buildCalls[1]!.steps).toEqual([
      ["fromTemplate", "snap-1:default"],
    ]);
  });

  it("manages volumes", async () => {
    const client = createSandboxClient({
      provider: e2b({ apiKey: "k" }),
      telemetry: false,
    });
    const v = await client.volumes.create({ name: "cache" });
    expect(v).toMatchObject({
      id: expect.stringMatching(/^vol/),
      name: "cache",
    });
    expect(JSON.stringify(v.raw)).not.toContain("vol-token");
    expect((await client.volumes.get("cache"))?.id).toBe(v.id);
    expect((await client.volumes.get(v.id))?.name).toBe("cache");
    const all = [];
    for await (const x of client.volumes.list()) {
      all.push(x.id);
    }
    expect(all).toEqual([v.id]);
    await client.volumes.delete("cache");
    expect(world.volumes.size).toBe(0);
    await expect(client.volumes.delete("cache")).rejects.toMatchObject({
      code: "NotFound",
    });
  });
});

describe("e2b adapter: declared surface", () => {
  it("declares truthful caps and flags", () => {
    const provider = e2b({ apiKey: "k" });
    expect(provider.capabilities).toBe(E2B_CAPS);
    expect(provider.flags.previewBrowserAuth).toBe(false);
    expect(provider.flags.templateSources).toEqual([
      "dockerfile",
      "image",
      "snapshot",
    ]);
    expect(E2B_CAPS.stop).toBe("unsupported");
    expect(E2B_CAPS.ssh).toBe("unsupported");
    expect(E2B_CAPS.gpu).toBe("unsupported");
    expect(E2B_CAPS.region).toBe("unsupported");
  });
});
