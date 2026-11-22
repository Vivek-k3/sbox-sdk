/**
 * Offline tests for the Modal adapter. `modal` is replaced by a fake whose
 * method names and argument shapes follow the real 0.11 `.d.ts` (fakes are
 * typed with `Pick<RealClass, ...>` / the SDK's param types), and whose exec
 * runs real shell semantics through `MiniShell` over an in-memory filesystem.
 * The shared conformance suite then runs end-to-end through the adapter.
 */
import type {
  FileInfo as ModalFileInfo,
  FileWatchEvent,
  SandboxCreateParams,
  SandboxExecParams,
  SandboxFilesystem,
  SandboxUpdateNetworkPolicyParams,
} from "modal";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runConformance } from "../conformance/index.js";
import { createSandboxClient } from "../index.js";
import { MiniShell } from "../memory/shell.js";
import type { ShellFs, ShellIo } from "../memory/shell.js";
import {
  CONNECT_TOKEN_PARAM,
  MODAL_CAPS,
  dockerfileToModal,
  egressToModal,
  mapModalError,
  modal,
  nameFromIdempotencyKey,
  PROC_DIR,
  templateImageName,
} from "./index.js";

// ---------------------------------------------------------------------------
// in-memory filesystem
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
const base = (p: string): string => norm(p).slice(norm(p).lastIndexOf("/") + 1);

class MemFs implements ShellFs {
  files = new Map<string, Uint8Array>();
  dirs = new Set(["/", "/tmp", "/root"]);
  onChange?: (type: "Create" | "Modify" | "Remove", path: string) => void;
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
    const existed = this.files.has(norm(path));
    this.files.set(norm(path), data);
    this.onChange?.(existed ? "Modify" : "Create", norm(path));
  }
  list(dir: string): { name: string; type: "file" | "dir" }[] | null {
    const d = norm(dir);
    if (!this.dirs.has(d)) {
      return null;
    }
    const out: { name: string; type: "file" | "dir" }[] = [];
    for (const x of this.dirs) {
      if (x !== d && parent(x) === d) {
        out.push({ name: base(x), type: "dir" });
      }
    }
    for (const f of this.files.keys()) {
      if (parent(f) === d) {
        out.push({ name: base(f), type: "file" });
      }
    }
    return out.toSorted((a, b) => a.name.localeCompare(b.name));
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
      this.onChange?.("Remove", p);
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
// fake `modal`
// ---------------------------------------------------------------------------

const named = (name: string) =>
  class extends Error {
    constructor(message: string) {
      super(message);
      this.name = name;
    }
  };
const NotFoundError = named("NotFoundError");
const AlreadyExistsError = named("AlreadyExistsError");
const ResourceExhaustedError = named("ResourceExhaustedError");
const InvalidError = named("InvalidError");
const SandboxFilesystemNotFoundError = named("SandboxFilesystemNotFoundError");

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A stream the fake can push into, shaped like ModalReadStream. */
function pushStream<T>() {
  let ctrl!: ReadableStreamDefaultController<T>;
  const stream = new ReadableStream<T>({
    start(c) {
      ctrl = c;
    },
  });
  let closed = false;
  return {
    close: () => {
      if (!closed) {
        closed = true;
        ctrl.close();
      }
    },
    push: (v: T) => {
      if (!closed) {
        ctrl.enqueue(v);
      }
    },
    stream: Object.assign(stream, {
      readBytes: async () => new Uint8Array(),
      readText: async () => "",
    }),
  };
}

class FakeImage {
  imageId: string;
  readonly tag: string;
  readonly layers: string[];
  readonly files?: MemFs;
  constructor(
    imageId: string,
    tag: string,
    layers: string[] = [],
    files?: MemFs
  ) {
    this.imageId = imageId;
    this.tag = tag;
    this.layers = layers;
    this.files = files;
  }
  dockerfileCommands(commands: string[]): FakeImage {
    for (const c of commands) {
      if (/^COPY /i.test(c.trim()) && !/^COPY --from=/i.test(c.trim())) {
        throw new InvalidError(
          "COPY commands that copy from local context are not yet supported."
        );
      }
    }
    return new FakeImage(
      "",
      this.tag,
      [...this.layers, ...commands],
      this.files
    );
  }
  async build(app: { appId: string }): Promise<FakeImage> {
    expect(app.appId).toBeTruthy();
    if (!this.imageId) {
      this.imageId = `im-${++world.counter}`;
      world.images.set(this.imageId, this);
    }
    return this;
  }
  async publish(
    name: string,
    params?: { environment?: string }
  ): Promise<void> {
    if (!this.imageId) {
      throw new InvalidError(
        "Cannot publish an image that has not been built yet."
      );
    }
    world.published.set(name, this);
    world.publishEnvs.push(params?.environment);
  }
}

class FakeVolume {
  readOnly = false;
  readonly volumeId: string;
  readonly name?: string;
  constructor(volumeId: string, name?: string) {
    this.volumeId = volumeId;
    this.name = name;
  }
  withMountOptions(p?: { readOnly?: boolean }): FakeVolume {
    const v = new FakeVolume(this.volumeId, this.name);
    v.readOnly = !!p?.readOnly;
    return v;
  }
}

interface FakeProc {
  ac: AbortController;
}

class FakeFilesystem implements Pick<
  SandboxFilesystem,
  | "readBytes"
  | "writeBytes"
  | "listFiles"
  | "stat"
  | "remove"
  | "makeDirectory"
  | "watch"
> {
  readonly sb: FakeSandbox;
  constructor(sb: FakeSandbox) {
    this.sb = sb;
  }
  #info(path: string): ModalFileInfo {
    const s = this.sb.store.stat(path);
    if (!s) {
      throw new SandboxFilesystemNotFoundError(`${path}: not found`);
    }
    return {
      group: "root",
      mode: 0o644,
      modifiedTime: 1_700_000_000,
      name: base(path),
      owner: "root",
      path: norm(path),
      permissions: "rw-r--r--",
      size: s.size,
      symlinkTarget: null,
      type: s.type === "dir" ? "directory" : "file",
    };
  }
  async readBytes(remotePath: string): Promise<Uint8Array> {
    const d = this.sb.store.read(remotePath);
    if (!d) {
      throw new SandboxFilesystemNotFoundError(`${remotePath}: not found`);
    }
    return d;
  }
  async writeBytes(
    data: Uint8Array | ArrayBuffer | Buffer,
    remotePath: string
  ): Promise<void> {
    if (!remotePath.startsWith("/")) {
      throw new InvalidError("remotePath must be absolute");
    }
    this.sb.store.write(remotePath, new Uint8Array(data));
  }
  async listFiles(remotePath: string): Promise<ModalFileInfo[]> {
    const entries = this.sb.store.list(remotePath);
    if (!entries) {
      throw new SandboxFilesystemNotFoundError(`${remotePath}: not found`);
    }
    return entries.map((e) => this.#info(`${norm(remotePath)}/${e.name}`));
  }
  async stat(remotePath: string): Promise<ModalFileInfo> {
    return this.#info(remotePath);
  }
  async remove(
    remotePath: string,
    options?: { recursive?: boolean }
  ): Promise<void> {
    if (this.sb.store.remove(remotePath, !!options?.recursive, false)) {
      throw new SandboxFilesystemNotFoundError(`${remotePath}: not found`);
    }
  }
  async makeDirectory(
    remotePath: string,
    options?: { createParents?: boolean }
  ): Promise<void> {
    if (this.sb.store.mkdir(remotePath, options?.createParents ?? true)) {
      throw new SandboxFilesystemNotFoundError(
        `${remotePath}: parent not found`
      );
    }
  }
  watch(
    remotePath: string,
    params?: { recursive?: boolean }
  ): AsyncIterable<FileWatchEvent> {
    const q = pushStream<FileWatchEvent>();
    const root = norm(remotePath);
    this.sb.store.onChange = (eventType, path) => {
      if (
        params?.recursive ? path.startsWith(`${root}/`) : parent(path) === root
      ) {
        q.push({ eventType, paths: [path] });
      }
    };
    return q.stream;
  }
}

class FakeSandbox {
  readonly sandboxId: string;
  store = new MemFs();
  terminated = false;
  procs = new Map<string, FakeProc>();
  network?: SandboxUpdateNetworkPolicyParams;
  readonly filesystem = new FakeFilesystem(this);
  readonly appId: string;
  readonly params: SandboxCreateParams;
  constructor(appId: string, params: SandboxCreateParams, image: FakeImage) {
    this.appId = appId;
    this.params = params;
    this.sandboxId = `sb-${++world.counter}`;
    if (image.files) {
      this.store = image.files.clone();
    }
  }
  get tags(): Record<string, string> {
    return { ...this.params.tags };
  }
  async getTags(): Promise<Record<string, string>> {
    return this.tags;
  }
  async poll(): Promise<number | null> {
    return this.terminated ? 0 : null;
  }
  async terminate(): Promise<void> {
    this.terminated = true;
    for (const p of this.procs.values()) {
      p.ac.abort();
    }
  }
  async tunnels(): Promise<Record<number, { url: string }>> {
    const out: Record<number, { url: string }> = {};
    for (const port of this.params.encryptedPorts ?? []) {
      out[port] = { url: `https://ta-${this.sandboxId}-${port}.w.modal.host` };
    }
    return out;
  }
  async createConnectToken(params?: { port?: number }) {
    return {
      token: "ctok",
      url: `https://${this.sandboxId}-${params?.port ?? 8080}.modal.run`,
    };
  }
  async updateNetworkPolicy(
    params: SandboxUpdateNetworkPolicyParams
  ): Promise<void> {
    if (!params.outboundCidrAllowlist || !params.outboundDomainAllowlist) {
      throw new InvalidError("both dimensions must be provided");
    }
    this.network = params;
  }
  async snapshotFilesystem(): Promise<FakeImage> {
    const img = new FakeImage(
      `im-${++world.counter}`,
      "snapshot",
      [],
      this.store.clone()
    );
    world.images.set(img.imageId, img);
    return img;
  }
  #io(
    params: SandboxExecParams | undefined,
    out: (d: Uint8Array) => void,
    err: (d: Uint8Array) => void,
    ac: AbortController
  ): ShellIo {
    return {
      cwd: params?.workdir ?? "/",
      env: { ...this.params.env, ...params?.env },
      signal: ac.signal,
      stderr: err,
      stdin: new Uint8Array(),
      stdout: out,
    };
  }
  async exec(command: string[], params?: SandboxExecParams) {
    if (this.terminated) {
      throw new NotFoundError(`sandbox ${this.sandboxId} terminated`);
    }
    const binary = params?.mode === "binary";
    const stdout = pushStream<string | Uint8Array>();
    const stderr = pushStream<string | Uint8Array>();
    const toOut = (q: typeof stdout) => (d: Uint8Array) =>
      q.push(binary ? d : dec.decode(d));
    const ac = new AbortController();
    const [sh, flag, script = "", arg0, arg1 = ""] = command;
    expect([sh, flag]).toEqual(["sh", "-c"]);
    let stdinSink: (d: Uint8Array | string) => void = () => {};
    let done: Promise<number>;

    const pidFile = /echo \$\$ > (\S+)/.exec(script)?.[1];
    if (pidFile) {
      this.procs.set(pidFile, { ac });
    }
    if (params?.pty) {
      // Interactive login shell: echo input, run each line, `exit N` ends it.
      const shell = new MiniShell(this.store);
      const io = this.#io(params, toOut(stdout), toOut(stdout), ac);
      let line = "";
      let chain = Promise.resolve();
      let resolveExit!: (n: number) => void;
      done = new Promise<number>((r) => {
        resolveExit = r;
      });
      ac.signal.addEventListener("abort", () => resolveExit(137));
      const runLine = async (cmd: string): Promise<void> => {
        const m = /^\s*exit\s*(\d*)/.exec(cmd);
        if (m) {
          resolveExit(Number(m[1] || 0));
        } else {
          await shell.run(cmd, io);
        }
      };
      stdinSink = (d) => {
        const text = typeof d === "string" ? d : dec.decode(d);
        stdout.push(binary ? enc.encode(text) : text);
        const parts = (line + text).split("\n");
        line = parts.pop() ?? "";
        for (const cmd of parts) {
          chain = chain.then(() => runLine(cmd));
        }
      };
    } else if (arg0 === "sbox-exec") {
      // The adapter's pid-recording wrapper: run "$1" as the real shell would.
      done = new MiniShell(this.store).run(
        arg1,
        this.#io(params, toOut(stdout), toOut(stderr), ac)
      );
    } else if (script.includes("kt(){")) {
      // Process-tree kill via /proc: abort whatever registered that pid file.
      const target = /cat (\S+) 2>/.exec(script)?.[1];
      if (target) {
        this.procs.get(target)?.ac.abort();
        this.procs.delete(target);
      }
      done = Promise.resolve(0);
    } else if (script.startsWith(`ls -1 ${PROC_DIR}`)) {
      stdout.push([...this.procs.keys()].map(base).join("\n"));
      done = Promise.resolve(0);
    } else if (script.includes("stty -F")) {
      done = Promise.resolve(0);
    } else {
      done = new MiniShell(this.store).run(
        script,
        this.#io(params, toOut(stdout), toOut(stderr), ac)
      );
    }
    if (params?.timeoutMs) {
      const t = setTimeout(() => ac.abort(), params.timeoutMs);
      void done.finally(() => clearTimeout(t));
    }
    const exit = done.then((code) => {
      if (pidFile) {
        this.procs.delete(pidFile);
      }
      stdout.close();
      stderr.close();
      return ac.signal.aborted ? 137 : code;
    });
    return {
      stderr: stderr.stream,
      stdin: new WritableStream<string | Uint8Array>({
        write: (chunk) => stdinSink(chunk),
      }),
      stdout: stdout.stream,
      wait: () => exit,
    } as never;
  }
}

class FakeWorld {
  counter = 0;
  apps = new Map<string, { appId: string; name: string }>();
  sandboxes = new Map<string, FakeSandbox>();
  images = new Map<string, FakeImage>();
  published = new Map<string, FakeImage>();
  publishEnvs: (string | undefined)[] = [];
  volumes = new Map<string, FakeVolume>();
  secrets: { name?: string; entries?: Record<string, string> }[] = [];
  creates: { appId: string; image: FakeImage; params: SandboxCreateParams }[] =
    [];
  exhausted = false;
}
let world = new FakeWorld();

interface FakeClientParams {
  tokenId?: string;
  tokenSecret?: string;
  environment?: string;
}
class FakeModalClient {
  readonly params?: FakeClientParams;
  constructor(params?: FakeClientParams) {
    this.params = params;
  }
  environmentName(environment?: string): string {
    return environment ?? this.params?.environment ?? "main";
  }
  close(): void {}
  readonly apps = {
    fromName: async (name: string, p?: { createIfMissing?: boolean }) => {
      let app = world.apps.get(name);
      if (!app) {
        if (!p?.createIfMissing) {
          throw new NotFoundError(`App '${name}' not found`);
        }
        app = { appId: `ap-${++world.counter}`, name };
        world.apps.set(name, app);
      }
      return app;
    },
  };
  readonly images = {
    delete: async (imageId: string) => {
      world.images.delete(imageId);
    },
    fromId: async (imageId: string) => {
      const img = world.images.get(imageId);
      if (!img) {
        throw new NotFoundError(`Image ${imageId} not found`);
      }
      return img;
    },
    fromName: async (name: string) => {
      const img = world.published.get(name);
      if (!img) {
        throw new NotFoundError(`Image '${name}' not found`);
      }
      return img;
    },
    fromRegistry: (tag: string) => new FakeImage("", tag),
  };
  readonly secrets = {
    fromName: async (name: string) => {
      world.secrets.push({ name });
      return { name, secretId: `st-${name}` };
    },
    fromObject: async (entries: Record<string, string>) => {
      world.secrets.push({ entries });
      return { secretId: "" };
    },
  };
  readonly volumes = {
    delete: async (name: string) => {
      world.volumes.delete(name);
    },
    fromName: async (name: string, p?: { createIfMissing?: boolean }) => {
      let v = world.volumes.get(name);
      if (!v) {
        if (!p?.createIfMissing) {
          throw new NotFoundError(`Volume '${name}' not found`);
        }
        v = new FakeVolume(`vo-${++world.counter}`, name);
        world.volumes.set(name, v);
      }
      return v;
    },
  };
  readonly cpClient = {
    volumeList: async (req: {
      environmentName: string;
      pagination?: { maxObjects: number; createdBefore: number };
    }) => {
      const all = [...world.volumes.values()].map((v, i) => ({
        createdAt: 1000 - i,
        label: v.name ?? "",
        metadata: {
          creationInfo: { createdAt: 1000 - i },
          name: v.name ?? "",
          version: 1,
        },
        volumeId: v.volumeId,
      }));
      const before = req.pagination?.createdBefore || Infinity;
      const max = req.pagination?.maxObjects ?? 100;
      return {
        environmentName: req.environmentName,
        items: all.filter((x) => x.createdAt < before).slice(0, max),
      };
    },
  };
  readonly sandboxes = {
    create: async (
      app: { appId: string },
      image: FakeImage,
      params?: SandboxCreateParams
    ) => {
      if (world.exhausted) {
        throw new ResourceExhaustedError("No capacity");
      }
      const p = params ?? {};
      world.creates.push({ appId: app.appId, image, params: p });
      if (
        p.name &&
        [...world.sandboxes.values()].some(
          (s) =>
            !s.terminated && s.appId === app.appId && s.params.name === p.name
        )
      ) {
        throw new AlreadyExistsError(`Sandbox '${p.name}' already exists`);
      }
      const sb = new FakeSandbox(app.appId, p, image);
      world.sandboxes.set(sb.sandboxId, sb);
      return sb;
    },
    fromId: async (id: string) => {
      const sb = world.sandboxes.get(id);
      if (!sb) {
        throw new NotFoundError(`Sandbox ${id} not found`);
      }
      return sb;
    },
    fromName: async (appName: string, name: string) => {
      const app = world.apps.get(appName);
      const sb = [...world.sandboxes.values()].find(
        (s) => !s.terminated && s.appId === app?.appId && s.params.name === name
      );
      if (!sb) {
        throw new NotFoundError(`Sandbox '${name}' not found`);
      }
      return sb;
    },
    async *list(p?: { appId?: string; tags?: Record<string, string> }) {
      for (const sb of world.sandboxes.values()) {
        if (sb.terminated || (p?.appId && sb.appId !== p.appId)) {
          continue;
        }
        if (
          p?.tags &&
          !Object.entries(p.tags).every(([k, v]) => sb.tags[k] === v)
        ) {
          continue;
        }
        yield sb;
      }
    },
  };
}

interface FakeReplacement {
  domain: string;
  headers: Record<string, string>;
  secret?: unknown;
}
class FakeOutboundPolicy {
  readonly replacements: FakeReplacement[];
  constructor(replacements: FakeReplacement[] = []) {
    this.replacements = replacements;
  }
  withHeaderReplacement(r: {
    domain: string;
    headers: Record<string, string>;
    secret?: unknown;
  }) {
    return new FakeOutboundPolicy([...this.replacements, r]);
  }
}

vi.mock("modal", () => ({
  ExperimentalOutboundPolicy: FakeOutboundPolicy,
  ModalClient: FakeModalClient,
}));

beforeEach(() => {
  world = new FakeWorld();
});

const ctx = { attempt: 1, fetch };

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("modal: pure helpers", () => {
  it("maps errors", () => {
    expect(mapModalError(new NotFoundError("x"))?.code).toBe("NotFound");
    expect(mapModalError(new SandboxFilesystemNotFoundError("x"))?.code).toBe(
      "NotFound"
    );
    const q = mapModalError(new ResourceExhaustedError("no capacity"));
    expect(q?.code).toBe("QuotaExceeded");
    expect(q?.retryable).toBe(true);
    expect(mapModalError(new AlreadyExistsError("x"))?.code).toBe("Conflict");
    expect(mapModalError(new InvalidError("x"))?.code).toBe("Validation");
    expect(
      mapModalError(Object.assign(new Error("denied"), { code: 16 }))?.code
    ).toBe("Unauthorized");
    expect(
      mapModalError(Object.assign(new Error("denied"), { code: 7 }))?.code
    ).toBe("Unauthorized");
    const SandboxTimeoutError = named("SandboxTimeoutError");
    expect(mapModalError(new SandboxTimeoutError("t"))?.code).toBe("Timeout");
    expect(mapModalError(new Error("boom"))).toBeUndefined();
  });

  it("splits Dockerfiles into a registry base + commands", () => {
    expect(
      dockerfileToModal(
        "# c\nFROM --platform=linux/amd64 python:3.12-slim AS app\nRUN pip install \\\n  numpy\nENV A=1\n"
      )
    ).toEqual({
      base: "python:3.12-slim",
      commands: ["RUN pip install  numpy", "ENV A=1"],
    });
    expect(
      dockerfileToModal("FROM alpine\nADD https://x.io/f /f\n").commands
    ).toEqual(["ADD https://x.io/f /f"]);
    expect(() => dockerfileToModal("FROM a\nCOPY . /app\n")).toThrow(/COPY/);
    expect(() => dockerfileToModal("FROM a\nADD ./x /x\n")).toThrow(/ADD/);
    expect(() => dockerfileToModal("FROM a\nFROM b\n")).toThrow(/multi-stage/);
    expect(() => dockerfileToModal("ARG V\nFROM a:$V\n")).toThrow(/ARG/);
  });

  it("maps egress policies to both allowlists", () => {
    expect(egressToModal({ mode: "block-all" })).toEqual({
      outboundCidrAllowlist: [],
      outboundDomainAllowlist: [],
    });
    expect(egressToModal({ mode: "allow-all" })).toEqual({
      outboundCidrAllowlist: ["0.0.0.0/0"],
      outboundDomainAllowlist: ["*"],
    });
    expect(egressToModal({ domains: ["a.com"], mode: "allow-list" })).toEqual({
      outboundCidrAllowlist: [],
      outboundDomainAllowlist: ["a.com"],
    });
    expect(() =>
      egressToModal({ deny: { cidrs: ["1.2.3.4/32"] }, mode: "allow-all" })
    ).toThrow(/deny/);
  });
});

describe("modal: spec mapping", () => {
  it("maps a rich create spec onto sandboxes.create", async () => {
    world.volumes.set("data", new FakeVolume("vo-data", "data"));
    const client = createSandboxClient({
      provider: modal({ appName: "my-app", tokenId: "i", tokenSecret: "s" }),
      telemetry: false,
    });
    await client.create({
      env: { A: "1" },
      idempotencyKey: "idem-1",
      lifecycle: { idleTimeoutMs: 60_000, maxAgeMs: 3_600_000 },
      metadata: { team: "x" },
      network: {
        domains: ["pypi.org"],
        inject: [
          {
            domains: ["api.github.com"],
            headers: {
              Authorization: { envVar: "GH", name: "gh-token" },
              "X-Static": "v$1",
            },
          },
        ],
        mode: "allow-list",
      },
      ports: [8000],
      region: "us-east-1",
      resources: { gpu: "A100", gpuCount: 2, memoryMB: 2048, vcpus: 1.5 },
      secrets: [{ name: "db" }, { name: "INLINE", value: "v" }],
      template: "python:3.12",
      volumes: [{ id: "data", mountPath: "/data", readOnly: true }],
    });
    const { appId, image, params } = world.creates[0]!;
    expect(appId).toBe(world.apps.get("my-app")!.appId);
    expect(image.tag).toBe("python:3.12");
    expect(params).toMatchObject({
      cpu: 1.5,
      encryptedPorts: [8000],
      env: { A: "1" },
      gpu: "A100:2",
      idleTimeoutMs: 60_000,
      memoryMiB: 2048,
      name: nameFromIdempotencyKey("idem-1"),
      outboundCidrAllowlist: [],
      outboundDomainAllowlist: ["pypi.org"],
      regions: ["us-east-1"],
      tags: { team: "x" },
      timeoutMs: 3_600_000,
    });
    expect(params.secrets).toHaveLength(2);
    expect((params.volumes!["/data"] as unknown as FakeVolume).readOnly).toBe(
      true
    );
    const policy =
      params.experimentalOutboundPolicy as unknown as FakeOutboundPolicy;
    expect(policy.replacements).toEqual([
      { domain: "api.github.com", headers: { "X-Static": "v$$1" } },
      {
        domain: "api.github.com",
        headers: { Authorization: "$GH" },
        secret: { name: "gh-token", secretId: "st-gh-token" },
      },
    ]);
  });

  it("block-all → blockNetwork; fromSnapshot/template ids → images.fromId", async () => {
    const p = modal({});
    const a = await p.create({ network: { mode: "block-all" } }, ctx);
    const snap = await a.snapshot!({}, ctx);
    expect(snap.id).toMatch(/^im-/);
    expect(snap.includesMemory).toBe(false);
    await a.writeFile("/tmp/m", enc.encode("x"), ctx);
    await p.create({ fromSnapshot: snap.id }, ctx);
    expect(world.creates[0]!.params.blockNetwork).toBe(true);
    expect(world.creates[1]!.image.imageId).toBe(snap.id);
  });

  it("ResourceExhaustedError (0.11 blocking create) maps to QuotaExceeded", async () => {
    world.exhausted = true;
    const client = createSandboxClient({
      provider: modal({}),
      retry: { retries: 0 },
      telemetry: false,
    });
    await expect(client.create()).rejects.toMatchObject({
      code: "QuotaExceeded",
    });
  });

  it("a retried create with the same idempotency key returns the same sandbox", async () => {
    const p = modal({});
    const a = await p.create({}, { ...ctx, idempotencyKey: "same" });
    const b = await p.create({}, { ...ctx, idempotencyKey: "same" });
    expect(b.id).toBe(a.id);
  });

  it("getInfo polls live state; list filters by tags/state/limit", async () => {
    const p = modal({});
    const hs = [];
    for (let i = 0; i < 4; i++) {
      hs.push(await p.create({ metadata: { g: i % 2 ? "odd" : "even" } }, ctx));
    }
    expect((await hs[0]!.getInfo(ctx)).state).toBe("running");
    await hs[0]!.destroy(ctx);
    expect((await hs[0]!.getInfo(ctx)).state).toBe("destroyed");
    const ids = async (f: Parameters<NonNullable<typeof p.list>>[0]) => {
      const out: string[] = [];
      for await (const s of p.list!(f, ctx)) {
        out.push(s.id);
      }
      return out;
    };
    expect(await ids({ metadata: { g: "even" } })).toEqual([hs[2]!.id]);
    expect(await ids({ limit: 2 })).toHaveLength(2);
    expect(await ids({ state: "stopped" })).toEqual([]);
  });

  it("previews: tunnel for declared ports, connect-token query auth otherwise", async () => {
    const client = createSandboxClient({
      provider: modal({}),
      telemetry: false,
    });
    const sb = await client.create({ ports: [3000] });
    const pub = await sb.ports.expose(3000);
    expect(pub.auth).toEqual({ type: "public" });
    const priv = await sb.ports.expose(3000, { visibility: "private" });
    expect(priv.auth).toEqual({
      param: CONNECT_TOKEN_PARAM,
      token: "ctok",
      type: "query",
    });
  });

  it("filesystem watch maps events", async () => {
    const p = modal({});
    const h = await p.create({}, ctx);
    const events: string[] = [];
    const close = await h.watch!(
      "/tmp",
      (e) => events.push(`${e.type}:${e.path}`),
      false,
      ctx
    );
    await h.writeFile("/tmp/a", enc.encode("1"), ctx);
    await h.writeFile("/tmp/a", enc.encode("2"), ctx);
    await new Promise((r) => setTimeout(r, 10));
    await close();
    expect(events).toEqual(["create:/tmp/a", "modify:/tmp/a"]);
  });

  it("templates: Dockerfile → fromRegistry + dockerfileCommands, published by cache key", async () => {
    const client = createSandboxClient({
      provider: modal({ environment: "dev" }),
      telemetry: false,
    });
    const ref = await client.templates.build({
      env: { X: "1" },
      source: { dockerfile: "FROM python:3.12-slim\nRUN pip install numpy\n" },
      workdir: "/app",
    });
    expect(ref.id).toMatch(/^im-/);
    const img = world.images.get(ref.id)!;
    expect(img.tag).toBe("python:3.12-slim");
    expect(img.layers).toEqual([
      "RUN pip install numpy",
      'ENV X="1"',
      "WORKDIR /app",
    ]);
    expect(world.published.get(templateImageName(ref.cacheKey!))).toBe(img);
    expect(world.publishEnvs).toEqual(["dev"]);
    const again = await client.templates.build({
      env: { X: "1" },
      source: { dockerfile: "FROM python:3.12-slim\nRUN pip install numpy\n" },
      workdir: "/app",
    });
    expect(again.id).toBe(ref.id);
    await expect(
      client.templates.build({
        source: { context: { a: "b" }, dockerfile: "FROM a\nCOPY a /a\n" },
      })
    ).rejects.toMatchObject({ code: "Validation" });
  });

  it("volumes paginate through cpClient.volumeList", async () => {
    for (let i = 0; i < 150; i++) {
      world.volumes.set(`v${i}`, new FakeVolume(`vo-${i}`, `v${i}`));
    }
    const p = modal({});
    let n = 0;
    for await (const _v of p.volumes!.list(ctx)) {
      n++;
    }
    expect(n).toBe(150);
    expect((await p.volumes!.get("vo-149", ctx))?.name).toBe("v149");
    expect(await p.volumes!.get("nope", ctx)).toBeUndefined();
    await p.volumes!.delete("vo-3", ctx);
    expect(world.volumes.has("v3")).toBe(false);
  });
});

describe("modal: conformance (offline, fake SDK)", () => {
  it("declares its capabilities", () => {
    const p = modal({});
    expect(p.capabilities).toBe(MODAL_CAPS);
    expect(p.flags.previewBrowserAuth).toBe(true);
  });

  it("passes the shared suite through the adapter", async () => {
    const report = await runConformance(
      modal({ tokenId: "i", tokenSecret: "s" }),
      {
        live: true,
        template: {
          env: { A: "1" },
          source: { image: "debian:bookworm-slim" },
        },
      }
    );
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed).toEqual([]);
    expect(report.checks.length).toBeGreaterThan(35);
  }, 60_000);
});
