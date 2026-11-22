/**
 * Offline tests for the Daytona adapter. `@daytona/sdk` (root + `/v0`) is
 * replaced by a fake whose method names and argument shapes follow the real
 * v0 `.d.ts` (each fake is typed with `Pick<RealClass, ...>`), and whose exec
 * runs real shell semantics through `MiniShell` over an in-memory filesystem.
 * The shared conformance suite then runs end-to-end through the adapter.
 */
import { readFileSync } from "node:fs";

import type {
  CreateSandboxFromImageParams,
  CreateSandboxFromSnapshotParams,
  CreateSnapshotParams,
  FileSystem,
  ListSandboxesQuery,
  Process,
  PtyCreateOptions,
  PtyConnectOptions,
  Sandbox as DaytonaSandbox,
  SandboxState as DaytonaState,
  Snapshot,
} from "@daytona/sdk/v0";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runConformance } from "../conformance/index.js";
import { createSandboxClient } from "../index.js";
import { MiniShell } from "../memory/shell.js";
import type { ShellFs, ShellIo } from "../memory/shell.js";
import {
  DAYTONA_CAPS,
  daytona,
  egressToDaytona,
  mapDaytonaError,
  mapDaytonaState,
  nameFromIdempotencyKey,
  parseSshCommand,
} from "./index.js";

// ---------------------------------------------------------------------------
// in-memory filesystem (shared by the fake fs API and the shell)
// ---------------------------------------------------------------------------

const norm = (p: string): string => {
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
};
const parent = (p: string): string => {
  const n = norm(p);
  return n.slice(0, n.lastIndexOf("/")) || "/";
};

class MemFs implements ShellFs {
  files = new Map<string, Uint8Array>();
  dirs = new Set(["/", "/tmp", "/home", "/home/daytona"]);
  clone(): MemFs {
    const c = new MemFs();
    c.files = new Map(this.files);
    c.dirs = new Set(this.dirs);
    return c;
  }
  #mkdirs(p: string): void {
    let cur = norm(p);
    while (!this.dirs.has(cur)) {
      this.dirs.add(cur);
      cur = parent(cur);
    }
  }
  read(path: string): Uint8Array | null {
    return this.files.get(norm(path)) ?? null;
  }
  write(path: string, data: Uint8Array): void {
    this.#mkdirs(parent(path));
    this.files.set(norm(path), data);
  }
  list(dir: string): { name: string; type: "file" | "dir" }[] | null {
    const d = norm(dir);
    if (!this.dirs.has(d)) {
      return null;
    }
    const out: { name: string; type: "file" | "dir" }[] = [];
    for (const x of this.dirs) {
      if (x !== d && parent(x) === d) {
        out.push({ name: x.slice(x.lastIndexOf("/") + 1), type: "dir" });
      }
    }
    for (const f of this.files.keys()) {
      if (parent(f) === d) {
        out.push({ name: f.slice(f.lastIndexOf("/") + 1), type: "file" });
      }
    }
    return out;
  }
  mkdir(path: string, recursive: boolean): string | null {
    if (!recursive && !this.dirs.has(parent(path))) {
      return `mkdir: ${path}: No such file or directory`;
    }
    this.#mkdirs(path);
    return null;
  }
  remove(path: string, recursive: boolean, force: boolean): string | null {
    const p = norm(path);
    if (this.files.delete(p)) {
      return null;
    }
    if (this.dirs.has(p)) {
      if (!recursive) {
        return `rm: ${path}: is a directory`;
      }
      for (const d of [...this.dirs]) {
        if (d === p || d.startsWith(`${p}/`)) {
          this.dirs.delete(d);
        }
      }
      for (const f of [...this.files.keys()]) {
        if (f.startsWith(`${p}/`)) {
          this.files.delete(f);
        }
      }
      return null;
    }
    return force ? null : `rm: ${path}: No such file or directory`;
  }
  rename(from: string, to: string): string | null {
    const data = this.files.get(norm(from));
    if (!data) {
      return `mv: ${from}: No such file or directory`;
    }
    this.files.delete(norm(from));
    this.write(to, data);
    return null;
  }
  stat(path: string): { type: "file" | "dir"; size: number } | null {
    const p = norm(path);
    if (this.dirs.has(p)) {
      return { size: 0, type: "dir" };
    }
    const f = this.files.get(p);
    return f ? { size: f.length, type: "file" } : null;
  }
  isDir(path: string): boolean {
    return this.dirs.has(norm(path));
  }
}

// ---------------------------------------------------------------------------
// fake @daytona/sdk v0
// ---------------------------------------------------------------------------

class FakeDaytonaError extends Error {
  statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "FakeDaytonaError";
    this.statusCode = statusCode;
  }
}
const notFound = (what: string) =>
  new FakeDaytonaError(`${what} not found`, 404);
const dec = new TextDecoder();
const enc = new TextEncoder();

interface FakeCmd {
  id: string;
  command: string;
  exitCode?: number;
  out: { stream: "stdout" | "stderr"; data: string }[];
  listeners: Set<(s: "stdout" | "stderr", d: string) => void>;
  done: Promise<void>;
  ac: AbortController;
}

class FakeProcess implements Pick<
  Process,
  | "createSession"
  | "executeSessionCommand"
  | "getSessionCommand"
  | "getSessionCommandLogs"
  | "sendSessionCommandInput"
  | "deleteSession"
  | "getSession"
  | "listSessions"
  | "createPty"
  | "connectPty"
  | "codeRun"
> {
  sessions = new Map<string, FakeCmd[]>();
  ptys = new Map<string, ReturnType<FakeProcess["makePty"]>>();
  readonly sb: FakeSandbox;
  constructor(sb: FakeSandbox) {
    this.sb = sb;
  }

  async createSession(sessionId: string): Promise<void> {
    if (this.sessions.has(sessionId)) {
      throw new FakeDaytonaError("session exists", 409);
    }
    this.sessions.set(sessionId, []);
  }
  async executeSessionCommand(
    sessionId: string,
    req: Parameters<Process["executeSessionCommand"]>[1]
  ): ReturnType<Process["executeSessionCommand"]> {
    const cmds = this.sessions.get(sessionId);
    if (!cmds) {
      throw notFound("session");
    }
    this.sb.assertStarted();
    const ac = new AbortController();
    const cmd: FakeCmd = {
      ac,
      command: req.command,
      done: Promise.resolve(),
      id: `cmd-${cmds.length + 1}`,
      listeners: new Set(),
      out: [],
    };
    const emit = (stream: "stdout" | "stderr") => (d: Uint8Array) => {
      const data = dec.decode(d);
      cmd.out.push({ data, stream });
      for (const l of cmd.listeners) {
        l(stream, data);
      }
    };
    cmd.done = new MiniShell(this.sb.store)
      .run(req.command, {
        cwd: "/home/daytona",
        env: { ...this.sb.env },
        signal: ac.signal,
        stderr: emit("stderr"),
        stdin: new Uint8Array(),
        stdout: emit("stdout"),
      })
      .then((code) => {
        cmd.exitCode = ac.signal.aborted ? 137 : code;
      });
    cmds.push(cmd);
    if (req.runAsync) {
      return { cmdId: cmd.id };
    }
    await cmd.done;
    return { cmdId: cmd.id, exitCode: cmd.exitCode };
  }
  #cmd(sessionId: string, commandId: string): FakeCmd {
    const c = this.sessions.get(sessionId)?.find((x) => x.id === commandId);
    if (!c) {
      throw notFound("command");
    }
    return c;
  }
  async getSessionCommand(sessionId: string, commandId: string) {
    const c = this.#cmd(sessionId, commandId);
    return { command: c.command, exitCode: c.exitCode, id: c.id };
  }
  getSessionCommandLogs(
    sessionId: string,
    commandId: string
  ): Promise<{ output?: string; stdout?: string; stderr?: string }>;
  getSessionCommandLogs(
    sessionId: string,
    commandId: string,
    onStdout: (chunk: string) => void,
    onStderr: (chunk: string) => void
  ): Promise<void>;
  async getSessionCommandLogs(
    sessionId: string,
    commandId: string,
    onStdout?: (chunk: string) => void,
    onStderr?: (chunk: string) => void
  ): Promise<{ stdout?: string; stderr?: string } | void> {
    const c = this.#cmd(sessionId, commandId);
    if (!onStdout || !onStderr) {
      await c.done;
      const join = (s: string) =>
        c.out
          .filter((o) => o.stream === s)
          .map((o) => o.data)
          .join("");
      return { stderr: join("stderr"), stdout: join("stdout") };
    }
    for (const o of c.out) {
      (o.stream === "stdout" ? onStdout : onStderr)(o.data);
    }
    const l = (s: "stdout" | "stderr", d: string) =>
      (s === "stdout" ? onStdout : onStderr)(d);
    c.listeners.add(l);
    await c.done;
    c.listeners.delete(l);
  }
  async sendSessionCommandInput(): Promise<void> {
    /* the fake shell has no live stdin */
  }
  async deleteSession(sessionId: string): Promise<void> {
    const cmds = this.sessions.get(sessionId);
    if (!cmds) {
      throw notFound("session");
    }
    for (const c of cmds) {
      c.ac.abort();
    }
    this.sessions.delete(sessionId);
  }
  async getSession(sessionId: string) {
    const cmds = this.sessions.get(sessionId);
    if (!cmds) {
      throw notFound("session");
    }
    return {
      commands: cmds.map((c) => ({
        command: c.command,
        exitCode: c.exitCode,
        id: c.id,
      })),
      sessionId,
    };
  }
  async listSessions() {
    return Promise.all(
      [...this.sessions.keys()].map((id) => this.getSession(id))
    );
  }
  makePty(id: string, onData: (d: Uint8Array) => void, cwd = "/") {
    const shell = new MiniShell(this.sb.store);
    const sink = { onData };
    let line = "";
    let chain = Promise.resolve();
    let resolveExit!: (r: { exitCode?: number }) => void;
    const exited = new Promise<{ exitCode?: number }>((r) => {
      resolveExit = r;
    });
    const io: ShellIo = {
      cwd,
      env: { ...this.sb.env },
      signal: new AbortController().signal,
      stderr: (d) => sink.onData(d),
      stdin: new Uint8Array(),
      stdout: (d) => sink.onData(d),
    };
    const runLine = async (cmd: string): Promise<void> => {
      const m = /^\s*exit\s*(\d*)/.exec(cmd);
      if (m) {
        resolveExit({ exitCode: Number(m[1] || 0) });
      } else {
        await shell.run(cmd, io);
      }
    };
    return {
      async connectPty(next: (d: Uint8Array) => void) {
        sink.onData = next;
      },
      disconnect: async () => {},
      exited,
      kill: async () => resolveExit({ exitCode: 137 }),
      resize: async (cols: number, rows: number) => ({
        active: true,
        cols,
        createdAt: "",
        cwd,
        envs: {},
        id,
        lazyStart: false,
        rows,
      }),
      sendInput: async (data: string | Uint8Array) => {
        const text = typeof data === "string" ? data : dec.decode(data);
        sink.onData(enc.encode(text));
        const parts = (line + text).split("\n");
        line = parts.pop() ?? "";
        for (const cmd of parts) {
          chain = chain.then(() => runLine(cmd));
        }
        await chain;
      },
      sessionId: id,
      wait: () => exited,
      waitForConnection: async () => {},
    };
  }
  async createPty(options?: PtyCreateOptions & PtyConnectOptions) {
    if (!options) {
      throw new FakeDaytonaError("options required", 400);
    }
    const p = this.makePty(options.id, options.onData, options.cwd);
    this.ptys.set(options.id, p);
    return p as never;
  }
  async connectPty(sessionId: string, options?: PtyConnectOptions) {
    const p = this.ptys.get(sessionId);
    if (!p || !options) {
      throw notFound("pty");
    }
    await p.connectPty(options.onData);
    return p as never;
  }
  async codeRun(code: string) {
    return {
      artifacts: { charts: [{ png: "iVBOR", title: "chart" }], stdout: code },
      exitCode: 0,
      result: `ran:${code}`,
    };
  }
}

class FakeFs implements Pick<
  FileSystem,
  | "createFolder"
  | "deleteFile"
  | "downloadFile"
  | "getFileDetails"
  | "listFiles"
  | "moveFiles"
  | "uploadFile"
  | "uploadFileStream"
> {
  readonly sb: FakeSandbox;
  constructor(sb: FakeSandbox) {
    this.sb = sb;
  }
  async createFolder(path: string, mode: string): Promise<void> {
    expect(mode).toMatch(/^[0-7]{3}$/);
    this.sb.store.mkdir(path, true);
  }
  async deleteFile(path: string, recursive?: boolean): Promise<void> {
    const err = this.sb.store.remove(path, !!recursive, false);
    if (err) {
      throw notFound(path);
    }
  }
  downloadFile(remotePath: string, timeout?: number): Promise<Buffer>;
  downloadFile(
    remotePath: string,
    localPath: string,
    timeout?: number
  ): Promise<void>;
  async downloadFile(remotePath: string): Promise<Buffer | void> {
    const data = this.sb.store.read(remotePath);
    if (!data) {
      throw new FakeDaytonaError(`File not found: ${remotePath}`, 404);
    }
    return Buffer.from(data);
  }
  async getFileDetails(path: string) {
    const s = this.sb.store.stat(path);
    if (!s) {
      throw notFound(path);
    }
    return this.#info(path, s);
  }
  #info(path: string, s: { type: "file" | "dir"; size: number }) {
    return {
      group: "daytona",
      isDir: s.type === "dir",
      modTime: new Date(0).toISOString(),
      modifiedAt: "",
      mode: "",
      name: path.slice(path.lastIndexOf("/") + 1),
      owner: "daytona",
      permissions: "",
      size: s.size,
    };
  }
  async listFiles(path: string) {
    const entries = this.sb.store.list(path);
    if (!entries) {
      throw notFound(path);
    }
    return entries.map((e) =>
      this.#info(
        `${norm(path)}/${e.name}`,
        this.sb.store.stat(`${path}/${e.name}`)!
      )
    );
  }
  async moveFiles(source: string, destination: string): Promise<void> {
    if (this.sb.store.rename(source, destination)) {
      throw notFound(source);
    }
  }
  async uploadFile(file: Buffer | string, remotePath: string): Promise<void> {
    if (typeof file === "string") {
      throw new FakeDaytonaError("local paths unsupported in fake", 400);
    }
    this.sb.store.write(remotePath, new Uint8Array(file));
  }
  async uploadFileStream(
    source: Parameters<FileSystem["uploadFileStream"]>[0],
    remotePath: string
  ): Promise<void> {
    if (source instanceof ReadableStream) {
      this.sb.store.write(
        remotePath,
        new Uint8Array(await new Response(source).arrayBuffer())
      );
    } else if (source instanceof Uint8Array) {
      this.sb.store.write(remotePath, new Uint8Array(source));
    } else {
      throw new FakeDaytonaError("unsupported upload source", 400);
    }
  }
}

type SandboxShape = Pick<
  DaytonaSandbox,
  | "id"
  | "name"
  | "labels"
  | "public"
  | "createdAt"
  | "refreshData"
  | "delete"
  | "stop"
  | "pause"
  | "start"
  | "setTtl"
  | "getPreviewLink"
  | "getSignedPreviewUrl"
  | "updateNetworkSettings"
  | "createSshAccess"
  | "getMetricsLatest"
  | "createSnapshot"
  | "fork"
>;

class FakeSandbox implements SandboxShape {
  id: string;
  name: string;
  labels: Record<string, string>;
  public = false;
  createdAt = new Date().toISOString();
  state: DaytonaState = "started";
  /** In-memory disk behind both the shell and the SDK-facing `fs` API. */
  store = new MemFs();
  env: Record<string, string>;
  ttl?: number;
  network?: Parameters<DaytonaSandbox["updateNetworkSettings"]>[0];
  readonly process = new FakeProcess(this);
  readonly fs = new FakeFs(this);
  readonly codeInterpreter = {
    createContext: async (cwd?: string) => ({
      active: true,
      createdAt: "",
      cwd: cwd ?? "/home/daytona",
      id: `ctx-${++this.ctxCounter}`,
      language: "python",
    }),
    runCode: async (
      code: string,
      o?: { onStdout?: (m: { output: string }) => void }
    ) => {
      o?.onStdout?.({ output: `kernel:${code}` });
      return { stderr: "", stdout: `kernel:${code}` };
    },
  };
  ctxCounter = 0;
  readonly world: FakeWorld;
  readonly params:
    | CreateSandboxFromImageParams
    | CreateSandboxFromSnapshotParams;
  constructor(
    world: FakeWorld,
    params: CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams
  ) {
    this.world = world;
    this.params = params;
    this.id = `sb-${++world.counter}`;
    this.name = params.name ?? this.id;
    this.labels = { ...params.labels };
    this.env = { ...params.envVars };
  }
  assertStarted(): void {
    if (this.state !== "started") {
      throw new FakeDaytonaError(`sandbox is ${this.state}`, 409);
    }
  }
  async refreshData(): Promise<void> {
    if (!this.world.sandboxes.has(this.id)) {
      throw notFound("sandbox");
    }
  }
  async delete(): Promise<void> {
    this.state = "destroyed";
    this.world.sandboxes.delete(this.id);
  }
  async stop(): Promise<void> {
    this.state = "stopped";
  }
  async pause(): Promise<void> {
    this.state = "paused";
  }
  async start(): Promise<void> {
    this.state = "started";
  }
  async setTtl(ttlMinutes: number): Promise<void> {
    this.ttl = ttlMinutes;
  }
  async getPreviewLink(port: number) {
    return {
      sandboxId: this.id,
      token: "ptok",
      url: `https://${port}-${this.id}.proxy.daytona.works`,
    };
  }
  async getSignedPreviewUrl(port: number, expiresInSeconds?: number) {
    expect(expiresInSeconds).toBeGreaterThan(0);
    return {
      port,
      sandboxId: this.id,
      token: "stok",
      url: `https://${port}-stok.proxy.daytona.works`,
    };
  }
  async updateNetworkSettings(
    s: Parameters<DaytonaSandbox["updateNetworkSettings"]>[0]
  ): Promise<void> {
    if (
      s.networkBlockAll === undefined &&
      s.networkAllowList === undefined &&
      s.domainAllowList === undefined
    ) {
      throw new FakeDaytonaError("at least one setting required", 400);
    }
    this.network = s;
  }
  async createSshAccess(expiresInMinutes?: number) {
    return {
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + (expiresInMinutes ?? 60) * 60_000),
      id: "ssh1",
      sandboxId: this.id,
      sshCommand: "ssh sshtok@ssh.app.daytona.io",
      token: "sshtok",
      updatedAt: new Date(),
    };
  }
  async getMetricsLatest() {
    return {
      cpuCount: 1,
      cpuUsedPct: 12.5,
      diskTotal: 10 * 1_048_576,
      diskUsed: 1_048_576,
      memCache: 0,
      memTotal: 1024 * 1_048_576,
      memUsed: 256 * 1_048_576,
      timestamp: new Date(),
    };
  }
  async createSnapshot(name: string): Promise<void> {
    this.world.addSnapshot(name, this.store.clone(), this.id);
  }
  async fork(): Promise<DaytonaSandbox> {
    const child = new FakeSandbox(this.world, { labels: this.labels });
    child.store = this.store.clone();
    this.world.sandboxes.set(child.id, child);
    return child.asSdk();
  }
  /** The SDK-facing view (the real class has private members a fake can't implement). */
  asSdk(): DaytonaSandbox {
    return this as unknown as DaytonaSandbox;
  }
}

interface FakeSnapshotRec {
  snap: Snapshot;
  files?: MemFs;
}

class FakeWorld {
  counter = 0;
  sandboxes = new Map<string, FakeSandbox>();
  snapshots = new Map<string, FakeSnapshotRec>();
  creates: (CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams)[] =
    [];
  snapshotCreates: CreateSnapshotParams[] = [];
  volumes: { id: string; name: string; createdAt: string }[] = [];
  addSnapshot(name: string, files?: MemFs, sourceSandboxId?: string) {
    const snap = {
      cpu: 1,
      createdAt: new Date(),
      disk: 1,
      entrypoint: null,
      errorReason: null,
      general: false,
      gpu: 0,
      id: `snap-${this.snapshots.size + 1}`,
      lastUsedAt: null,
      mem: 1,
      name,
      size: null,
      sourceSandboxId: sourceSandboxId ?? null,
      state: "active",
      updatedAt: new Date(),
    } as Snapshot;
    this.snapshots.set(name, { files, snap });
    return snap;
  }
}

let world = new FakeWorld();

class FakeV0Client {
  readonly config?: Record<string, unknown>;
  constructor(config?: Record<string, unknown>) {
    this.config = config;
  }
  async create(
    params?: CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams
  ): Promise<DaytonaSandbox> {
    const p = params ?? {};
    world.creates.push(p);
    if (
      p.name &&
      [...world.sandboxes.values()].some((s) => s.name === p.name)
    ) {
      throw new FakeDaytonaError(`sandbox ${p.name} already exists`, 409);
    }
    const sb = new FakeSandbox(world, p);
    if ("snapshot" in p && p.snapshot) {
      const rec = world.snapshots.get(p.snapshot);
      if (!rec) {
        throw notFound(`snapshot ${p.snapshot}`);
      }
      if (rec.files) {
        sb.store = rec.files.clone();
      }
    }
    world.sandboxes.set(sb.id, sb);
    return sb.asSdk();
  }
  async get(idOrName: string): Promise<DaytonaSandbox> {
    const sb =
      world.sandboxes.get(idOrName) ??
      [...world.sandboxes.values()].find((s) => s.name === idOrName);
    if (!sb) {
      throw notFound(`sandbox ${idOrName}`);
    }
    return sb.asSdk();
  }
  async *list(
    query?: ListSandboxesQuery
  ): AsyncIterableIterator<DaytonaSandbox> {
    let n = 0;
    for (const sb of world.sandboxes.values()) {
      if (
        query?.labels &&
        !Object.entries(query.labels).every(([k, v]) => sb.labels[k] === v)
      ) {
        continue;
      }
      if (query?.states && !query.states.includes(sb.state)) {
        continue;
      }
      if (query?.limit !== undefined && n >= query.limit) {
        return;
      }
      n++;
      yield sb.asSdk();
    }
  }
  readonly snapshot = {
    create: async (
      params: CreateSnapshotParams,
      options?: { onLogs?: (chunk: string) => void }
    ): Promise<Snapshot> => {
      world.snapshotCreates.push(params);
      const files = new MemFs();
      if (typeof params.image !== "string") {
        const img = params.image as unknown as FakeImage;
        for (const line of img.lines) {
          options?.onLogs?.(`Step: ${line}\n`);
          const copy = /^COPY\s+(\S+)\s+(\S+)/.exec(line);
          if (copy && img.contextDir) {
            files.write(
              copy[2]!,
              new Uint8Array(readFileSync(`${img.contextDir}/${copy[1]}`))
            );
          }
        }
      }
      return world.addSnapshot(params.name, files);
    },
    delete: async (s: Snapshot | string) => {
      world.snapshots.delete(typeof s === "string" ? s : s.name);
    },
    get: async (idOrName: string): Promise<Snapshot> => {
      const rec =
        world.snapshots.get(idOrName) ??
        [...world.snapshots.values()].find((r) => r.snap.id === idOrName);
      if (!rec) {
        throw notFound(`snapshot ${idOrName}`);
      }
      return rec.snap;
    },
    list: async (q?: {
      page?: number;
      limit?: number;
      sourceSandboxId?: string;
    }) => {
      const all = [...world.snapshots.values()]
        .map((r) => r.snap)
        .filter(
          (s) => !q?.sourceSandboxId || s.sourceSandboxId === q.sourceSandboxId
        );
      const limit = q?.limit ?? 10;
      const page = q?.page ?? 1;
      return {
        items: all.slice((page - 1) * limit, page * limit),
        page,
        total: all.length,
        totalPages: Math.max(1, Math.ceil(all.length / limit)),
      };
    },
  };
  readonly volume = {
    create: async (name: string) => {
      const v = {
        createdAt: new Date().toISOString(),
        id: `vol-${world.volumes.length + 1}`,
        name,
      };
      world.volumes.push(v);
      return v as never;
    },
    delete: async (v: { id: string }) => {
      world.volumes = world.volumes.filter((x) => x.id !== v.id);
    },
    get: async (name: string) => {
      const v = world.volumes.find((x) => x.name === name);
      if (!v) {
        throw notFound(`volume ${name}`);
      }
      return v as never;
    },
    list: async () => world.volumes as never,
  };
  async [Symbol.asyncDispose](): Promise<void> {}
}

class FakeImage {
  lines: string[] = [];
  contextDir?: string;
  static fromDockerfile(path: string): FakeImage {
    const img = new FakeImage();
    img.lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    img.contextDir = path.slice(0, path.lastIndexOf("/"));
    return img;
  }
  static base(image: string): FakeImage {
    const img = new FakeImage();
    img.lines = [`FROM ${image}`];
    return img;
  }
  env(vars: Record<string, string>): FakeImage {
    this.lines.push(...Object.entries(vars).map(([k, v]) => `ENV ${k}=${v}`));
    return this;
  }
  workdir(dir: string): FakeImage {
    this.lines.push(`WORKDIR ${dir}`);
    return this;
  }
  dockerfileCommands(cmds: string[]): FakeImage {
    this.lines.push(...cmds);
    return this;
  }
}

const rootConfigs: unknown[] = [];
vi.mock("@daytona/sdk", () => ({
  Daytona: class {
    readonly v0: FakeV0Client;
    constructor(config?: Record<string, unknown>) {
      rootConfigs.push(config);
      this.v0 = new FakeV0Client(config);
    }
    async close() {}
  },
}));
vi.mock("@daytona/sdk/v0", () => ({
  Image: FakeImage,
  RootOnlyClientV0: FakeV0Client,
}));

beforeEach(() => {
  world = new FakeWorld();
});

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("daytona: pure helpers", () => {
  it("maps every Daytona state", () => {
    const cases: [DaytonaState, string][] = [
      ["started", "running"],
      ["snapshotting", "running"],
      ["creating", "creating"],
      ["pulling_snapshot", "creating"],
      ["stopping", "suspending"],
      ["stopped", "stopped"],
      ["paused", "paused"],
      ["archived", "archived"],
      ["destroyed", "destroyed"],
      ["build_failed", "error"],
      ["unknown", "unknown"],
    ];
    for (const [s, want] of cases) {
      expect(mapDaytonaState(s)).toBe(want);
    }
    expect(mapDaytonaState(undefined)).toBe("unknown");
  });

  it("maps errors by status code", () => {
    const e = (status: number) => new FakeDaytonaError("x", status);
    expect(mapDaytonaError(e(401))?.code).toBe("Unauthorized");
    expect(mapDaytonaError(e(403))?.code).toBe("Unauthorized");
    expect(mapDaytonaError(e(404))?.code).toBe("NotFound");
    expect(mapDaytonaError(e(409))?.code).toBe("Conflict");
    const q = mapDaytonaError(e(429));
    expect(q?.code).toBe("QuotaExceeded");
    expect(q?.retryable).toBe(true);
    expect(mapDaytonaError(e(408))?.code).toBe("Timeout");
    expect(mapDaytonaError(new Error("operation timed out"))?.code).toBe(
      "Timeout"
    );
    expect(mapDaytonaError(new Error("boom"))).toBeUndefined();
  });

  it("maps egress policies", () => {
    expect(egressToDaytona({ mode: "block-all" })).toEqual({
      networkBlockAll: true,
    });
    expect(egressToDaytona({ mode: "allow-all" })).toEqual({
      networkBlockAll: false,
    });
    expect(
      egressToDaytona({
        cidrs: ["10.0.0.0/8"],
        domains: ["a.com", "*.b.io"],
        mode: "allow-list",
      })
    ).toEqual({
      domainAllowList: "a.com,*.b.io",
      networkAllowList: "10.0.0.0/8",
    });
    expect(() =>
      egressToDaytona({ deny: { domains: ["x"] }, mode: "allow-all" })
    ).toThrow(/deny/);
  });

  it("derives stable names and parses ssh commands", () => {
    expect(nameFromIdempotencyKey("abc")).toBe(nameFromIdempotencyKey("abc"));
    expect(nameFromIdempotencyKey("x".repeat(100)).length).toBeLessThanOrEqual(
      63
    );
    expect(parseSshCommand("ssh -p 2222 tok@ssh.example.io", "tok")).toEqual({
      host: "ssh.example.io",
      port: 2222,
      user: "tok",
    });
  });
});

describe("daytona: spec mapping", () => {
  it("maps a rich create spec onto v0 create params", async () => {
    const client = createSandboxClient({
      provider: daytona({ apiKey: "k", autoArchiveInterval: 30, target: "eu" }),
      telemetry: false,
    });
    world.volumes.push({ createdAt: "", id: "vol-x", name: "data" });
    await client.create({
      env: { A: "1" },
      idempotencyKey: "idem-1",
      lifecycle: {
        idleTimeoutMs: 10 * 60_000,
        maxAgeMs: 2 * 3_600_000,
        onIdle: "pause",
      },
      metadata: { team: "x" },
      network: { domains: ["pypi.org"], mode: "allow-list" },
      region: "us",
      resources: { diskMB: 10_240, gpu: "H100", memoryMB: 4096, vcpus: 2 },
      secrets: [
        { envVar: "API_KEY", name: "prod-api-key" },
        { name: "INLINE", value: "v" },
      ],
      template: "debian:12",
      volumes: [{ id: "data", mountPath: "/data" }],
    });
    expect(world.creates[0]).toMatchObject({
      autoArchiveInterval: 30,
      autoPauseInterval: 10,
      autoStopInterval: 0,
      domainAllowList: "pypi.org",
      envVars: { A: "1", INLINE: "v" },
      image: "debian:12",
      labels: { team: "x" },
      name: nameFromIdempotencyKey("idem-1"),
      resources: { cpu: 2, disk: 10, gpu: 1, gpuType: "H100", memory: 4 },
      secrets: { API_KEY: "prod-api-key" },
      target: "us",
      ttlMinutes: 120,
      volumes: [{ mountPath: "/data", volumeId: "vol-x" }],
    });
    expect(rootConfigs.at(-1)).toEqual({
      apiKey: "k",
      jwtToken: undefined,
      organizationId: undefined,
    });
  });

  it("uses snapshots for non-image templates and fromSnapshot; destroy-on-idle deletes", async () => {
    world.addSnapshot("my-snap");
    const client = createSandboxClient({
      provider: daytona({ apiKey: "k" }),
      telemetry: false,
    });
    await client.create({
      lifecycle: { idleTimeoutMs: 60_000, onIdle: "destroy" },
      template: "my-snap",
    });
    await client.create({ fromSnapshot: "my-snap" });
    expect(world.creates[0]).toMatchObject({
      autoDeleteInterval: 0,
      autoStopInterval: 1,
      snapshot: "my-snap",
    });
    expect(world.creates[1]).toMatchObject({ snapshot: "my-snap" });
  });

  it("a retried create with the same idempotency key returns the same sandbox", async () => {
    const p = daytona({ apiKey: "k" });
    const ctx = { attempt: 1, fetch, idempotencyKey: "same" };
    const a = await p.create({}, ctx);
    const b = await p.create({}, ctx);
    expect(b.id).toBe(a.id);
  });

  it("list honors metadata, state and limit", async () => {
    const p = daytona({ apiKey: "k" });
    const ctx = { attempt: 1, fetch };
    for (let i = 0; i < 5; i++) {
      await p.create({ metadata: { g: i % 2 ? "odd" : "even" } }, ctx);
    }
    const ids = async (f: Parameters<NonNullable<typeof p.list>>[0]) => {
      const out: string[] = [];
      for await (const s of p.list!(f, ctx)) {
        out.push(s.id);
      }
      return out;
    };
    expect(await ids({ metadata: { g: "even" } })).toHaveLength(3);
    expect(await ids({ limit: 2 })).toHaveLength(2);
    expect(await ids({ state: "paused" })).toHaveLength(0);
    const first = [...world.sandboxes.values()][0]!;
    first.state = "paused";
    expect(await ids({ state: "paused" })).toEqual([first.id]);
  });

  it("setTimeout maps to a wall-clock TTL in minutes", async () => {
    const client = createSandboxClient({
      provider: daytona({ apiKey: "k" }),
      telemetry: false,
    });
    const sb = await client.create();
    await sb.setTimeout(90_000);
    expect([...world.sandboxes.values()][0]!.ttl).toBe(2);
  });

  it("previews: header token for public links, signed URL for private", async () => {
    const client = createSandboxClient({
      provider: daytona({ apiKey: "k" }),
      telemetry: false,
    });
    const sb = await client.create();
    const pub = await sb.ports.expose(3000);
    expect(pub.auth).toEqual({
      headers: { "X-Daytona-Preview-Token": "ptok" },
      type: "header",
    });
    const priv = await sb.ports.expose(3000, { visibility: "private" });
    expect(priv.auth).toEqual({ type: "signed-url" });
    expect(priv.wsUrl).toBe("wss://3000-stok.proxy.daytona.works/");
  });

  it("volumes and template lookup paginate snapshots", async () => {
    const p = daytona({ apiKey: "k" });
    const ctx = { attempt: 1, fetch };
    const v = await p.volumes!.create({ name: "v1" }, ctx);
    expect((await p.volumes!.get("v1", ctx))?.id).toBe(v.id);
    await p.volumes!.delete(v.id, ctx);
    expect(await p.volumes!.get("v1", ctx)).toBeUndefined();
    for (let i = 0; i < 25; i++) {
      world.addSnapshot(`filler-${i}`);
    }
    const key = "ab".repeat(32);
    world.addSnapshot(`custom-${key.slice(0, 16)}`);
    const ref = await p.templates!.lookup(key, ctx);
    expect(ref?.id).toBe(`custom-${key.slice(0, 16)}`);
    expect(await p.templates!.lookup("cd".repeat(32), ctx)).toBeUndefined();
  });
});

describe("daytona: conformance (offline, fake SDK)", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("declares its capabilities", () => {
    const p = daytona({ apiKey: "k" });
    expect(p.capabilities).toBe(DAYTONA_CAPS);
    expect(p.flags.previewBrowserAuth).toBe(true);
    expect(p.flags.templateSources).toEqual(["dockerfile", "image"]);
  });

  it("passes the shared suite through the adapter", async () => {
    const report = await runConformance(daytona({ apiKey: "k" }), {
      live: true,
      template: {
        source: {
          context: { "hello.txt": "hi" },
          dockerfile: "FROM debian:12\nCOPY hello.txt /app/hello.txt\n",
        },
      },
    });
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed).toEqual([]);
    expect(report.checks.length).toBeGreaterThan(35);
  }, 60_000);
});
