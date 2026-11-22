/**
 * Offline tests for the Superserve adapter. `@superserve/sdk` is replaced by a
 * fake modeled on the real 0.13 `.d.ts` (method names, option shapes, error
 * class names). Each fake sandbox is backed by the in-memory provider, i.e.
 * MiniShell over an in-memory filesystem, so commands, files, snapshots and
 * template build steps really run.
 */
import type {
  BuildLogEvent,
  CommandResult,
  CommandSession,
  ConnectionOptions,
  NetworkConfig,
  PreviewToken,
  PublishedPreviewPort,
  Sandbox as RealSandbox,
  SandboxCreateOptions,
  SandboxInfo,
  SandboxListOptions,
  SandboxStatus,
  SandboxUpdateOptions,
  Snapshot as RealSnapshot,
  SnapshotCreateOptions,
  SnapshotInfo,
  SpawnOptions,
  Template as RealTemplate,
  TemplateCreateOptions,
  TemplateInfo,
  VolumeCreateOptions,
  VolumeInfo as SsVolumeInfo,
  WaitUntilReadyOptions,
} from "@superserve/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CallContext,
  DriverHandle,
  SandboxProvider,
} from "../adapter/index.js";
import { runConformance } from "../conformance/index.js";
import { memory } from "../memory/index.js";
import {
  dockerfileToBuildSpec,
  lifecycleOptions,
  mapSecrets,
  mapSuperserveError,
  mapSuperserveStatus,
  SUPERSERVE_CAPS,
  superserve,
  superserveTemplateName,
  toNetworkConfig,
} from "./index.js";

// ---------------------------------------------------------------------------
// fake SDK
// ---------------------------------------------------------------------------

class FakeError extends Error {
  readonly statusCode?: number;
  readonly code?: string;
  constructor(
    name: string,
    message: string,
    statusCode?: number,
    code?: string
  ) {
    super(message);
    // oxlint-disable-next-line unicorn/custom-error-definition -- mirrors the SDK's class names
    this.name = name;
    this.statusCode = statusCode;
    this.code = code;
  }
}
const notFound = (what: string) =>
  new FakeError("NotFoundError", `${what} not found`, 404);
const validation = (msg: string) => new FakeError("ValidationError", msg, 400);
const conflict = (msg: string) => new FakeError("ConflictError", msg, 409);

interface Call {
  method: string;
  args: unknown;
}

const backend = memory({ idPrefix: "ssmem" });
const memCtx = (): CallContext => ({ attempt: 1, fetch: globalThis.fetch });
const enc = new TextEncoder();
const dec = new TextDecoder();

interface SbRecord {
  id: string;
  name: string;
  status: SandboxStatus;
  metadata: Record<string, string>;
  env: Record<string, string>;
  network?: NetworkConfig;
  timeoutSeconds?: number;
  idleTimeoutSeconds?: number;
  autoDeleteSeconds?: number;
  secrets: Record<string, string>;
  createdAt: Date;
  mem: DriverHandle;
  ports: Map<number, PublishedPreviewPort>;
  sourceSnapshotId?: string;
}

interface SnapRecord extends SnapshotInfo {
  memSnap: string;
  env: Record<string, string>;
}

interface TplRecord extends TemplateInfo {
  memSnap?: string;
  env: Record<string, string>;
  logs: BuildLogEvent[];
  error?: string;
}

const state = {
  calls: [] as Call[],
  sandboxes: new Map<string, SbRecord>(),
  secrets: new Set<string>(),
  snapshots: new Map<string, SnapRecord>(),
  templates: new Map<string, TplRecord>(),
  volumes: new Map<string, SsVolumeInfo>(),
  seq: 0,
  reset() {
    this.calls = [];
    this.sandboxes.clear();
    this.snapshots.clear();
    this.templates.clear();
    this.volumes.clear();
    this.secrets.clear();
    this.templates.set("tpl-system", {
      createdAt: new Date(0),
      diskMib: 4096,
      env: {},
      id: "tpl-system",
      logs: [],
      memoryMib: 1024,
      name: "superserve/base",
      status: "ready",
      teamId: "system",
      vcpu: 1,
    });
  },
};
const record = (method: string, args: unknown) =>
  state.calls.push({ args, method });
const nextId = (p: string) =>
  `${p}-${(++state.seq).toString().padStart(6, "0")}`;

const PREVIEW_HOST = "sandbox.superserve.test";

function validateNetwork(n: NetworkConfig | undefined): void {
  for (const d of n?.denyOut ?? []) {
    if (!/^[\d.:a-f]+(\/\d+)?$/i.test(d)) {
      throw validation(`denyOut accepts IPs and CIDRs only, got ${d}`);
    }
  }
}

function infoOf(r: SbRecord): SandboxInfo {
  return {
    createdAt: r.createdAt,
    id: r.id,
    memoryMib: 1024,
    metadata: { ...r.metadata },
    name: r.name,
    previewAccess: "public",
    status: r.status,
    vcpuCount: 1,
    ...(r.network ? { network: r.network } : {}),
    ...(r.timeoutSeconds === undefined
      ? {}
      : { timeoutSeconds: r.timeoutSeconds }),
    ...(r.sourceSnapshotId ? { sourceSnapshotId: r.sourceSnapshotId } : {}),
  };
}

function rec(id: string): SbRecord {
  const r = state.sandboxes.get(id);
  if (!r) {
    throw notFound(`sandbox ${id}`);
  }
  return r;
}

async function activate(r: SbRecord): Promise<void> {
  if (r.status === "paused") {
    await r.mem.resume!(memCtx());
    r.status = "active";
  }
}

class FakeSession implements CommandSession {
  readonly stdin: CommandSession["stdin"];
  readonly #result: Promise<CommandResult>;
  readonly #ac = new AbortController();
  constructor(r: SbRecord, command: string, o: SpawnOptions) {
    const chunks: Uint8Array[] = [];
    let closeStdin!: () => void;
    const stdinClosed = new Promise<void>((res) => {
      closeStdin = res;
    });
    this.stdin = {
      close: () => closeStdin(),
      write: (d) => {
        chunks.push(typeof d === "string" ? enc.encode(d) : d);
      },
    };
    let timedOut = false;
    const timer =
      o.timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => {
              timedOut = true;
              this.#ac.abort();
            },
            Math.ceil(o.timeoutMs / 1000) * 1000
          );
    this.#result = (async () => {
      await Promise.race([
        stdinClosed,
        new Promise((res) => setTimeout(res, 20)),
      ]);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const stdin = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        stdin.set(c, off);
        off += c.length;
      }
      const ex = r.mem.exec(
        command,
        {
          cwd: o.cwd,
          env: { ...r.env, ...o.env },
          stdin,
        },
        memCtx()
      );
      if (this.#ac.signal.aborted) {
        void ex.kill();
      }
      this.#ac.signal.addEventListener("abort", () => void ex.kill(), {
        once: true,
      });
      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      for await (const ev of ex) {
        if (ev.type === "stdout") {
          stdout += ev.data;
          o.onStdout?.(ev.data);
        } else if (ev.type === "stderr") {
          stderr += ev.data;
          o.onStderr?.(ev.data);
        } else {
          exitCode = ev.exitCode;
        }
      }
      clearTimeout(timer);
      return {
        exitCode: timedOut ? 124 : exitCode,
        stderr,
        stdout,
        truncated: false,
      };
    })();
    this.#result.catch(() => {});
    o.signal?.addEventListener("abort", () => this.#ac.abort(), { once: true });
  }
  kill(signal = "SIGTERM"): void {
    record("session.kill", signal);
    this.#ac.abort();
  }
  wait(): Promise<CommandResult> {
    return this.#result;
  }
  async close(): Promise<void> {
    this.#ac.abort();
    await this.#result.catch(() => {});
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

type SandboxSurface = Pick<
  RealSandbox,
  | "id"
  | "name"
  | "status"
  | "metadata"
  | "getInfo"
  | "kill"
  | "pause"
  | "resume"
  | "update"
  | "snapshots"
  | "getPreviewUrl"
  | "publishPreviewPort"
  | "unpublishPreviewPort"
  | "listPreviewPorts"
  | "getPreviewToken"
>;

class FakeSnapshot implements Pick<
  RealSnapshot,
  | "id"
  | "sandboxId"
  | "kind"
  | "status"
  | "name"
  | "sizeBytes"
  | "resources"
  | "createdAt"
  | "delete"
> {
  readonly id: string;
  readonly sandboxId: string;
  readonly kind = "mem+fs" as const;
  readonly status = "ready" as const;
  readonly name?: string;
  readonly sizeBytes = 1;
  readonly resources = { diskMib: 4096, memoryMib: 1024, vcpuCount: 1 };
  readonly createdAt: Date;
  constructor(s: SnapshotInfo) {
    this.id = s.id;
    this.sandboxId = s.sandboxId;
    this.name = s.name;
    this.createdAt = s.createdAt;
  }
  async delete(): Promise<void> {
    record("Snapshot#delete", this.id);
    state.snapshots.delete(this.id);
  }
}

class FakeSandbox implements SandboxSurface {
  readonly id: string;
  readonly name: string;
  readonly status: SandboxStatus;
  readonly metadata: Record<string, string>;
  readonly commands: Pick<RealSandbox["commands"], "spawn">;
  readonly files: Pick<RealSandbox["files"], "read" | "write">;

  constructor(r: SbRecord) {
    this.id = r.id;
    this.name = r.name;
    this.status = r.status;
    this.metadata = { ...r.metadata };
    this.commands = {
      spawn: async (command: string, o: SpawnOptions = {}) => {
        record("commands.spawn", { command, options: o });
        const live = rec(this.id);
        await activate(live);
        return new FakeSession(live, command, o);
      },
    };
    this.files = {
      read: async (path: string) => {
        if (!path.startsWith("/")) {
          throw validation(`Path must start with "/": ${path}`);
        }
        const live = rec(this.id);
        await activate(live);
        try {
          return await live.mem.readFile(path, memCtx());
        } catch {
          throw notFound(`file ${path}`);
        }
      },
      write: async (path, content) => {
        if (!path.startsWith("/")) {
          throw validation(`Path must start with "/": ${path}`);
        }
        const live = rec(this.id);
        await activate(live);
        const bytes =
          typeof content === "string"
            ? enc.encode(content)
            : content instanceof Uint8Array
              ? content
              : content instanceof ArrayBuffer
                ? new Uint8Array(content)
                : new Uint8Array(await content.arrayBuffer());
        await live.mem.writeFile(path, bytes, memCtx());
      },
    };
  }

  static async create(options: SandboxCreateOptions): Promise<FakeSandbox> {
    record("Sandbox.create", options);
    if (!options.name) {
      throw validation("name is required");
    }
    if (options.fromTemplate && options.fromSnapshot) {
      throw validation("fromTemplate and fromSnapshot are mutually exclusive");
    }
    validateNetwork(options.network);
    if (
      options.idleTimeoutSeconds !== undefined &&
      (options.idleTimeoutSeconds < 60 || options.idleTimeoutSeconds > 604_800)
    ) {
      throw validation("idleTimeoutSeconds out of range");
    }
    for (const [envKey, secret] of Object.entries(options.secrets ?? {})) {
      if (!state.secrets.has(secret)) {
        throw new FakeError(
          "ValidationError",
          `secret_not_found: ${secret}`,
          400,
          "secret_not_found"
        );
      }
      if (options.envVars && envKey in options.envVars) {
        throw validation(`${envKey} is set by both envVars and secrets`);
      }
    }
    for (const v of options.volumes ?? []) {
      const id = typeof v.volume === "string" ? v.volume : v.volume.id;
      if (
        ![...state.volumes.values()].some((x) => x.id === id || x.name === id)
      ) {
        throw notFound(`volume ${id}`);
      }
    }
    let fromSnap: string | undefined;
    let baseEnv: Record<string, string> = {};
    if (options.fromSnapshot) {
      const id =
        typeof options.fromSnapshot === "string"
          ? options.fromSnapshot
          : options.fromSnapshot.id;
      const snap = state.snapshots.get(id);
      if (!snap) {
        throw notFound(`snapshot ${id}`);
      }
      fromSnap = snap.memSnap;
      baseEnv = snap.env;
    }
    if (options.fromTemplate) {
      const key =
        typeof options.fromTemplate === "string"
          ? options.fromTemplate
          : options.fromTemplate.id;
      const tpl = [...state.templates.values()].find(
        (t) => t.id === key || t.name === key
      );
      if (!tpl || tpl.status !== "ready") {
        throw notFound(`template ${key}`);
      }
      fromSnap = tpl.memSnap;
      baseEnv = tpl.env;
    }
    const mem = await backend.create(
      { metadata: {}, ...(fromSnap ? { fromSnapshot: fromSnap } : {}) },
      memCtx()
    );
    const r: SbRecord = {
      createdAt: new Date(Date.now() + state.seq),
      env: { ...baseEnv, ...options.envVars },
      id: nextId("sb"),
      mem,
      metadata: { ...options.metadata },
      name: options.name,
      ports: new Map(),
      secrets: { ...options.secrets },
      status: "active",
      ...(options.network ? { network: options.network } : {}),
      ...(options.timeoutSeconds === undefined
        ? {}
        : { timeoutSeconds: options.timeoutSeconds }),
      ...(options.idleTimeoutSeconds === undefined
        ? {}
        : { idleTimeoutSeconds: options.idleTimeoutSeconds }),
      ...(options.autoDeleteSeconds === undefined
        ? {}
        : { autoDeleteSeconds: options.autoDeleteSeconds }),
      ...(typeof options.fromSnapshot === "string"
        ? { sourceSnapshotId: options.fromSnapshot }
        : {}),
    };
    state.sandboxes.set(r.id, r);
    return new FakeSandbox(r);
  }

  static async connect(
    sandboxId: string,
    options: ConnectionOptions = {}
  ): Promise<FakeSandbox> {
    record("Sandbox.connect", { options, sandboxId });
    const r = rec(sandboxId);
    await activate(r);
    return new FakeSandbox(r);
  }

  static async list(options: SandboxListOptions = {}): Promise<SandboxInfo[]> {
    record("Sandbox.list", options);
    const statuses =
      options.status === undefined
        ? undefined
        : typeof options.status === "string"
          ? [options.status]
          : options.status;
    const rows = [...state.sandboxes.values()]
      .filter((r) => !statuses || statuses.includes(r.status))
      .filter((r) =>
        Object.entries(options.metadata ?? {}).every(
          ([k, v]) => r.metadata[k] === v
        )
      )
      .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const off = options.offset ?? 0;
    return rows
      .slice(off, options.limit === undefined ? undefined : off + options.limit)
      .map(infoOf);
  }

  async getInfo(): Promise<SandboxInfo> {
    return infoOf(rec(this.id));
  }

  async kill(): Promise<void> {
    record("Sandbox#kill", this.id);
    const r = state.sandboxes.get(this.id);
    if (r) {
      await r.mem.destroy(memCtx());
      state.sandboxes.delete(this.id);
    }
  }

  async pause(options: { wait?: boolean } = {}): Promise<void> {
    record("Sandbox#pause", options);
    const r = rec(this.id);
    if (r.status !== "active") {
      throw conflict(`sandbox is ${r.status}`);
    }
    await r.mem.pause!(memCtx());
    r.status = "paused";
  }

  async resume(): Promise<void> {
    record("Sandbox#resume", this.id);
    const r = rec(this.id);
    if (r.status === "active") {
      throw conflict("sandbox is already active");
    }
    await activate(r);
  }

  async update(options: SandboxUpdateOptions): Promise<void> {
    record("Sandbox#update", options);
    const r = rec(this.id);
    if (options.network) {
      if (r.status !== "active") {
        throw conflict("network changes need an active sandbox");
      }
      validateNetwork(options.network);
      r.network = options.network;
    }
    if (options.timeoutSeconds !== undefined) {
      r.timeoutSeconds = options.timeoutSeconds ?? undefined;
    }
    if (options.metadata) {
      r.metadata = { ...options.metadata };
    }
  }

  async snapshot(options: SnapshotCreateOptions = {}): Promise<FakeSnapshot> {
    record("Sandbox#snapshot", options);
    const r = rec(this.id);
    if (
      options.name !== undefined &&
      (options.name.length < 1 || options.name.length > 64)
    ) {
      throw validation("snapshot name must be 1-64 characters");
    }
    const memRef = await r.mem.snapshot!({ name: options.name }, memCtx());
    const s: SnapRecord = {
      createdAt: new Date(),
      env: { ...r.env },
      id: nextId("snap"),
      kind: "mem+fs",
      memSnap: memRef.id,
      resources: { diskMib: 4096, memoryMib: 1024, vcpuCount: 1 },
      sandboxId: r.id,
      sizeBytes: 1,
      status: "ready",
      ...(options.name ? { name: options.name } : {}),
    };
    state.snapshots.set(s.id, s);
    return new FakeSnapshot(s);
  }

  async snapshots(): Promise<SnapshotInfo[]> {
    return [...state.snapshots.values()]
      .filter((s) => s.sandboxId === this.id)
      .map(({ memSnap: _m, env: _e, ...s }) => s);
  }

  getPreviewUrl(port: number): string {
    if (
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65_535 ||
      port === 49_983
    ) {
      throw validation(`Invalid preview port ${port}`);
    }
    return `https://${port}-${this.id}.${PREVIEW_HOST}`;
  }

  async publishPreviewPort(
    port: number,
    options: { access?: "public" | "private" } = {}
  ): Promise<PublishedPreviewPort> {
    record("Sandbox#publishPreviewPort", { options, port });
    this.getPreviewUrl(port);
    const r = rec(this.id);
    const p = {
      access: options.access ?? r.ports.get(port)?.access ?? "public",
      port,
      tokenVersion: 1,
    };
    r.ports.set(port, p);
    return p;
  }

  async unpublishPreviewPort(port: number): Promise<void> {
    record("Sandbox#unpublishPreviewPort", port);
    rec(this.id).ports.delete(port);
  }

  async listPreviewPorts() {
    return {
      ports: [...rec(this.id).ports.values()],
      previewAccess: "public" as const,
    };
  }

  async getPreviewToken(
    port: number,
    options: { expiresInSeconds?: number } = {}
  ): Promise<PreviewToken> {
    record("Sandbox#getPreviewToken", { options, port });
    const p = rec(this.id).ports.get(port);
    if (!p) {
      throw notFound(`preview port ${port}`);
    }
    return {
      access: p.access,
      header: "X-Superserve-Preview-Token",
      port,
      previewAccess: "public",
      queryParam: "superserve_preview_token",
      token: `tok-${this.id}-${port}`,
      tokenVersion: p.tokenVersion,
      ...(options.expiresInSeconds
        ? { expiresAt: new Date(Date.now() + options.expiresInSeconds * 1000) }
        : {}),
    };
  }
}

class FakeTemplate implements Pick<
  RealTemplate,
  | "id"
  | "name"
  | "teamId"
  | "status"
  | "vcpu"
  | "memoryMib"
  | "diskMib"
  | "createdAt"
  | "waitUntilReady"
> {
  readonly id: string;
  readonly name: string;
  readonly teamId = "team";
  readonly status: TemplateInfo["status"];
  readonly vcpu: number;
  readonly memoryMib: number;
  readonly diskMib: number;
  readonly createdAt: Date;
  constructor(t: TplRecord) {
    this.id = t.id;
    this.name = t.name;
    this.status = t.status;
    this.vcpu = t.vcpu;
    this.memoryMib = t.memoryMib;
    this.diskMib = t.diskMib;
    this.createdAt = t.createdAt;
  }

  static async create(options: TemplateCreateOptions): Promise<FakeTemplate> {
    record("Template.create", options);
    if (!options.from) {
      throw validation("from is required");
    }
    if ([...state.templates.values()].some((t) => t.name === options.name)) {
      throw conflict(`template ${options.name} exists`);
    }
    for (const step of options.steps ?? []) {
      if (Object.keys(step).length !== 1) {
        throw validation("exactly one of run/env/workdir/user per step");
      }
    }
    const t: TplRecord = {
      createdAt: new Date(Date.now() + state.seq),
      diskMib: options.diskMib ?? 4096,
      env: {},
      id: nextId("tpl"),
      logs: [],
      memoryMib: options.memoryMib ?? 1024,
      name: options.name,
      status: "building",
      teamId: "team",
      vcpu: options.vcpu ?? 1,
    };
    state.templates.set(t.id, t);
    // "Build": run each step in a build VM, then snapshot it.
    const mem = await backend.create({ metadata: {} }, memCtx());
    let cwd = "/";
    const log = (text: string, stream: BuildLogEvent["stream"] = "stdout") =>
      t.logs.push({ stream, text, timestamp: new Date() });
    for (const step of options.steps ?? []) {
      if ("run" in step) {
        log(`RUN ${step.run.slice(0, 60)}`, "system");
        let out = "";
        let code = 0;
        for await (const ev of mem.exec(
          step.run,
          { cwd, env: t.env },
          memCtx()
        )) {
          if (ev.type === "exit") {
            code = ev.exitCode;
          } else {
            out += ev.data;
          }
        }
        if (out) {
          log(out);
        }
        if (code !== 0) {
          t.status = "failed";
          t.error = `step_failed: exit ${code}`;
          return new FakeTemplate(t);
        }
      } else if ("env" in step) {
        t.env[step.env.key] = step.env.value;
      } else if ("workdir" in step) {
        cwd = step.workdir;
        await mem.mkdir!(cwd, true, memCtx());
      }
    }
    t.memSnap = (await mem.snapshot!({}, memCtx())).id;
    t.status = "ready";
    t.builtAt = new Date();
    return new FakeTemplate(t);
  }

  static async connect(nameOrId: string): Promise<FakeTemplate> {
    record("Template.connect", nameOrId);
    const t = [...state.templates.values()].find(
      (x) => x.id === nameOrId || x.name === nameOrId
    );
    if (!t) {
      throw notFound(`template ${nameOrId}`);
    }
    return new FakeTemplate(t);
  }

  static async list(): Promise<TemplateInfo[]> {
    record("Template.list", undefined);
    return [...state.templates.values()].map(
      ({ memSnap: _m, env: _e, logs: _l, error: _x, ...t }) => t
    );
  }

  static async deleteById(nameOrId: string): Promise<void> {
    record("Template.deleteById", nameOrId);
    for (const [k, t] of state.templates) {
      if (t.id === nameOrId || t.name === nameOrId) {
        state.templates.delete(k);
      }
    }
  }

  async waitUntilReady(
    options: WaitUntilReadyOptions = {}
  ): Promise<TemplateInfo> {
    const t = state.templates.get(this.id);
    if (!t) {
      throw notFound(`template ${this.id}`);
    }
    for (const ev of t.logs) {
      options.onLog?.(ev);
    }
    if (t.status === "failed") {
      throw new FakeError("BuildError", t.error ?? "build failed");
    }
    const { memSnap: _m, env: _e, logs: _l, error: _x, ...info } = t;
    return info;
  }
}

const FakeVolume = {
  async create(options: VolumeCreateOptions): Promise<SsVolumeInfo> {
    record("Volume.create", options);
    const v: SsVolumeInfo = {
      capacityBytes: options.capacityBytes ?? 10 * 1_073_741_824,
      createdAt: new Date(),
      generation: 1,
      id: nextId("vol"),
      name: options.name,
      region: "use",
      status: "ready",
      updatedAt: new Date(),
      usedBytes: 0,
    };
    state.volumes.set(v.id, v);
    return v;
  },
  async connect(nameOrId: string): Promise<SsVolumeInfo> {
    const v = [...state.volumes.values()].find(
      (x) => x.id === nameOrId || x.name === nameOrId
    );
    if (!v) {
      throw notFound(`volume ${nameOrId}`);
    }
    return v;
  },
  async list(): Promise<SsVolumeInfo[]> {
    return [...state.volumes.values()];
  },
  async deleteById(nameOrId: string): Promise<void> {
    for (const [k, v] of state.volumes) {
      if (v.id === nameOrId || v.name === nameOrId) {
        state.volumes.delete(k);
      }
    }
  },
};

const fakeSdk = {
  Sandbox: FakeSandbox,
  Snapshot: {
    async deleteById(id: string) {
      record("Snapshot.deleteById", id);
      state.snapshots.delete(id);
    },
  },
  Template: FakeTemplate,
  Volume: FakeVolume,
} satisfies Partial<Record<keyof typeof import("@superserve/sdk"), unknown>>;

vi.mock("@superserve/sdk", () => fakeSdk);

const ctx = (over: Partial<CallContext> = {}): CallContext => ({
  attempt: 1,
  fetch: globalThis.fetch,
  idempotencyKey: "k1",
  ...over,
});

beforeEach(() => state.reset());

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("superserve adapter (offline conformance)", () => {
  it("passes the shared conformance suite through the fake SDK", async () => {
    const report = await runConformance(superserve({ apiKey: "ss_test" }), {
      live: true,
      template: {
        source: {
          context: { "hello.txt": "hi from context" },
          dockerfile: [
            "FROM ubuntu:24.04",
            "ARG DIR=/app",
            "RUN mkdir -p $DIR",
            `COPY hello.txt \${DIR}/hello.txt`,
            "ENV GREETING=hi",
            "WORKDIR /app",
            "EXPOSE 8080",
          ].join("\n"),
        },
      },
    });
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed).toEqual([]);
    const names = report.checks.map((c) => c.name);
    expect(names).toContain("templates: build, cache hit, boot from template");
    expect(names).toContain("fork: clone sees parent files");
    expect(report.checks.length).toBeGreaterThanOrEqual(38);
  }, 60_000);
});

describe("superserve adapter (mapping)", () => {
  it("declares the expected capabilities and flags", () => {
    const p = superserve();
    expect(p.name).toBe("superserve");
    expect(p.capabilities).toBe(SUPERSERVE_CAPS);
    expect(p.flags.previewBrowserAuth).toBe(true);
    expect(p.flags.templateSources).toEqual(["image", "dockerfile"]);
  });

  it("maps a rich create spec onto Sandbox.create", async () => {
    state.secrets.add("anthropic-prod");
    await FakeVolume.create({ name: "data" });
    const vol = [...state.volumes.values()][0]!;
    const p = superserve({
      apiKey: "ss_live_use_x",
      baseUrl: "https://api.example",
    });
    await p.create(
      {
        env: { A: "1" },
        lifecycle: {
          idleTimeoutMs: 120_000,
          maxAgeMs: 3_600_000,
          onIdle: "destroy",
        },
        metadata: { team: "x" },
        name: "rich",
        network: { domains: ["api.openai.com"], mode: "allow-list" },
        ports: [3000],
        secrets: [
          { envVar: "ANTHROPIC_API_KEY", name: "anthropic-prod" },
          { name: "PLAIN", value: "v" },
        ],
        volumes: [{ id: vol.id, mountPath: "/data", readOnly: true }],
      },
      ctx()
    );
    const call = state.calls.find((c) => c.method === "Sandbox.create")!
      .args as SandboxCreateOptions;
    expect(call).toMatchObject({
      apiKey: "ss_live_use_x",
      autoDeleteSeconds: 0,
      baseUrl: "https://api.example",
      envVars: { A: "1", PLAIN: "v" },
      idleTimeoutSeconds: 120,
      name: "rich",
      network: {
        allowOut: ["api.openai.com", "1.1.1.1/32", "8.8.8.8/32"],
        denyOut: ["0.0.0.0/0"],
      },
      secrets: { ANTHROPIC_API_KEY: "anthropic-prod" },
      timeoutSeconds: 3600,
      volumes: [{ mountPath: "/data", readOnly: true, volume: vol.id }],
    });
    expect(call.metadata?.team).toBe("x");
    expect(call.metadata?.["sbox-idempotency-key"]).toMatch(/^[0-9a-f]{32}$/);
    expect(
      state.calls.some((c) => c.method === "Sandbox#publishPreviewPort")
    ).toBe(true);
  });

  it("refuses spec fields Superserve cannot honor before any call", async () => {
    const p = superserve();
    await expect(p.create({ region: "eu" }, ctx())).rejects.toMatchObject({
      code: "NotSupported",
    });
    await expect(
      p.create({ resources: { vcpus: 2 } }, ctx())
    ).rejects.toMatchObject({
      code: "NotSupported",
    });
    await expect(
      p.create(
        {
          network: {
            inject: [{ domains: ["x"], headers: { A: "b" } }],
            mode: "allow-all",
          },
        },
        ctx()
      )
    ).rejects.toMatchObject({ code: "NotSupported" });
    expect(state.calls).toEqual([]);
  });

  it("reuses the sandbox from an earlier attempt with the same idempotency key", async () => {
    const p = superserve();
    const a = await p.create({ name: "x" }, ctx());
    const b = await p.create({ name: "x" }, ctx({ attempt: 2 }));
    expect(b.id).toBe(a.id);
    expect(state.sandboxes.size).toBe(1);
  });

  it("maps every status and the error taxonomy", () => {
    expect(mapSuperserveStatus("starting")).toBe("creating");
    expect(mapSuperserveStatus("active")).toBe("running");
    expect(mapSuperserveStatus("pausing")).toBe("suspending");
    expect(mapSuperserveStatus("paused")).toBe("paused");
    expect(mapSuperserveStatus("resuming")).toBe("creating");
    expect(mapSuperserveStatus("migrating")).toBe("paused");
    expect(mapSuperserveStatus("failed")).toBe("error");
    expect(mapSuperserveStatus("deleted")).toBe("destroyed");
    expect(mapSuperserveStatus("weird")).toBe("unknown");

    expect(
      mapSuperserveError(new FakeError("AuthenticationError", "bad key", 401))
        ?.code
    ).toBe("Unauthorized");
    expect(mapSuperserveError(notFound("x"))?.code).toBe("NotFound");
    expect(mapSuperserveError(conflict("busy"))?.code).toBe("Conflict");
    const rl = mapSuperserveError(
      new FakeError("RateLimitError", "slow down", 429)
    );
    expect(rl?.code).toBe("QuotaExceeded");
    expect(rl?.retryable).toBe(true);
    expect(
      mapSuperserveError(new FakeError("BillingError", "trial", 402))?.retryable
    ).toBe(false);
    expect(mapSuperserveError(new FakeError("TimeoutError", "t"))?.code).toBe(
      "Timeout"
    );
    expect(mapSuperserveError(validation("v"))?.code).toBe("Validation");
    expect(
      mapSuperserveError(new FakeError("SandboxError", "x", 403))?.code
    ).toBe("Unauthorized");
    expect(mapSuperserveError(new Error("weird"))).toBeUndefined();
  });

  it("paginates list() and honors state, metadata and limit", async () => {
    for (let i = 0; i < 230; i++) {
      await FakeSandbox.create({
        metadata: { batch: i % 2 ? "odd" : "even" },
        name: `s${i}`,
      });
    }
    const p = superserve();
    const all: string[] = [];
    for await (const info of p.list!({ metadata: { batch: "odd" } }, ctx())) {
      all.push(info.id);
    }
    expect(all).toHaveLength(115);
    const offsets = state.calls
      .filter((c) => c.method === "Sandbox.list")
      .map((c) => (c.args as SandboxListOptions).offset);
    expect(offsets).toEqual([0, 100]);
    const limited: string[] = [];
    for await (const info of p.list!({ limit: 3, state: "running" }, ctx())) {
      limited.push(info.id);
    }
    expect(limited).toHaveLength(3);
    const none: string[] = [];
    for await (const info of p.list!({ state: "stopped" }, ctx())) {
      none.push(info.id);
    }
    expect(none).toEqual([]);
  });

  it("maps egress policies, secrets and lifecycle", () => {
    expect(toNetworkConfig({ mode: "allow-all" })).toEqual({
      allowOut: [],
      denyOut: [],
    });
    expect(
      toNetworkConfig({ deny: { cidrs: ["10.0.0.0/8"] }, mode: "allow-all" })
    ).toEqual({
      allowOut: [],
      denyOut: ["10.0.0.0/8"],
    });
    expect(toNetworkConfig({ mode: "block-all" })).toEqual({
      allowOut: [],
      denyOut: ["0.0.0.0/0"],
    });
    expect(
      toNetworkConfig({ cidrs: ["140.82.112.0/20"], mode: "allow-list" })
    ).toEqual({
      allowOut: ["140.82.112.0/20"],
      denyOut: ["0.0.0.0/0"],
    });
    expect(() =>
      toNetworkConfig({ deny: { domains: ["x.com"] }, mode: "allow-all" })
    ).toThrow(/deny/);
    expect(mapSecrets([{ mode: "egress", name: "gh", envVar: "GH" }])).toEqual({
      bindings: { GH: "gh" },
      envVars: {},
    });
    expect(() =>
      mapSecrets([{ mode: "egress", name: "gh", value: "x" }])
    ).toThrow();
    expect(lifecycleOptions({ idleTimeoutMs: 1000 })).toEqual({
      idleTimeoutSeconds: 60,
    });
    expect(lifecycleOptions({ maxAgeMs: 1500, onIdle: "pause" })).toEqual({
      timeoutSeconds: 2,
    });
  });

  it("mints a query token for private previews", async () => {
    const p = superserve({ previewTokenTtlSeconds: 600 });
    const h = await p.create({}, ctx());
    const prev = await h.exposePort!(8081, { private: true }, ctx());
    expect(prev.auth).toEqual({
      param: "superserve_preview_token",
      token: `tok-${h.id}-8081`,
      type: "query",
    });
    expect(prev.url).toBe(`https://8081-${h.id}.${PREVIEW_HOST}`);
    const tokenCall = state.calls.find(
      (c) => c.method === "Sandbox#getPreviewToken"
    );
    expect(tokenCall?.args).toMatchObject({
      options: { expiresInSeconds: 600 },
    });
    expect((await h.listPorts!(ctx())).map((x) => x.port)).toEqual([8081]);
  });

  it("forks via a memory snapshot and cleans the snapshot up", async () => {
    const p = superserve();
    const h = await p.create({ metadata: { m: "1" }, name: "parent" }, ctx());
    await h.writeFile("/tmp/f", enc.encode("x"), ctx());
    const kids = await h.fork!(2, ctx());
    expect(kids).toHaveLength(2);
    expect(dec.decode(await kids[1]!.readFile("/tmp/f", ctx()))).toBe("x");
    expect(state.snapshots.size).toBe(0);
    expect((await kids[0]!.getInfo(ctx())).metadata).toEqual({ m: "1" });
  });

  it("writes stdin to spawned processes and kills by id", async () => {
    const p: SandboxProvider = superserve();
    const h = await p.create({}, ctx());
    const proc = await h.spawn!("cat", {}, ctx());
    await proc.writeStdin!(enc.encode("typed"));
    await proc.closeStdin!();
    let out = "";
    for await (const ev of proc) {
      if (ev.type === "stdout") {
        out += ev.data;
      }
    }
    expect(out).toBe("typed");
    const sleeper = await h.spawn!("sleep 30", {}, ctx());
    await h.killProcess!(sleeper.id, undefined, ctx());
    const events = [];
    for await (const ev of sleeper) {
      events.push(ev);
    }
    expect(events.at(-1)).toMatchObject({ type: "exit" });
    expect(
      state.calls.some(
        (c) => c.method === "session.kill" && c.args === "SIGKILL"
      )
    ).toBe(true);
  });
});

describe("superserve templates", () => {
  it("translates a Dockerfile into BuildSpec steps", () => {
    const spec = dockerfileToBuildSpec(
      [
        "FROM --platform=linux/amd64 python:3.12-slim AS base",
        "ARG V=1.2",
        'ENV A=1 B="two words"',
        "ENV LEGACY some value",
        "WORKDIR /srv",
        "COPY app.py ./",
        'RUN ["pip", "install", "x==$V"]',
        "USER app:app",
        "LABEL a=b",
        'CMD ["python", "app.py"]',
      ].join("\n"),
      new Map([["app.py", enc.encode("print(1)")]])
    );
    expect(spec.from).toBe("python:3.12-slim");
    expect(spec.startCmd).toBe("'python' 'app.py'");
    expect(spec.ignored).toEqual(["LABEL"]);
    expect(spec.steps).toEqual([
      { env: { key: "A", value: "1" } },
      { env: { key: "B", value: "two words" } },
      { env: { key: "LEGACY", value: "some value" } },
      { workdir: "/srv" },
      {
        run: `mkdir -p '/srv' && printf '%s' '${btoa("print(1)")}' | base64 -d > '/srv/app.py'`,
      },
      { run: "'pip' 'install' 'x==1.2'" },
      { user: { name: "app" } },
    ]);
    expect(() => dockerfileToBuildSpec("FROM a\nFROM b\n", new Map())).toThrow(
      /multi-stage/
    );
    expect(() =>
      dockerfileToBuildSpec("FROM a\nCOPY --from=x /a /b\n", new Map())
    ).toThrow(/--from/);
  });

  it("names templates with the cache key and finds them again", async () => {
    const key = "a".repeat(64);
    expect(superserveTemplateName(`sbox-${key.slice(0, 16)}`, key)).toBe(
      `sbox-${key.slice(0, 16)}`
    );
    expect(superserveTemplateName("My Env", key)).toBe(
      `my-env-${key.slice(0, 12)}`
    );
    const p = superserve();
    const events: string[] = [];
    const ref = await p.templates!.build(
      {
        cacheKey: key,
        name: "My Env",
        resources: { diskMB: 8192, memoryMB: 2048, vcpus: 2 },
        source: { image: "node:22" },
        startCmd: "node server.js",
      },
      { onEvent: (e) => events.push(e.type === "status" ? e.status : e.line) },
      ctx()
    );
    expect(
      state.calls.find((c) => c.method === "Template.create")?.args
    ).toMatchObject({
      diskMib: 8192,
      from: "node:22",
      memoryMib: 2048,
      name: `my-env-${key.slice(0, 12)}`,
      startCmd: "node server.js",
      vcpu: 2,
    });
    expect(events[0]).toBe("building");
    expect((await p.templates!.lookup(key, ctx()))?.id).toBe(ref.id);
    expect((await p.templates!.lookup("My Env", ctx()))?.id).toBe(ref.id);
    expect(await p.templates!.lookup("b".repeat(64), ctx())).toBeUndefined();
    const listed = [];
    for await (const t of p.templates!.list!(ctx())) {
      listed.push(t.name);
    }
    expect(listed).toEqual([`my-env-${key.slice(0, 12)}`]);
  });

  it("surfaces a failed build as an error", async () => {
    const p = superserve();
    await expect(
      p.templates!.build(
        {
          cacheKey: "c".repeat(64),
          name: "bad",
          source: { dockerfile: "FROM x\nRUN exit 7\n" },
        },
        { onEvent: () => {} },
        ctx()
      )
    ).rejects.toThrow(/step_failed/);
  });
});

describe("superserve volumes", () => {
  it("creates, gets, lists and deletes volumes", async () => {
    const p = superserve();
    const v = await p.volumes!.create({ name: "cache", sizeMB: 2048 }, ctx());
    expect(v.sizeMB).toBe(2048);
    expect(
      state.calls.find((c) => c.method === "Volume.create")?.args
    ).toMatchObject({
      capacityBytes: 2048 * 1_048_576,
      idempotencyKey: "k1",
      name: "cache",
    });
    expect((await p.volumes!.get("cache", ctx()))?.id).toBe(v.id);
    expect(await p.volumes!.get("missing", ctx())).toBeUndefined();
    await p.volumes!.delete(v.id, ctx());
    const left = [];
    for await (const x of p.volumes!.list(ctx())) {
      left.push(x);
    }
    expect(left).toEqual([]);
  });
});
