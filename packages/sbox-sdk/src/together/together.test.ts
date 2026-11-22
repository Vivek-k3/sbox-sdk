/**
 * Offline tests for the Together Sandbox adapter. `together-sandbox` is mocked
 * with a fake `TogetherSandbox` whose method names and argument shapes follow
 * the installed `.d.ts` (together-sandbox@4.1.1). The real `HttpError` and
 * `Page` classes are kept. Execs run on `MiniShell` over an in-memory
 * filesystem and stream stdout/stderr as separate `ExecStdout` events with a
 * final `exitCode`, so the full conformance suite runs through the adapter.
 */
import { readFile as readHostFile } from "node:fs/promises";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { runConformance } from "../conformance/index.js";
import { SandboxError } from "../internal/errors.js";
import type { CallContext } from "../internal/types.js";
import { MiniShell } from "../memory/shell.js";
import type { ShellFs } from "../memory/shell.js";
import {
  TOGETHER_CAPS,
  mapTogetherError,
  mapTogetherStatus,
  renderDockerfile,
  terminatedState,
  toCreateParams,
  together,
} from "./index.js";

type Mod = typeof import("together-sandbox");
type RealSandbox = InstanceType<Mod["Sandbox"]>;
type Client = InstanceType<Mod["TogetherSandbox"]>;
type Info = import("together-sandbox").SandboxInfo;
type Snap = import("together-sandbox").Snapshot;
type ExecStdout = import("together-sandbox").ExecStdout;
type CreateParams = import("together-sandbox").CreateSandboxParams;
type SnapParams = import("together-sandbox").CreateSnapshotParams;
type TerminationSnapshot = import("together-sandbox").TerminationSnapshotParams;
type ExecItem = Awaited<ReturnType<RealSandbox["execs"]["create"]>>;
type ExecBody = Parameters<RealSandbox["execs"]["create"]>[0];
type StdinBody = Parameters<RealSandbox["execs"]["sendStdin"]>[1];
type OutGen = Awaited<ReturnType<RealSandbox["execs"]["streamOutput"]>>;
type WatchGen = Awaited<ReturnType<RealSandbox["files"]["watch"]>>;
type WatchEvent =
  WatchGen extends AsyncGenerator<infer E, unknown, unknown> ? E : never;
type GenReturn<G> =
  G extends AsyncGenerator<unknown, infer R, unknown> ? R : never;
type FileInfo = Awaited<ReturnType<RealSandbox["files"]["stat"]>>;

const actual = await vi.importActual<Mod>("together-sandbox");

vi.mock("together-sandbox", async (importOriginal) => ({
  ...(await importOriginal<Mod>()),
  TogetherSandbox: FakeTogether,
}));

const enc = new TextEncoder();
const dec = new TextDecoder();
const notFound = (what: string) =>
  new actual.HttpError(`${what} not found`, 404);

// ---------------------------------------------------------------------------
// in-memory filesystem
// ---------------------------------------------------------------------------

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
  dirs = new Set(["/", "/tmp", "/home", "/var", "/var/tmp", "/app"]);
  watchers: { dir: string; push: (e: WatchEvent) => void }[] = [];

  clone(): MemFs {
    const c = new MemFs();
    c.files = new Map(this.files);
    c.dirs = new Set(this.dirs);
    return c;
  }
  ensureDirs(dir: string): void {
    let cur = norm(dir);
    while (cur !== "/") {
      this.dirs.add(cur);
      cur = parent(cur);
    }
  }
  #notify(path: string, type: WatchEvent["type"]): void {
    for (const w of this.watchers) {
      if (parent(path) === w.dir) {
        w.push({ paths: [path], timestamp: new Date().toISOString(), type });
      }
    }
  }
  read(p: string) {
    return this.files.get(norm(p)) ?? null;
  }
  write(p: string, data: Uint8Array) {
    const n = norm(p);
    const existed = this.files.has(n);
    this.ensureDirs(parent(n));
    this.files.set(n, data);
    this.#notify(n, existed ? "CHANGE" : "ADD");
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
    this.ensureDirs(p);
    return null;
  }
  remove(p: string, _recursive: boolean, force: boolean) {
    const n = norm(p);
    if (this.files.delete(n)) {
      this.#notify(n, "REMOVE");
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

// ---------------------------------------------------------------------------
// fake execs
// ---------------------------------------------------------------------------

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

class FakeExec {
  item: ExecItem;
  log: ExecStdout[] = [];
  done = false;
  deleted = false;
  stdin: StdinBody[] = [];
  readonly env: Record<string, string>;
  #seq = 0;
  #wakers: (() => void)[] = [];
  readonly ac = new AbortController();
  #line = "";
  #chain = Promise.resolve();

  private readonly fs: MemFs;

  constructor(id: string, body: ExecBody, fs: MemFs) {
    this.fs = fs;
    this.env = { ...body.env };
    this.item = {
      args: body.args,
      command: body.command,
      exitCode: 0,
      id,
      pid: Math.floor(Math.random() * 30_000),
      pty: body.pty ?? false,
      status: "running",
      ...(body.user ? { user: body.user } : {}),
    };
    if (!body.pty) {
      const script =
        body.command === "sh" && body.args[0] === "-c"
          ? (body.args[1] ?? "")
          : [body.command, ...body.args].map(q).join(" ");
      void new MiniShell(fs)
        .run(script, this.#io(body))
        .then((code) => this.finish(code));
    }
  }
  #io(body: ExecBody) {
    return {
      cwd: body.cwd ?? "/",
      env: { ...body.env },
      signal: this.ac.signal,
      stderr: (d: Uint8Array) => this.emit("stderr", dec.decode(d)),
      stdin: new Uint8Array(),
      stdout: (d: Uint8Array) => this.emit("stdout", dec.decode(d)),
    };
  }
  emit(type: "stdout" | "stderr", output: string): void {
    this.log.push({ output, sequence: this.#seq++, type });
    this.#wake();
  }
  finish(code: number): void {
    if (this.done) {
      return;
    }
    this.done = true;
    if (!this.deleted) {
      this.item = { ...this.item, exitCode: code, status: "finished" };
      this.log.push({
        exitCode: code,
        output: "",
        sequence: this.#seq++,
        type: "stdout",
      });
    }
    this.#wake();
  }
  kill(): void {
    this.deleted = true;
    this.ac.abort();
    this.done = true;
    this.#wake();
  }
  #wake(): void {
    const w = this.#wakers;
    this.#wakers = [];
    for (const f of w) {
      f();
    }
  }
  /** PTY input: echo, then run complete lines through the shell. */
  input(body: StdinBody): void {
    this.stdin.push(body);
    if (!this.item.pty || body.type !== "stdin") {
      return;
    }
    this.emit("stdout", body.input.replaceAll("\n", "\r\n"));
    this.#line += body.input;
    let nl = this.#line.indexOf("\n");
    while (nl !== -1) {
      const cmd = this.#line.slice(0, nl);
      this.#line = this.#line.slice(nl + 1);
      const exit = /^\s*exit(?:\s+(\d+))?\s*$/.exec(cmd);
      this.#chain = this.#chain.then(async () => {
        if (exit) {
          this.finish(Number(exit[1] ?? 0));
        } else {
          await new MiniShell(this.fs).run(cmd, {
            ...this.#io({ args: [], command: "sh", env: this.env }),
          });
        }
      });
      nl = this.#line.indexOf("\n");
    }
  }
  stream(from = 0): OutGen {
    const self = this;
    async function* gen(): OutGen {
      let i = from;
      for (;;) {
        while (i < self.log.length) {
          const ev = self.log[i++]!;
          yield ev;
          if (typeof ev.exitCode === "number") {
            return {} as GenReturn<OutGen>;
          }
        }
        if (self.done) {
          return {} as GenReturn<OutGen>;
        }
        await new Promise<void>((r) => self.#wakers.push(r));
      }
    }
    return gen();
  }
}

// ---------------------------------------------------------------------------
// fake world
// ---------------------------------------------------------------------------

interface FakeBox {
  info: Info;
  fs: MemFs;
  execs: Map<string, FakeExec>;
}
interface FakeSnap {
  snap: Snap;
  aliases: Set<string>;
  fs: MemFs;
}

const world = {
  configs: [] as unknown[],
  createCalls: [] as CreateParams[],
  /** Page size cap, to exercise cursor pagination. */
  pageSize: 10,
  sandboxes: new Map<string, FakeBox>(),
  snapCreates: [] as SnapParams[],
  snapshots: new Map<string, FakeSnap>(),
  terminateCalls: [] as { id: string; snapshot?: TerminationSnapshot | null }[],
  reset(): void {
    this.configs = [];
    this.createCalls = [];
    this.sandboxes.clear();
    this.snapCreates = [];
    this.snapshots.clear();
    this.terminateCalls = [];
    this.addSnapshot({ aliases: ["base@v1"], fs: new MemFs(), memory: false });
  },
  addSnapshot(o: {
    aliases: string[];
    fs: MemFs;
    memory: boolean;
    tags?: Record<string, string>;
  }): FakeSnap {
    for (const s of this.snapshots.values()) {
      for (const a of o.aliases) {
        s.aliases.delete(a);
      }
    }
    const now = new Date().toISOString();
    const fs: FakeSnap = {
      aliases: new Set(o.aliases),
      fs: o.fs,
      snap: {
        byte_size: 1,
        created_at: now,
        id: crypto.randomUUID(),
        memory: o.memory,
        organization_id: null,
        project_id: "proj",
        retired_at: null,
        tags: o.tags ?? {},
        ttl: null,
        updated_at: now,
      },
    };
    this.snapshots.set(fs.snap.id, fs);
    return fs;
  },
  findSnapshot(ref: { id?: string; alias?: string }): FakeSnap {
    const s = ref.id
      ? this.snapshots.get(ref.id)
      : [...this.snapshots.values()].find((x) =>
          x.aliases.has(ref.alias ?? "")
        );
    if (!s) {
      throw notFound(`snapshot ${ref.id ?? ref.alias}`);
    }
    return s;
  },
  box(id: string): FakeBox {
    const b = this.sandboxes.get(id);
    if (!b) {
      throw notFound(`sandbox ${id}`);
    }
    return b;
  },
};

function page<T>(items: T[], limit: number | undefined, cursor?: string) {
  const size = Math.min(limit ?? 20, world.pageSize);
  const fetch = async (
    c?: string
  ): Promise<InstanceType<typeof actual.Page<T>>> => {
    const start = Number(c ?? 0);
    const slice = items.slice(start, start + size);
    const next = start + size < items.length ? String(start + size) : null;
    return new actual.Page(slice, next, fetch);
  };
  return fetch(cursor);
}

const tagsMatch = (
  have: Record<string, string>,
  want?: Record<string, string>
) => !want || Object.entries(want).every(([k, v]) => have[k] === v);

class FakeSandboxObj implements Pick<
  RealSandbox,
  "id" | "files" | "directories" | "execs"
> {
  private readonly box: FakeBox;
  constructor(box: FakeBox) {
    this.box = box;
  }
  get id(): string {
    return this.box.info.id;
  }
  get vmInfo(): Info {
    return this.box.info;
  }
  #live(): FakeBox {
    if (this.box.info.status !== "running") {
      throw new actual.HttpError("sandbox agent unreachable", 0);
    }
    return this.box;
  }
  get files(): RealSandbox["files"] {
    const box = () => this.#live();
    const stat = (path: string): FileInfo => {
      const s = box().fs.stat(path);
      if (!s) {
        throw notFound(path);
      }
      return {
        isDir: s.type === "dir",
        modTime: new Date().toISOString(),
        name: base(path),
        path: norm(path),
        size: s.size,
      };
    };
    return {
      copy: async (from, to) => {
        const d = box().fs.read(from);
        if (!d) {
          throw notFound(from);
        }
        box().fs.write(to, d);
      },
      create: async (path, content) => {
        const bytes =
          typeof content === "string"
            ? enc.encode(content)
            : new Uint8Array(await content.arrayBuffer());
        box().fs.write(path, bytes);
        return dec.decode(bytes);
      },
      delete: async (path) => {
        if (!box().fs.read(path)) {
          throw notFound(path);
        }
        box().fs.remove(path, false, false);
      },
      move: async (from, to) => {
        if (box().fs.rename(from, to)) {
          throw notFound(from);
        }
      },
      read: async (path) => {
        const d = box().fs.read(path);
        if (!d) {
          throw notFound(path);
        }
        return dec.decode(d);
      },
      stat: async (path) => stat(path),
      watch: async (path) => {
        const fs = box().fs;
        const events: WatchEvent[] = [
          { paths: [], timestamp: new Date().toISOString(), type: "connected" },
        ];
        let wake: (() => void) | undefined;
        const watcher = {
          dir: norm(path),
          push: (e: WatchEvent) => {
            events.push(e);
            wake?.();
          },
        };
        fs.watchers.push(watcher);
        const nextEvent = () =>
          new Promise<void>((r) => {
            wake = r;
          });
        async function* gen(): WatchGen {
          try {
            for (;;) {
              while (events.length > 0) {
                yield events.shift()!;
              }
              await nextEvent();
            }
          } finally {
            fs.watchers = fs.watchers.filter((w) => w !== watcher);
          }
        }
        return gen();
      },
    };
  }
  get directories(): RealSandbox["directories"] {
    const box = () => this.#live();
    return {
      create: async (path) => {
        box().fs.mkdir(path);
      },
      delete: async (path) => {
        if (!box().fs.isDir(path)) {
          throw notFound(path);
        }
        box().fs.remove(path, true, false);
      },
      list: async (path) => {
        const entries = box().fs.list(path);
        if (!entries) {
          throw notFound(path);
        }
        return entries.map((e) => ({
          isDir: e.type === "dir",
          modTime: new Date().toISOString(),
          name: e.name,
          path: `${norm(path) === "/" ? "" : norm(path)}/${e.name}`,
          size: box().fs.read(`${path}/${e.name}`)?.length ?? 0,
        }));
      },
    };
  }
  get execs(): RealSandbox["execs"] {
    const box = () => this.#live();
    const get = (id: string): FakeExec => {
      const e = box().execs.get(id);
      if (!e) {
        throw notFound(`exec ${id}`);
      }
      return e;
    };
    const create = async (body: ExecBody): Promise<ExecItem> => {
      const id = `exec-${crypto.randomUUID().slice(0, 8)}`;
      const e = new FakeExec(id, body, box().fs);
      box().execs.set(id, e);
      return e.item;
    };
    return {
      create,
      delete: async (id) => {
        get(id).kill();
        box().execs.delete(id);
      },
      exec: async () => {
        throw new Error("adapter must stream, not use execs.exec");
      },
      get: async (id) => get(id).item,
      getOutput: async (id) => ({
        exitCode: get(id).done ? get(id).item.exitCode : undefined,
        output: get(id)
          .log.map((l) => l.output)
          .join(""),
      }),
      list: async () => [...box().execs.values()].map((e) => e.item),
      sendStdin: async (id, body) => {
        const e = get(id);
        e.input(body);
        return e.item;
      },
      start: async (id) => get(id).item,
      streamList: async () => {
        throw new Error("not used");
      },
      streamOutput: async (id, lastSequence) => get(id).stream(lastSequence),
    };
  }
}

const asSandbox = (b: FakeBox): RealSandbox =>
  new FakeSandboxObj(b) as unknown as RealSandbox;

class FakeTogether {
  readonly sandboxes: Pick<
    Client["sandboxes"],
    "create" | "list" | "get" | "connect" | "terminate"
  >;
  readonly snapshots: Pick<
    Client["snapshots"],
    "create" | "getById" | "getByAlias" | "list" | "alias" | "retire"
  >;

  constructor(config: unknown) {
    world.configs.push(config);
    this.sandboxes = {
      connect: async (id) => {
        const b = world.box(id);
        if (b.info.status !== "running") {
          throw new Error(
            `Sandbox ${id} is ${b.info.status}, expected running`
          );
        }
        return asSandbox(b);
      },
      create: async (params = {}) => {
        world.createCalls.push(params);
        const snap = world.findSnapshot({
          alias: params.snapshotAlias,
          id: params.snapshotId,
        });
        if (snap.snap.retired_at) {
          throw new actual.HttpError("snapshot retired", 409);
        }
        const now = new Date().toISOString();
        const info: Omit<Info, "id"> = {
          agent: { token: "agent-token", url: "https://agent", version: "1" },
          cpu: params.cpu ?? 1,
          createdAt: now,
          memoryBytes: params.memoryBytes ?? 2 * 1024 ** 3,
          organizationId: null,
          projectId: "proj",
          recoveryAt: null,
          resizedAt: null,
          snapshotId: snap.snap.id,
          startedAt: now,
          status: "running",
          statusReason: snap.snap.memory ? "restored" : "cold_started",
          tags: { ...params.tags },
          terminatedAt: null,
          terminationPolicy: params.terminationPolicy ?? null,
          ttl: params.ttl ?? null,
          updatedAt: now,
        };
        const box: FakeBox = {
          execs: new Map(),
          fs: snap.fs.clone(),
          info: { ...info, id: crypto.randomUUID() } as Info,
        };
        world.sandboxes.set(box.info.id, box);
        return asSandbox(box);
      },
      get: async (id) => ({ ...world.box(id).info }),
      list: async (options) => {
        const items = [...world.sandboxes.values()]
          .map((b) => ({ ...b.info }))
          .filter(
            (i) =>
              (!options?.statuses || options.statuses.includes(i.status)) &&
              tagsMatch(i.tags, options?.tags)
          );
        return page(items, options?.limit, options?.cursor);
      },
      terminate: async (id, options = {}) => {
        world.terminateCalls.push({ id, ...options });
        const b = world.box(id);
        if (b.info.status === "terminated") {
          throw new actual.HttpError("already terminated", 409);
        }
        const snapshot =
          options.snapshot === undefined
            ? (b.info.terminationPolicy?.snapshot ?? null)
            : options.snapshot;
        for (const e of b.execs.values()) {
          e.kill();
        }
        if (snapshot) {
          world.addSnapshot({
            aliases: [`sandbox:${id}`, ...(snapshot.aliases ?? [])],
            fs: b.fs.clone(),
            memory: snapshot.memory ?? false,
            tags: snapshot.tags,
          });
        }
        b.info = {
          ...b.info,
          agent: { ...b.info.agent, token: null, url: null },
          status: "terminated",
        };
      },
    };
    this.snapshots = {
      alias: async (id, alias) => {
        const s = world.findSnapshot({ id });
        for (const o of world.snapshots.values()) {
          o.aliases.delete(alias);
        }
        s.aliases.add(alias);
      },
      create: async (params) => {
        world.snapCreates.push(params);
        const fs = new MemFs();
        params.onProgress?.({ output: "Preparing build", step: "prepare" });
        if ("context" in params) {
          const dockerfile = await readHostFile(
            params.dockerfile ?? join(params.context, "Dockerfile"),
            "utf-8"
          );
          for (const line of dockerfile.split("\n")) {
            params.onProgress?.({ output: line, step: "build" });
            const m = /^COPY\s+(\S+)\s+(\S+)/.exec(line);
            if (m) {
              const data = await readHostFile(join(params.context, m[1]!));
              fs.write(m[2]!, new Uint8Array(data));
            }
          }
        }
        params.onProgress?.({ output: "Registering", step: "register" });
        const s = world.addSnapshot({
          aliases: params.alias ? [params.alias] : [],
          fs,
          memory: false,
          tags: params.tags,
        });
        return { alias: params.alias, snapshotId: s.snap.id };
      },
      getByAlias: async (alias) => ({ ...world.findSnapshot({ alias }).snap }),
      getById: async (id) => ({ ...world.findSnapshot({ id }).snap }),
      list: async (options) => {
        const items = [...world.snapshots.values()]
          .map((s) => ({ ...s.snap }))
          .filter(
            (s) =>
              (!options?.excludeRetired || !s.retired_at) &&
              tagsMatch(s.tags, options?.tags)
          );
        return page(items, options?.limit, options?.cursor);
      },
      retire: async (id) => {
        const s = world.findSnapshot({ id });
        s.snap = { ...s.snap, retired_at: new Date().toISOString() };
        return { ...s.snap };
      },
    };
  }
}

const ctx = (over: Partial<CallContext> = {}): CallContext => ({
  attempt: 1,
  fetch: globalThis.fetch,
  ...over,
});

beforeEach(() => world.reset());

// ---------------------------------------------------------------------------
// conformance
// ---------------------------------------------------------------------------

describe("together conformance (offline, fake SDK)", () => {
  it("passes the full suite incl. pause/resume (new id) and templates", async () => {
    const report = await runConformance(together({ apiKey: "k" }), {
      expectedCaps: {
        pause: "native",
        snapshot: "unsupported",
        stop: "native",
      },
      live: true,
      spec: { template: "base@v1" },
      template: {
        source: {
          context: { "hello.txt": "from template" },
          dockerfile:
            "FROM debian:bookworm-slim\nCOPY hello.txt /app/hello.txt\n",
        },
      },
    });
    const failed = report.checks.filter((c) => !c.ok);
    expect(JSON.stringify(failed, null, 2)).toBe("[]");
    expect(report.checks.length).toBe(35);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// spec mapping
// ---------------------------------------------------------------------------

describe("create spec mapping", () => {
  it("maps template, resources, lifecycle, metadata, name and idempotency", async () => {
    const p = together({ apiKey: "k" });
    const h = await p.create(
      {
        env: { FOO: "bar baz" },
        lifecycle: { maxAgeMs: 90_500, onIdle: "pause" },
        metadata: { team: "a" },
        name: "box-1",
        resources: { memoryMB: 4096, vcpus: 2 },
        secrets: [{ name: "TOKEN", value: "s3cret" }],
        template: "base@v1",
      },
      ctx({ idempotencyKey: "idem-1" })
    );
    const call = world.createCalls[0]!;
    expect(call).toMatchObject({
      cpu: 2,
      memoryBytes: 4096 * 1024 * 1024,
      snapshotAlias: "base@v1",
      terminationPolicy: { snapshot: { memory: true } },
      ttl: 91,
    });
    expect(call.tags).toMatchObject({ "sbox-name": "box-1", team: "a" });
    expect(call.tags?.["sbox-idem"]).toMatch(/^[0-9a-f]{32}$/);
    expect(h.name).toBe("box-1");
    // the retry config never re-sends non-idempotent creates
    expect(world.configs[0]).toMatchObject({ apiKey: "k" });

    // env persisted in the VM and applied per exec, also after reconnect
    const box = world.box(h.id);
    expect(dec.decode(box.fs.read("/var/tmp/.sbox/env.json")!)).toContain(
      "bar baz"
    );
    const again = await p.connect(h.id, ctx());
    let out = "";
    for await (const ev of again.exec("echo $FOO $TOKEN", {}, ctx())) {
      if (ev.type === "stdout") {
        out += ev.data;
      }
    }
    expect(out.trim()).toBe("bar baz s3cret");

    const info = await h.getInfo(ctx());
    expect(info.metadata).toEqual({ "sbox-name": "box-1", team: "a" });
  });

  it("uses snapshotId for UUIDs and fromSnapshot over template", () => {
    const id = "3f1c8a9e-5b2d-4e7a-9c10-6d8f2b4a1e33";
    expect(toCreateParams({ fromSnapshot: id, template: "x@y" }, {})).toEqual({
      snapshotId: id,
    });
    expect(toCreateParams({}, {}, "dflt@v1")).toEqual({
      snapshotAlias: "dflt@v1",
    });
    expect(
      toCreateParams({ lifecycle: { onIdle: "stop" }, template: "a" }, {})
    ).toMatchObject({ terminationPolicy: { snapshot: { memory: false } } });
  });

  it("rejects what Together cannot do instead of dropping it", async () => {
    const p = together({ apiKey: "k" });
    const cases = [
      {},
      { ports: [8080], template: "base@v1" },
      { network: { mode: "block-all" as const }, template: "base@v1" },
      { secrets: [{ name: "VAULT_ONLY" }], template: "base@v1" },
      { metadata: { "bad key!": "x" }, template: "base@v1" },
      { region: "eu", template: "base@v1" },
    ];
    for (const spec of cases) {
      await expect(p.create(spec, ctx())).rejects.toMatchObject({
        code: "Validation",
      });
    }
    expect(world.createCalls).toHaveLength(0);
  });

  it("retried create with the same idempotency key reuses the sandbox", async () => {
    const p = together({ apiKey: "k" });
    const a = await p.create(
      { template: "base@v1" },
      ctx({ idempotencyKey: "k1" })
    );
    const b = await p.create(
      { template: "base@v1" },
      ctx({ attempt: 2, idempotencyKey: "k1" })
    );
    expect(b.id).toBe(a.id);
    expect(world.createCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// errors + state
// ---------------------------------------------------------------------------

describe("mapTogetherError", () => {
  it.each([
    [401, "Unauthorized"],
    [403, "Unauthorized"],
    [404, "NotFound"],
    [409, "Conflict"],
    [429, "QuotaExceeded"],
    [408, "Timeout"],
    [422, "Validation"],
    [500, "Provider"],
  ])("HTTP %i → %s", (status, code) => {
    expect(mapTogetherError(new actual.HttpError("x", status))?.code).toBe(
      code
    );
  });

  it("transport failures (status 0) are retryable", () => {
    const e = mapTogetherError(new actual.HttpError("ECONNREFUSED", 0));
    expect(e?.code).toBe("Provider");
    expect(e?.retryable).toBe(true);
    expect(
      mapTogetherError(new actual.HttpError("request timeout", 0))?.code
    ).toBe("Timeout");
  });

  it("maps lifecycle failures and leaves unknowns alone", () => {
    expect(
      mapTogetherError(new Error("failed_to_start: out_of_capacity"))?.code
    ).toBe("QuotaExceeded");
    expect(mapTogetherError(new Error("weird"))).toBeUndefined();
    expect(mapTogetherError("nope")).toBeUndefined();
  });
});

describe("state mapping", () => {
  it("maps every live status", () => {
    expect(mapTogetherStatus("starting")).toBe("creating");
    expect(mapTogetherStatus("running")).toBe("running");
    expect(mapTogetherStatus("terminating")).toBe("suspending");
    expect(mapTogetherStatus("recovering")).toBe("creating");
    expect(mapTogetherStatus("failed_to_start")).toBe("error");
    expect(mapTogetherStatus("unrecovered")).toBe("error");
    expect(mapTogetherStatus("terminated")).toBe("destroyed");
    expect(mapTogetherStatus("???")).toBe("unknown");
  });

  it("derives terminated → paused/stopped/destroyed from the produced snapshot", () => {
    const s = world.findSnapshot({ alias: "base@v1" }).snap;
    expect(terminatedState({ ...s, memory: true })).toBe("paused");
    expect(terminatedState({ ...s, memory: false })).toBe("stopped");
    expect(terminatedState({ ...s, retired_at: "2026-01-01" })).toBe(
      "destroyed"
    );
    expect(terminatedState(undefined)).toBe("destroyed");
  });

  it("pause/stop/resume/destroy through the handle", async () => {
    const p = together({ apiKey: "k" });
    const h = await p.create({ template: "base@v1" }, ctx());
    const oldId = h.id;
    await h.writeFile("/tmp/x", enc.encode("kept"), ctx());
    await h.pause!(ctx());
    expect(world.terminateCalls.at(-1)).toEqual({
      id: oldId,
      snapshot: { memory: true },
    });
    expect((await h.getInfo(ctx())).state).toBe("paused");
    await expect(h.readFile("/tmp/x", ctx())).rejects.toMatchObject({
      code: "Conflict",
    });

    await h.resume!(ctx());
    expect(h.id).not.toBe(oldId);
    expect(world.createCalls.at(-1)).toMatchObject({
      snapshotAlias: `sandbox:${oldId}`,
    });
    const info = await h.getInfo(ctx());
    expect(info).toMatchObject({ id: h.id, state: "running" });
    expect(dec.decode(await h.readFile("/tmp/x", ctx()))).toBe("kept");
    // the parent's snapshot is retired, so the old id now reads as destroyed
    expect((await (await p.connect(oldId, ctx())).getInfo(ctx())).state).toBe(
      "destroyed"
    );

    await h.stop!(ctx());
    expect((await h.getInfo(ctx())).state).toBe("stopped");
    await h.destroy(ctx());
    expect((await h.getInfo(ctx())).state).toBe("destroyed");
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("list", () => {
  it("paginates fully and honors metadata, state and limit", async () => {
    const p = together({ apiKey: "k" });
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) {
      const h = await p.create(
        { metadata: { grp: i % 2 ? "odd" : "even" }, template: "base@v1" },
        ctx()
      );
      ids.push(h.id);
    }
    await (
      await p.connect(ids[0]!, ctx())
    ).pause!(ctx());

    const all = [];
    for await (const i of p.list!(undefined, ctx())) {
      all.push(i);
    }
    expect(all).toHaveLength(23);

    const even = [];
    for await (const i of p.list!({ metadata: { grp: "even" } }, ctx())) {
      even.push(i);
    }
    expect(even).toHaveLength(12);

    const paused = [];
    for await (const i of p.list!({ state: "paused" }, ctx())) {
      paused.push(i.id);
    }
    expect(paused).toEqual([ids[0]]);

    const limited = [];
    for await (const i of p.list!({ limit: 3, state: "running" }, ctx())) {
      limited.push(i);
    }
    expect(limited).toHaveLength(3);
  });

  it("verify makes one cheap list call", async () => {
    await expect(together({ apiKey: "k" }).verify!(ctx())).resolves.toBe(
      undefined
    );
  });
});

// ---------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------

describe("templates", () => {
  const key = "a".repeat(64);

  it("builds a Dockerfile context remotely with alias, cacheKey and tags", async () => {
    const p = together({ apiKey: "k" });
    const events: string[] = [];
    const ref = await p.templates!.build(
      {
        cacheKey: key,
        env: { MODE: "x" },
        name: "Borat Desktop",
        source: {
          context: { "a.txt": "A" },
          dockerfile: "FROM debian\nCOPY a.txt /a.txt\n",
        },
        workdir: "/w",
      },
      {
        onEvent: (e) => events.push(e.type === "log" ? `${e.step}` : e.status),
      },
      ctx()
    );
    const call = world.snapCreates[0]!;
    expect(call).toMatchObject({
      alias: "borat-desktop@aaaaaaaaaaaa",
      cacheKey: "sbox/borat-desktop",
      tags: { "sbox-template": "1", "sbox-template-key": key },
    });
    expect(events).toContain("build");
    expect(ref).toMatchObject({
      cacheKey: key,
      name: "borat-desktop@aaaaaaaaaaaa",
    });
    expect(world.findSnapshot({ id: ref.id }).fs.read("/a.txt")).toBeTruthy();

    // lookup by cache key, alias and id; retired → absent
    expect((await p.templates!.lookup(key, ctx()))?.id).toBe(ref.id);
    expect(
      (await p.templates!.lookup("borat-desktop@aaaaaaaaaaaa", ctx()))?.id
    ).toBe(ref.id);
    expect((await p.templates!.lookup(ref.id, ctx()))?.id).toBe(ref.id);
    expect(await p.templates!.lookup("missing@x", ctx())).toBeUndefined();
    const listed = [];
    for await (const t of p.templates!.list!(ctx())) {
      listed.push(t.id);
    }
    expect(listed).toEqual([ref.id]);
    await p.templates!.delete!(ref.id, ctx());
    expect(await p.templates!.lookup(key, ctx())).toBeUndefined();
  });

  it("renders TemplateSpec env/workdir/user into the Dockerfile", () => {
    expect(
      renderDockerfile({
        env: { A: "1 2" },
        source: { image: "node:22" },
        user: "node",
        workdir: "/app",
      })
    ).toBe('FROM node:22\nENV A="1 2"\nWORKDIR /app\nUSER node\n');
  });

  it("image and snapshot sources", async () => {
    const p = together({ apiKey: "k" });
    const img = await p.templates!.build(
      { cacheKey: key, name: "n", source: { image: "node:22" } },
      { onEvent: () => {} },
      ctx()
    );
    expect(world.snapCreates.at(-1)).toMatchObject({
      alias: "n@aaaaaaaaaaaa",
      image: "node:22",
    });
    await expect(
      p.templates!.build(
        {
          cacheKey: key,
          name: "n",
          source: {
            image: "x",
            registryAuth: { password: "p", username: "u" },
          },
        },
        { onEvent: () => {} },
        ctx()
      )
    ).rejects.toMatchObject({ code: "Validation" });
    const fromSnap = await p.templates!.build(
      { cacheKey: "b".repeat(64), name: "s", source: { snapshot: img.id } },
      { onEvent: () => {} },
      ctx()
    );
    expect(fromSnap.id).toBe(img.id);
    expect(
      world.findSnapshot({ id: img.id }).aliases.has("s@bbbbbbbbbbbb")
    ).toBe(true);
  });
});

describe("contract", () => {
  it("declares no preview, snapshot, fork or egress support", () => {
    expect(TOGETHER_CAPS).toMatchObject({
      egressControl: "unsupported",
      exposePort: "unsupported",
      fork: "unsupported",
      snapshot: "unsupported",
    });
    expect(new SandboxError("NotFound", "x").code).toBe("NotFound");
  });
});
