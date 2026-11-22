/**
 * Offline tests for the Freestyle adapter. `freestyle` is replaced by a fake
 * modeled on the real 0.2.23 `.d.ts`; the fake reuses the SDK's own firewall
 * and TLS rule validators, so a malformed rule fails here exactly as it would
 * against the API. Each fake VM is backed by the in-memory provider (MiniShell
 * over an in-memory filesystem), so exec, files, PTYs and snapshots really run.
 */
import type {
  ClosePtySessionResult,
  CreateFirewallRuleOptions,
  CreateTlsRuleOptions,
  CreateVmOptions,
  DirEntry as FsDirEntry,
  ExecOptions as FsExecOptions,
  ExecResult as FsExecResult,
  FileStat,
  FirewallRuleData,
  FreestyleOptions as SdkOptions,
  ListSnapshotsOptions,
  ListVmsOptions,
  PtyAttachOptions,
  PtyOpenOptions,
  PtySession,
  PtySessionEvents,
  SnapshotData,
  TlsRuleData,
  Vm as RealVm,
  VmData,
} from "freestyle";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CallContext, DriverHandle, DriverPty } from "../adapter/index.js";
import { runConformance } from "../conformance/index.js";
import { memory } from "../memory/index.js";
import {
  ENV_FILE,
  egressRules,
  FREESTYLE_CAPS,
  freestyle,
  lifecycleOptions,
  mapFreestyleError,
  mapFreestyleState,
  pickBaseSnapshot,
  ptyCommand,
  resolveFrom,
  slugForName,
} from "./index.js";

type Actual = typeof import("freestyle");

// ---------------------------------------------------------------------------
// fake SDK
// ---------------------------------------------------------------------------

class FakeApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    // oxlint-disable-next-line unicorn/custom-error-definition -- mirrors the SDK's class name
    this.name = "FreestyleApiError";
    this.status = status;
    this.code = code;
  }
}
const notFound = (what: string) =>
  new FakeApiError(404, "NOT_FOUND", `${what} not found`);
const conflict = (what: string) => new FakeApiError(409, "CONFLICT", what);
const badRequest = (what: string) => new FakeApiError(400, "BAD_REQUEST", what);

const backend = memory({ idPrefix: "fsmem" });
const memCtx = (): CallContext => ({ attempt: 1, fetch: globalThis.fetch });
const enc = new TextEncoder();
const dec = new TextDecoder();

const BASE_SIZES: Record<
  string,
  { cpu: number; memory: number; storage: number }
> = {
  "freestyle/busybox": { cpu: 1, memory: 128, storage: 1024 },
  "freestyle/ubuntu": { cpu: 4, memory: 8192, storage: 32_768 },
  "freestyle/ubuntu-lg": { cpu: 8, memory: 16_384, storage: 65_536 },
  "freestyle/ubuntu-sm": { cpu: 2, memory: 4096, storage: 16_384 },
};

interface PtyRecord {
  id: number;
  slug?: string;
  mem: DriverPty;
  scroll: Uint8Array[];
  listeners: Set<PtySessionEvents>;
  exitCode?: number;
}

interface VmRecord {
  data: VmData;
  mem: DriverHandle;
  live: Map<number, () => void>;
  ptys: Map<number, PtyRecord>;
}

interface SnapRecord extends SnapshotData {
  memSnap: string;
  resources: { cpu: number; memory: number; storage: number };
}

interface Call {
  method: string;
  args: unknown;
}

const state = {
  calls: [] as Call[],
  firewall: new Map<string, FirewallRuleData>(),
  identities: new Set<string>(),
  options: [] as (SdkOptions | undefined)[],
  seq: 0,
  snapshots: new Map<string, SnapRecord>(),
  tls: new Map<string, TlsRuleData & { secret?: Record<string, string> }>(),
  vms: new Map<string, VmRecord>(),
  reset() {
    this.calls = [];
    this.firewall.clear();
    this.identities.clear();
    this.options = [];
    this.snapshots.clear();
    this.tls.clear();
    this.vms.clear();
  },
};
const record = (method: string, args: unknown) =>
  state.calls.push({ args, method });
const nextId = (p: string) =>
  `${p}-${(++state.seq).toString(36).padStart(6, "0")}`;
const now = () => new Date().toISOString();

let actual: Actual;

function vmRec(idOrSlug: string): VmRecord {
  const r =
    state.vms.get(idOrSlug) ??
    [...state.vms.values()].find((v) => v.data.slug === idOrSlug);
  if (!r) {
    throw notFound(`vm ${idOrSlug}`);
  }
  return r;
}

async function wake(r: VmRecord): Promise<void> {
  if (r.data.state !== "running") {
    await r.mem.resume!(memCtx());
    r.data = { ...r.data, state: "running" };
  }
}

function fill<T extends { vmId?: string }>(ep: T, vmId: string): T {
  const bare = Object.keys(ep).every((k) => k === "port" || k === "protocol");
  return bare ? { ...ep, vmId } : ep;
}

function storeFirewall(
  rule: CreateFirewallRuleOptions,
  vmId?: string
): FirewallRuleData {
  const source = vmId ? fill(rule.source, vmId) : rule.source;
  const destination = vmId ? fill(rule.destination, vmId) : rule.destination;
  const dep = source.vmId ?? destination.vmId;
  const r: FirewallRuleData = {
    action: "allow",
    createdAt: now(),
    dependencies: dep ? [{ id: dep, kind: "vm" }] : [],
    destination,
    id: nextId("fw"),
    source,
    updatedAt: now(),
    ...(rule.description ? { description: rule.description } : {}),
  };
  state.firewall.set(r.id, r);
  return r;
}

function storeTls(rule: CreateTlsRuleOptions, vmId?: string): TlsRuleData {
  if (
    [...state.tls.values()].some(
      (t) => t.domain === rule.domain && t.source.public && rule.source.public
    )
  ) {
    throw conflict(`domain ${rule.domain} is taken`);
  }
  const source = vmId ? fill(rule.source, vmId) : rule.source;
  const destination = vmId ? fill(rule.destination, vmId) : rule.destination;
  const redacted = rule.transform?.map((t) =>
    "headers" in t
      ? {
          headers: Object.fromEntries(
            Object.keys(t.headers).map((k) => [k, "***"])
          ),
        }
      : t
  );
  const r: TlsRuleData & { secret?: Record<string, string> } = {
    accountId: "acct",
    action: "allow",
    createdAt: now(),
    dependencies: [],
    destination,
    domain: rule.domain,
    id: nextId("tls"),
    protocol: "http",
    source,
    updatedAt: now(),
    ...(redacted ? { redacted: true, transform: redacted } : {}),
  };
  const headers = rule.transform?.find((t) => "headers" in t);
  if (headers && "headers" in headers) {
    r.secret = headers.headers;
  }
  state.tls.set(r.id, r);
  return r;
}

function rulesFor<
  T extends { source: { vmId?: string }; destination: { vmId?: string } },
>(all: Iterable<T>, vmId: string): T[] {
  return [...all].filter(
    (r) => r.source.vmId === vmId || r.destination.vmId === vmId
  );
}

const WRAP_RE =
  /^echo \$\$ > (\S+); sh -c ('(?:[^']|'\\'')*'); __r=\$\?; rm -f \S+; exit \$__r$/;
let pidSeq = 1000;

async function runIn(
  r: VmRecord,
  command: string,
  env: Record<string, string> | undefined,
  timeoutMs: number
): Promise<FsExecResult> {
  const kill = /__k (\d+) /.exec(command);
  if (kill) {
    r.live.get(Number(kill[1]))?.();
    return { statusCode: 0, stderr: "", stdout: "" };
  }
  const wrapped = WRAP_RE.exec(command);
  const pid = ++pidSeq;
  if (wrapped) {
    await r.mem.writeFile(wrapped[1]!, enc.encode(`${pid}\n`), memCtx());
  }
  const ex = r.mem.exec(
    wrapped ? `sh -c ${wrapped[2]}` : command,
    { env },
    memCtx()
  );
  let timedOut = false;
  let killed = false;
  r.live.set(pid, () => {
    killed = true;
    void ex.kill();
  });
  const timer = setTimeout(() => {
    timedOut = true;
    void ex.kill();
  }, timeoutMs);
  let stdout = "";
  let stderr = "";
  let code = 0;
  for await (const ev of ex) {
    if (ev.type === "stdout") {
      stdout += ev.data;
    } else if (ev.type === "stderr") {
      stderr += ev.data;
    } else {
      code = ev.exitCode;
    }
  }
  clearTimeout(timer);
  r.live.delete(pid);
  if (wrapped) {
    await Promise.resolve()
      .then(() => r.mem.remove?.(wrapped[1]!, false, memCtx()))
      .catch(() => {});
  }
  return { statusCode: timedOut ? null : killed ? 137 : code, stderr, stdout };
}

class FakePtySession implements Pick<
  PtySession,
  | "ready"
  | "write"
  | "resize"
  | "signal"
  | "detach"
  | "sessionId"
  | "slug"
  | "created"
> {
  readonly ready = Promise.resolve();
  readonly #rec: PtyRecord;
  readonly #events: PtySessionEvents;
  constructor(rec: PtyRecord, events: PtySessionEvents) {
    this.#rec = rec;
    this.#events = events;
    rec.listeners.add(events);
    for (const chunk of rec.scroll) {
      events.onData?.(chunk);
    }
    if (rec.exitCode !== undefined) {
      events.onExit?.(rec.exitCode);
    }
  }
  get sessionId(): number {
    return this.#rec.id;
  }
  get slug(): string | undefined {
    return this.#rec.slug;
  }
  get created(): boolean {
    return true;
  }
  write(data: Uint8Array | string): void {
    void this.#rec.mem.write(
      typeof data === "string" ? enc.encode(data) : data
    );
  }
  resize(options: { cols: number; rows: number }): void {
    record("pty.resize", options);
  }
  signal(signal: "sigint" | "sigkill"): void {
    record("pty.signal", signal);
  }
  detach(): void {
    this.#rec.listeners.delete(this.#events);
  }
}

class FakeVm implements Pick<
  RealVm,
  | "id"
  | "data"
  | "update"
  | "start"
  | "pause"
  | "resize"
  | "delete"
  | "exec"
  | "snapshot"
  | "firewallRules"
> {
  readonly id: string;
  readonly fs: Pick<
    RealVm["fs"],
    | "readFile"
    | "readTextFile"
    | "readFileStream"
    | "writeFile"
    | "readDir"
    | "mkdir"
    | "remove"
    | "exists"
    | "stat"
  >;
  readonly pty: Pick<RealVm["pty"], "open" | "attach" | "list" | "close">;

  constructor(id: string) {
    this.id = id;
    const read = async (path: string) => {
      const r = vmRec(this.id);
      try {
        return await r.mem.readFile(path, memCtx());
      } catch {
        throw notFound(`file ${path}`);
      }
    };
    this.fs = {
      exists: async (path) => {
        try {
          await vmRec(this.id).mem.stat!(path, memCtx());
          return true;
        } catch {
          return false;
        }
      },
      mkdir: async (path) => {
        const r = vmRec(this.id);
        await wake(r);
        await r.mem.mkdir!(path, true, memCtx());
      },
      readDir: async (path): Promise<FsDirEntry[]> => {
        const entries = await Promise.resolve()
          .then(() => vmRec(this.id).mem.listDir!(path, memCtx()))
          .catch(() => {
            throw notFound(`dir ${path}`);
          });
        return entries.map((e) => ({
          kind: e.type === "dir" ? "directory" : "file",
          name: e.name,
        }));
      },
      readFile: (path) => read(path),
      readFileStream: async (path) => {
        const bytes = await read(path);
        return new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        });
      },
      readTextFile: async (path) => dec.decode(await read(path)),
      remove: async (path) => {
        const r = vmRec(this.id);
        await wake(r);
        await r.mem.remove!(path, true, memCtx());
      },
      stat: async (path): Promise<FileStat> => {
        const s = await Promise.resolve()
          .then(() => vmRec(this.id).mem.stat!(path, memCtx()))
          .catch(() => {
            throw notFound(`path ${path}`);
          });
        return {
          group: "root",
          isDirectory: s.type === "dir",
          isFile: s.type === "file",
          isSymlink: false,
          modified: now(),
          owner: "root",
          permissions: "0644",
          size: s.size,
        };
      },
      writeFile: async (path, content, options = {}) => {
        record("fs.writeFile", { options, path });
        if (!path.startsWith("/")) {
          throw badRequest("path must be absolute");
        }
        const r = vmRec(this.id);
        await wake(r);
        const bytes =
          typeof content === "string"
            ? enc.encode(content)
            : content instanceof Uint8Array
              ? content
              : new Uint8Array(await content.arrayBuffer());
        await r.mem.writeFile(path, bytes, memCtx());
      },
    };
    this.pty = {
      attach: async (options: PtyAttachOptions & PtySessionEvents) => {
        record("pty.attach", options.session);
        const r = vmRec(this.id);
        const rec = [...r.ptys.values()].find(
          (p) => p.id === options.session || p.slug === options.session
        );
        if (!rec) {
          throw notFound(`pty ${options.session}`);
        }
        return new FakePtySession(rec, options) as unknown as PtySession;
      },
      close: async (session): Promise<ClosePtySessionResult> => {
        record("pty.close", session);
        const r = vmRec(this.id);
        const rec = [...r.ptys.values()].find(
          (p) => p.id === session || p.slug === session
        );
        if (!rec) {
          throw notFound(`pty ${session}`);
        }
        const was = rec.exitCode;
        await rec.mem.kill();
        r.ptys.delete(rec.id);
        return {
          sessionId: rec.id,
          ...(was === undefined ? {} : { exitCode: was }),
        };
      },
      list: async () => ({
        sessions: [...vmRec(this.id).ptys.values()].map((p) => ({
          cols: 80,
          createdUnix: 0,
          rows: 24,
          sessionId: p.id,
          state: p.exitCode === undefined ? "running" : "exited",
        })),
      }),
      open: async (options: PtyOpenOptions & PtySessionEvents = {}) => {
        record("pty.open", {
          cols: options.cols,
          exec: options.exec,
          rows: options.rows,
        });
        const r = vmRec(this.id);
        await wake(r);
        const mem = await r.mem.createPty!({}, memCtx());
        const rec: PtyRecord = {
          id: r.ptys.size + 1,
          listeners: new Set(),
          mem,
          scroll: [],
          ...(options.slug ? { slug: options.slug } : {}),
        };
        r.ptys.set(rec.id, rec);
        void (async () => {
          for await (const chunk of mem.output) {
            rec.scroll.push(chunk);
            for (const l of rec.listeners) {
              l.onData?.(chunk);
            }
          }
        })();
        void mem.wait().then((code) => {
          rec.exitCode = code;
          for (const l of rec.listeners) {
            l.onExit?.(code);
          }
        });
        const session = new FakePtySession(rec, options);
        const login = ` && exec "\${SHELL:-/bin/sh}" -l`;
        if (options.exec?.endsWith(login)) {
          session.write(`${options.exec.slice(0, -login.length)}\n`);
        } else if (options.exec) {
          session.write(`${options.exec.replace(/ && exec /, " && ")}\nexit\n`);
        }
        return session as unknown as PtySession;
      },
    };
  }

  async data(): Promise<VmData> {
    return vmRec(this.id).data;
  }
  async update(options: Parameters<RealVm["update"]>[0]): Promise<VmData> {
    record("vm.update", options);
    const r = vmRec(this.id);
    r.data = {
      ...r.data,
      ...(options.ttlSeconds === undefined
        ? {}
        : { ttlSeconds: options.ttlSeconds }),
    };
    return r.data;
  }
  async start(): Promise<VmData> {
    record("vm.start", this.id);
    const r = vmRec(this.id);
    await wake(r);
    return r.data;
  }
  async pause(): Promise<VmData> {
    record("vm.pause", this.id);
    const r = vmRec(this.id);
    if (r.data.state !== "running") {
      throw conflict(`vm is ${r.data.state}`);
    }
    await r.mem.pause!(memCtx());
    r.data = { ...r.data, state: "paused" };
    return r.data;
  }
  async resize(options: Parameters<RealVm["resize"]>[0]): Promise<VmData> {
    record("vm.resize", options);
    const r = vmRec(this.id);
    const cur = r.data.resources;
    if (
      (options.cpu ?? cur.cpu) < cur.cpu ||
      (options.memory ?? cur.memory) < cur.memory ||
      (options.storage ?? cur.storage) < cur.storage
    ) {
      throw badRequest("resize is grow-only");
    }
    r.data = { ...r.data, resources: { ...cur, ...options } };
    return r.data;
  }
  async delete(): Promise<void> {
    record("vm.delete", this.id);
    const r = vmRec(this.id);
    for (const k of r.live.values()) {
      k();
    }
    state.vms.delete(r.data.id);
    for (const [k, f] of state.firewall) {
      if (f.dependencies.some((d) => d.id === r.data.id)) {
        state.firewall.delete(k);
      }
    }
    for (const [k, t] of state.tls) {
      if (t.source.vmId === r.data.id || t.destination.vmId === r.data.id) {
        state.tls.delete(k);
      }
    }
  }
  async exec(options: string | FsExecOptions): Promise<FsExecResult> {
    const o = typeof options === "string" ? { command: options } : options;
    record("vm.exec", o);
    if (o.env) {
      for (const k of Object.keys(o.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
          throw badRequest(`invalid env key ${k}`);
        }
      }
    }
    const r = vmRec(this.id);
    await wake(r);
    return runIn(r, o.command, o.env, o.timeoutMs ?? 30_000);
  }
  linuxUser(user: string) {
    record("vm.linuxUser", user);
    return { exec: (o: string | FsExecOptions) => this.exec(o), pty: this.pty };
  }
  async snapshot(options: Parameters<RealVm["snapshot"]>[0] = {}) {
    record("vm.snapshot", options);
    const r = vmRec(this.id);
    if (
      options.slug &&
      [...state.snapshots.values()].some((s) => s.slug === options.slug)
    ) {
      throw conflict(`snapshot slug ${options.slug} taken`);
    }
    const memRef = await r.mem.snapshot!({}, memCtx());
    const s: SnapRecord = {
      createdAt: now(),
      id: nextId("sh"),
      memSnap: memRef.id,
      public: false,
      resources: { ...r.data.resources },
      sourceVmId: r.data.id,
      updatedAt: now(),
      ...(options.slug ? { slug: options.slug } : {}),
      ...(options.displayName ? { displayName: options.displayName } : {}),
    };
    state.snapshots.set(s.id, s);
    const { memSnap: _m, resources: _r, ...snapshot } = s;
    return { snapshot, snapshotId: s.id, sourceVmId: r.data.id };
  }
  async firewallRules() {
    const rules = rulesFor(state.firewall.values(), vmRec(this.id).data.id);
    return { rules, totalCount: rules.length };
  }
}

function snapRec(idOrSlug: string): SnapRecord {
  const s =
    state.snapshots.get(idOrSlug) ??
    [...state.snapshots.values()].find((x) => x.slug === idOrSlug);
  if (!s) {
    throw notFound(`snapshot ${idOrSlug}`);
  }
  return s;
}

function publicSnap(s: SnapRecord): SnapshotData {
  const { memSnap: _m, resources: _r, ...rest } = s;
  return rest;
}

function page<T>(items: T[], limit = 50, offset = 0): T[] {
  return items.slice(offset, offset + limit);
}

class FakeFreestyle {
  readonly vms = {
    create: async (options: CreateVmOptions) => {
      record("vms.create", options);
      actual.validateFirewallSpec(options.firewall, "VM");
      if (options.tls !== undefined) {
        actual.validateTlsSpec(options.tls);
      }
      if (
        options.slug &&
        [...state.vms.values()].some((v) => v.data.slug === options.slug)
      ) {
        throw conflict(`slug ${options.slug} is taken`);
      }
      let memSnap: string | undefined;
      let resources = BASE_SIZES["freestyle/ubuntu"]!;
      const snapId = options.snapshotId ?? undefined;
      if (snapId && BASE_SIZES[snapId]) {
        resources = BASE_SIZES[snapId]!;
      } else if (snapId) {
        const s = snapRec(snapId);
        memSnap = s.memSnap;
        resources = s.resources;
      }
      const mem = await backend.create(
        { metadata: {}, ...(memSnap ? { fromSnapshot: memSnap } : {}) },
        memCtx()
      );
      const id = nextId("vm");
      const data: VmData = {
        createdAt: now(),
        id,
        metadata: { ...options.metadata },
        networks: [],
        resources: { ...resources },
        state: "running",
        updatedAt: now(),
        vpcs: [],
        ...(options.slug ? { slug: options.slug } : {}),
        ...(options.displayName ? { displayName: options.displayName } : {}),
        ...(snapId ? { snapshotId: snapId } : {}),
        ...(options.idleTimeoutSeconds === undefined
          ? {}
          : { idleTimeoutSeconds: options.idleTimeoutSeconds }),
        ...(options.ttlSeconds === undefined
          ? {}
          : { ttlSeconds: options.ttlSeconds }),
      };
      state.vms.set(id, { data, live: new Map(), mem, ptys: new Map() });
      const firewallRules = options.firewall.rules.map((rule) =>
        storeFirewall(rule, id)
      );
      const tlsRules = (options.tls?.rules ?? []).map((rule) =>
        storeTls(rule, id)
      );
      return {
        data,
        firewallRules,
        tlsRules,
        vm: new FakeVm(id) as unknown as RealVm,
        vmId: id,
      };
    },
    delete: async (idOrSlug: string) =>
      new FakeVm(vmRec(idOrSlug).data.id).delete(),
    get: async (idOrSlug: string) => {
      record("vms.get", idOrSlug);
      return vmRec(idOrSlug).data;
    },
    list: async (options: ListVmsOptions = {}) => {
      record("vms.list", options);
      const want = (options.metadata ?? "")
        .split(",")
        .filter(Boolean)
        .map((pair) => {
          const i = pair.indexOf(":");
          return [pair.slice(0, i), pair.slice(i + 1)] as const;
        });
      const all = [...state.vms.values()]
        .map((v) => v.data)
        .filter((d) => !options.state || d.state === options.state)
        .filter((d) => !options.slug || d.slug === options.slug)
        .filter((d) => want.every(([k, v]) => d.metadata[k] === v));
      const count = (s: string) => all.filter((d) => d.state === s).length;
      return {
        pausedCount: count("paused"),
        pausingCount: count("pausing"),
        runningCount: count("running"),
        startingCount: count("starting"),
        stoppedCount: count("stopped"),
        totalCount: all.length,
        vms: page(all, options.limit, options.offset),
      };
    },
    ref: (idOrSlug: string) => new FakeVm(idOrSlug) as unknown as RealVm,
    snapshots: {
      delete: async (id: string) => {
        record("snapshots.delete", id);
        state.snapshots.delete(snapRec(id).id);
      },
      get: async (idOrSlug: string) => publicSnap(snapRec(idOrSlug)),
      list: async (options: ListSnapshotsOptions = {}) => {
        const all = [...state.snapshots.values()].filter(
          (s) => !options.sourceVmId || s.sourceVmId === options.sourceVmId
        );
        return {
          snapshots: page(all, options.limit, options.offset).map(publicSnap),
          totalCount: all.length,
        };
      },
    },
  };

  readonly firewall = {
    rules: {
      create: async (options: CreateFirewallRuleOptions) => {
        record("firewall.create", options);
        actual.validateFirewallRule(options);
        return storeFirewall(options);
      },
      delete: async (id: string) => {
        record("firewall.delete", id);
        state.firewall.delete(id);
      },
      list: async (
        options: { vmId?: string; limit?: number; offset?: number } = {}
      ) => {
        const all = options.vmId
          ? rulesFor(state.firewall.values(), options.vmId)
          : [...state.firewall.values()];
        return {
          rules: page(all, options.limit, options.offset),
          totalCount: all.length,
        };
      },
    },
  };

  readonly tls = {
    rules: {
      create: async (options: CreateTlsRuleOptions) => {
        record("tls.create", options);
        actual.validateTlsRule(options);
        const { secret: _s, ...rule } = storeTls(options) as TlsRuleData & {
          secret?: unknown;
        };
        return rule;
      },
      delete: async (id: string) => {
        record("tls.delete", id);
        state.tls.delete(id);
      },
      list: async (
        options: { vmId?: string; limit?: number; offset?: number } = {}
      ) => {
        const all = (
          options.vmId
            ? rulesFor(state.tls.values(), options.vmId)
            : [...state.tls.values()]
        ).map(({ secret: _s, ...r }) => r);
        return {
          rules: page(all, options.limit, options.offset),
          totalCount: all.length,
        };
      },
    },
  };

  readonly identities = {
    create: async () => {
      const identityId = nextId("id");
      state.identities.add(identityId);
      return {
        data: { id: identityId, managed: false },
        identity: {
          id: identityId,
          permissions: {
            vm: {
              grant: async (o: { vmId: string }) => {
                record("identity.grant", o);
                vmRec(o.vmId);
              },
            },
          },
          tokens: {
            create: async () => ({
              id: nextId("tok"),
              token: `token-${identityId}`,
            }),
          },
        },
        identityId,
      };
    },
    delete: async (id: string) => {
      record("identities.delete", id);
      state.identities.delete(id);
    },
  };

  constructor(options?: SdkOptions) {
    state.options.push(options);
  }
}

vi.mock("freestyle", async (importOriginal) => {
  actual = await importOriginal<Actual>();
  return { ...actual, Freestyle: FakeFreestyle };
});

const ctx = (over: Partial<CallContext> = {}): CallContext => ({
  attempt: 1,
  fetch: globalThis.fetch,
  idempotencyKey: "key-1",
  ...over,
});

beforeEach(() => state.reset());

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("freestyle adapter (offline conformance)", () => {
  it("passes the shared conformance suite through the fake SDK", async () => {
    const report = await runConformance(freestyle({ apiKey: "fs_test" }), {
      live: true,
      template: {
        source: {
          context: { "app/hello.txt": "hi from context" },
          dockerfile: [
            "FROM ubuntu:24.04",
            "ARG DIR=/srv",
            "RUN mkdir -p $DIR",
            "COPY app/ /srv/",
            "ENV GREETING=hello",
            "WORKDIR /srv",
            "EXPOSE 3000",
          ].join("\n"),
        },
      },
    });
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed).toEqual([]);
    const names = report.checks.map((c) => c.name);
    expect(names).toContain("templates: build, cache hit, boot from template");
    expect(names).toContain("pty: interactive echo + exit code");
    expect(names).toContain(
      "client: getOrCreate returns the same sandbox by name"
    );
    expect(report.checks.length).toBeGreaterThanOrEqual(36);
  }, 60_000);
});

describe("freestyle adapter (mapping)", () => {
  it("declares the expected capabilities and flags", () => {
    const p = freestyle();
    expect(p.capabilities).toBe(FREESTYLE_CAPS);
    expect(p.flags.perCommandEnvCwd).toBe(false);
    expect(p.flags.templateSources).toEqual(["snapshot", "dockerfile"]);
  });

  it("maps a rich create spec onto vms.create", async () => {
    const p = freestyle({ apiKey: "k", baseUrl: "https://api.example" });
    const h = await p.create(
      {
        env: { A: "1" },
        lifecycle: {
          idleTimeoutMs: 600_000,
          maxAgeMs: 7_200_000,
          onIdle: "destroy",
        },
        metadata: { team: "x" },
        name: "Rich Box",
        network: {
          cidrs: ["10.0.0.0/8"],
          domains: ["pypi.org"],
          inject: [
            {
              domains: ["api.openai.com"],
              headers: { authorization: { name: "oai", value: "Bearer sk" } },
            },
          ],
          mode: "allow-list",
        },
        ports: [3000],
        resources: { memoryMB: 12_000, vcpus: 6 },
        secrets: [{ name: "TOKEN", value: "t" }],
      },
      ctx()
    );
    const call = state.calls.find((c) => c.method === "vms.create")!
      .args as CreateVmOptions;
    expect(state.options[0]).toEqual({
      apiKey: "k",
      baseUrl: "https://api.example",
    });
    expect(call).toMatchObject({
      autoDeleteSeconds: 0,
      displayName: "Rich Box",
      firewall: {
        rules: [
          {
            action: "allow",
            description: "sbox:egress",
            destination: { cidr: "10.0.0.0/8" },
            source: {},
          },
        ],
      },
      idleTimeoutSeconds: 600,
      snapshotId: "freestyle/ubuntu-lg",
      ttlSeconds: 7200,
    });
    expect(call.metadata?.team).toBe("x");
    expect(call.tls?.rules).toEqual([
      {
        action: "allow",
        destination: { public: true },
        domain: "pypi.org",
        source: {},
      },
      {
        action: "allow",
        destination: { public: true },
        domain: "api.openai.com",
        source: {},
        transform: [{ headers: { authorization: "Bearer sk" } }],
      },
      expect.objectContaining({
        destination: { port: 3000 },
        source: { public: true },
      }),
    ]);
    expect(JSON.parse(dec.decode(await h.readFile(ENV_FILE, ctx())))).toEqual({
      A: "1",
      TOKEN: "t",
    });
    const r = await h.exec("echo $A$TOKEN", {}, ctx());
    let out = "";
    for await (const ev of r) {
      if (ev.type === "stdout") {
        out += ev.data;
      }
    }
    expect(out.trim()).toBe("1t");
    expect((await h.listPorts!(ctx()))[0]?.url).toMatch(
      /^https:\/\/sbox-3000-[0-9a-f]{10}\.style\.dev$/
    );
  });

  it("refuses what Freestyle cannot do before any call", async () => {
    const p = freestyle();
    await expect(
      p.create({ volumes: [{ id: "v", mountPath: "/v" }] }, ctx())
    ).rejects.toMatchObject({
      code: "NotSupported",
    });
    await expect(
      p.create(
        { network: { deny: { cidrs: ["1.2.3.4/32"] }, mode: "allow-all" } },
        ctx()
      )
    ).rejects.toMatchObject({
      code: "NotSupported",
    });
    await expect(
      p.create({ secrets: [{ name: "stored" }] }, ctx())
    ).rejects.toMatchObject({ code: "NotSupported" });
    await expect(
      p.create(
        {
          network: {
            inject: [{ domains: ["x.com"], headers: { a: { name: "n" } } }],
            mode: "block-all",
          },
        },
        ctx()
      )
    ).rejects.toMatchObject({ code: "Validation" });
    expect(state.calls.filter((c) => c.method === "vms.create")).toEqual([]);
  });

  it("reuses the VM from an earlier attempt with the same idempotency key", async () => {
    const p = freestyle();
    const a = await p.create({}, ctx());
    const b = await p.create({}, ctx({ attempt: 2 }));
    expect(b.id).toBe(a.id);
    expect(state.vms.size).toBe(1);
  });

  it("maps states, errors, lifecycle, bases and FROM lines", async () => {
    expect(mapFreestyleState("starting")).toBe("creating");
    expect(mapFreestyleState("running")).toBe("running");
    expect(mapFreestyleState("pausing")).toBe("suspending");
    expect(mapFreestyleState("paused")).toBe("paused");
    expect(mapFreestyleState("stopped")).toBe("stopped");
    expect(mapFreestyleState("nope")).toBe("unknown");

    expect(
      mapFreestyleError(new FakeApiError(401, "UNAUTHORIZED", "x"))?.code
    ).toBe("Unauthorized");
    expect(
      mapFreestyleError(new FakeApiError(403, "FORBIDDEN", "x"))?.code
    ).toBe("Unauthorized");
    expect(mapFreestyleError(notFound("x"))?.code).toBe("NotFound");
    expect(mapFreestyleError(conflict("x"))?.code).toBe("Conflict");
    const q = mapFreestyleError(new FakeApiError(429, "RATE_LIMITED", "x"));
    expect(q?.code).toBe("QuotaExceeded");
    expect(q?.retryable).toBe(true);
    expect(
      mapFreestyleError(new FakeApiError(504, "GATEWAY_TIMEOUT", "x"))?.code
    ).toBe("Timeout");
    expect(mapFreestyleError(badRequest("x"))?.code).toBe("Validation");
    expect(
      mapFreestyleError(new actual.FirewallRuleValidationError("a", "b"))?.code
    ).toBe("Validation");
    expect(mapFreestyleError(new Error("x"))).toBeUndefined();

    expect(lifecycleOptions({ maxAgeMs: 60_000 })).toEqual({
      maxRunSeconds: 60,
    });
    expect(lifecycleOptions({ idleTimeoutMs: 1500, onIdle: "pause" })).toEqual({
      idleTimeoutSeconds: 2,
    });

    expect(pickBaseSnapshot(undefined)).toBeUndefined();
    expect(pickBaseSnapshot({ vcpus: 2 })).toBe("freestyle/ubuntu-sm");
    expect(pickBaseSnapshot({ memoryMB: 64 * 1024 })).toBe(
      "freestyle/ubuntu-2xl"
    );
    expect(() => pickBaseSnapshot({ vcpus: 64 })).toThrow(/largest/);

    expect(resolveFrom("ubuntu:24.04")).toBe("freestyle/ubuntu");
    expect(resolveFrom("ubuntu", { vcpus: 8 })).toBe("freestyle/ubuntu-lg");
    expect(resolveFrom("freestyle/busybox")).toBe("freestyle/busybox");
    expect(resolveFrom("sh-abc123")).toBe("sh-abc123");
    expect(() => resolveFrom("python:3.12")).toThrow(/OCI/);

    expect(await slugForName("my-box")).toBe("my-box");
    expect(await slugForName("My Box!")).toMatch(/^my-box-[0-9a-f]{8}$/);
  });

  it("maps egress policies onto firewall and TLS rules", () => {
    expect(egressRules(undefined, {})).toEqual({
      firewall: [
        {
          action: "allow",
          description: "sbox:egress",
          destination: { public: true },
          source: {},
        },
      ],
      tls: [],
    });
    expect(egressRules({ mode: "block-all" }, { vmId: "vm-1" })).toEqual({
      firewall: [],
      tls: [],
    });
    const both = egressRules(
      {
        domains: ["a.com"],
        inject: [
          { domains: ["a.com", "b.com"], headers: { "x-key": "literal" } },
        ],
        mode: "allow-list",
      },
      { vmId: "vm-1" }
    );
    expect(both.tls).toEqual([
      {
        action: "allow",
        destination: { public: true },
        domain: "a.com",
        source: { vmId: "vm-1" },
        transform: [{ headers: { "x-key": "literal" } }],
      },
      {
        action: "allow",
        destination: { public: true },
        domain: "b.com",
        source: { vmId: "vm-1" },
        transform: [{ headers: { "x-key": "literal" } }],
      },
    ]);
  });

  it("replaces only its own egress rules at runtime", async () => {
    const p = freestyle();
    const h = await p.create({ ports: [8080] }, ctx());
    await new FakeFreestyle().firewall.rules.create({
      action: "allow",
      destination: { port: 22, protocol: "tcp", vmId: h.id },
      source: { cidr: "203.0.113.0/24" },
    });
    await h.setEgressPolicy!(
      { domains: ["pypi.org"], mode: "allow-list" },
      ctx()
    );
    const fw = [...state.firewall.values()];
    expect(fw.map((r) => r.description ?? "user")).toEqual(["user"]);
    const domains = [...state.tls.values()].map((t) => t.domain);
    expect(domains).toHaveLength(2);
    expect(domains).toContain("pypi.org");
    expect(domains.some((d) => d.startsWith("sbox-8080-"))).toBe(true);
    await h.setEgressPolicy!({ mode: "allow-all" }, ctx());
    expect([...state.tls.values()].map((t) => t.domain)).toEqual([
      expect.stringMatching(/^sbox-8080-/),
    ]);
    expect(
      [...state.firewall.values()].filter(
        (r) => r.description === "sbox:egress"
      )
    ).toHaveLength(1);
  });

  it("paginates list() and honors filters", async () => {
    const p = freestyle();
    for (let i = 0; i < 205; i++) {
      await new FakeFreestyle().vms.create({
        firewall: { rules: [] },
        metadata: { b: i < 150 ? "x" : "y" },
      });
    }
    const ids: string[] = [];
    for await (const info of p.list!({ metadata: { b: "x" } }, ctx())) {
      ids.push(info.id);
    }
    expect(ids).toHaveLength(150);
    const listCalls = state.calls
      .filter((c) => c.method === "vms.list")
      .map((c) => c.args as ListVmsOptions);
    expect(listCalls.map((c) => c.offset)).toEqual([0, 100]);
    expect(listCalls[0]?.metadata).toBe("b:x");
    const limited: string[] = [];
    for await (const info of p.list!({ limit: 2, state: "running" }, ctx())) {
      limited.push(info.id);
    }
    expect(limited).toHaveLength(2);
  });

  it("creates SSH credentials from a scoped identity and cleans up", async () => {
    const p = freestyle();
    const h = await p.create({}, ctx());
    const creds = await h.createSsh!(ctx());
    expect(creds).toMatchObject({
      host: "beta-ssh.freestyle.sh",
      port: 22,
      privateKey: "",
    });
    expect(creds.user).toMatch(new RegExp(`^${h.id}:token-`));
    await h.destroy(ctx());
    expect(state.identities.size).toBe(0);
  });

  it("reattaches to a PTY by id and replays its output", async () => {
    const p = freestyle();
    const h = await p.create({}, ctx());
    const t = await h.createPty!({ cols: 80, rows: 24 }, ctx());
    await t.write(enc.encode("echo first\n"));
    const again = await h.connectPty!(t.id, ctx());
    let out = "";
    for await (const chunk of again.output) {
      out += dec.decode(chunk);
      if (out.includes("first\r\n") || out.split("first").length > 2) {
        break;
      }
    }
    expect(out).toContain("first");
    await again.kill();
    expect(await again.wait()).toBe(130);
  });

  it("wraps PTY commands with cwd and env", () => {
    expect(ptyCommand({}, {})).toBeUndefined();
    expect(ptyCommand({ cmd: "python3" }, {})).toBe("python3");
    expect(ptyCommand({ cwd: "/w" }, { A: "1" })).toBe(
      `cd '/w' && export A='1' && exec "\${SHELL:-/bin/sh}" -l`
    );
  });

  it("forks through a snapshot, keeps egress, and deletes the snapshot", async () => {
    const p = freestyle();
    const h = await p.create(
      {
        env: { E: "v" },
        network: { cidrs: ["10.0.0.0/8"], mode: "allow-list" },
      },
      ctx()
    );
    await h.writeFile("/tmp/m", enc.encode("parent"), ctx());
    const [kid] = await h.fork!(1, ctx());
    expect(dec.decode(await kid!.readFile("/tmp/m", ctx()))).toBe("parent");
    expect(state.snapshots.size).toBe(0);
    const forkCreate = state.calls.findLast((c) => c.method === "vms.create")!
      .args as CreateVmOptions;
    expect(forkCreate.firewall.rules).toEqual([
      {
        action: "allow",
        description: "sbox:egress",
        destination: { cidr: "10.0.0.0/8" },
        source: {},
      },
    ]);
  });

  it("builds a snapshot template with startCmd-free steps and finds it by cache key", async () => {
    const p = freestyle();
    const key = "d".repeat(64);
    const events: string[] = [];
    const ref = await p.templates!.build(
      {
        cacheKey: key,
        env: { MODE: "prod" },
        name: "web",
        source: {
          context: { "a.sh": "echo a" },
          dockerfile:
            "FROM busybox\nCOPY --chmod=755 a.sh /opt/a.sh\nRUN cat /opt/a.sh\n",
        },
      },
      { onEvent: (e) => events.push(e.type === "log" ? e.line : e.status) },
      ctx()
    );
    expect(events).toContain("building");
    expect(events).toContain("echo a");
    expect(
      state.calls.find((c) => c.method === "fs.writeFile")?.args
    ).toMatchObject({ options: { mode: 0o755 }, path: "/opt/a.sh" });
    expect(
      state.calls.find((c) => c.method === "vms.create")?.args
    ).toMatchObject({ snapshotId: "freestyle/busybox" });
    expect(state.vms.size).toBe(0);
    expect((await p.templates!.lookup(key, ctx()))?.id).toBe(ref.id);
    const h = await p.create({ template: ref.id }, ctx());
    let out = "";
    for await (const ev of h.exec("echo $MODE", {}, ctx())) {
      if (ev.type === "stdout") {
        out += ev.data;
      }
    }
    expect(out.trim()).toBe("prod");
    await expect(
      p.templates!.build(
        {
          cacheKey: "e".repeat(64),
          name: "bad",
          source: { dockerfile: "FROM busybox\nRUN exit 9\n" },
        },
        { onEvent: () => {} },
        ctx()
      )
    ).rejects.toThrow(/exit 9/);
    expect(state.vms.size).toBe(1);
  });
});
