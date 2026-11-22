/**
 * Offline tests for the Vercel adapter against a fake `@vercel/sandbox` 4.x.
 *
 * The fake mirrors the real surface the adapter uses (named sandboxes,
 * `Sandbox.create/get/getOrCreate/fork/list` paginators, detached
 * `runCommand` + `Command.logs/wait/kill/writeStdin`, `fs.*`, `update`,
 * `snapshot`, `delete`, `openInteractive`, `Snapshot`, `Drive`). Each fake VM
 * is an in-memory sandbox from `../memory`, whose exec runs on `MiniShell`, so
 * the full conformance suite runs for real. The interactive PTY is a fake
 * global `WebSocket` speaking the CLI's `start`/`resize`/`exit` protocol.
 */
import type * as V from "@vercel/sandbox";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { CallContext, ResolvedSandboxSpec } from "../adapter/index.js";
import { runConformance } from "../conformance/index.js";
import {
  VERCEL_CAPS,
  mapVercelError,
  mapVercelStatus,
  nameFromIdempotencyKey,
  toCreateParams,
  toNetworkPolicy,
  vercel,
} from "./index.js";

type CreateParams = NonNullable<Parameters<typeof V.Sandbox.create>[0]>;
type GetParams = Parameters<typeof V.Sandbox.get>[0];
type ListParams = NonNullable<Parameters<typeof V.Sandbox.list>[0]>;
type ForkParams = Parameters<typeof V.Sandbox.fork>[0];
type UpdateParams = Parameters<V.Sandbox["update"]>[0];
type DeleteOpts = Parameters<V.Sandbox["delete"]>[0];
type RunParams = Exclude<Parameters<V.Sandbox["runCommand"]>[0], string>;

interface FakeState {
  createCalls: CreateParams[];
  getCalls: GetParams[];
  listCalls: ListParams[];
  forkCalls: ForkParams[];
  updateCalls: UpdateParams[];
  deleteCalls: DeleteOpts[];
  runCalls: Record<string, unknown>[];
  kills: unknown[];
  /** Names of sandboxes currently stored. */
  names(): string[];
  /** Seed listed sandboxes for pagination tests. */
  seed(n: number, tags: Record<string, string>): void;
  reset(): void;
  wsUrls: string[];
}

const state = vi.hoisted(
  (): FakeState => ({
    createCalls: [],
    deleteCalls: [],
    forkCalls: [],
    getCalls: [],
    kills: [],
    listCalls: [],
    names: () => [],
    reset() {
      /* replaced by the mock factory */
    },
    runCalls: [],
    seed() {
      /* replaced by the mock factory */
    },
    updateCalls: [],
    wsUrls: [],
  })
);

vi.mock("@vercel/sandbox", async () => {
  const { memory } = await import("../memory/index.js");
  type MemHandle = import("../adapter/index.js").DriverHandle;
  type OutputEvent = import("../adapter/index.js").OutputEvent;

  const mem = memory({ idPrefix: "vm" });
  const ctx: CallContext = { attempt: 1, fetch: globalThis.fetch };

  class APIError<E> extends Error {
    response: Response;
    json?: E;
    constructor(response: Response, options?: { message?: string; json?: E }) {
      super(options?.message ?? `HTTP ${response.status}`);
      this.name = "APIError";
      this.response = response;
      this.json = options?.json;
    }
  }
  const apiErr = (status: number, message: string) =>
    new APIError(new Response(null, { status }), { message });
  const fsError = (code: string, path: string) =>
    Object.assign(new Error(`${code}: no such file or directory, '${path}'`), {
      code,
      path,
    });

  // ---- commands --------------------------------------------------------
  class FakeCommand {
    readonly cmdId: string;
    exitCode: number | null = null;
    readonly #events: { stream: "stdout" | "stderr"; data: string }[] = [];
    readonly #wakers: (() => void)[] = [];
    readonly #exec: ReturnType<MemHandle["exec"]>;
    readonly #stdinOpen: boolean;
    readonly #done: Promise<number>;
    #closed = false;
    constructor(
      id: string,
      exec: ReturnType<MemHandle["exec"]>,
      stdinOpen: boolean,
      timeoutMs?: number
    ) {
      this.cmdId = id;
      this.#exec = exec;
      this.#stdinOpen = stdinOpen;
      let timedOut = false;
      const timer = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            void exec.kill();
          }, timeoutMs)
        : undefined;
      this.#done = (async () => {
        let code = 0;
        for await (const ev of exec as AsyncIterable<OutputEvent>) {
          if (ev.type === "exit") {
            code = ev.exitCode;
          } else {
            this.#events.push({ data: ev.data, stream: ev.type });
            this.#wake();
          }
        }
        clearTimeout(timer);
        this.exitCode = timedOut ? 137 : code;
        this.#closed = true;
        this.#wake();
        return this.exitCode;
      })();
    }
    #wake() {
      for (const w of this.#wakers.splice(0)) {
        w();
      }
    }
    async *logs(): AsyncGenerator<{
      stream: "stdout" | "stderr";
      data: string;
    }> {
      let i = 0;
      for (;;) {
        while (i < this.#events.length) {
          yield this.#events[i++]!;
        }
        if (this.#closed) {
          return;
        }
        await new Promise<void>((r) => this.#wakers.push(r));
      }
    }
    async wait(): Promise<{ exitCode: number }> {
      return { exitCode: await this.#done };
    }
    async kill(signal?: Parameters<V.Command["kill"]>[0]): Promise<void> {
      state.kills.push(signal);
      await this.#exec.kill();
    }
    async writeStdin(data: string | Uint8Array): Promise<void> {
      if (!this.#stdinOpen) {
        throw new Error("stdin was not opened (pass stdin: true)");
      }
      const bytes =
        typeof data === "string" ? new TextEncoder().encode(data) : data;
      await this.#exec.writeStdin?.(bytes);
    }
  }

  // ---- sandboxes -------------------------------------------------------
  interface Rec {
    name: string;
    vm: MemHandle;
    status: "running" | "stopped";
    persistent: boolean;
    tags?: Record<string, string>;
    ports: number[];
    timeout: number;
    createdAt: number;
    commands: Map<string, FakeCommand>;
    snapshots: string[];
    networkPolicy?: unknown;
    deleted: boolean;
  }
  const store = new Map<string, Rec>();
  let seq = 0;
  let cmdSeq = 0;

  const route = (name: string, port: number) => ({
    port,
    subdomain: `sb-${name}-${port}`,
    url: `https://sb-${name}-${port}.vercel.run`,
  });

  class FakeSandbox {
    readonly #r: Rec;
    constructor(r: Rec) {
      this.#r = r;
    }
    #live(): Rec {
      if (this.#r.deleted) {
        throw apiErr(404, `sandbox ${this.#r.name} not found`);
      }
      // Persistent sandboxes resume on the next call that needs a session.
      if (this.#r.status === "stopped") {
        this.#r.status = "running";
      }
      return this.#r;
    }
    get name() {
      return this.#r.name;
    }
    get routes() {
      return this.#r.ports.map((p) => route(this.#r.name, p));
    }
    get status() {
      return this.#r.status;
    }
    get tags() {
      return this.#r.tags;
    }
    get persistent() {
      return this.#r.persistent;
    }
    get createdAt() {
      return new Date(this.#r.createdAt);
    }
    get cwd() {
      return "/vercel/sandbox";
    }
    get vcpus() {
      return 2;
    }
    get memory() {
      return 4096;
    }
    get totalActiveCpuDurationMs() {
      return 500;
    }
    get totalDurationMs() {
      return 1000;
    }
    get totalEgressBytes() {
      return 10;
    }
    get totalIngressBytes() {
      return 20;
    }
    domain(p: number): string {
      const r = this.routes.find((x) => x.port === p);
      if (!r) {
        throw new Error(`No route for port ${p}`);
      }
      return `https://${r.subdomain}.vercel.run`;
    }
    async runCommand(params: RunParams | string): Promise<FakeCommand> {
      if (typeof params === "string" || !params.detached) {
        throw new Error("adapter must use the detached object form");
      }
      if (params.stdin && !params.detached) {
        throw new Error("stdin requires detached");
      }
      state.runCalls.push({ ...params });
      const r = this.#live();
      const script =
        params.cmd === "sh" && params.args?.[0] === "-c"
          ? params.args[1]!
          : [params.cmd, ...(params.args ?? [])].join(" ");
      const exec = r.vm.exec(script, { cwd: params.cwd, env: params.env }, ctx);
      const id = `cmd_${++cmdSeq}`;
      const c = new FakeCommand(
        id,
        exec,
        params.stdin === true,
        params.timeoutMs
      );
      r.commands.set(id, c);
      return c;
    }
    async getCommand(cmdId: string): Promise<FakeCommand> {
      const c = this.#live().commands.get(cmdId);
      if (!c) {
        throw apiErr(404, `command ${cmdId} not found`);
      }
      return c;
    }
    asUser(_username: string): FakeSandbox {
      return this;
    }
    async readFileToBuffer(file: { path: string }): Promise<Buffer | null> {
      try {
        return Buffer.from(await this.#live().vm.readFile(file.path, ctx));
      } catch {
        return null;
      }
    }
    async writeFiles(
      files: { path: string; content: string | Uint8Array }[]
    ): Promise<void> {
      const r = this.#live();
      for (const f of files) {
        const bytes =
          typeof f.content === "string"
            ? new TextEncoder().encode(f.content)
            : f.content;
        await r.vm.writeFile(f.path, bytes, ctx);
      }
    }
    get fs() {
      const vm = () => this.#live().vm;
      const stat = async (path: string) => {
        try {
          return await vm().stat!(path, ctx);
        } catch {
          throw fsError("ENOENT", path);
        }
      };
      return {
        async mkdir(path: string, o?: { recursive?: boolean }) {
          await vm().mkdir!(path, o?.recursive ?? false, ctx);
          return undefined;
        },
        async readdir(path: string, o: { withFileTypes: true }) {
          if (!o.withFileTypes) {
            throw new Error("adapter must pass withFileTypes: true");
          }
          const entries = await vm().listDir!(path, ctx);
          return entries.map((e) => ({
            isDirectory: () => e.type === "dir",
            isSymbolicLink: () => e.type === "symlink",
            name: e.name,
          }));
        },
        async rename(from: string, to: string) {
          await vm().rename!(from, to, ctx);
        },
        async rm(path: string, o?: { recursive?: boolean; force?: boolean }) {
          await vm().remove!(path, o?.recursive ?? false, ctx);
        },
        async stat(path: string) {
          const s = await stat(path);
          return {
            isDirectory: () => s.type === "dir",
            mtime: new Date(0),
            size: s.size,
          };
        },
      };
    }
    async update(params: UpdateParams): Promise<void> {
      state.updateCalls.push(params);
      const r = this.#r;
      if (params.ports) {
        r.ports = [...params.ports];
      }
      if (params.timeout !== undefined) {
        r.timeout = params.timeout;
      }
      if (params.networkPolicy !== undefined) {
        r.networkPolicy = params.networkPolicy;
      }
      if (params.tags) {
        r.tags = params.tags;
      }
    }
    async stop(): Promise<object> {
      this.#r.status = "stopped";
      return {};
    }
    async snapshot(): Promise<{ snapshotId: string; createdAt: Date }> {
      const ref = await this.#live().vm.snapshot!({}, ctx);
      this.#r.snapshots.push(ref.id);
      this.#r.status = "stopped"; // snapshotting stops the session
      return { createdAt: new Date(), snapshotId: ref.id };
    }
    async listSnapshots() {
      return paginate(
        this.#r.snapshots.map((id) => ({
          createdAt: 0,
          id,
          region: "iad1",
          sizeBytes: 1,
          sourceSessionId: "s",
          status: "created" as const,
          updatedAt: 0,
        })),
        "snapshots",
        {}
      );
    }
    async delete(o?: DeleteOpts): Promise<void> {
      state.deleteCalls.push(o);
      this.#r.deleted = true;
      store.delete(this.#r.name);
      await this.#r.vm.destroy(ctx);
    }
    async openInteractive(): Promise<{ url: string; token: string }> {
      this.#live();
      return {
        token: `tok-${this.#r.name}`,
        url: `wss://pty.vercel.test/${this.#r.name}`,
      };
    }
  }

  const newRec = (
    vm: MemHandle,
    p: {
      name?: string;
      tags?: Record<string, string>;
      ports?: number[];
      persistent?: boolean;
      timeout?: number;
    }
  ): Rec => {
    const name = p.name ?? `sbx_${++seq}`;
    if (store.has(name)) {
      throw apiErr(409, `sandbox ${name} already exists`);
    }
    const r: Rec = {
      commands: new Map(),
      createdAt: Date.now(),
      deleted: false,
      name,
      persistent: p.persistent ?? true,
      ports: p.ports ?? [],
      snapshots: [],
      status: "running",
      tags: p.tags,
      timeout: p.timeout ?? 300_000,
      vm,
    };
    store.set(name, r);
    return r;
  };

  function paginate<T, K extends string>(
    items: T[],
    key: K,
    params: { limit?: number; cursor?: string },
    pageSize = 2
  ) {
    const size = params.limit ?? pageSize;
    const pageAt = (cursor: number) => {
      const slice = items.slice(cursor, cursor + size);
      const next = cursor + size < items.length ? String(cursor + size) : null;
      return {
        [key]: slice,
        pagination: { count: slice.length, next },
      } as Record<K, T[]> & {
        pagination: { count: number; next: string | null };
      };
    };
    const first = pageAt(Number(params.cursor ?? 0));
    return Object.assign(first, {
      async *[Symbol.asyncIterator]() {
        let page = first;
        for (;;) {
          yield* page[key];
          if (!page.pagination.next) {
            return;
          }
          page = pageAt(Number(page.pagination.next));
        }
      },
      async *pages() {
        yield first;
      },
      async toArray() {
        return [...items];
      },
    });
  }

  const Sandbox = {
    async create(params: CreateParams = {}) {
      state.createCalls.push(params);
      if (
        "image" in params &&
        "runtime" in params &&
        params.image &&
        params.runtime
      ) {
        throw new TypeError("`runtime` and `image` cannot be used together.");
      }
      const source = params.source;
      const vm = await mem.create(
        {
          env: params.env,
          ...(source?.type === "snapshot"
            ? { fromSnapshot: source.snapshotId }
            : {}),
        },
        ctx
      );
      return new FakeSandbox(newRec(vm, params));
    },
    async fork(params: ForkParams) {
      state.forkCalls.push(params);
      const src = store.get(params.sourceSandbox);
      if (!src) {
        throw apiErr(404, `sandbox ${params.sourceSandbox} not found`);
      }
      const [vm] = await src.vm.fork!(1, ctx);
      return new FakeSandbox(
        newRec(vm!, { name: params.name, ports: src.ports, tags: src.tags })
      );
    },
    async get(params: GetParams) {
      state.getCalls.push(params);
      const r = store.get(params.name);
      if (!r) {
        throw apiErr(404, `sandbox ${params.name} not found`);
      }
      if (params.resume) {
        r.status = "running";
      }
      return new FakeSandbox(r);
    },
    async getOrCreate(params: CreateParams & { resume?: boolean }) {
      if (params.name && store.has(params.name)) {
        return Sandbox.get({ name: params.name, resume: params.resume });
      }
      return Sandbox.create(params);
    },
    async list(params: ListParams = {}) {
      state.listCalls.push(params);
      const tags = params.tags as Record<string, string> | undefined;
      if (tags && Object.keys(tags).length > 1) {
        throw apiErr(400, "only a single tag filter is supported");
      }
      const rows = [...store.values()]
        .filter((r) =>
          Object.entries(tags ?? {}).every(([k, v]) => r.tags?.[k] === v)
        )
        .map((r) => ({
          createdAt: r.createdAt,
          currentSessionId: "s",
          name: r.name,
          persistent: r.persistent,
          status: r.status,
          tags: r.tags,
          updatedAt: r.createdAt,
        }));
      return paginate(rows, "sandboxes", params);
    },
  };

  const Snapshot = {
    async get(params: { snapshotId: string }) {
      return {
        async delete() {
          for (const r of store.values()) {
            r.snapshots = r.snapshots.filter((s) => s !== params.snapshotId);
          }
        },
        snapshotId: params.snapshotId,
      };
    },
  };

  // ---- drives ----------------------------------------------------------
  const drives = new Map<
    string,
    { name: string; region: string; maxSize: number }
  >();
  const driveView = (d: { name: string; region: string; maxSize: number }) => ({
    createdAt: new Date(0),
    driveId: `drv_${d.name}`,
    async delete() {
      drives.delete(d.name);
    },
    maxSize: d.maxSize,
    name: d.name,
    region: d.region,
  });
  const Drive = {
    async get(p: { name: string }) {
      const d = drives.get(p.name);
      if (!d) {
        throw apiErr(404, `drive ${p.name} not found`);
      }
      return driveView(d);
    },
    async getOrCreate(p: { name: string; region?: string; maxSize?: number }) {
      const d = drives.get(p.name) ?? {
        maxSize: p.maxSize ?? 1024 * 1_048_576,
        name: p.name,
        region: p.region ?? "iad1",
      };
      drives.set(p.name, d);
      return driveView(d);
    },
    async list() {
      return paginate([...drives.values()].map(driveView), "drives", {});
    },
  };

  state.names = () => [...store.keys()];
  state.seed = (n, tags) => {
    for (let i = 0; i < n; i++) {
      newRec({} as MemHandle, { name: `seed-${i}`, tags });
    }
  };
  state.reset = () => {
    store.clear();
    drives.clear();
    for (const k of [
      "createCalls",
      "getCalls",
      "listCalls",
      "forkCalls",
      "updateCalls",
      "deleteCalls",
      "runCalls",
      "kills",
      "wsUrls",
    ] as const) {
      state[k].length = 0;
    }
  };

  // ---- interactive PTY: a fake global WebSocket ------------------------
  class FakeWebSocket extends EventTarget {
    static readonly OPEN = 1;
    readyState = 0;
    binaryType = "blob";
    #pty?: Awaited<ReturnType<NonNullable<MemHandle["createPty"]>>>;
    constructor(url: string) {
      super();
      state.wsUrls.push(url);
      setTimeout(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      }, 0);
    }
    send(data: string | ArrayBufferView | ArrayBuffer) {
      if (typeof data === "string") {
        const msg = JSON.parse(data) as {
          type: string;
          cols?: number;
          rows?: number;
          cwd?: string;
        };
        if (msg.type === "start") {
          void this.#start(msg);
        } else if (msg.type === "resize") {
          void this.#pty?.resize(msg.cols ?? 80, msg.rows ?? 24);
        }
        return;
      }
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      void this.#pty?.write(bytes);
    }
    async #start(msg: { cols?: number; rows?: number }) {
      const [r] = [...store.values()];
      const vm = r!.vm;
      this.#pty = await vm.createPty!({ cols: msg.cols, rows: msg.rows }, ctx);
      const pty = this.#pty;
      void (async () => {
        for await (const chunk of pty.output) {
          const copy = new Uint8Array(chunk).buffer;
          this.dispatchEvent(new MessageEvent("message", { data: copy }));
        }
      })();
      void pty.wait().then((code) => {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({ code, type: "exit" }),
          })
        );
        this.close();
      });
    }
    close() {
      if (this.readyState === 3) {
        return;
      }
      this.readyState = 3;
      void this.#pty?.kill();
      this.dispatchEvent(new Event("close"));
    }
  }
  vi.stubGlobal("WebSocket", FakeWebSocket);

  return { APIError, Drive, Sandbox, Snapshot };
});

const ctx: CallContext = { attempt: 1, fetch: globalThis.fetch };
const creds = { projectId: "prj_1", teamId: "team_1", token: "tok_1" };

beforeEach(() => {
  state.reset();
});

describe("vercel adapter: conformance (offline, fake SDK)", () => {
  beforeAll(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("passes the full conformance suite", async () => {
    const report = await runConformance(vercel(creds), {
      expectedCaps: { codeInterpreter: "unsupported", pty: "native" },
      live: true,
    });
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(report.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "pty: interactive echo + exit code",
        "snapshots: create returns a ref",
        "fork: clone sees parent files",
        "lifecycle: pause/resume keeps files",
        "client: getOrCreate returns the same sandbox by name",
      ])
    );
    // nothing leaked: every sandbox the suite created was deleted
    expect(state.names()).toEqual([]);
  }, 60_000);
});

describe("vercel adapter: spec mapping", () => {
  const rich: ResolvedSandboxSpec = {
    env: { A: "1" },
    lifecycle: { maxAgeMs: 600_000, onIdle: "destroy" },
    metadata: { team: "infra", env: "ci" },
    name: "my-box",
    network: {
      domains: ["pypi.org"],
      mode: "allow-list",
      cidrs: ["10.0.0.0/8"],
    },
    ports: [3000],
    region: "fra1",
    resources: { memoryMB: 8192 },
    secrets: [{ name: "TOKEN", value: "s3cret" }],
    template: "my-repo:v1",
    volumes: [
      { id: "data", mountPath: "/data" },
      { id: "cache", mountPath: "/cache", readOnly: true },
    ],
  };

  it("maps a rich spec onto Sandbox.create params", async () => {
    await vercel(creds).create(rich, { ...ctx, idempotencyKey: "abc" });
    const p = state.createCalls[0]!;
    expect(p).toMatchObject({
      env: { A: "1", TOKEN: "s3cret" },
      image: "my-repo:v1",
      mounts: {
        "/cache": { drive: "cache", mode: "snapshot" },
        "/data": { drive: "data", mode: "read-write" },
      },
      name: "my-box",
      networkPolicy: {
        allow: ["pypi.org"],
        subnets: { allow: ["10.0.0.0/8"] },
      },
      persistent: false,
      ports: [3000],
      projectId: "prj_1",
      region: "fra1",
      resources: { vcpus: 4 },
      tags: { env: "ci", team: "infra" },
      teamId: "team_1",
      timeout: 600_000,
      token: "tok_1",
    });
    expect("runtime" in p).toBe(false);
  });

  it("boots from a snapshot via source, and rejects template + snapshot", () => {
    expect(toCreateParams({ fromSnapshot: "snap_1" })).toMatchObject({
      source: { snapshotId: "snap_1", type: "snapshot" },
    });
    expect(() =>
      toCreateParams({ fromSnapshot: "snap_1", template: "x" })
    ).toThrow(/mutually exclusive/);
  });

  it("maps legacy runtime names to managed images", () => {
    expect(toCreateParams({ template: "node22" })).toMatchObject({
      image: "vercel/sandbox/node:22",
    });
    expect(toCreateParams({ template: "python3.13" })).toMatchObject({
      runtime: "python3.13",
    });
  });

  it("rejects more than 5 tags and GPUs", () => {
    const metadata = Object.fromEntries(
      [1, 2, 3, 4, 5, 6].map((i) => [`k${i}`, "v"])
    );
    expect(() => toCreateParams({ metadata })).toThrow(/at most 5 tags/);
    expect(() => toCreateParams({ resources: { gpu: "H100" } })).toThrow(/GPU/);
  });

  it("derives a deterministic name from the idempotency key", async () => {
    await vercel(creds).create({}, { ...ctx, idempotencyKey: "K-1/2" });
    expect(state.createCalls[0]!.name).toBe(nameFromIdempotencyKey("K-1/2"));
    expect(nameFromIdempotencyKey("K-1/2")).toBe("sbox-k-1-2");
  });

  it("a retried create that hits Conflict returns the existing sandbox", async () => {
    const p = vercel(creds);
    const a = await p.create({}, { ...ctx, idempotencyKey: "same" });
    const b = await p.create(
      {},
      { ...ctx, attempt: 2, idempotencyKey: "same" }
    );
    expect(b.id).toBe(a.id);
    expect(state.names()).toHaveLength(1);
  });

  it("passes timeoutMs, cwd, env and sudo natively to runCommand", async () => {
    const h = await vercel(creds).create({}, ctx);
    const ex = h.exec(
      "echo hi",
      { cwd: "/tmp", env: { X: "1" }, timeoutMs: 5000, user: "root" },
      ctx
    );
    for await (const _ of ex) {
      /* drain */
    }
    expect(state.runCalls[0]).toMatchObject({
      args: ["-c", "echo hi"],
      cmd: "sh",
      cwd: "/tmp",
      detached: true,
      env: { X: "1" },
      sudo: true,
      timeoutMs: 5000,
    });
    expect(state.runCalls[0]!.stdin).toBeUndefined();
  });

  it("destroy deletes the sandbox and its orphan snapshots", async () => {
    const h = await vercel(creds).create({}, ctx);
    await h.destroy(ctx);
    expect(state.deleteCalls[0]).toMatchObject({ deleteOrphanSnapshots: true });
    expect(state.names()).toEqual([]);
  });
});

describe("vercel adapter: egress policy", () => {
  it("maps modes, deny and inject", () => {
    expect(toNetworkPolicy({ mode: "allow-all" })).toBe("allow-all");
    expect(toNetworkPolicy({ mode: "block-all" })).toBe("deny-all");
    expect(
      toNetworkPolicy({
        deny: { cidrs: ["1.2.3.4/32"], domains: ["evil.com"] },
        inject: [
          {
            domains: ["api.github.com"],
            headers: { Authorization: { name: "gh", value: "Bearer x" } },
          },
        ],
        mode: "allow-all",
      })
    ).toEqual({
      allow: {
        "*": [],
        "api.github.com": [
          { transform: [{ headers: { Authorization: "Bearer x" } }] },
        ],
        "evil.com": [
          {
            response: {
              body: "blocked by sbox egress policy",
              contentType: "text/plain",
              statusCode: 403,
            },
          },
        ],
      },
      subnets: { deny: ["1.2.3.4/32"] },
    });
  });

  it("resolves inject secrets from spec.secrets and rejects valueless refs", () => {
    const policy = {
      inject: [{ domains: ["x.com"], headers: { K: { name: "KEY" } } }],
      mode: "allow-list" as const,
    };
    expect(
      toNetworkPolicy(policy, [{ mode: "egress", name: "KEY", value: "v" }])
    ).toEqual({
      allow: { "x.com": [{ transform: [{ headers: { K: "v" } }] }] },
    });
    expect(() => toNetworkPolicy(policy)).toThrow(/needs a value/);
  });
});

describe("vercel adapter: list + verify", () => {
  it("paginates fully and honors metadata, state and limit", async () => {
    state.seed(5, { a: "1", b: "2" });
    const p = vercel(creds);
    const all: string[] = [];
    for await (const info of p.list!({ metadata: { a: "1", b: "2" } }, ctx)) {
      all.push(info.id);
    }
    expect(all).toEqual(["seed-0", "seed-1", "seed-2", "seed-3", "seed-4"]);
    // only one tag goes to the API (its limit), the rest is filtered locally
    expect(state.listCalls[0]!.tags).toEqual({ a: "1" });
    const limited: string[] = [];
    for await (const info of p.list!({ limit: 3, state: "running" }, ctx)) {
      limited.push(info.id);
    }
    expect(limited).toHaveLength(3);
    const none: string[] = [];
    for await (const info of p.list!({ state: "stopped" }, ctx)) {
      none.push(info.id);
    }
    expect(none).toEqual([]);
  });

  it("verify lists with limit 1 and never creates", async () => {
    const res = await vercel(creds).verify!(ctx);
    expect(res).toEqual({ account: "team_1" });
    expect(state.listCalls[0]).toMatchObject({ limit: 1 });
    expect(state.createCalls).toHaveLength(0);
  });
});

describe("vercel adapter: volumes (Drives)", () => {
  it("creates, gets, lists and deletes drives by name", async () => {
    const v = vercel(creds).volumes!;
    const d = await v.create(
      { name: "data", region: "sfo1", sizeMB: 2048 },
      ctx
    );
    expect(d).toMatchObject({ id: "data", region: "sfo1", sizeMB: 2048 });
    expect((await v.get("data", ctx))?.id).toBe("data");
    expect(await v.get("nope", ctx)).toBeUndefined();
    const listed: string[] = [];
    for await (const x of v.list(ctx)) {
      listed.push(x.id);
    }
    expect(listed).toEqual(["data"]);
    await v.delete("data", ctx);
    expect(await v.get("data", ctx)).toBeUndefined();
  });
});

describe("vercel adapter: status + errors", () => {
  it("maps every session status", () => {
    expect(mapVercelStatus("pending")).toBe("creating");
    expect(mapVercelStatus("running")).toBe("running");
    expect(mapVercelStatus("stopping")).toBe("suspending");
    expect(mapVercelStatus("snapshotting")).toBe("suspending");
    expect(mapVercelStatus("stopped")).toBe("stopped");
    expect(mapVercelStatus("failed")).toBe("error");
    expect(mapVercelStatus("aborted")).toBe("error");
    expect(mapVercelStatus(undefined)).toBe("unknown");
  });

  it("maps HTTP statuses, fs errors and credential errors", async () => {
    const { APIError } = await import("@vercel/sandbox");
    const http = (status: number) =>
      mapVercelError(new APIError(new Response(null, { status })))?.code;
    expect(http(401)).toBe("Unauthorized");
    expect(http(403)).toBe("Unauthorized");
    expect(http(404)).toBe("NotFound");
    expect(http(409)).toBe("Conflict");
    expect(http(429)).toBe("QuotaExceeded");
    expect(
      mapVercelError(new APIError(new Response(null, { status: 429 })))
        ?.retryable
    ).toBe(true);
    expect(http(500)).toBe("Provider");
    expect(
      mapVercelError(Object.assign(new Error("ENOENT: x"), { code: "ENOENT" }))
        ?.code
    ).toBe("NotFound");
    expect(
      mapVercelError(
        new Error("Missing credentials parameters to access the Vercel API")
      )?.code
    ).toBe("Unauthorized");
    expect(mapVercelError(new Error("request timed out"))?.code).toBe(
      "Timeout"
    );
  });

  it("declares the caps table", () => {
    const p = vercel(creds);
    expect(p.capabilities).toBe(VERCEL_CAPS);
    expect(p.flags.previewModel).toBe("declaredPorts");
    expect(p.templates).toBeUndefined();
  });
});
