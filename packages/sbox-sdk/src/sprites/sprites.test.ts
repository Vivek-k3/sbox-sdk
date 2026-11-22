/**
 * Offline tests for the Sprites adapter. `@fly/sprites` is replaced by an
 * in-memory fake that mirrors the real SDK's method names and argument
 * shapes (from its .d.ts); exec runs through MiniShell over an in-memory fs,
 * so the full conformance suite runs against the adapter without a network.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type {
  Checkpoint,
  CreateSpriteOptions,
  Dirent,
  FilesystemWatchEvent,
  ListOptions,
  NetworkPolicy,
  Session,
  SessionKillEvent,
  SpawnOptions,
  SpriteInfo,
  SpriteList,
  Stats,
  StreamMessage,
  URLSettings,
} from "@fly/sprites";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runConformance } from "../conformance/index.js";
import { createSandboxClient } from "../internal/client.js";
import { SandboxError } from "../internal/errors.js";
import { MiniShell } from "../memory/shell.js";
import type { ShellFs } from "../memory/shell.js";

// --------------------------------------------------------------------------
// in-memory fake of @fly/sprites
// --------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

function norm(p: string): string {
  const parts: string[] = [];
  for (const seg of (p.startsWith("/") ? p : `/${p}`).split("/")) {
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

class FilesystemError extends Error {
  readonly code: string;
  readonly path: string;
  constructor(message: string, code: string, path: string) {
    super(message);
    this.name = "FilesystemError";
    this.code = code;
    this.path = path;
  }
}

class APIError extends Error {
  readonly statusCode: number;
  readonly errorCode?: string;
  constructor(message: string, statusCode: number, errorCode?: string) {
    super(message);
    this.name = "APIError";
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

class MemFs {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>(["/", "/tmp", "/home", "/home/sprite"]);

  write(path: string, data: Uint8Array): void {
    const p = norm(path);
    let d = parent(p);
    while (!this.dirs.has(d)) {
      this.dirs.add(d);
      d = parent(d);
    }
    this.files.set(p, data);
  }
  list(dir: string): { name: string; type: "file" | "dir" }[] | null {
    const d = norm(dir);
    if (!this.dirs.has(d)) {
      return null;
    }
    const out = new Map<string, "file" | "dir">();
    for (const x of this.dirs) {
      if (x !== d && parent(x) === d) {
        out.set(x.slice(x.lastIndexOf("/") + 1), "dir");
      }
    }
    for (const f of this.files.keys()) {
      if (parent(f) === d) {
        out.set(f.slice(f.lastIndexOf("/") + 1), "file");
      }
    }
    return [...out].map(([name, type]) => ({ name, type }));
  }
  remove(path: string, recursive: boolean, force: boolean): string | null {
    const p = norm(path);
    if (this.files.delete(p)) {
      return null;
    }
    if (this.dirs.has(p)) {
      if (!recursive) {
        return `rm: cannot remove '${path}': Is a directory`;
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
    return force ? null : `rm: cannot remove '${path}': No such file`;
  }
  mkdir(path: string, recursive: boolean): string | null {
    const p = norm(path);
    if (this.dirs.has(p)) {
      return recursive ? null : "mkdir: File exists";
    }
    if (!recursive && !this.dirs.has(parent(p))) {
      return "mkdir: No such file or directory";
    }
    let d = p;
    while (!this.dirs.has(d)) {
      this.dirs.add(d);
      d = parent(d);
    }
    return null;
  }
  rename(from: string, to: string): string | null {
    const a = norm(from);
    const b = norm(to);
    const f = this.files.get(a);
    if (f) {
      this.files.delete(a);
      this.write(b, f);
      return null;
    }
    if (this.dirs.has(a)) {
      this.mkdir(b, true);
      for (const [k, v] of [...this.files]) {
        if (k.startsWith(`${a}/`)) {
          this.files.delete(k);
          this.write(b + k.slice(a.length), v);
        }
      }
      this.dirs.delete(a);
      return null;
    }
    return `mv: cannot stat '${from}'`;
  }
  shellFs(): ShellFs {
    return {
      isDir: (p) => this.dirs.has(norm(p)),
      list: (d) => this.list(d),
      mkdir: (p, r) => this.mkdir(p, r),
      read: (p) => this.files.get(norm(p)) ?? null,
      remove: (p, r, f) => this.remove(p, r, f),
      rename: (a, b) => this.rename(a, b),
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

interface FakeState {
  name: string;
  id: string;
  status: string;
  labels: string[];
  environment: Record<string, string>;
  options: CreateSpriteOptions;
  urlSettings: URLSettings;
  policy?: NetworkPolicy;
  fs: MemFs;
  checkpoints: { cp: Checkpoint; files: Map<string, Uint8Array> }[];
  sessions: Map<string, FakeCommand>;
  createdAt: Date;
}

const store = new Map<string, FakeState>();
const calls: { method: string; args: unknown[] }[] = [];
let sessionCounter = 0;
let pageSize = 2;

/** Mirrors SpriteCommand: EventEmitter + stdin/stdout/stderr streams. */
// The real SpriteCommand extends Node's EventEmitter; mirror that.
// oxlint-disable-next-line unicorn/prefer-event-target
class FakeCommand extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  #code = -1;
  #resolve!: (n: number) => void;
  readonly #exit = new Promise<number>((r) => {
    this.#resolve = r;
  });
  readonly #ac = new AbortController();
  sessionId?: string;

  readonly st: FakeState;
  readonly options: SpawnOptions;

  constructor(
    st: FakeState,
    command: string,
    args: string[],
    options: SpawnOptions
  ) {
    super();
    this.st = st;
    this.options = options;
    queueMicrotask(() => {
      this.emit("spawn");
      if (options.tty) {
        this.#interactive();
      } else {
        const script =
          command === "sh" && args[0] === "-c"
            ? (args[1] ?? "")
            : [command, ...args].join(" ");
        void this.#run(script);
      }
    });
  }

  #io(tty: boolean) {
    const fix = (d: Uint8Array) =>
      tty ? enc.encode(dec.decode(d).replaceAll("\n", "\r\n")) : d;
    return {
      cwd: this.options.cwd ?? "/home/sprite",
      env: { ...this.st.environment, ...this.options.env },
      signal: this.#ac.signal,
      stderr: (d: Uint8Array) =>
        (tty ? this.stdout : this.stderr).write(fix(d)),
      stdin: new Uint8Array(),
      stdout: (d: Uint8Array) => this.stdout.write(fix(d)),
    };
  }

  async #run(script: string): Promise<void> {
    const code = await new MiniShell(this.st.fs.shellFs()).run(
      script,
      this.#io(false)
    );
    this.#finish(this.#ac.signal.aborted ? 137 : code);
  }

  #interactive(): void {
    if (this.options.detachable) {
      this.sessionId = `sess-${++sessionCounter}`;
      this.st.sessions.set(this.sessionId, this);
      this.emit("message", {
        session_id: this.sessionId,
        tty: true,
        type: "session_info",
      });
    }
    const shell = new MiniShell(this.st.fs.shellFs());
    let line = "";
    let chain = Promise.resolve();
    this.stdin.on("data", (chunk: Uint8Array) => {
      const text = dec.decode(chunk);
      this.stdout.write(enc.encode(text.replaceAll("\n", "\r\n")));
      line += text;
      let nl = line.indexOf("\n");
      while (nl !== -1) {
        const cmd = line.slice(0, nl);
        line = line.slice(nl + 1);
        const m = /^\s*exit(?:\s+(\d+))?\s*$/.exec(cmd);
        chain = m
          ? chain.then(() => this.#finish(Number(m[1] ?? 0)))
          : chain.then(async () => {
              await shell.run(cmd, this.#io(true));
            });
        nl = line.indexOf("\n");
      }
    });
  }

  #finish(code: number): void {
    if (this.#code !== -1) {
      return;
    }
    this.#code = code;
    if (this.sessionId) {
      this.st.sessions.delete(this.sessionId);
    }
    this.stdout.end();
    this.stderr.end();
    this.#resolve(code);
    this.emit("exit", code);
  }

  wait(): Promise<number> {
    return this.#exit;
  }
  kill(signal = "SIGTERM"): void {
    calls.push({ args: [signal], method: "command.kill" });
    this.#ac.abort();
    if (this.options.tty) {
      this.#finish(137);
    }
  }
  signal(sig: string): void {
    this.kill(sig);
  }
  close(): void {
    this.#finish(this.#code === -1 ? 137 : this.#code);
  }
  resize(cols: number, rows: number): void {
    calls.push({ args: [cols, rows], method: "command.resize" });
  }
  exitCode(): number {
    return this.#code;
  }
}

function stream<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  };
}

function mustGet(name: string): FakeState {
  const st = store.get(name);
  if (!st) {
    throw new APIError(`sprite ${name} not found (status 404)`, 404);
  }
  return st;
}

function info(st: FakeState): SpriteInfo {
  return {
    createdAt: st.createdAt,
    environment: st.environment,
    id: st.id,
    labels: st.labels,
    name: st.name,
    organization: "acme",
    status: st.status,
    updatedAt: st.createdAt,
    url: `https://${st.name}-abc123.sprites.app`,
    urlSettings: st.urlSettings,
  };
}

/** Mirrors SpriteFilesystem (fs/promises-like). */
class FakeFilesystem {
  readonly st: FakeState;
  constructor(st: FakeState) {
    this.st = st;
  }
  async readFile(path: string, _enc?: null): Promise<Buffer> {
    const f = this.st.fs.files.get(norm(path));
    if (!f) {
      throw new FilesystemError(`no such file: ${path}`, "ENOENT", path);
    }
    return Buffer.from(f);
  }
  async writeFile(path: string, data: string | Buffer): Promise<void> {
    this.st.fs.write(
      path,
      typeof data === "string" ? enc.encode(data) : new Uint8Array(data)
    );
  }
  async readdir(path: string, _o: { withFileTypes: true }): Promise<Dirent[]> {
    const entries = this.st.fs.list(path);
    if (!entries) {
      throw new FilesystemError(`not a dir: ${path}`, "ENOENT", path);
    }
    return entries.map((e) => ({
      isDirectory: () => e.type === "dir",
      isFile: () => e.type === "file",
      isSymbolicLink: () => false,
      name: e.name,
      parentPath: path,
    }));
  }
  async mkdir(path: string, o?: { recursive?: boolean }): Promise<void> {
    const err = this.st.fs.mkdir(path, o?.recursive ?? false);
    if (err) {
      throw new FilesystemError(err, "EEXIST", path);
    }
  }
  async rm(
    path: string,
    o?: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    const err = this.st.fs.remove(
      path,
      o?.recursive ?? false,
      o?.force ?? false
    );
    if (err) {
      throw new FilesystemError(err, "ENOENT", path);
    }
  }
  async rename(a: string, b: string): Promise<void> {
    const err = this.st.fs.rename(a, b);
    if (err) {
      throw new FilesystemError(err, "ENOENT", a);
    }
  }
  async stat(path: string): Promise<Stats> {
    const s = this.st.fs.shellFs().stat(path);
    if (!s) {
      throw new FilesystemError(`no such file: ${path}`, "ENOENT", path);
    }
    const now = new Date();
    return {
      atime: now,
      birthtime: now,
      isDirectory: () => s.type === "dir",
      isFile: () => s.type === "file",
      isSymbolicLink: () => false,
      mode: 0o644,
      mtime: now,
      size: s.size,
    };
  }
  async watch(
    _paths: string | string[],
    _o?: { recursive?: boolean }
  ): Promise<AsyncIterable<FilesystemWatchEvent> & { close(): void }> {
    const events: FilesystemWatchEvent[] = [
      { type: "subscribed" },
      { event: "create", path: "/tmp/w.txt", type: "event" },
    ];
    return { ...stream(events), close: () => undefined };
  }
}

/** Mirrors Sprite: methods operate on the store by name. */
class FakeSprite {
  readonly name: string;
  readonly client: FakeClient;
  constructor(client: FakeClient, st: FakeState) {
    this.client = client;
    this.name = st.name;
    Object.assign(this, info(st));
  }
  get #st(): FakeState {
    return mustGet(this.name);
  }
  spawn(command: string, args: string[] = [], options: SpawnOptions = {}) {
    calls.push({ args: [command, args, options], method: "spawn" });
    return new FakeCommand(this.#st, command, args, options);
  }
  createSession(command: string, args: string[] = [], options = {}) {
    calls.push({ args: [command, args, options], method: "createSession" });
    return new FakeCommand(this.#st, command, args, {
      ...options,
      detachable: true,
      tty: true,
    });
  }
  attachSession(sessionId: string) {
    if (!this.#st.sessions.has(sessionId)) {
      throw new APIError(`session ${sessionId} not found`, 404);
    }
    return new FakeCommand(this.#st, "tmux", ["attach"], { tty: true });
  }
  async listSessions(): Promise<Session[]> {
    return [...this.#st.sessions.keys()].map((id) => ({
      bytesPerSecond: 0,
      command: "bash",
      created: new Date(),
      id,
      isActive: true,
      tty: true,
      workdir: "/",
    }));
  }
  async killSession(id: string): Promise<AsyncIterable<SessionKillEvent>> {
    const cmd = this.#st.sessions.get(id);
    if (!cmd) {
      throw new APIError(`session ${id} not found`, 404);
    }
    cmd.kill("SIGKILL");
    return stream<SessionKillEvent>([{ type: "killed" }, { type: "complete" }]);
  }
  async createCheckpoint(
    comment?: string
  ): Promise<AsyncIterable<StreamMessage>> {
    const st = this.#st;
    const cp: Checkpoint = {
      comment,
      createTime: new Date(),
      id: `v${st.checkpoints.length}`,
    };
    st.checkpoints.push({ cp, files: new Map(st.fs.files) });
    return stream<StreamMessage>([
      { data: "creating", type: "info" },
      { data: `Checkpoint created: ${cp.id}`, type: "complete" },
    ]);
  }
  async listCheckpoints(): Promise<Checkpoint[]> {
    return [
      { createTime: new Date(), id: "Current" },
      ...this.#st.checkpoints.map((c) => c.cp),
    ];
  }
  async restoreCheckpoint(id: string): Promise<AsyncIterable<StreamMessage>> {
    const snap = this.#st.checkpoints.find((c) => c.cp.id === id);
    if (!snap) {
      throw new Error(`Failed to restore checkpoint (status 404): nope`);
    }
    this.#st.fs.files = new Map(snap.files);
    return stream<StreamMessage>([{ type: "complete" }]);
  }
  async updateURLSettings(settings: URLSettings): Promise<void> {
    calls.push({ args: [settings], method: "updateURLSettings" });
    this.#st.urlSettings = settings;
  }
  async updateNetworkPolicy(policy: NetworkPolicy): Promise<void> {
    calls.push({ args: [policy], method: "updateNetworkPolicy" });
    this.#st.policy = policy;
  }
  filesystem(_wd?: string) {
    return new FakeFilesystem(this.#st);
  }
}

/** Mirrors SpritesClient. */
class FakeClient {
  readonly token: string;
  readonly options: { baseURL?: string };
  constructor(token: string, options: { baseURL?: string } = {}) {
    this.token = token;
    this.options = options;
  }
  async createSprite(
    name: string,
    options: CreateSpriteOptions = {}
  ): Promise<FakeSprite> {
    calls.push({ args: [name, options], method: "createSprite" });
    if (this.token === "bad") {
      throw new APIError("unauthorized (status 401)", 401);
    }
    if (store.has(name)) {
      throw new APIError(`sprite ${name} exists (status 409)`, 409);
    }
    const st: FakeState = {
      checkpoints: [],
      createdAt: new Date(),
      environment: { ...options.environment },
      fs: new MemFs(),
      id: `sprite-${store.size + 1}`,
      labels: options.labels ?? [],
      name,
      options,
      sessions: new Map(),
      status: "running",
      urlSettings: options.urlSettings ?? { auth: "sprite" },
    };
    store.set(name, st);
    return new FakeSprite(this, st);
  }
  async getSprite(name: string): Promise<FakeSprite> {
    return new FakeSprite(this, mustGet(name));
  }
  async listSprites(options: ListOptions = {}): Promise<SpriteList> {
    if (this.token === "bad") {
      throw new APIError("unauthorized (status 401)", 401);
    }
    calls.push({ args: [options], method: "listSprites" });
    const all = [...store.values()].map(info);
    const start = Number(options.continuationToken ?? 0);
    const size = Math.min(options.maxResults ?? 100, pageSize);
    const next = start + size;
    return {
      hasMore: next < all.length,
      nextContinuationToken: next < all.length ? String(next) : undefined,
      organizationName: "acme",
      sprites: all.slice(start, next),
    };
  }
  async deleteSprite(name: string): Promise<void> {
    mustGet(name);
    store.delete(name);
  }
}

vi.mock("@fly/sprites", () => ({ SpritesClient: FakeClient }));

const {
  decodeLabels,
  encodeLabels,
  mapSpriteStatus,
  mapSpritesError,
  nameFromKey,
  sprites,
  SPRITES_CAPS,
  toCreateArgs,
  toNetworkPolicy,
} = await import("./index.js");

beforeEach(() => {
  store.clear();
  calls.length = 0;
  pageSize = 2;
});

// --------------------------------------------------------------------------
// tests
// --------------------------------------------------------------------------

describe("sprites conformance (offline, fake SDK)", () => {
  it("passes the full live conformance suite", async () => {
    const report = await runConformance(sprites({ token: "tok" }), {
      expectedCaps: { pause: "unsupported", snapshot: "native" },
      live: true,
    });
    const failed = report.checks.filter((c) => !c.ok);
    expect(JSON.stringify(failed, null, 2)).toBe("[]");
    expect(report.checks.length).toBeGreaterThan(30);
  }, 60_000);
});

describe("spec mapping", () => {
  it("maps a rich spec onto createSprite", async () => {
    const client = createSandboxClient({
      provider: sprites({ runtime: "default", token: "tok" }),
      telemetry: false,
    });
    const sb = await client.create({
      env: { A: "1" },
      idempotencyKey: "idem-1",
      metadata: { team: "a b", "x=y": "z" },
      network: { domains: ["github.com"], mode: "allow-list" },
      region: "ord",
      resources: { diskMB: 20_000, memoryMB: 2048, vcpus: 2 },
      secrets: [{ name: "TOKEN", value: "s3cret" }],
      template: "dev",
    });
    const create = calls.find((c) => c.method === "createSprite");
    const [name, options] = create!.args as [string, CreateSpriteOptions];
    expect(name).toBe(await nameFromKey("idem-1"));
    expect(sb.id).toBe(name);
    expect(options).toEqual({
      config: { cpus: 2, ramMB: 2048, region: "ord", storageGB: 20 },
      environment: { A: "1", TOKEN: "s3cret" },
      labels: ["team=a%20b", "x%3Dy=z"],
      runtime: "dev",
    });
    expect(
      calls.find((c) => c.method === "updateNetworkPolicy")?.args[0]
    ).toEqual({
      rules: [
        { action: "allow", domain: "github.com" },
        { action: "deny", domain: "*" },
      ],
    });
    const i = await sb.getInfo();
    expect(i.metadata).toEqual({ team: "a b", "x=y": "z" });
    expect(i.state).toBe("running");
  });

  it("is idempotent: a retried create with the same key reuses the sprite", async () => {
    const p = sprites({ token: "tok" });
    const ctx = { attempt: 1, fetch, idempotencyKey: "k" };
    const a = await p.create({}, ctx);
    const b = await p.create({}, { ...ctx, attempt: 2 });
    expect(a.id).toBe(b.id);
    expect(store.size).toBe(1);
  });

  it("rejects unsupported spec fields up front", () => {
    expect(() => toCreateArgs({ template: "ubuntu" }, "n", {})).toThrow(
      /default.*dev/
    );
    expect(() => toCreateArgs({ fromSnapshot: "v1" }, "n", {})).toThrow(
      /checkpoint cannot seed/
    );
    expect(() => toCreateArgs({ secrets: [{ name: "X" }] }, "n", {})).toThrow(
      /inline value/
    );
    expect(() =>
      toCreateArgs({ volumes: [{ id: "v", mountPath: "/m" }] }, "n", {})
    ).toThrow(SandboxError);
  });

  it("getOrCreate returns the same named sprite and records sbox-name", async () => {
    const client = createSandboxClient({
      provider: sprites({ token: "tok" }),
      telemetry: false,
    });
    const a = await client.getOrCreate({ name: "dev-box" });
    const b = await client.getOrCreate({ name: "dev-box" });
    expect(a.id).toBe("dev-box");
    expect(b.id).toBe("dev-box");
    expect(store.get("dev-box")?.labels).toEqual(["sbox-name=dev-box"]);
  });
});

describe("previews", () => {
  it("toggles sprite-wide URL auth and reports header auth when private", async () => {
    const client = createSandboxClient({
      provider: sprites({ token: "tok" }),
      telemetry: false,
    });
    const sb = await client.create();
    const pub = await sb.ports!.expose(8080);
    expect(pub.auth).toEqual({ type: "public" });
    expect(pub.url).toMatch(/sprites\.app/);
    const priv = await sb.ports!.expose(8080, { visibility: "private" });
    expect(priv.auth).toEqual({
      headers: { Authorization: "Bearer tok" },
      type: "header",
    });
    expect(store.get(sb.id)?.urlSettings).toEqual({ auth: "sprite" });
    const listed = await sb.ports!.list();
    expect(listed[0]?.auth?.type).toBe("header");
  });
});

describe("pty", () => {
  it("uses the server session id and supports connect + kill", async () => {
    const client = createSandboxClient({
      provider: sprites({ token: "tok" }),
      telemetry: false,
    });
    const sb = await client.create();
    const t = await sb.pty!.create({ cols: 90, rows: 20 });
    expect(t.id).toMatch(/^sess-/);
    const again = await sb.pty!.connect(t.id);
    expect(again.id).toBe(t.id);
    await t.kill();
    expect(store.get(sb.id)?.sessions.size).toBe(0);
  });
});

describe("snapshots", () => {
  it("creates, lists and restores filesystem checkpoints", async () => {
    const client = createSandboxClient({
      provider: sprites({ token: "tok" }),
      telemetry: false,
    });
    const sb = await client.create();
    await sb.files.write("/tmp/a.txt", "one");
    const ref = await sb.snapshots!.create({ name: "base" });
    expect(ref).toMatchObject({
      id: "v0",
      includesMemory: false,
      name: "base",
    });
    await sb.files.write("/tmp/a.txt", "two");
    await sb.snapshots!.restore(ref);
    expect(await (await sb.files.read("/tmp/a.txt")).text()).toBe("one");
    const list = await sb.snapshots!.list();
    expect(list.map((s) => s.id)).toEqual(["v0"]);
    await expect(
      sb.snapshots!.create({ mode: "memory" })
    ).rejects.toMatchObject({ code: "Validation" });
  });
});

describe("files watch", () => {
  it("maps watcher events", async () => {
    const client = createSandboxClient({
      provider: sprites({ token: "tok" }),
      telemetry: false,
    });
    const sb = await client.create();
    const seen: unknown[] = [];
    const w = await sb.files.watch("/tmp", (e) => seen.push(e));
    await new Promise((r) => setTimeout(r, 10));
    await w.close();
    expect(seen).toEqual([{ path: "/tmp/w.txt", type: "create" }]);
  });
});

describe("list", () => {
  it("paginates fully and filters by metadata, state and limit", async () => {
    pageSize = 2;
    const p = sprites({ token: "tok" });
    const ctx = { attempt: 1, fetch };
    for (let i = 0; i < 5; i++) {
      await p.create(
        { metadata: { group: i % 2 === 0 ? "even" : "odd" } },
        { ...ctx, idempotencyKey: `k${i}` }
      );
    }
    store.get([...store.keys()][4]!)!.status = "cold";
    const all: string[] = [];
    for await (const i of p.list!(undefined, ctx)) {
      all.push(i.id);
    }
    expect(all).toHaveLength(5);
    const pages = calls.filter((c) => c.method === "listSprites").length;
    expect(pages).toBe(3);
    const even: string[] = [];
    for await (const i of p.list!({ metadata: { group: "even" } }, ctx)) {
      even.push(i.id);
    }
    expect(even).toHaveLength(3);
    const stopped: string[] = [];
    for await (const i of p.list!({ state: "stopped" }, ctx)) {
      stopped.push(i.id);
    }
    expect(stopped).toHaveLength(1);
    const limited: string[] = [];
    for await (const i of p.list!({ limit: 2 }, ctx)) {
      limited.push(i.id);
    }
    expect(limited).toHaveLength(2);
  });

  it("verify reports the organization and fails on a bad token", async () => {
    const ok = await createSandboxClient({
      provider: sprites({ token: "tok" }),
      telemetry: false,
    }).verify();
    expect(ok).toEqual({ account: "acme", ok: true, provider: "sprites" });
    const bad = await createSandboxClient({
      provider: sprites({ token: "bad" }),
      telemetry: false,
    }).verify();
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error.code).toBe("Unauthorized");
  });
});

describe("pure mappers", () => {
  it("maps every sprite status", () => {
    expect(mapSpriteStatus("running")).toBe("running");
    expect(mapSpriteStatus("warm")).toBe("paused");
    expect(mapSpriteStatus("cold")).toBe("stopped");
    expect(mapSpriteStatus("weird")).toBe("unknown");
    expect(mapSpriteStatus(undefined)).toBe("unknown");
  });

  it("maps errors", () => {
    const code = (e: unknown) => mapSpritesError(e)?.code;
    expect(code(new APIError("x", 401))).toBe("Unauthorized");
    expect(code(new APIError("x", 403))).toBe("Unauthorized");
    expect(code(new APIError("x", 404))).toBe("NotFound");
    expect(code(new APIError("x", 409))).toBe("Conflict");
    const quota = mapSpritesError(new APIError("x", 429));
    expect(quota?.code).toBe("QuotaExceeded");
    expect(quota?.retryable).toBe(true);
    expect(
      code(new APIError("x", 400, "concurrent_sprite_limit_exceeded"))
    ).toBe("QuotaExceeded");
    expect(code(new APIError("x", 504))).toBe("Timeout");
    expect(code(new APIError("x", 502))).toBe("Provider");
    expect(code(new FilesystemError("x", "ENOENT", "/a"))).toBe("NotFound");
    expect(code(new Error("Failed to list sessions (status 404): x"))).toBe(
      "NotFound"
    );
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(code(abort)).toBe("Timeout");
    expect(mapSpritesError(new Error("random"))).toBeUndefined();
  });

  it("maps egress policies", () => {
    expect(toNetworkPolicy({ mode: "allow-all" })).toEqual({ rules: [] });
    expect(toNetworkPolicy({ mode: "block-all" })).toEqual({
      rules: [{ action: "deny", domain: "*" }],
    });
    expect(
      toNetworkPolicy({ deny: { domains: ["evil.com"] }, mode: "allow-all" })
    ).toEqual({
      rules: [
        { action: "deny", domain: "evil.com" },
        { action: "allow", domain: "*" },
      ],
    });
    expect(() =>
      toNetworkPolicy({ cidrs: ["10.0.0.0/8"], mode: "allow-list" })
    ).toThrow(/CIDR/);
    expect(() =>
      toNetworkPolicy({
        inject: [{ domains: ["x"], headers: { A: "b" } }],
        mode: "allow-all",
      })
    ).toThrow(/injection/);
  });

  it("round-trips labels", () => {
    const m = { "a=b": "c d", plain: "v" };
    expect(decodeLabels(encodeLabels(m))).toEqual(m);
    expect(decodeLabels(["production"])).toEqual({ production: "" });
  });

  it("declares a truthful caps table", () => {
    expect(SPRITES_CAPS.pause).toBe("unsupported");
    expect(SPRITES_CAPS.templateBuild).toBe("unsupported");
    expect(SPRITES_CAPS.pty).toBe("native");
  });
});
