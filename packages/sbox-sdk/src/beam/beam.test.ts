/**
 * Offline tests for the Beam adapter. `@beamcloud/beam-js` is replaced by a
 * fake modelled on the real 1.1.x method names and argument shapes (`Sandbox`,
 * `SandboxInstance`, `SandboxProcess`, `SandboxFileSystem`, `Image`, `Volume`,
 * `beamOpts`, `BeamClient`), typed against the SDK's own declarations where
 * the classes allow it. Exec runs through MiniShell over an in-memory fs, so
 * the full conformance suite runs offline.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type {
  CreateStubConfig,
  Image as RealImage,
  SandboxFileSystem as RealFs,
  SandboxInstance as RealInstance,
  SandboxProcess as RealProcess,
} from "@beamcloud/beam-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runConformance } from "../conformance/index.js";
import { createSandboxClient } from "../internal/client.js";
import { MiniShell } from "../memory/shell.js";
import type { ShellFs } from "../memory/shell.js";
import {
  BEAM_CAPS,
  beam,
  beamNetwork,
  isBeamImageId,
  mapBeamError,
  mapBeamStatus,
} from "./index.js";

// ---------------------------------------------------------------------------
// in-memory filesystem
// ---------------------------------------------------------------------------

function norm(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") {
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
function parentOf(p: string): string {
  const n = norm(p);
  return n.slice(0, n.lastIndexOf("/")) || "/";
}
function baseOf(p: string): string {
  const n = norm(p);
  return n.slice(n.lastIndexOf("/") + 1);
}

class MemFs implements ShellFs {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>(["/", "/tmp", "/home", "/app"]);

  clone(): MemFs {
    const c = new MemFs();
    c.files = new Map(this.files);
    c.dirs = new Set(this.dirs);
    return c;
  }
  isDir(p: string): boolean {
    return this.dirs.has(norm(p));
  }
  read(p: string): Uint8Array | null {
    return this.files.get(norm(p)) ?? null;
  }
  write(p: string, d: Uint8Array): void {
    let cur = parentOf(p);
    while (!this.dirs.has(cur)) {
      this.dirs.add(cur);
      cur = parentOf(cur);
    }
    this.files.set(norm(p), d);
  }
  list(d: string): { name: string; type: "file" | "dir" }[] | null {
    const dir = norm(d);
    if (!this.dirs.has(dir)) {
      return null;
    }
    const out: { name: string; type: "file" | "dir" }[] = [];
    for (const x of this.dirs) {
      if (x !== dir && parentOf(x) === dir) {
        out.push({ name: baseOf(x), type: "dir" });
      }
    }
    for (const f of this.files.keys()) {
      if (parentOf(f) === dir) {
        out.push({ name: baseOf(f), type: "file" });
      }
    }
    return out;
  }
  mkdir(p: string, recursive: boolean): string | null {
    const n = norm(p);
    if (this.dirs.has(n)) {
      return recursive ? null : "exists";
    }
    if (!recursive && !this.dirs.has(parentOf(n))) {
      return "no parent";
    }
    let cur = n;
    while (!this.dirs.has(cur)) {
      this.dirs.add(cur);
      cur = parentOf(cur);
    }
    return null;
  }
  remove(p: string, recursive: boolean, force: boolean): string | null {
    const n = norm(p);
    if (this.files.delete(n)) {
      return null;
    }
    if (this.dirs.has(n)) {
      if (!recursive) {
        return "is a directory";
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
    return force ? null : "no such file";
  }
  rename(a: string, b: string): string | null {
    const from = norm(a);
    const data = this.files.get(from);
    if (data) {
      this.files.delete(from);
      this.write(b, data);
      return null;
    }
    return "no such file";
  }
  stat(p: string): { type: "file" | "dir"; size: number } | null {
    const n = norm(p);
    if (this.dirs.has(n)) {
      return { size: 0, type: "dir" };
    }
    const f = this.files.get(n);
    return f ? { size: f.length, type: "file" } : null;
  }
}

// ---------------------------------------------------------------------------
// fake @beamcloud/beam-js
// ---------------------------------------------------------------------------

class SandboxConnectionError extends Error {
  override name = "SandboxConnectionError";
}
class SandboxFileSystemError extends Error {
  override name = "SandboxFileSystemError";
}
class SandboxProcessError extends Error {
  override name = "SandboxProcessError";
}

const world = {
  calls: [] as string[],
  checkpoints: new Map<string, MemFs>(),
  configs: [] as CreateStubConfig[],
  counter: 0,
  images: new Map<string, MemFs>(),
  imageBuilds: 0,
  instances: new Map<string, FakeInstance>(),
  network: [] as { blockNetwork: boolean; allowList?: string[] }[],
  ttl: [] as number[],
  workspaceCalls: 0,
};

const beamOpts = {
  gatewayUrl: "https://app.beam.cloud",
  timeout: 30_000,
  token: "",
  workspaceId: "",
};

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Mirrors SandboxProcessStream: polls the process's output buffer. */
class FakeStream {
  #seen = 0;
  readonly proc: FakeProcess;
  readonly which: "out" | "err";
  constructor(proc: FakeProcess, which: "out" | "err") {
    this.proc = proc;
    this.which = which;
  }
  #next(): string {
    const all = this.which === "out" ? this.proc.out : this.proc.err;
    const chunk = all.slice(this.#seen);
    this.#seen = all.length;
    return chunk;
  }
  async read(): Promise<string> {
    return this.#next();
  }
  async *[Symbol.asyncIterator](): AsyncIterableIterator<string> {
    for (;;) {
      const chunk = this.#next();
      if (chunk) {
        yield chunk;
        continue;
      }
      if (this.proc.exitCode >= 0) {
        const last = this.#next();
        if (last) {
          yield last;
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

class FakeProcess implements Pick<
  RealProcess,
  | "pid"
  | "exitCode"
  | "command"
  | "running"
  | "cwd"
  | "wait"
  | "kill"
  | "status"
> {
  exitCode = -1;
  running = true;
  out = "";
  err = "";
  cwd: string;
  readonly #ac = new AbortController();
  readonly #done: Promise<number>;
  readonly inst: FakeInstance;
  readonly pid: number;
  readonly command: string;
  constructor(
    inst: FakeInstance,
    pid: number,
    command: string,
    opts: { cwd?: string; env?: Record<string, string> } = {}
  ) {
    this.inst = inst;
    this.pid = pid;
    this.command = command;
    this.cwd = opts.cwd ?? "/";
    const shell = new MiniShell(inst.memfs);
    this.#done = shell
      .run(command, {
        cwd: this.cwd,
        env: { ...inst.env, ...opts.env },
        signal: this.#ac.signal,
        stderr: (d) => {
          this.err += dec.decode(d);
        },
        stdin: new Uint8Array(),
        stdout: (d) => {
          this.out += dec.decode(d);
        },
      })
      .then((code) => {
        this.exitCode = this.#ac.signal.aborted ? 137 : code;
        this.running = false;
        return this.exitCode;
      });
  }
  async wait(): Promise<number> {
    return this.#done;
  }
  async kill(): Promise<void> {
    world.calls.push(`kill:${this.pid}`);
    this.#ac.abort();
  }
  async status(): Promise<[number, string]> {
    return [this.exitCode, this.running ? "RUNNING" : "EXITED"];
  }
  async poll(): Promise<[number, string]> {
    return this.status();
  }
  get stdout(): FakeStream {
    return new FakeStream(this, "out");
  }
  get stderr(): FakeStream {
    return new FakeStream(this, "err");
  }
}

function fileInfo(name: string, isDir: boolean, size: number) {
  return {
    group: "root",
    isDir,
    modTime: 1_700_000_000,
    mode: isDir ? 0o755 : 0o644,
    name,
    owner: "root",
    permissions: isDir ? 0o755 : 0o644,
    size,
    toString: () => name,
  };
}

class FakeFs implements Pick<
  RealFs,
  | "writeBytes"
  | "readBytes"
  | "statFile"
  | "listFiles"
  | "createDirectory"
  | "deleteDirectory"
  | "deleteFile"
> {
  readonly inst: FakeInstance;
  constructor(inst: FakeInstance) {
    this.inst = inst;
  }
  get m(): MemFs {
    return this.inst.memfs;
  }
  async writeBytes(path: string, content: Uint8Array | string): Promise<void> {
    if (!this.m.isDir(parentOf(path))) {
      throw new SandboxFileSystemError("open: no such file or directory");
    }
    this.m.files.set(
      norm(path),
      typeof content === "string"
        ? enc.encode(content)
        : new Uint8Array(content)
    );
  }
  async readBytes(path: string): Promise<Buffer> {
    const f = this.m.read(path);
    if (!f) {
      throw new SandboxFileSystemError("file not found");
    }
    return Buffer.from(f);
  }
  async statFile(path: string) {
    const s = this.m.stat(path);
    if (!s) {
      throw new SandboxFileSystemError("stat: no such file or directory");
    }
    return fileInfo(baseOf(path), s.type === "dir", s.size);
  }
  async listFiles(path: string) {
    const entries = this.m.list(path);
    if (!entries) {
      throw new SandboxFileSystemError("not a directory");
    }
    return entries.map((e) =>
      fileInfo(
        e.name,
        e.type === "dir",
        this.m.read(join(path, e.name))?.length ?? 0
      )
    );
  }
  async createDirectory(path: string): Promise<void> {
    const err = this.m.mkdir(path, false);
    if (err) {
      throw new SandboxFileSystemError(err);
    }
  }
  async deleteDirectory(path: string): Promise<void> {
    if (this.m.remove(path, true, false)) {
      throw new SandboxFileSystemError("no such directory");
    }
  }
  async deleteFile(path: string): Promise<void> {
    if (this.m.remove(path, false, false)) {
      throw new SandboxFileSystemError("no such file");
    }
  }
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

class FakeInstance implements Pick<
  RealInstance,
  | "containerId"
  | "stubId"
  | "terminated"
  | "sandboxId"
  | "updateTtl"
  | "exposePort"
  | "listUrls"
  | "updateNetworkPermissions"
  | "snapshot"
  | "createImageFromFilesystem"
  | "terminate"
> {
  terminated = false;
  stubId = "stub_1";
  readonly fs: FakeFs;
  readonly urls: Record<number, string> = {};
  processes: Record<number, FakeProcess> = {};
  #pid = 100;
  readonly containerId: string;
  memfs: MemFs;
  readonly env: Record<string, string>;
  constructor(
    containerId: string,
    memfs: MemFs,
    env: Record<string, string> = {}
  ) {
    this.containerId = containerId;
    this.memfs = memfs;
    this.env = env;
    this.fs = new FakeFs(this);
    world.instances.set(containerId, this);
  }
  get sandboxId(): string {
    return this.containerId;
  }
  async exec(
    command: string | string[],
    opts?: { cwd?: string; env?: Record<string, string> }
  ): Promise<FakeProcess> {
    const text = Array.isArray(command)
      ? command.map(shellQuote).join(" ")
      : command;
    return this.execShell(text, opts);
  }
  async execShell(
    command: string,
    opts?: { cwd?: string; env?: Record<string, string> }
  ): Promise<FakeProcess> {
    this.assertLive();
    const p = new FakeProcess(this, ++this.#pid, command, opts);
    this.processes[p.pid] = p;
    return p;
  }
  /** Python is simulated by running the code through the shell. */
  async runCode(
    code: string,
    blocking = true,
    cwd?: string,
    env?: Record<string, string>
  ) {
    const p = await this.execShell(code, { cwd, env });
    if (!blocking) {
      return p;
    }
    const exitCode = await p.wait();
    return {
      exitCode,
      pid: p.pid,
      result: p.out + p.err,
      stderr: p.err,
      stdout: p.out,
    };
  }
  async listProcesses(): Promise<FakeProcess[]> {
    this.assertLive();
    return Object.values(this.processes).filter((p) => p.running);
  }
  getProcess(pid: number): FakeProcess {
    const p = this.processes[pid];
    if (!p) {
      throw new SandboxProcessError(`Process with pid ${pid} not found`);
    }
    return p;
  }
  async updateTtl(ttl: number): Promise<void> {
    world.ttl.push(ttl);
  }
  async exposePort(port: number): Promise<string> {
    const url = `https://${this.containerId}-${port}.app.beam.cloud`;
    this.urls[port] = url;
    return url;
  }
  async listUrls(): Promise<Record<number, string>> {
    return { ...this.urls };
  }
  async updateNetworkPermissions(
    blockNetwork = false,
    allowList?: string[]
  ): Promise<void> {
    if (blockNetwork && allowList !== undefined) {
      throw new Error(
        "Cannot specify both 'blockNetwork=true' and 'allowList'."
      );
    }
    world.network.push({ allowList, blockNetwork });
  }
  async snapshot(): Promise<string> {
    const id = `ckpt_${++world.counter}`;
    world.checkpoints.set(id, this.memfs.clone());
    return id;
  }
  async createImageFromFilesystem(): Promise<string> {
    const id = (++world.counter).toString(16).padStart(16, "a");
    world.images.set(id, this.memfs.clone());
    return id;
  }
  async terminate(): Promise<boolean> {
    world.instances.delete(this.containerId);
    this.terminated = true;
    return true;
  }
  assertLive(): void {
    if (!world.instances.has(this.containerId)) {
      throw new SandboxProcessError("container not found");
    }
  }
}

class FakeImage implements Pick<RealImage, "id" | "exists" | "build"> {
  id = "";
  config: {
    baseImage?: string;
    dockerfile?: string;
    context?: Map<string, Uint8Array>;
    imageId?: string;
    envVars?: Record<string, string>;
  } = {};
  static fromRegistry(uri: string, creds?: Record<string, string>): FakeImage {
    const i = new FakeImage();
    i.config.baseImage = uri;
    world.calls.push(`fromRegistry:${uri}${creds ? ":creds" : ""}`);
    return i;
  }
  static async fromDockerfile(
    path: string,
    contextDir?: string
  ): Promise<FakeImage> {
    const i = new FakeImage();
    i.config.dockerfile = readFileSync(path, "utf-8");
    const dir = contextDir ?? dirname(path);
    i.config.context = new Map();
    for (const line of i.config.dockerfile.split("\n")) {
      const m = /^COPY\s+(\S+)\s+(\S+)/.exec(line);
      if (m?.[1]) {
        i.config.context.set(
          m[2]!,
          new Uint8Array(readFileSync(join(dir, m[1])))
        );
      }
    }
    return i;
  }
  static fromId(id: string): FakeImage {
    const i = new FakeImage();
    i.config.imageId = id;
    return i;
  }
  withEnvs(env: Record<string, string>): FakeImage {
    this.config.envVars = env;
    return this;
  }
  #key(): string {
    if (this.config.imageId) {
      return this.config.imageId;
    }
    const raw = JSON.stringify({
      b: this.config.baseImage,
      d: this.config.dockerfile,
      e: this.config.envVars,
    });
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
  }
  async exists() {
    const id = this.#key();
    const exists = world.images.has(id);
    return {
      exists,
      result: { imageId: exists ? id : undefined, success: exists },
    };
  }
  async build() {
    const id = this.#key();
    if (!world.images.has(id)) {
      world.imageBuilds++;
      const fs = new MemFs();
      for (const [dest, data] of this.config.context ?? []) {
        fs.write(dest, data);
      }
      world.images.set(id, fs);
    }
    this.id = id;
    return { imageId: id, success: true };
  }
}

class FakeVolume {
  readonly name: string;
  readonly mountPath: string;
  constructor(name: string, mountPath: string) {
    this.name = name;
    this.mountPath = mountPath;
  }
}

class FakeSandbox {
  readonly config: CreateStubConfig;
  constructor(config: CreateStubConfig) {
    this.config = config;
  }
  async create(): Promise<FakeInstance> {
    world.configs.push(this.config);
    let fs = new MemFs();
    const img = this.config.image as unknown as FakeImage | undefined;
    if (img) {
      const id = img.config.imageId ?? (await img.build()).imageId;
      const base = world.images.get(id);
      if (!base && img.config.imageId) {
        throw new SandboxConnectionError(`image ${id} not found`);
      }
      if (base) {
        fs = base.clone();
        for (const d of ["/tmp", "/home", "/app"]) {
          fs.dirs.add(d);
        }
      }
    }
    const env = Array.isArray(this.config.env) ? {} : { ...this.config.env };
    return new FakeInstance(`sandbox-${++world.counter}`, fs, env);
  }
  static async connect(id: string): Promise<FakeInstance> {
    const inst = world.instances.get(id);
    if (!inst) {
      throw new SandboxConnectionError("container not found");
    }
    return inst;
  }
  static async createFromSnapshot(snapshotId: string): Promise<FakeInstance> {
    const fs = world.checkpoints.get(snapshotId);
    if (!fs) {
      throw new SandboxConnectionError("checkpoint not found");
    }
    return new FakeInstance(`sandbox-${++world.counter}`, fs.clone());
  }
  static async terminate(id: string): Promise<boolean> {
    return world.instances.delete(id);
  }
}

const BeamClient = {
  async _getWorkspace() {
    world.workspaceCalls++;
    if (!beamOpts.token) {
      throw new Error("Beam token is not set");
    }
    return { name: "my-workspace" };
  },
  async request(config: { method?: string; url?: string }) {
    if (!beamOpts.token) {
      throw new Error("Beam token is not set");
    }
    if (
      config.method === "GET" &&
      config.url === "/api/v1/gateway/containers"
    ) {
      return {
        data: {
          containers: [...world.instances.keys()].map((containerId) => ({
            containerId,
            scheduledAt: "2026-11-22T10:00:00Z",
            status: "RUNNING",
          })),
          ok: true,
        },
      };
    }
    throw new Error(`unexpected request ${config.method} ${config.url}`);
  },
};

const fakeModule = {
  BeamClient,
  Image: FakeImage,
  Sandbox: FakeSandbox,
  SandboxConnectionError,
  SandboxFileSystemError,
  SandboxInstance: FakeInstance,
  SandboxProcess: FakeProcess,
  SandboxProcessError,
  Volume: FakeVolume,
  beamOpts,
  default: BeamClient,
};

vi.mock("@beamcloud/beam-js", () => fakeModule);

beforeEach(() => {
  world.configs = [];
  world.network = [];
  world.calls = [];
  world.ttl = [];
});

const make = () => beam({ token: "t", workspaceId: "w" });

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("beam adapter (offline)", () => {
  it("declares truthful capabilities", () => {
    const p = make();
    expect(p.name).toBe("beam");
    expect(p.capabilities).toBe(BEAM_CAPS);
    expect(p.capabilities.streaming).toBe("native");
    expect(p.capabilities.list).toBe("unsupported");
    expect(p.flags.templateSources).toEqual(["dockerfile", "image"]);
    expect(p.flags.previewBrowserAuth).toBe(false);
  });

  it("passes the conformance suite against the fake SDK", async () => {
    const report = await runConformance(make(), {
      live: true,
      template: {
        source: {
          context: { "hello.txt": "hi" },
          dockerfile:
            "FROM debian:bookworm-slim\nCOPY hello.txt /app/hello.txt\n",
        },
      },
    });
    const failed = report.checks.filter((c) => !c.ok);
    expect(JSON.stringify(failed, null, 2)).toBe("[]");
    expect(report.checks.length).toBeGreaterThan(30);
  }, 60_000);

  it("maps a rich spec onto the stub config", async () => {
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const sb = await client.create({
      env: { A: "1" },
      lifecycle: { maxAgeMs: 120_000 },
      metadata: { team: "x" },
      name: "my-app",
      network: { cidrs: ["8.8.8.8/32"], mode: "allow-list" },
      ports: [8080],
      resources: { gpu: "A10G", memoryMB: 2048, vcpus: 2 },
      secrets: [
        { name: "OPENAI_KEY", mode: "egress" },
        { name: "INLINE", value: "s3cret" },
      ],
      template: "python:3.12-slim",
      volumes: [{ id: "weights", mountPath: "/mnt/weights" }],
    });
    const cfg = world.configs.at(-1)!;
    expect(cfg).toMatchObject({
      allowList: ["8.8.8.8/32"],
      blockNetwork: false,
      cpu: 2,
      env: { A: "1", INLINE: "s3cret" },
      gpu: "A10G",
      gpuCount: 1,
      keepWarmSeconds: 120,
      memory: 2048,
      name: "my-app",
      ports: [8080],
      secrets: [{ name: "OPENAI_KEY" }],
    });
    expect(cfg.volumes?.map((v) => [v.name, v.mountPath])).toEqual([
      ["weights", "/mnt/weights"],
    ]);
    expect(world.calls).toContain("fromRegistry:python:3.12-slim");
    expect((await sb.getInfo()).metadata).toEqual({ team: "x" });
    await sb.destroy();
    expect((await sb.getInfo()).state).toBe("destroyed");
  });

  it("defaults the lifetime and app name, and boots image ids via fromId", async () => {
    const p = make();
    const client = createSandboxClient({ provider: p, telemetry: false });
    const src = await client.create();
    const snap = await src.snapshots!.create({ mode: "filesystem" });
    expect(snap.includesMemory).toBe(false);
    expect(snap.id.startsWith("image:")).toBe(true);
    expect(world.configs.at(-1)).toMatchObject({
      keepWarmSeconds: 600,
      name: "sbox",
    });
    await src.files.write("/tmp/after.txt", "x");
    const restored = await client.create({ fromSnapshot: snap });
    expect(await restored.files.exists("/tmp/after.txt")).toBe(false);
    const mem = await src.snapshots!.create();
    expect(mem.includesMemory).toBe(true);
    const fromMem = await client.create({ fromSnapshot: mem });
    expect(await (await fromMem.files.read("/tmp/after.txt")).text()).toBe("x");
  });

  it("rejects settings Beam cannot honor instead of dropping them", async () => {
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const cases = [
      { lifecycle: { idleTimeoutMs: 60_000 } },
      { lifecycle: { onIdle: "pause" as const } },
      { region: "eu" },
      { volumes: [{ id: "v", mountPath: "/v", readOnly: true }] },
      { secrets: [{ envVar: "OTHER", name: "S" }] },
      { resources: { gpu: "TPUv5" } },
      { network: { deny: { domains: ["x.com"] }, mode: "allow-all" as const } },
    ];
    for (const spec of cases) {
      await expect(client.create(spec)).rejects.toMatchObject({
        code: "Validation",
      });
    }
  });

  it("writes into missing parent directories natively", async () => {
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const sb = await client.create();
    await sb.files.write("/tmp/a/b/c.txt", "deep");
    expect(await (await sb.files.read("/tmp/a/b/c.txt")).text()).toBe("deep");
    expect((await sb.files.stat("/tmp/a/b/c.txt")).mtime).toBeInstanceOf(Date);
  });

  it("streams stdout/stderr separately and runs code", async () => {
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const sb = await client.create();
    const out: string[] = [];
    const res = await sb.code!.runCode(
      "echo 42; echo 'ValueError: bad' >&2; exit 1",
      {
        onStdout: (c) => out.push(c),
      }
    );
    expect(out.join("")).toBe("42\n");
    expect(res.error).toMatchObject({ name: "ValueError", value: "bad" });
    await expect(
      sb.code!.runCode("1", { language: "javascript" })
    ).rejects.toMatchObject({
      code: "Validation",
    });
  });

  it("lists processes and exposed URLs", async () => {
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const sb = await client.create();
    const p = await sb.commands.spawn("sleep 30");
    expect((await sb.commands.list()).map((x) => x.id)).toContain(p.id);
    await sb.commands.kill(p.id);
    await p.wait();
    await sb.ports!.expose(3000);
    expect(await sb.ports!.list()).toEqual([
      expect.objectContaining({ auth: { type: "public" }, port: 3000 }),
    ]);
    await expect(sb.commands.kill("99999")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  it("maps egress policies to blockNetwork/allowList", async () => {
    expect(beamNetwork({ mode: "allow-all" })).toEqual({
      allowList: [],
      blockNetwork: false,
    });
    expect(beamNetwork({ mode: "block-all" })).toEqual({ blockNetwork: true });
    expect(
      beamNetwork({ domains: ["api.openai.com"], mode: "allow-list" })
    ).toEqual({
      allowList: ["api.openai.com"],
      blockNetwork: false,
    });
    expect(beamNetwork({ mode: "allow-list" })).toEqual({ blockNetwork: true });
    expect(() =>
      beamNetwork({
        domains: Array.from({ length: 65 }, (_, i) => `h${i}.com`),
        mode: "allow-list",
      })
    ).toThrow(/at most 64/);
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const sb = await client.create();
    await sb.network!.setEgressPolicy({ mode: "block-all" });
    expect(world.network.at(-1)).toEqual({
      allowList: undefined,
      blockNetwork: true,
    });
  });

  it("builds templates once and reuses them by content", async () => {
    const p = make();
    const spec = { source: { image: "node:22-slim" }, env: { X: "1" } };
    const client = createSandboxClient({ provider: p, telemetry: false });
    const before = world.imageBuilds;
    const ref = await client.templates!.build(spec);
    const events: string[] = [];
    // A fresh client (no in-process memo) still finds the image via exists().
    const other = createSandboxClient({ provider: make(), telemetry: false });
    const ref2 = await other.templates!.build(spec, {
      onEvent: (e) => events.push(e.type === "status" ? e.status : "log"),
    });
    expect(ref2.id).toBe(ref.id);
    expect(world.imageBuilds - before).toBe(1);
    expect(events).toContain("cached");
    expect(await client.templates!.get(ref.id)).toMatchObject({ id: ref.id });
    expect(isBeamImageId(ref.id)).toBe(true);
    await expect(
      client.templates!.build({ source: { image: "x" }, startCmd: "srv" })
    ).rejects.toMatchObject({ code: "Validation" });
  });

  it("verifies credentials without creating", async () => {
    const before = world.instances.size;
    const res = await createSandboxClient({
      provider: make(),
      telemetry: false,
    }).verify();
    expect(res).toEqual({
      account: "my-workspace",
      ok: true,
      provider: "beam",
    });
    expect(world.instances.size).toBe(before);
  });

  it("refuses a second token in one process", async () => {
    const client = createSandboxClient({
      provider: beam({ token: "other", workspaceId: "w" }),
      telemetry: false,
    });
    const res = await client.verify();
    expect(res.ok).toBe(false);
  });

  it("maps statuses", () => {
    expect(mapBeamStatus("RUNNING")).toBe("running");
    expect(mapBeamStatus("PENDING")).toBe("creating");
    expect(mapBeamStatus("STOPPING")).toBe("stopped");
    expect(mapBeamStatus("FAILED")).toBe("error");
    expect(mapBeamStatus("weird")).toBe("unknown");
    expect(mapBeamStatus(undefined)).toBe("unknown");
  });

  it("maps errors", () => {
    const http = (status: number) =>
      Object.assign(new Error(`HTTP ${status}`), {
        isAxiosError: true,
        response: { status },
      });
    expect(mapBeamError(http(401))?.code).toBe("Unauthorized");
    expect(mapBeamError(http(403))?.code).toBe("Unauthorized");
    expect(mapBeamError(http(404))?.code).toBe("NotFound");
    expect(mapBeamError(http(409))?.code).toBe("Conflict");
    const quota = mapBeamError(http(429));
    expect(quota?.code).toBe("QuotaExceeded");
    expect(quota?.retryable).toBe(true);
    expect(
      mapBeamError(Object.assign(new Error("t"), { code: "ECONNABORTED" }))
        ?.code
    ).toBe("Timeout");
    expect(mapBeamError(new Error("Beam token is not set"))?.code).toBe(
      "Unauthorized"
    );
    expect(
      mapBeamError(new SandboxConnectionError("container not found"))?.code
    ).toBe("NotFound");
    expect(mapBeamError(new Error("boom"))?.code).toBe("Provider");
  });
});
