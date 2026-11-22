/**
 * Offline tests for the Railway adapter against a fake `railway` SDK. The fake
 * mirrors the real 3.17 surface (`Sandbox.create` overloads, `exec` returning
 * an `ExecHandle`, `files.*`, checkpoints, sessions) and runs commands through
 * the in-memory `MiniShell`, so the full conformance suite runs for real.
 */
import type * as RW from "railway";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CallContext } from "../adapter/index.js";
import { runConformance } from "../conformance/index.js";
import {
  METADATA_PATH,
  RAILWAY_CAPS,
  mapRailwayError,
  mapRailwayStatus,
  railway,
} from "./index.js";

/** The public (non-`#private`) surface of an SDK class. */
type Public<T> = { [K in keyof T]: T[K] };

interface FakeState {
  createCalls: { source: unknown; options: RW.CreateOptions | undefined }[];
  connectCalls: { id: string; options: RW.ConnectOptions | undefined }[];
  listCalls: (RW.ListOptions | undefined)[];
  checkpointCalls: (RW.CheckpointOptions | undefined)[];
  forkCalls: (RW.ForkOptions | undefined)[];
  execCalls: { target: RW.ExecTarget; options: RW.ExecOptions }[];
  kills: (RW.ExecSignal | undefined)[];
  reset(): void;
}

const state = vi.hoisted(
  (): FakeState => ({
    checkpointCalls: [],
    connectCalls: [],
    createCalls: [],
    execCalls: [],
    forkCalls: [],
    kills: [],
    listCalls: [],
    reset() {
      /* replaced by the mock factory */
    },
  })
);

vi.mock("railway", async () => {
  const { MiniShell } = await import("../memory/shell.js");
  type ShellFs = import("../memory/shell.js").ShellFs;

  // ---- errors (same class names as the SDK; the adapter maps by name) ----
  class RailwayError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "RailwayError";
    }
  }
  class RailwayAuthError extends Error {
    readonly variable: string;
    constructor(variable: string, message = `${variable} is not set`) {
      super(message);
      this.name = "RailwayAuthError";
      this.variable = variable;
    }
  }
  class RailwayConnectionError extends Error {
    constructor(args: { message: string }) {
      super(args.message);
      this.name = "RailwayConnectionError";
    }
  }
  class ExecNotStartedError extends Error {
    constructor(args: { message: string }) {
      super(args.message);
      this.name = "ExecNotStartedError";
    }
  }
  class RailwayGraphQLError extends Error {
    readonly status: number;
    constructor(args: { message: string; status: number }) {
      super(args.message);
      this.name = "RailwayGraphQLError";
      this.status = args.status;
    }
  }
  class SandboxNotFoundError extends Error {
    constructor(args: { id: string; environmentId: string }) {
      super(
        `Sandbox ${args.id} not found in environment ${args.environmentId}`
      );
      this.name = "SandboxNotFoundError";
    }
  }
  class SandboxFilesError extends Error {
    constructor(args: { operation: string; path: string; message: string }) {
      super(args.message);
      this.name = "SandboxFilesError";
    }
  }
  class SandboxFileNotFoundError extends Error {
    constructor(args: { operation: string; path: string; message: string }) {
      super(args.message);
      this.name = "SandboxFileNotFoundError";
    }
  }
  class SandboxTimeoutError extends Error {
    constructor(args: { resource: string; id: string }) {
      super(`${args.resource} ${args.id} timed out`);
      this.name = "SandboxTimeoutError";
    }
  }

  // ---- in-memory filesystem ----------------------------------------------
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
    const i = n.lastIndexOf("/");
    return i <= 0 ? "/" : n.slice(0, i);
  };
  const base = (p: string): string =>
    norm(p).slice(norm(p).lastIndexOf("/") + 1);

  class MemFs implements ShellFs {
    files = new Map<string, Uint8Array>();
    dirs = new Set(["/", "/tmp", "/etc", "/root"]);
    clone(): MemFs {
      const c = new MemFs();
      c.files = new Map(this.files);
      c.dirs = new Set(this.dirs);
      return c;
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
    read(p: string) {
      return this.files.get(norm(p)) ?? null;
    }
    write(p: string, d: Uint8Array) {
      this.mkdirp(parent(p));
      this.files.set(norm(p), d);
    }
    isDir(p: string) {
      return this.dirs.has(norm(p));
    }
    list(dir: string) {
      const d = norm(dir);
      if (!this.dirs.has(d)) {
        return null;
      }
      const out: { name: string; type: "file" | "dir" }[] = [];
      for (const s of this.dirs) {
        if (s !== d && parent(s) === d) {
          out.push({ name: base(s), type: "dir" });
        }
      }
      for (const f of this.files.keys()) {
        if (parent(f) === d) {
          out.push({ name: base(f), type: "file" });
        }
      }
      return out.toSorted((a, b) => a.name.localeCompare(b.name));
    }
    mkdir(p: string, recursive: boolean) {
      if (!recursive && !this.dirs.has(parent(p))) {
        return `mkdir: cannot create '${p}': No such file or directory`;
      }
      this.mkdirp(p);
      return null;
    }
    remove(p: string, recursive: boolean, force: boolean) {
      const n = norm(p);
      if (this.files.delete(n)) {
        return null;
      }
      if (this.dirs.has(n)) {
        if (!recursive) {
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
      return force ? null : `rm: cannot remove '${p}': No such file`;
    }
    rename(a: string, b: string) {
      const from = norm(a);
      const to = norm(b);
      const data = this.files.get(from);
      if (data) {
        this.write(to, data);
        this.files.delete(from);
        return null;
      }
      if (this.dirs.has(from)) {
        for (const f of [...this.files.keys()]) {
          if (f.startsWith(`${from}/`)) {
            this.write(to + f.slice(from.length), this.files.get(f)!);
            this.files.delete(f);
          }
        }
        for (const d of [...this.dirs]) {
          if (d === from || d.startsWith(`${from}/`)) {
            this.dirs.delete(d);
            this.dirs.add(to + d.slice(from.length));
          }
        }
        return null;
      }
      return `mv: cannot stat '${a}'`;
    }
    stat(p: string) {
      const n = norm(p);
      if (this.dirs.has(n)) {
        return { size: 0, type: "dir" as const };
      }
      const f = this.files.get(n);
      return f ? { size: f.length, type: "file" as const } : null;
    }
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  async function toBytes(data: RW.FileWriteData): Promise<Uint8Array> {
    if (typeof data === "string") {
      return enc.encode(data);
    }
    if (data instanceof Uint8Array) {
      return data;
    }
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    if (data instanceof Blob) {
      return new Uint8Array(await data.arrayBuffer());
    }
    const src = typeof data === "function" ? data() : data;
    if (src instanceof ReadableStream) {
      return new Uint8Array(await new Response(src).arrayBuffer());
    }
    const chunks: Uint8Array[] = [];
    for await (const c of src) {
      chunks.push(c);
    }
    return new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer());
  }

  const notFound = (operation: string, path: string) =>
    new SandboxFileNotFoundError({
      message: "file does not exist",
      operation,
      path,
    });

  const MOD_TIME = "2026-11-22T10:00:00Z";

  class FakeFiles implements Public<RW.SandboxFiles> {
    readonly fs: MemFs;
    constructor(fs: MemFs) {
      this.fs = fs;
    }

    read = (async (
      path: string,
      options?: RW.FileReadOptions & { format?: RW.FileReadFormat }
    ) => {
      const data = this.fs.read(path);
      if (!data) {
        throw notFound("read", path);
      }
      if (options?.format === "bytes") {
        return new Uint8Array(data);
      }
      if (options?.format === "stream") {
        return new Response(new Uint8Array(data)).body!;
      }
      return dec.decode(data);
    }) as RW.SandboxFiles["read"];

    async write(path: string, data: RW.FileWriteData): Promise<void> {
      this.fs.write(path, await toBytes(data));
    }
    entry(path: string): RW.SandboxFileEntry | undefined {
      const s = this.fs.stat(path);
      return s
        ? {
            isDir: s.type === "dir",
            modTime: MOD_TIME,
            mode: s.type === "dir" ? 0o755 : 0o644,
            name: base(path),
            size: s.size,
          }
        : undefined;
    }
    async list(path: string): Promise<RW.SandboxFileEntry[]> {
      const entries = this.fs.list(path);
      if (!entries) {
        throw notFound("list", path);
      }
      return entries.map((e) => this.entry(`${norm(path)}/${e.name}`)!);
    }
    async stat(path: string): Promise<RW.SandboxFileEntry> {
      const e = this.entry(path);
      if (!e) {
        throw notFound("stat", path);
      }
      return e;
    }
    async exists(path: string): Promise<boolean> {
      return this.fs.stat(path) !== null;
    }
    async mkdir(path: string): Promise<void> {
      this.fs.mkdirp(path);
    }
    async remove(path: string): Promise<void> {
      const n = norm(path);
      if (this.fs.dirs.has(n) && (this.fs.list(n)?.length ?? 0) > 0) {
        throw new SandboxFilesError({
          message: "directory not empty",
          operation: "remove",
          path,
        });
      }
      if (this.fs.remove(n, true, false)) {
        throw notFound("remove", path);
      }
    }
    async rename(oldPath: string, newPath: string): Promise<void> {
      if (this.fs.rename(oldPath, newPath)) {
        throw notFound("rename", oldPath);
      }
    }
  }

  // ---- exec sessions -------------------------------------------------------
  interface Session {
    name: string;
    command: string;
    running: boolean;
    exitCode: number | null;
    log: { stream: "stdout" | "stderr"; data: string }[];
    listeners: Set<(stream: "stdout" | "stderr", data: string) => void>;
    done: Promise<RW.ExecResult>;
    kill(): void;
  }

  class FakeExecHandle implements Public<RW.ExecHandle> {
    readonly [Symbol.toStringTag] = "ExecHandle" as const;
    readonly sessionName: Promise<string>;
    readonly stdin: RW.ExecStdin;
    readonly #result: Promise<RW.ExecResult>;
    readonly #session: Session;
    constructor(
      session: Session,
      result: Promise<RW.ExecResult>,
      stdin: RW.ExecStdin
    ) {
      this.#session = session;
      this.#result = result;
      this.sessionName = Promise.resolve(session.name);
      this.stdin = stdin;
    }
    then<A = RW.ExecResult, B = never>(
      onfulfilled?: ((value: RW.ExecResult) => A | PromiseLike<A>) | null,
      onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null
    ): Promise<A | B> {
      return this.#result.then(onfulfilled, onrejected);
    }
    catch<T = never>(
      onrejected?: ((reason: unknown) => T | PromiseLike<T>) | null
    ): Promise<RW.ExecResult | T> {
      return this.#result.catch(onrejected);
    }
    finally(onfinally?: (() => void) | null): Promise<RW.ExecResult> {
      return this.#result.finally(onfinally);
    }
    result(): Promise<RW.ExecResult> {
      return this.#result;
    }
    async kill(signal?: RW.ExecSignal): Promise<boolean> {
      state.kills.push(signal);
      this.#session.kill();
      return true;
    }
    async detach(): Promise<string> {
      return this.#session.name;
    }
  }

  // ---- sandboxes -----------------------------------------------------------
  const sandboxes = new Map<string, FakeSandbox>();
  const checkpoints = new Map<
    string,
    { info: RW.SandboxCheckpointInfo; fs: MemFs }
  >();
  let ids = 0;

  const makeDomains = (
    id: string,
    opts: RW.ForkOptions | undefined
  ): RW.SandboxDomain[] => {
    if (!opts?.domains?.length) {
      return [];
    }
    if (opts.networkIsolation !== "PRIVATE") {
      throw new RailwayGraphQLError({
        message: "Public domains require PRIVATE network isolation",
        status: 200,
      });
    }
    return opts.domains.map((d) => ({
      domain: `${d.prefix ?? "sbx"}-${id}-${d.port}.up.railway.app`,
      port: d.port,
      prefix: d.prefix ?? "sbx",
    }));
  };

  class FakeTemplate implements RW.SandboxTemplate {
    readonly steps: string[];
    constructor(steps: string[] = []) {
      this.steps = steps;
    }
    run(command: string) {
      return new FakeTemplate([...this.steps, command]);
    }
    withPackages(...packages: string[]) {
      return new FakeTemplate([
        ...this.steps,
        `apt-get install ${packages.join(" ")}`,
      ]);
    }
    withEnv() {
      return this;
    }
    workdir() {
      return this;
    }
    async build() {
      return this;
    }
  }

  class FakeSandbox implements Public<RW.Sandbox> {
    #info: RW.SandboxInfo;
    readonly fs: MemFs;
    readonly sessions_ = new Map<string, Session>();
    #sessionCounter = 0;
    readonly #files: FakeFiles;

    constructor(
      fs: MemFs,
      opts: RW.CreateOptions | RW.ForkOptions | undefined
    ) {
      const id = `sbx_${++ids}`;
      this.fs = fs;
      this.#files = new FakeFiles(fs);
      this.#info = {
        createdAt: new Date().toISOString(),
        domains: makeDomains(id, opts),
        environmentId:
          (opts && "environmentId" in opts && opts.environmentId) ||
          "env_default",
        id,
        idleTimeoutMinutes: opts?.idleTimeoutMinutes ?? null,
        networkIsolation: opts?.networkIsolation ?? "ISOLATED",
        region: opts?.region ?? "us-west2",
        status: "RUNNING",
      };
      sandboxes.set(id, this);
    }

    get id() {
      return this.#info.id;
    }
    get status() {
      return this.#info.status;
    }
    get networkIsolation() {
      return this.#info.networkIsolation;
    }
    get domains() {
      return this.#info.domains;
    }
    get environmentId() {
      return this.#info.environmentId;
    }
    get region() {
      return this.#info.region;
    }
    get idleTimeoutMinutes() {
      return this.#info.idleTimeoutMinutes ?? null;
    }
    get createdAt() {
      return this.#info.createdAt;
    }
    get files() {
      return this.#files as unknown as RW.SandboxFiles;
    }

    static template(): RW.SandboxTemplate {
      return new FakeTemplate();
    }

    static async create(
      source?: string | RW.SandboxTemplate | RW.CreateOptions,
      options?: RW.CreateOptions
    ): Promise<FakeSandbox> {
      state.createCalls.push({
        options:
          typeof source === "object" && !(source instanceof FakeTemplate)
            ? (source as RW.CreateOptions)
            : options,
        source:
          typeof source === "object" && !(source instanceof FakeTemplate)
            ? undefined
            : source,
      });
      if (typeof source === "string") {
        const cp = checkpoints.get(source);
        if (!cp) {
          throw new RailwayGraphQLError({
            message: `Checkpoint "${source}" not found`,
            status: 200,
          });
        }
        return new FakeSandbox(cp.fs.clone(), options);
      }
      if (source instanceof FakeTemplate) {
        return new FakeSandbox(new MemFs(), options);
      }
      return new FakeSandbox(
        new MemFs(),
        source as RW.CreateOptions | undefined
      );
    }

    static async connect(
      ...[id, options]: Parameters<typeof import("railway").Sandbox.connect>
    ): Promise<FakeSandbox> {
      state.connectCalls.push({ id, options });
      const sb = sandboxes.get(id);
      if (!sb) {
        throw new SandboxNotFoundError({ environmentId: "env_default", id });
      }
      return sb;
    }

    static async list(options?: RW.ListOptions): Promise<RW.SandboxInfo[]> {
      state.listCalls.push(options);
      const all = [...sandboxes.values()].map((s) => s.toJSON());
      return options?.first === undefined ? all : all.slice(0, options.first);
    }

    static async checkpoints(
      options?: RW.CheckpointOptions
    ): Promise<RW.SandboxCheckpointInfo[]> {
      state.checkpointCalls.push(options);
      return [...checkpoints.values()].map((c) => c.info).toReversed();
    }

    static async renameCheckpoint(
      id: string,
      name: string
    ): Promise<RW.SandboxCheckpointInfo> {
      for (const [key, cp] of checkpoints) {
        if (cp.info.id === id) {
          checkpoints.delete(key);
          cp.info = { ...cp.info, key: name };
          checkpoints.set(name, cp);
          return cp.info;
        }
      }
      throw new RailwayGraphQLError({
        message: "checkpoint not found",
        status: 200,
      });
    }

    static async deleteCheckpoint(
      id: string,
      options?: RW.CheckpointOptions
    ): Promise<void> {
      state.checkpointCalls.push(options);
      for (const [key, cp] of checkpoints) {
        if (cp.info.id === id) {
          checkpoints.delete(key);
          return;
        }
      }
      throw new RailwayGraphQLError({
        message: "checkpoint not found",
        status: 200,
      });
    }

    #assertLive(): void {
      if (this.#info.status !== "RUNNING") {
        throw new SandboxNotFoundError({
          environmentId: this.environmentId,
          id: this.id,
        });
      }
    }

    exec(target: RW.ExecTarget, options: RW.ExecOptions = {}): RW.ExecHandle {
      state.execCalls.push({ options, target });
      const reattach = typeof target !== "string";
      if (
        reattach &&
        (options.cwd || options.env || options.stdin || options.timeoutSec)
      ) {
        throw new TypeError("cwd/env/stdin/timeoutSec are fresh-exec only");
      }
      const listen = (stream: "stdout" | "stderr", data: string) =>
        (stream === "stdout" ? options.onStdout : options.onStderr)?.(data);
      const noStdin: RW.ExecStdin = {
        async end() {
          throw new Error("stdin not enabled");
        },
        async write() {
          throw new Error("stdin not enabled");
        },
      };
      if (reattach) {
        const s = this.sessions_.get(target.sessionName);
        if (!s) {
          const err = Promise.reject(
            new RailwayConnectionError({
              message: `session ${target.sessionName} not found`,
            })
          );
          err.catch(() => undefined);
          return new FakeExecHandle(
            {
              done: err,
              exitCode: null,
              kill() {},
              listeners: new Set(),
              log: [],
              name: target.sessionName,
              running: false,
              command: "",
            },
            err,
            noStdin
          ) as unknown as RW.ExecHandle;
        }
        for (const l of s.log) {
          listen(l.stream, l.data);
        }
        s.listeners.add(listen);
        return new FakeExecHandle(
          s,
          s.done,
          noStdin
        ) as unknown as RW.ExecHandle;
      }

      this.#assertLive();
      const ac = new AbortController();
      const stdinChunks: Uint8Array[] = [];
      let stdinOpen = !!options.stdin;
      let timedOut = false;
      let killed = false;
      const name = `exec-${this.id}-${++this.#sessionCounter}`;
      const session: Session = {
        command: target,
        done: Promise.resolve() as unknown as Promise<RW.ExecResult>,
        exitCode: null,
        kill() {
          killed = true;
          ac.abort();
        },
        listeners: new Set([listen]),
        log: [],
        name,
        running: true,
      };
      const emit = (stream: "stdout" | "stderr", bytes: Uint8Array) => {
        const data = dec.decode(bytes);
        session.log.push({ data, stream });
        for (const l of session.listeners) {
          l(stream, data);
        }
      };
      const timer = options.timeoutSec
        ? setTimeout(() => {
            timedOut = true;
            ac.abort();
          }, options.timeoutSec * 1000)
        : undefined;
      options.signal?.addEventListener("abort", () => ac.abort());
      session.done = (async (): Promise<RW.ExecResult> => {
        await new Promise((r) => setTimeout(r, 0));
        const stdin = new Uint8Array(
          await new Blob(stdinChunks as BlobPart[]).arrayBuffer()
        );
        const code = await new MiniShell(this.fs).run(target, {
          cwd: options.cwd ?? "/",
          env: { ...options.env },
          signal: ac.signal,
          stderr: (d) => emit("stderr", d),
          stdin,
          stdout: (d) => emit("stdout", d),
        });
        clearTimeout(timer);
        stdinOpen = false;
        session.running = false;
        if (options.signal?.aborted) {
          throw options.signal.reason;
        }
        const exitCode = killed || timedOut ? -1 : code;
        session.exitCode = exitCode;
        const out = session.log
          .filter((l) => l.stream === "stdout")
          .map((l) => l.data)
          .join("");
        const err = session.log
          .filter((l) => l.stream === "stderr")
          .map((l) => l.data)
          .join("");
        const captured = options.captureOutput !== false;
        return {
          exitCode,
          stderr: captured ? err : "",
          stdout: captured ? out : "",
          timedOut,
          truncated: false,
        };
      })();
      this.sessions_.set(name, session);
      const stdin: RW.ExecStdin = options.stdin
        ? {
            async end() {
              stdinOpen = false;
            },
            async write(data) {
              if (!stdinOpen) {
                throw new Error("stdin closed");
              }
              stdinChunks.push(
                typeof data === "string" ? enc.encode(data) : data
              );
            },
          }
        : noStdin;
      return new FakeExecHandle(
        session,
        session.done,
        stdin
      ) as unknown as RW.ExecHandle;
    }

    async fork(options?: RW.ForkOptions): Promise<RW.Sandbox> {
      this.#assertLive();
      state.forkCalls.push(options);
      return new FakeSandbox(this.fs.clone(), options) as unknown as RW.Sandbox;
    }

    async checkpoint(name: string): Promise<RW.SandboxCheckpointInfo> {
      this.#assertLive();
      const info: RW.SandboxCheckpointInfo = {
        createdAt: new Date().toISOString(),
        environmentId: this.environmentId,
        id: `cp_${checkpoints.size + 1}_${name}`,
        key: name,
      };
      checkpoints.set(name, { fs: this.fs.clone(), info });
      return info;
    }

    async destroy(): Promise<void> {
      for (const s of this.sessions_.values()) {
        s.kill();
      }
      this.#info = { ...this.#info, status: "DESTROYED" };
      sandboxes.delete(this.id);
    }

    async sessions(): Promise<RW.SandboxSessionInfo[] | null> {
      return [...this.sessions_.values()].map((s) => ({
        attached: s.listeners.size > 0,
        command: s.command,
        createdAt: null,
        exitCode: s.exitCode,
        exitedAt: null,
        foregroundActive: null,
        kind: "EXEC",
        name: s.name,
        running: s.running,
      }));
    }

    async execHttp(): Promise<RW.ExecHttpResult> {
      throw new Error("not used by the adapter");
    }

    async heartbeat(): Promise<RW.Sandbox> {
      this.#assertLive();
      return this as unknown as RW.Sandbox;
    }

    async refresh(): Promise<RW.Sandbox> {
      if (!sandboxes.has(this.id)) {
        throw new SandboxNotFoundError({
          environmentId: this.environmentId,
          id: this.id,
        });
      }
      return this as unknown as RW.Sandbox;
    }

    async [Symbol.asyncDispose](): Promise<void> {
      await this.destroy();
    }

    toJSON(): RW.SandboxInfo {
      return { ...this.#info };
    }
  }

  state.reset = () => {
    sandboxes.clear();
    checkpoints.clear();
    state.createCalls.length = 0;
    state.connectCalls.length = 0;
    state.listCalls.length = 0;
    state.checkpointCalls.length = 0;
    state.forkCalls.length = 0;
    state.execCalls.length = 0;
    state.kills.length = 0;
  };

  return {
    ExecNotStartedError,
    RailwayAuthError,
    RailwayConnectionError,
    RailwayError,
    RailwayGraphQLError,
    Sandbox: FakeSandbox,
    SandboxFileNotFoundError,
    SandboxFilesError,
    SandboxNotFoundError,
    SandboxTimeoutError,
  };
});

const CFG = { environmentId: "env_1", token: "tok" } as const;
const ctx = (over: Partial<CallContext> = {}): CallContext => ({
  attempt: 1,
  fetch: globalThis.fetch,
  idempotencyKey: "idem-1",
  ...over,
});

beforeEach(() => {
  state.reset();
});

describe("railway adapter (offline, fake SDK)", () => {
  it("declares truthful capabilities", () => {
    const p = railway(CFG);
    expect(p.name).toBe("railway");
    expect(p.capabilities).toBe(RAILWAY_CAPS);
    expect(p.capabilities).toMatchObject({
      background: "native",
      exposePort: "native",
      killProcess: "native",
      pause: "unsupported",
      privatePreview: "unsupported",
      region: "native",
      secretsVault: "native",
      stdin: "native",
      templateBuild: "unsupported",
    });
    expect(p.flags.previewModel).toBe("declaredPorts");
    expect(p.templates).toBeUndefined();
  });

  it("passes the conformance suite offline", async () => {
    const report = await runConformance(
      railway({ ...CFG, networkIsolation: "PRIVATE" }),
      { live: true, spec: { ports: [8080] } }
    );
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed).toEqual([]);
    expect(report.checks.length).toBeGreaterThan(30);
  }, 60_000);

  it("maps a rich spec onto Sandbox.create (checkpoint source)", async () => {
    const p = railway({ ...CFG, networkIsolation: "PRIVATE" });
    const seed = await p.create({}, ctx());
    await (
      await import("railway")
    ).Sandbox.connect(seed.id).then((s) => s.checkpoint("base-cp"));
    state.createCalls.length = 0;

    await p.create(
      {
        env: { A: "1" },
        lifecycle: { idleTimeoutMs: 90_000, onIdle: "destroy" },
        metadata: { team: "x" },
        name: "box",
        ports: [3000],
        region: "europe-west4",
        resources: { memoryMB: 2048, vcpus: 2 },
        secrets: [
          { name: "API_KEY" },
          { envVar: "DB_PASS", name: "db", value: "s3cret" },
        ],
        template: "base-cp",
      },
      ctx()
    );
    expect(state.createCalls).toHaveLength(1);
    const call = state.createCalls[0]!;
    expect(call.source).toBe("base-cp");
    expect(call.options).toEqual({
      domains: [{ port: 3000 }],
      env: { A: "1", API_KEY: `${"$"}{{shared.API_KEY}}`, DB_PASS: "s3cret" },
      environmentId: "env_1",
      idleTimeoutMinutes: 2,
      networkIsolation: "PRIVATE",
      region: "europe-west4",
      resources: { cpu: 2, memoryGB: 2.048 },
      token: "tok",
    });
  });

  it("keeps the config when no template is given (old :301 bug)", async () => {
    const p = railway(CFG);
    await p.create({ env: { X: "y" } }, ctx());
    expect(state.createCalls[0]).toEqual({
      options: { env: { X: "y" }, environmentId: "env_1", token: "tok" },
      source: undefined,
    });
  });

  it("prefers fromSnapshot and falls back to the factory recipe", async () => {
    const { Sandbox } = await import("railway");
    const recipe = Sandbox.template().withPackages("git");
    const p = railway({ ...CFG, template: recipe });
    const h = await p.create({}, ctx());
    expect(state.createCalls[0]!.source).toBe(recipe);
    await (await Sandbox.connect(h.id)).checkpoint("snap-a");
    await p.create({ fromSnapshot: "snap-a", template: "other" }, ctx());
    expect(state.createCalls[1]!.source).toBe("snap-a");
  });

  it("rejects spec fields Railway cannot honor", async () => {
    const p = railway(CFG);
    const bad = [
      { lifecycle: { maxAgeMs: 1000 } },
      { lifecycle: { idleTimeoutMs: 1000, onIdle: "pause" as const } },
      { network: { mode: "block-all" as const } },
      { volumes: [{ id: "v", mountPath: "/data" }] },
      { ports: [80] }, // needs networkIsolation: "PRIVATE"
      { secrets: [{ mode: "egress" as const, name: "gh" }] },
      { resources: { gpu: "A10G" } },
    ];
    for (const spec of bad) {
      await expect(p.create(spec, ctx())).rejects.toMatchObject({
        code: "Validation",
      });
    }
    expect(state.createCalls).toHaveLength(0);
  });

  it("passes token/environmentId to connect, list and checkpoints (old :316/:321)", async () => {
    const p = railway(CFG);
    const h = await p.create({}, ctx());
    await p.connect(h.id, ctx());
    expect(state.connectCalls.at(-1)!.options).toEqual(CFG);
    for await (const _ of p.list!(undefined, ctx())) {
      // drain
    }
    expect(state.listCalls.at(-1)).toEqual(CFG);
    await h.listSnapshots!(ctx());
    expect(state.checkpointCalls.at(-1)).toEqual(CFG);
  });

  it("verify is a 1-item list, never a create", async () => {
    const p = railway(CFG);
    await p.verify!(ctx());
    expect(state.listCalls).toEqual([{ ...CFG, first: 1 }]);
    expect(state.createCalls).toHaveLength(0);
  });

  it("getInfo reads live status and persisted metadata", async () => {
    const p = railway(CFG);
    const h = await p.create({ metadata: { k: "v" }, name: "n1" }, ctx());
    const info = await h.getInfo(ctx());
    expect(info).toMatchObject({
      metadata: { k: "v" },
      name: "n1",
      provider: "railway",
      state: "running",
    });
    const { Sandbox } = await import("railway");
    const text = await (await Sandbox.connect(h.id)).files.read(METADATA_PATH);
    expect(JSON.parse(text)).toEqual({
      idempotencyKey: "idem-1",
      metadata: { k: "v" },
      name: "n1",
    });
    await h.destroy(ctx());
    await expect(Promise.resolve(h.getInfo(ctx()))).rejects.toThrow();
  });

  it("list honors state, metadata and limit", async () => {
    const p = railway(CFG);
    await p.create({ metadata: { g: "a" } }, ctx());
    await p.create({ metadata: { g: "b" } }, ctx());
    await p.create({ metadata: { g: "a" } }, ctx());
    // A fresh provider has no cache: metadata comes from the in-sandbox file.
    const fresh = railway(CFG);
    const collect = async (
      f: Parameters<NonNullable<typeof fresh.list>>[0]
    ) => {
      const out = [];
      for await (const i of fresh.list!(f, ctx())) {
        out.push(i);
      }
      return out;
    };
    expect(await collect({ metadata: { g: "a" } })).toHaveLength(2);
    expect(await collect({ limit: 1, metadata: { g: "a" } })).toHaveLength(1);
    expect(await collect({ limit: 2 })).toHaveLength(2);
    expect(await collect({ state: "running" })).toHaveLength(3);
    expect(await collect({ state: "paused" })).toHaveLength(0);
  });

  it("an idempotent retry reuses the sandbox from the first attempt", async () => {
    const p = railway(CFG);
    const first = await p.create({}, ctx({ idempotencyKey: "k-9" }));
    const retry = await p.create(
      {},
      ctx({ attempt: 2, idempotencyKey: "k-9" })
    );
    expect(retry.id).toBe(first.id);
    expect(state.createCalls).toHaveLength(1);
  });

  it("kill() sends a real signal through ExecHandle.kill (old :234)", async () => {
    const p = railway(CFG);
    const h = await p.create({}, ctx());
    const ex = h.exec("sleep 30", {}, ctx());
    setTimeout(() => void ex.kill("SIGKILL"), 20);
    const events = [];
    for await (const ev of ex) {
      events.push(ev);
    }
    expect(state.kills).toEqual(["KILL"]);
    expect(events.at(-1)).toEqual({ exitCode: -1, type: "exit" });
  });

  it("passes cwd/env/timeoutSec natively", async () => {
    const p = railway(CFG);
    const h = await p.create({}, ctx());
    const ex = h.exec(
      "pwd",
      { cwd: "/tmp", env: { A: "b" }, timeoutMs: 1500 },
      ctx()
    );
    for await (const _ of ex) {
      // drain
    }
    expect(state.execCalls.at(-1)!.options).toMatchObject({
      cwd: "/tmp",
      env: { A: "b" },
      timeoutSec: 2,
    });
  });

  it("spawn keeps stdin open and lists/reattaches sessions", async () => {
    const p = railway(CFG);
    const h = await p.create({}, ctx());
    const proc = await h.spawn!("cat", {}, ctx());
    expect(state.execCalls.at(-1)!.options.stdin).toBe(true);
    await proc.writeStdin!(new TextEncoder().encode("hello"));
    let out = "";
    for await (const ev of proc) {
      if (ev.type === "stdout") {
        out += ev.data;
      }
    }
    expect(out).toBe("hello");
    const sleeper = await h.spawn!("sleep 30", {}, ctx());
    expect((await h.listProcesses!(ctx())).map((x) => x.id)).toContain(
      sleeper.id
    );
    const again = await h.connectProcess!(sleeper.id, ctx());
    expect(again.id).toBe(sleeper.id);
    await h.killProcess!(sleeper.id, undefined, ctx());
    expect(state.kills.at(-1)).toBe("TERM");
  });

  it("stat parses modTime (old :274)", async () => {
    const p = railway(CFG);
    const h = await p.create({}, ctx());
    await h.writeFile("/tmp/a.txt", new TextEncoder().encode("abc"), ctx());
    const s = await h.stat!("/tmp/a.txt", ctx());
    expect(s).toEqual({
      mtime: new Date("2026-11-22T10:00:00Z"),
      path: "/tmp/a.txt",
      size: 3,
      type: "file",
    });
  });

  it("snapshots list and delete through Sandbox.checkpoints (old :283)", async () => {
    const p = railway(CFG);
    const h = await p.create({}, ctx());
    const ref = await h.snapshot!({ name: "cp-1" }, ctx());
    expect(ref).toMatchObject({ id: "cp-1", includesMemory: false });
    expect((await h.listSnapshots!(ctx())).map((r) => r.id)).toEqual(["cp-1"]);
    await h.deleteSnapshot!("cp-1", ctx());
    expect(await h.listSnapshots!(ctx())).toEqual([]);
    await expect(
      Promise.resolve(h.deleteSnapshot!("cp-1", ctx()))
    ).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  it("forks drop the getOrCreate name from the cloned metadata", async () => {
    const p = railway(CFG);
    const h = await p.create({ metadata: { "sbox-name": "x", t: "1" } }, ctx());
    const [child] = await h.fork!(1, ctx());
    expect((await child!.getInfo(ctx())).metadata).toEqual({ t: "1" });
  });

  it("maps every status", () => {
    expect(mapRailwayStatus("CREATING")).toBe("creating");
    expect(mapRailwayStatus("RUNNING")).toBe("running");
    expect(mapRailwayStatus("DESTROYING")).toBe("destroyed");
    expect(mapRailwayStatus("DESTROYED")).toBe("destroyed");
    expect(mapRailwayStatus("FAILED")).toBe("error");
    expect(mapRailwayStatus("WHATEVER")).toBe("unknown");
  });

  it("maps errors", async () => {
    const m = await import("railway");
    const code = (e: unknown) => mapRailwayError(e)?.code;
    expect(code(new m.RailwayAuthError("RAILWAY_TOKEN"))).toBe("Unauthorized");
    expect(
      code(new m.SandboxNotFoundError({ environmentId: "e", id: "x" }))
    ).toBe("NotFound");
    expect(
      code(
        new m.SandboxFileNotFoundError({
          message: "nope",
          operation: "read",
          path: "/x",
        })
      )
    ).toBe("NotFound");
    const gql = (status: number, message = "boom") =>
      new m.RailwayGraphQLError({ message, status });
    expect(code(gql(401))).toBe("Unauthorized");
    expect(code(gql(200, "Not Authorized"))).toBe("Unauthorized");
    expect(code(gql(404))).toBe("NotFound");
    expect(code(gql(429))).toBe("QuotaExceeded");
    expect(mapRailwayError(gql(429))?.retryable).toBe(true);
    expect(code(gql(409))).toBe("Conflict");
    expect(code(gql(500))).toBe("Provider");
    expect(code(new TypeError("bad"))).toBe("Validation");
    expect(
      code(
        new m.SandboxTimeoutError({
          id: "x",
          lastStatus: "CREATING",
          resource: "sandbox",
          timeoutMs: 1,
        })
      )
    ).toBe("Timeout");
  });
});
