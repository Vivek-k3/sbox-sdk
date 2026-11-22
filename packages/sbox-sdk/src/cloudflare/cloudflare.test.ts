/**
 * Offline tests for the (deprecated) Cloudflare 0.12 adapter against a fake
 * `@cloudflare/sandbox`. The fake mirrors the 0.12.14 surface the adapter uses
 * — `getSandbox()` stubs with `startProcess` + SSE `streamProcessLogs`,
 * base64 `readFile`/`writeFile`, `listFiles`, `tunnels`, `createSession()` +
 * `terminal()` (a Workers-style WebSocket upgrade), `createBackup` /
 * `restoreBackup`, the Container `getState` / `setAllowedHosts` /
 * `setDeniedHosts` / `stop` RPCs — over an in-memory sandbox from `../memory`
 * whose exec runs on `MiniShell`, so the conformance suite runs for real.
 */
import type * as CF from "@cloudflare/sandbox";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { CallContext } from "../adapter/index.js";
import { runConformance } from "../conformance/index.js";
import {
  CLOUDFLARE_CAPS,
  applyEgress,
  cloudflare,
  decodeBackupRef,
  encodeBackupRef,
  mapCloudflareError,
  mapCloudflareState,
} from "./index.js";

type StartProcessOpts = NonNullable<Parameters<CF.Sandbox["startProcess"]>[1]>;
type SandboxOptions = CF.SandboxOptions;

interface FakeState {
  getSandboxCalls: { id: string; options?: SandboxOptions }[];
  startCalls: { cmd: string; options?: StartProcessOpts }[];
  allowed: string[][];
  denied: string[][];
  envs: Record<string, string | undefined>[];
  backups: CF.DirectoryBackup[];
  restores: CF.DirectoryBackup[];
  stops: string[];
  destroyed: string[];
  sleepAfter: (string | number)[];
  ptyOptions: (CF.PtyOptions | undefined)[];
  /** Live DO ids. */
  ids(): string[];
  reset(): void;
}

const state = vi.hoisted(
  (): FakeState => ({
    allowed: [],
    backups: [],
    denied: [],
    destroyed: [],
    envs: [],
    getSandboxCalls: [],
    ids: () => [],
    ptyOptions: [],
    reset() {
      /* replaced by the mock factory */
    },
    restores: [],
    sleepAfter: [],
    startCalls: [],
    stops: [],
  })
);

vi.mock("@cloudflare/sandbox", async () => {
  const { memory } = await import("../memory/index.js");
  type MemHandle = import("../adapter/index.js").DriverHandle;
  type OutputEvent = import("../adapter/index.js").OutputEvent;
  const mem = memory({ idPrefix: "ct" });
  const ctx: CallContext = { attempt: 1, fetch: globalThis.fetch };
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  /** Same shape as the SDK's container errors (`code` + `httpStatus`). */
  class SandboxError extends Error {
    readonly code: string;
    readonly httpStatus: number;
    constructor(code: string, message: string, httpStatus: number) {
      super(message);
      this.name = "SandboxError";
      this.code = code;
      this.httpStatus = httpStatus;
    }
  }

  const sse = (ev: unknown) => enc.encode(`data: ${JSON.stringify(ev)}\n\n`);

  async function* parseSSEStream<T>(
    stream: ReadableStream<Uint8Array>,
    signal?: AbortSignal
  ): AsyncIterable<T> {
    const reader = stream.getReader();
    let buf = "";
    try {
      for (;;) {
        if (signal?.aborted) {
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        buf += dec.decode(value, { stream: true });
        let i = buf.indexOf("\n\n");
        while (i !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data: ")) {
              yield JSON.parse(line.slice(6)) as T;
            }
          }
          i = buf.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  interface Proc {
    id: string;
    command: string;
    exec: ReturnType<MemHandle["exec"]>;
    events: CF.LogEvent[];
    done: boolean;
    exitCode?: number;
    wakers: (() => void)[];
  }

  interface DO {
    id: string;
    vm: MemHandle;
    status: "running" | "stopped";
    env: Record<string, string>;
    procs: Map<string, Proc>;
    tunnels: Map<number, CF.TunnelInfo>;
    sessions: Map<
      string,
      { cwd?: string; env?: Record<string, string | undefined> }
    >;
    watchers: { path: string; push: (ev: CF.FileWatchSSEEvent) => void }[];
  }
  const objects = new Map<string, DO>();
  let procSeq = 0;
  let sessSeq = 0;

  const notFound = (path: string) =>
    new SandboxError("FILE_NOT_FOUND", `File not found: ${path}`, 404);

  const boot = async (o: DO) => {
    if (o.status === "stopped") {
      // A restarted container starts from a fresh disk.
      o.vm = await mem.create({}, ctx);
      o.status = "running";
      o.procs.clear();
    }
    return o.vm;
  };

  /** Fake Workers WebSocket for the terminal upgrade. */
  class WorkersWebSocket extends EventTarget {
    accepted = false;
    #pty: Awaited<ReturnType<NonNullable<MemHandle["createPty"]>>>;
    #closed = false;
    constructor(pty: Awaited<ReturnType<NonNullable<MemHandle["createPty"]>>>) {
      super();
      this.#pty = pty;
    }
    accept() {
      this.accepted = true;
      setTimeout(() => {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({ type: "ready" }),
          })
        );
        void (async () => {
          for await (const chunk of this.#pty.output) {
            this.dispatchEvent(
              new MessageEvent("message", {
                data: new Uint8Array(chunk).buffer,
              })
            );
          }
        })();
        void this.#pty.wait().then((code) => {
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ code, type: "exit" }),
            })
          );
          this.close();
        });
      }, 0);
    }
    send(data: string | ArrayBuffer | ArrayBufferView) {
      if (!this.accepted) {
        throw new Error("send() before accept()");
      }
      if (typeof data === "string") {
        const msg = JSON.parse(data) as {
          type: string;
          cols: number;
          rows: number;
        };
        if (msg.type === "resize") {
          void this.#pty.resize(msg.cols, msg.rows);
        }
        return;
      }
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      void this.#pty.write(bytes);
    }
    close() {
      if (!this.#closed) {
        this.#closed = true;
        void this.#pty.kill();
        this.dispatchEvent(new Event("close"));
      }
    }
  }

  const makeStub = (o: DO) => {
    const startProcess = async (
      command: string,
      options?: StartProcessOpts,
      sessionEnv?: Record<string, string | undefined>
    ) => {
      state.startCalls.push({ cmd: command, options });
      const vm = await boot(o);
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries({
        ...o.env,
        ...sessionEnv,
        ...options?.env,
      })) {
        if (v !== undefined) {
          env[k] = v;
        }
      }
      const exec = vm.exec(command, { cwd: options?.cwd, env }, ctx);
      const id = `proc_${++procSeq}`;
      const p: Proc = {
        command,
        done: false,
        events: [],
        exec,
        id,
        wakers: [],
      };
      o.procs.set(id, p);
      let timedOut = false;
      const timer = options?.timeout
        ? setTimeout(() => {
            timedOut = true;
            void exec.kill();
          }, options.timeout)
        : undefined;
      const wake = () => {
        for (const w of p.wakers.splice(0)) {
          w();
        }
      };
      void (async () => {
        for await (const ev of exec as AsyncIterable<OutputEvent>) {
          const timestamp = new Date().toISOString();
          if (ev.type === "exit") {
            clearTimeout(timer);
            p.exitCode = timedOut ? 124 : ev.exitCode;
            p.events.push({
              data: "",
              exitCode: p.exitCode,
              processId: id,
              timestamp,
              type: "exit",
            });
          } else {
            p.events.push({
              data: ev.data,
              processId: id,
              timestamp,
              type: ev.type,
            });
          }
          wake();
        }
        p.done = true;
        wake();
      })();
      return {
        command,
        id,
        status: "running" as const,
      };
    };

    const procView = (p: Proc) => ({
      command: p.command,
      id: p.id,
      status: p.done ? ("completed" as const) : ("running" as const),
    });

    const stub = {
      async containerFetch(url: string, init: RequestInit, port?: number) {
        return new Response(
          `fetched ${url} on ${port} via ${init.method ?? "GET"}`
        );
      },
      async createBackup(options: CF.BackupOptions) {
        const vm = await boot(o);
        const snap = await vm.snapshot!({}, ctx);
        const b: CF.DirectoryBackup = {
          dir: options.dir,
          id: snap.id,
          ...(options.localBucket ? { localBucket: true } : {}),
        };
        state.backups.push(b);
        return b;
      },
      async createCodeContext(options?: CF.CreateContextOptions) {
        return {
          createdAt: new Date(),
          cwd: options?.cwd ?? "/workspace",
          id: `ctx_${++sessSeq}`,
          language: options?.language ?? "python",
          lastUsed: new Date(),
        };
      },
      async createSession(options?: CF.SessionOptions) {
        await boot(o);
        const id = options?.id ?? `session_${++sessSeq}`;
        o.sessions.set(id, { cwd: options?.cwd, env: options?.env });
        return sessionView(id);
      },
      async deleteSession(sessionId: string) {
        o.sessions.delete(sessionId);
        return { sessionId, success: true, timestamp: "" };
      },
      async destroy() {
        state.destroyed.push(o.id);
        objects.delete(o.id);
        await o.vm.destroy(ctx);
      },
      async exec(command: string) {
        const vm = await boot(o);
        let stdout = "";
        let stderr = "";
        let exitCode = 0;
        for await (const ev of vm.exec(
          command,
          {},
          ctx
        ) as AsyncIterable<OutputEvent>) {
          if (ev.type === "stdout") {
            stdout += ev.data;
          } else if (ev.type === "stderr") {
            stderr += ev.data;
          } else {
            exitCode = ev.exitCode;
          }
        }
        return {
          command,
          duration: 0,
          exitCode,
          stderr,
          stdout,
          success: exitCode === 0,
          timestamp: "",
        };
      },
      async getProcess(id: string) {
        const p = o.procs.get(id);
        return p ? procView(p) : null;
      },
      async getSession(sessionId: string) {
        if (!o.sessions.has(sessionId)) {
          throw new SandboxError("SESSION_DESTROYED", "no session", 404);
        }
        return sessionView(sessionId);
      },
      async getState() {
        return { lastChange: Date.now(), status: o.status };
      },
      async killProcess(id: string, _signal?: string) {
        const p = o.procs.get(id);
        if (!p) {
          throw new SandboxError(
            "PROCESS_NOT_FOUND",
            `Process not found: ${id}`,
            404
          );
        }
        await p.exec.kill();
      },
      async listFiles(path: string, options?: CF.ListFilesOptions) {
        if (!options?.includeHidden) {
          throw new Error("adapter should list hidden files too");
        }
        const vm = await boot(o);
        let entries;
        try {
          entries = await vm.listDir!(path, ctx);
        } catch {
          throw notFound(path);
        }
        const files = await Promise.all(
          entries.map(async (e) => {
            const s = await vm.stat!(e.path, ctx);
            return {
              absolutePath: e.path,
              mode: "rw-r--r--",
              modifiedAt: new Date(0).toISOString(),
              name: e.name,
              permissions: {
                executable: false,
                readable: true,
                writable: true,
              },
              relativePath: e.name,
              size: s.size,
              type:
                e.type === "dir" ? ("directory" as const) : ("file" as const),
            };
          })
        );
        return {
          count: files.length,
          files,
          path,
          success: true,
          timestamp: "",
        };
      },
      async listProcesses() {
        return [...o.procs.values()].map(procView);
      },
      async mkdir(path: string, options?: { recursive?: boolean }) {
        const vm = await boot(o);
        await vm.mkdir!(path, options?.recursive ?? false, ctx);
        return {
          path,
          recursive: !!options?.recursive,
          success: true,
          timestamp: "",
        };
      },
      async readFile(path: string, options?: { encoding?: string }) {
        if (options?.encoding !== "base64") {
          throw new Error("adapter should read with encoding: base64");
        }
        const vm = await boot(o);
        let bytes: Uint8Array;
        try {
          bytes = await vm.readFile(path, ctx);
        } catch {
          throw notFound(path);
        }
        return {
          content: Buffer.from(bytes).toString("base64"),
          encoding: "base64" as const,
          path,
          success: true,
          timestamp: "",
        };
      },
      async renameFile(oldPath: string, newPath: string) {
        const vm = await boot(o);
        await vm.rename!(oldPath, newPath, ctx);
        return { newPath, path: oldPath, success: true, timestamp: "" };
      },
      async restoreBackup(backup: CF.DirectoryBackup) {
        state.restores.push(backup);
        const vm = await boot(o);
        try {
          await vm.restoreSnapshot!(backup.id, ctx);
        } catch {
          /* backups taken in another DO: the real SDK restores by id from R2 */
        }
        return { dir: backup.dir, id: backup.id, success: true };
      },
      async setAllowedHosts(hosts: string[]) {
        state.allowed.push(hosts);
      },
      async setDeniedHosts(hosts: string[]) {
        state.denied.push(hosts);
      },
      async setEnvVars(envVars: Record<string, string | undefined>) {
        state.envs.push(envVars);
        for (const [k, v] of Object.entries(envVars)) {
          if (v !== undefined) {
            o.env[k] = v;
          }
        }
      },
      async setSleepAfter(sleepAfter: string | number) {
        state.sleepAfter.push(sleepAfter);
      },
      startProcess: (command: string, options?: StartProcessOpts) =>
        startProcess(command, options),
      async stop() {
        state.stops.push(o.id);
        o.status = "stopped";
      },
      async streamProcessLogs(processId: string) {
        const p = o.procs.get(processId);
        if (!p) {
          throw new SandboxError(
            "PROCESS_NOT_FOUND",
            `Process not found: ${processId}`,
            404
          );
        }
        return new ReadableStream<Uint8Array>({
          async start(c) {
            let i = 0;
            for (;;) {
              while (i < p.events.length) {
                c.enqueue(sse(p.events[i++]));
              }
              if (p.done) {
                c.close();
                return;
              }
              await new Promise<void>((r) => p.wakers.push(r));
            }
          },
        });
      },
      tunnels: {
        async destroy(portOrInfo: number | CF.TunnelInfo) {
          o.tunnels.delete(
            typeof portOrInfo === "number" ? portOrInfo : portOrInfo.port
          );
        },
        async get(port: number, options?: CF.TunnelOptions) {
          const existing = o.tunnels.get(port);
          if (existing) {
            return existing;
          }
          const t: CF.TunnelInfo = options?.name
            ? {
                createdAt: "",
                hostname: `${options.name}.example.com`,
                id: "uuid",
                name: options.name,
                port,
                url: `https://${options.name}.example.com`,
              }
            : {
                createdAt: "",
                hostname: `q${port}.trycloudflare.com`,
                id: `quick-${port}`,
                port,
                url: `https://q${port}.trycloudflare.com`,
              };
          o.tunnels.set(port, t);
          return t;
        },
        async list() {
          return [...o.tunnels.values()];
        },
      },
      async watch(path: string, _options?: CF.WatchOptions) {
        let push!: (ev: CF.FileWatchSSEEvent) => void;
        const stream = new ReadableStream<Uint8Array>({
          cancel() {
            o.watchers = o.watchers.filter((w) => w.push !== push);
          },
          start(c) {
            push = (ev) => c.enqueue(sse(ev));
            push({ path, type: "watching", watchId: "w1" });
          },
        });
        o.watchers.push({ path, push });
        return stream;
      },
      async writeFile(
        path: string,
        content: string,
        options?: { encoding?: string }
      ) {
        if (options?.encoding !== "base64") {
          throw new Error("adapter should write with encoding: base64");
        }
        const vm = await boot(o);
        await vm.writeFile(
          path,
          new Uint8Array(Buffer.from(content, "base64")),
          ctx
        );
        for (const w of o.watchers) {
          if (path.startsWith(w.path)) {
            w.push({
              eventType: "modify",
              isDirectory: false,
              path,
              timestamp: "",
              type: "event",
            });
          }
        }
        return { path, success: true, timestamp: "" };
      },
    };

    const sessionView = (id: string) => ({
      id,
      async terminal(request: Request, options?: CF.PtyOptions) {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          throw new Error("terminal() requires a WebSocket upgrade request");
        }
        state.ptyOptions.push(options);
        const sess = o.sessions.get(id);
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(sess?.env ?? {})) {
          if (v !== undefined) {
            env[k] = v;
          }
        }
        const pty = await o.vm.createPty!(
          { cols: options?.cols, cwd: sess?.cwd, env, rows: options?.rows },
          ctx
        );
        return Object.assign(new Response(null), {
          webSocket: new WorkersWebSocket(pty),
        });
      },
    });

    return stub;
  };

  function getSandbox(_ns: unknown, id: string, options?: SandboxOptions) {
    state.getSandboxCalls.push({ id, options });
    let o = objects.get(id);
    if (!o) {
      o = {
        env: {},
        id,
        procs: new Map(),
        sessions: new Map(),
        status: "stopped",
        tunnels: new Map(),
        vm: undefined as unknown as MemHandle,
        watchers: [],
      };
      objects.set(id, o);
    }
    return makeStub(o);
  }

  state.ids = () => [...objects.keys()];
  state.reset = () => {
    objects.clear();
    for (const k of [
      "getSandboxCalls",
      "startCalls",
      "allowed",
      "denied",
      "envs",
      "backups",
      "restores",
      "stops",
      "destroyed",
      "sleepAfter",
      "ptyOptions",
    ] as const) {
      state[k].length = 0;
    }
  };

  return { SandboxError, getSandbox, parseSSEStream };
});

const ctx: CallContext = { attempt: 1, fetch: globalThis.fetch };
const binding = { idFromName: (name: string) => ({ name }) };
const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

beforeEach(() => {
  state.reset();
});

describe("cloudflare adapter: conformance (offline, fake SDK)", () => {
  beforeAll(() => {
    warn.mockClear();
  });
  afterAll(() => {
    warn.mockClear();
  });

  it("passes the full conformance suite", async () => {
    const report = await runConformance(cloudflare({ binding }), {
      expectedCaps: { list: "unsupported", pty: "native", snapshot: "native" },
      live: true,
    });
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(report.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "verify: key check succeeds without creating",
        "pty: interactive echo + exit code",
        "network: set egress policy",
        "snapshots: create returns a ref",
        "exec: kill process by id",
      ])
    );
    expect(state.ids()).toEqual([]);
  }, 60_000);
});

describe("cloudflare adapter: deprecation", () => {
  it("warns once, on the first factory call", async () => {
    vi.resetModules();
    const fresh = await import("./index.js");
    warn.mockClear();
    fresh.cloudflare({ binding });
    fresh.cloudflare({ binding });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/0\.12.*2026-12-31/);
  });
});

describe("cloudflare adapter: spec mapping", () => {
  it("applies metadata, lifecycle, env, secrets and network at create", async () => {
    const h = await cloudflare({
      binding,
      sandboxOptions: { transport: "rpc" },
    }).create(
      {
        env: { A: "1" },
        lifecycle: { idleTimeoutMs: 90_000 },
        metadata: { team: "infra" },
        name: "box-1",
        network: { domains: ["pypi.org"], mode: "allow-list" },
        secrets: [{ name: "TOKEN", value: "s" }],
      },
      ctx
    );
    expect(h.id).toBe("box-1");
    expect(state.getSandboxCalls[0]).toEqual({
      id: "box-1",
      options: {
        labels: { team: "infra" },
        sleepAfter: "90s",
        transport: "rpc",
      },
    });
    expect(state.envs).toEqual([{ A: "1", TOKEN: "s" }]);
    expect(state.allowed).toEqual([["pypi.org"]]);
    expect(state.denied).toEqual([[]]);
    expect((await h.getInfo(ctx)).state).toBe("running");
  });

  it("uses the idempotency key as the Durable Object name", async () => {
    const h = await cloudflare({ binding }).create(
      {},
      { ...ctx, idempotencyKey: "idem-1" }
    );
    expect(h.id).toBe("idem-1");
  });

  it("restores fromSnapshot after boot", async () => {
    await cloudflare({ binding }).create(
      { fromSnapshot: "bk1:/workspace/app" },
      ctx
    );
    expect(state.restores).toEqual([{ dir: "/workspace/app", id: "bk1" }]);
  });

  it("rejects what 0.12 cannot do", async () => {
    const p = cloudflare({ binding });
    await expect(p.create({ template: "x" }, ctx)).rejects.toThrow(/template/);
    await expect(p.create({ region: "weur" }, ctx)).rejects.toThrow(/region/);
    await expect(
      p.create({ volumes: [{ id: "b", mountPath: "/data" }] }, ctx)
    ).rejects.toThrow(/volumes/);
    await expect(
      p.create({ secrets: [{ mode: "egress", name: "K", value: "v" }] }, ctx)
    ).rejects.toMatchObject({ code: "NotSupported" });
  });

  it("passes cwd, env and timeoutMs to startProcess", async () => {
    const h = await cloudflare({ binding }).create({}, ctx);
    for await (const _ of h.exec(
      "echo hi",
      { cwd: "/tmp", env: { X: "1" }, timeoutMs: 5000 },
      ctx
    )) {
      /* drain */
    }
    expect(state.startCalls.at(-1)).toEqual({
      cmd: "echo hi",
      options: { cwd: "/tmp", env: { X: "1" }, timeout: 5000 },
    });
  });
});

describe("cloudflare adapter: lifecycle, previews, snapshots, watch", () => {
  it("stop() stops the container and getInfo reports it", async () => {
    const h = await cloudflare({ binding }).create({}, ctx);
    await h.stop!(ctx);
    expect(state.stops).toHaveLength(1);
    expect((await h.getInfo(ctx)).state).toBe("stopped");
  });

  it("setTimeout sets sleepAfter in seconds", async () => {
    const h = await cloudflare({ binding }).create({}, ctx);
    await h.setTimeout!(120_000, ctx);
    expect(state.sleepAfter).toEqual(["120s"]);
  });

  it("previews use quick tunnels, or named tunnels when configured", async () => {
    const quick = await cloudflare({ binding }).create({ name: "q" }, ctx);
    expect(await quick.exposePort!(8080, {}, ctx)).toEqual({
      auth: { type: "public" },
      port: 8080,
      url: "https://q8080.trycloudflare.com",
    });
    expect(await quick.listPorts!(ctx)).toHaveLength(1);
    await quick.unexposePort!(8080, ctx);
    expect(await quick.listPorts!(ctx)).toHaveLength(0);
    const named = await cloudflare({ binding, namedTunnels: true }).create(
      { name: "Box_1" },
      ctx
    );
    expect((await named.exposePort!(3000, {}, ctx)).url).toBe(
      "https://p3000-box-1.example.com"
    );
  });

  it("snapshots back up snapshotDir and restore in place", async () => {
    const h = await cloudflare({
      binding,
      snapshotDir: "/app",
      localBackups: true,
    }).create({}, ctx);
    const ref = await h.snapshot!({ name: "s1" }, ctx);
    expect(ref).toMatchObject({ includesMemory: false, name: "s1" });
    expect(state.backups[0]).toMatchObject({ dir: "/app", localBucket: true });
    expect(ref.id).toBe(encodeBackupRef(state.backups[0]!));
    await h.restoreSnapshot!(ref.id, ctx);
    expect(state.restores.at(-1)).toEqual({ ...state.backups[0] });
    expect(decodeBackupRef("plain-id", "/workspace")).toEqual({
      dir: "/workspace",
      id: "plain-id",
    });
  });

  it("watch() maps SSE file events and closes", async () => {
    const h = await cloudflare({ binding }).create({}, ctx);
    const seen: string[] = [];
    const close = await h.watch!(
      "/tmp",
      (e) => seen.push(`${e.type}:${e.path}`),
      true,
      ctx
    );
    await h.writeFile("/tmp/w.txt", new TextEncoder().encode("x"), ctx);
    await new Promise((r) => setTimeout(r, 10));
    await close();
    expect(seen).toEqual(["modify:/tmp/w.txt"]);
  });

  it("code interpreter maps contexts and results", async () => {
    const h = await cloudflare({ binding }).create({}, ctx);
    const k = await h.createContext!({ language: "python" }, ctx);
    expect(k.language).toBe("python");
    await expect(h.createContext!({ language: "ruby" }, ctx)).rejects.toThrow(
      /language/
    );
  });
});

describe("cloudflare adapter: egress", () => {
  const fake = () => {
    const calls: string[] = [];
    return {
      calls,
      s: {
        async setAllowedHosts(h: string[]) {
          calls.push(`allow:${h.join(",")}`);
        },
        async setDeniedHosts(h: string[]) {
          calls.push(`deny:${h.join(",")}`);
        },
      } as unknown as CF.Sandbox,
    };
  };

  it("maps modes onto allowed/denied host lists", async () => {
    const a = fake();
    await applyEgress(a.s, {
      mode: "allow-all",
      deny: { domains: ["evil.com"] },
    });
    await applyEgress(a.s, { mode: "block-all" });
    await applyEgress(a.s, { domains: ["*.github.com"], mode: "allow-list" });
    expect(a.calls).toEqual([
      "allow:*",
      "deny:evil.com",
      "allow:",
      "deny:*",
      "allow:*.github.com",
      "deny:",
    ]);
  });

  it("rejects CIDRs and injection", async () => {
    const a = fake();
    await expect(
      applyEgress(a.s, { cidrs: ["10.0.0.0/8"], mode: "allow-list" })
    ).rejects.toThrow(/CIDR/);
    await expect(
      applyEgress(a.s, {
        inject: [{ domains: ["x.com"], headers: { A: "b" } }],
        mode: "allow-all",
      })
    ).rejects.toMatchObject({ code: "NotSupported" });
  });
});

describe("cloudflare adapter: status, errors, verify", () => {
  it("maps every container state", () => {
    expect(mapCloudflareState({ lastChange: 0, status: "running" })).toBe(
      "running"
    );
    expect(mapCloudflareState({ lastChange: 0, status: "healthy" })).toBe(
      "running"
    );
    expect(mapCloudflareState({ lastChange: 0, status: "stopping" })).toBe(
      "stopped"
    );
    expect(mapCloudflareState({ lastChange: 0, status: "stopped" })).toBe(
      "stopped"
    );
    expect(
      mapCloudflareState({
        exitCode: 0,
        lastChange: 0,
        status: "stopped_with_code",
      })
    ).toBe("stopped");
    expect(
      mapCloudflareState({
        exitCode: 2,
        lastChange: 0,
        status: "stopped_with_code",
      })
    ).toBe("error");
    expect(mapCloudflareState(undefined)).toBe("unknown");
  });

  it("maps SDK error codes, HTTP statuses and RPC-flattened messages", () => {
    const e = (code: string, httpStatus: number) =>
      Object.assign(new Error(code), { code, httpStatus });
    expect(mapCloudflareError(e("FILE_NOT_FOUND", 404))?.code).toBe("NotFound");
    expect(mapCloudflareError(e("PORT_IN_USE", 409))?.code).toBe("Conflict");
    expect(mapCloudflareError(e("PERMISSION_DENIED", 403))?.code).toBe(
      "Unauthorized"
    );
    expect(mapCloudflareError(e("VALIDATION_FAILED", 400))?.code).toBe(
      "Validation"
    );
    expect(mapCloudflareError(e("CONTAINER_UNAVAILABLE", 503))?.retryable).toBe(
      true
    );
    expect(mapCloudflareError(e("X", 429))?.code).toBe("QuotaExceeded");
    expect(mapCloudflareError(new Error("File not found: /x"))?.code).toBe(
      "NotFound"
    );
    expect(mapCloudflareError(new Error("request timed out"))?.code).toBe(
      "Timeout"
    );
  });

  it("verify checks the binding without touching a sandbox", async () => {
    await expect(cloudflare({ binding }).verify!(ctx)).resolves.toBeUndefined();
    await expect(
      cloudflare({ binding: {} }).verify!(ctx)
    ).rejects.toMatchObject({
      code: "Unauthorized",
    });
    expect(state.getSandboxCalls).toHaveLength(0);
  });

  it("declares the caps table", () => {
    const p = cloudflare({ binding });
    expect(p.capabilities).toBe(CLOUDFLARE_CAPS);
    expect(p.flags.previewModel).toBe("tunnel");
    expect(p.list).toBeUndefined();
    expect(p.volumes).toBeUndefined();
  });
});
