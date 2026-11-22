/**
 * Offline tests for the (deprecated) Runloop adapter. `@runloop/api-client` is
 * replaced by a fake modelled on the 1.24.1 `.d.ts` (method names + argument
 * shapes), backed by `MiniShell` over an in-memory filesystem per devbox.
 */
import type { Runloop } from "@runloop/api-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runConformance } from "../conformance/index.js";
import { createSandboxClient } from "../index.js";
import { MiniShell } from "../memory/shell.js";
import type { ShellFs } from "../memory/shell.js";
import {
  mapRunloopError,
  mapRunloopState,
  RUNLOOP_CAPS,
  runloop,
} from "./index.js";

type Client = InstanceType<typeof import("@runloop/api-client").default>;
type Devboxes = Client["devboxes"];

// ---------------------------------------------------------------------------
// in-memory devbox filesystem (a flat map is enough: the core polyfills ls/stat
// over exec, which MiniShell answers from this ShellFs)
// ---------------------------------------------------------------------------

const norm = (p: string): string => {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "..") {
      out.pop();
    } else if (seg && seg !== ".") {
      out.push(seg);
    }
  }
  return `/${out.join("/")}`;
};
const parent = (p: string) => norm(p).slice(0, norm(p).lastIndexOf("/")) || "/";

class FakeFs implements ShellFs {
  files = new Map<string, Uint8Array>();
  dirs = new Set(["/", "/tmp", "/home/user"]);
  clone(): FakeFs {
    const f = new FakeFs();
    f.files = new Map(this.files);
    f.dirs = new Set(this.dirs);
    return f;
  }
  #mkp(d: string) {
    for (let c = norm(d); !this.dirs.has(c); c = parent(c)) {
      this.dirs.add(c);
    }
  }
  read(p: string) {
    return this.files.get(norm(p)) ?? null;
  }
  write(p: string, d: Uint8Array) {
    this.#mkp(parent(p));
    this.files.set(norm(p), d);
  }
  isDir(p: string) {
    return this.dirs.has(norm(p));
  }
  list(d: string) {
    const dir = norm(d);
    if (!this.dirs.has(dir)) {
      return null;
    }
    const out = new Map<string, "file" | "dir">();
    for (const x of this.dirs) {
      if (x !== dir && parent(x) === dir) {
        out.set(x.slice(x.lastIndexOf("/") + 1), "dir");
      }
    }
    for (const x of this.files.keys()) {
      if (parent(x) === dir) {
        out.set(x.slice(x.lastIndexOf("/") + 1), "file");
      }
    }
    return [...out].map(([name, type]) => ({ name, type }));
  }
  mkdir(p: string, recursive: boolean) {
    if (this.dirs.has(norm(p))) {
      return recursive ? null : `mkdir: ${p}: File exists`;
    }
    if (!recursive && !this.dirs.has(parent(p))) {
      return `mkdir: ${p}: No such file or directory`;
    }
    this.#mkp(p);
    return null;
  }
  remove(p: string, recursive: boolean, force: boolean) {
    const n = norm(p);
    if (this.files.delete(n)) {
      return null;
    }
    if (this.dirs.has(n)) {
      if (!recursive) {
        return `rm: ${p}: Is a directory`;
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
    return force ? null : `rm: ${p}: No such file or directory`;
  }
  rename(a: string, b: string) {
    const data = this.files.get(norm(a));
    if (!data) {
      return `mv: cannot stat '${a}'`;
    }
    this.files.delete(norm(a));
    this.write(b, data);
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
}

// ---------------------------------------------------------------------------
// fake SDK
// ---------------------------------------------------------------------------

const apiError = (status: number, message: string) =>
  Object.assign(new Error(`${status} ${message}`), { status });
const named = (name: string, message: string) =>
  Object.assign(new Error(message), { name });

interface Box {
  view: Runloop.DevboxView;
  fs: FakeFs;
  env: Record<string, string>;
}
let seq = 0;
const world = {
  boxes: new Map<string, Box>(),
  calls: [] as { method: string; args: unknown }[],
  pageFetches: 0,
  snapshots: new Map<string, FakeFs>(),
};
const record = (method: string, args: unknown) =>
  world.calls.push({ args, method });
const callsOf = (m: string) =>
  world.calls.filter((c) => c.method === m).map((c) => c.args);
const box = (id: string): Box => {
  const b = world.boxes.get(id);
  if (!b || b.view.status === "shutdown") {
    throw apiError(404, "devbox not found");
  }
  return b;
};
const setStatus = (id: string, status: Runloop.DevboxView["status"]) => {
  const b = box(id);
  b.view = { ...b.view, status };
  return b.view;
};

const dec = new TextDecoder();
const execute: Devboxes["executeAndAwaitCompletion"] = async (
  id,
  params,
  options
) => {
  const b = box(id);
  if (b.view.status !== "running") {
    throw apiError(400, "devbox is not running");
  }
  const ac = new AbortController();
  let timedOut = false;
  const outer = options?.signal ?? undefined;
  outer?.addEventListener("abort", () => ac.abort(), { once: true });
  const timeoutMs = options?.longPoll?.timeoutMs;
  const timer = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, timeoutMs)
    : undefined;
  let stdout = "";
  let stderr = "";
  try {
    const exit_status = await new MiniShell(b.fs).run(params.command, {
      cwd: "/home/user",
      env: { HOME: "/home/user", ...b.env },
      signal: ac.signal,
      stderr: (d) => (stderr += dec.decode(d)),
      stdin: new Uint8Array(),
      stdout: (d) => (stdout += dec.decode(d)),
    });
    if (timedOut) {
      throw named(
        "PollingTimeoutError",
        `Long poll timed out after ${timeoutMs}ms`
      );
    }
    if (outer?.aborted) {
      throw named("LongPollAbortError", "Long poll aborted");
    }
    return {
      devbox_id: id,
      execution_id: `exe_${++seq}`,
      exit_status,
      status: "completed",
      stderr,
      stdout,
    };
  } finally {
    clearTimeout(timer);
  }
};

/** The first call signature of an (often overloaded) Stainless method, async. */
type FirstSig<F> = F extends {
  (...a: infer A): infer R;
  (...a: infer _B): unknown;
}
  ? (...a: A) => Promise<Awaited<R>>
  : never;
type FakeDevboxes = {
  [K in
    | "awaitRunning"
    | "awaitSuspended"
    | "createAndAwaitRunning"
    | "downloadFile"
    | "enableTunnel"
    | "executeAndAwaitCompletion"
    | "removeTunnel"
    | "resume"
    | "retrieve"
    | "shutdown"
    | "snapshotDisk"
    | "suspend"
    | "uploadFile"]: FirstSig<Devboxes[K]>;
} & { list: unknown };

const devboxes: FakeDevboxes = {
  awaitRunning: async (id) => setStatus(id, "running"),
  awaitSuspended: async (id) => box(id).view,
  createAndAwaitRunning: async (body = {}) => {
    record("createAndAwaitRunning", body);
    const fs = body.snapshot_id
      ? world.snapshots.get(body.snapshot_id)?.clone()
      : new FakeFs();
    if (!fs) {
      throw apiError(404, "snapshot not found");
    }
    const id = `dbx_${++seq}`;
    const view = {
      capabilities: [],
      create_time_ms: Date.now(),
      end_time_ms: null,
      id,
      launch_parameters: {},
      metadata: { ...body.metadata },
      name: body.name ?? null,
      state_transitions: [],
      status: "running",
    } as Runloop.DevboxView;
    world.boxes.set(id, { env: { ...body.environment_variables }, fs, view });
    return view;
  },
  downloadFile: async (id, body) => {
    const data = box(id).fs.read(body.path);
    if (!data) {
      throw apiError(400, `{"error":"File not found: ${body.path}"}`);
    }
    // The SDK types this as its fetch-shim Response; the adapter only reads
    // arrayBuffer(), which the global Response provides.
    return new Response(new Uint8Array(data)) as unknown as Awaited<
      ReturnType<Devboxes["downloadFile"]>
    >;
  },
  enableTunnel: async (id: string) => {
    record("enableTunnel", id);
    const tunnel: Runloop.TunnelView = {
      auth_mode: "open",
      create_time_ms: Date.now(),
      http_keep_alive: true,
      tunnel_key: `tk${id}`,
      wake_on_http: false,
    };
    box(id).view = { ...box(id).view, tunnel };
    return tunnel;
  },
  executeAndAwaitCompletion: execute,
  list: (query?: { limit?: number }) => {
    // Cursor pages of `limit`; iterating the page promise walks every page.
    const all = [...world.boxes.values()].map((b) => b.view);
    const size = query?.limit ?? 20;
    async function* pages() {
      for (let i = 0; i === 0 || i < all.length; i += size) {
        world.pageFetches++;
        yield* all.slice(i, i + size);
      }
    }
    return Object.assign(Promise.resolve({ devboxes: all.slice(0, size) }), {
      [Symbol.asyncIterator]: pages,
    });
  },
  removeTunnel: async (id: string) => {
    record("removeTunnel", id);
    box(id).view = { ...box(id).view, tunnel: null };
    return {};
  },
  resume: async (id: string) => setStatus(id, "resuming"),
  retrieve: async (id: string) => box(id).view,
  shutdown: async (id: string) => {
    record("shutdown", id);
    return setStatus(id, "shutdown");
  },
  snapshotDisk: async (id: string, body?: Runloop.DevboxSnapshotDiskParams) => {
    const sid = `snp_${++seq}`;
    world.snapshots.set(sid, box(id).fs.clone());
    return {
      create_time_ms: Date.now(),
      id: sid,
      metadata: {},
      name: body?.name ?? null,
      source_devbox_id: id,
    };
  },
  suspend: async (id: string) => setStatus(id, "suspended"),
  uploadFile: async (id, body) => {
    record("uploadFile", body);
    const file = body.file;
    if (!file || !("arrayBuffer" in file)) {
      throw apiError(400, "file must be a FileLike (use toFile)");
    }
    const read = file.arrayBuffer as () => Promise<ArrayBuffer>;
    box(id).fs.write(body.path, new Uint8Array(await read.call(file)));
    return {};
  },
};

vi.mock("@runloop/api-client", async () => {
  const actual = await vi.importActual<typeof import("@runloop/api-client")>(
    "@runloop/api-client"
  );
  return {
    default: class {
      devboxes = devboxes;
      constructor(o: { bearerToken?: string }) {
        record("new Runloop", o);
      }
    },
    toFile: actual.toFile,
  };
});

beforeEach(() => {
  world.calls.length = 0;
});

describe("runloop adapter (deprecated)", () => {
  it("warns once and declares truthful caps", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = runloop({ apiKey: "k" });
    runloop({ apiKey: "k" });
    expect(p.capabilities).toBe(RUNLOOP_CAPS);
    expect(p.capabilities.privatePreview).toBe("unsupported");
    expect(p.flags.previewModel).toBe("tunnel");
    expect(typeof p.verify).toBe("function");
    // Module-level flag: may already have fired in an earlier test.
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    warn.mockRestore();
  });

  it("passes offline conformance (live checks on)", async () => {
    const report = await runConformance(runloop({ apiKey: "k" }), {
      live: true,
    });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.checks.length).toBeGreaterThan(25);
  }, 60_000);

  it("maps the spec, builds tunnel preview URLs, wraps uploads with toFile", async () => {
    const client = createSandboxClient({
      provider: runloop({ apiKey: "k" }),
      telemetry: false,
    });
    const sb = await client.create({
      env: { A: "1" },
      metadata: { team: "x" },
      name: "dev",
      template: "bpt_123",
    });
    expect(callsOf("createAndAwaitRunning")[0]).toEqual({
      blueprint_id: "bpt_123",
      environment_variables: { A: "1" },
      metadata: { team: "x" },
      name: "dev",
    });
    const p = await sb.ports!.expose(3000);
    expect(p.url).toBe(`https://3000-tk${sb.id}.tunnel.runloop.ai`);
    expect(p.auth).toEqual({ type: "public" });
    await sb.ports!.expose(3001);
    expect(callsOf("enableTunnel")).toHaveLength(1); // one tunnel per devbox
    await sb.ports!.unexpose(3000);
    expect(callsOf("removeTunnel")).toHaveLength(0); // 3001 still uses it
    await sb.ports!.unexpose(3001);
    expect(callsOf("removeTunnel")).toEqual([sb.id]);

    await sb.files.write("/tmp/x.bin", new Uint8Array([0, 255]));
    const up = callsOf("uploadFile")[0] as { file: unknown; path: string };
    expect(up.path).toBe("/tmp/x.bin");
    expect(up.file).toMatchObject({ name: "x.bin" }); // toFile() FileLike
    expect(await world.boxes.get(sb.id)!.fs.read("/tmp/x.bin")).toEqual(
      new Uint8Array([0, 255])
    );
    await sb.destroy();
    expect(callsOf("shutdown")).toEqual([sb.id]);
  });

  it("authenticated tunnels carry header auth", async () => {
    const client = createSandboxClient({
      provider: runloop({ apiKey: "k" }),
      telemetry: false,
    });
    const sb = await client.create();
    const b = world.boxes.get(sb.id)!;
    b.view = {
      ...b.view,
      tunnel: {
        auth_mode: "authenticated",
        auth_token: "tok",
        create_time_ms: 0,
        http_keep_alive: true,
        tunnel_key: "abc",
        wake_on_http: false,
      },
    };
    const p = await (await client.connect(sb.id)).ports!.expose(8080);
    expect(p.url).toBe("https://8080-abc.tunnel.runloop.ai");
    expect(p.auth).toEqual({
      headers: { "X-Runloop-Tunnel-Authorization": "Bearer tok" },
      type: "header",
    });
    await sb.destroy();
  });

  it("list walks every cursor page and getInfo is live", async () => {
    const client = createSandboxClient({
      provider: runloop({ apiKey: "k" }),
      telemetry: false,
    });
    const made = [];
    for (let i = 0; i < 3; i++) {
      made.push(await client.create({ metadata: { pg: "1" } }));
    }
    // >100 devboxes so the adapter's limit-100 pages need a second fetch.
    for (let i = 0; i < 100; i++) {
      await devboxes.createAndAwaitRunning({ metadata: { pg: "filler" } });
    }
    world.pageFetches = 0;
    const seen: string[] = [];
    for await (const i of client.list({ metadata: { pg: "1" } })) {
      seen.push(i.id);
    }
    expect(seen).toEqual(made.map((s) => s.id));
    expect(world.pageFetches).toBeGreaterThan(1);

    setStatus(made[0]!.id, "suspended");
    expect((await made[0]!.getInfo()).state).toBe("paused");
  });

  it("maps statuses and errors", () => {
    expect(mapRunloopState("queued")).toBe("creating");
    expect(mapRunloopState("scheduled")).toBe("creating");
    expect(mapRunloopState("provisioning")).toBe("creating");
    expect(mapRunloopState("initializing")).toBe("creating");
    expect(mapRunloopState("resuming")).toBe("creating");
    expect(mapRunloopState("running")).toBe("running");
    expect(mapRunloopState("suspending")).toBe("suspending");
    expect(mapRunloopState("suspended")).toBe("paused");
    expect(mapRunloopState("failure")).toBe("error");
    expect(mapRunloopState("shutdown")).toBe("destroyed");
    expect(mapRunloopState("??")).toBe("unknown");

    const code = (e: Error) => mapRunloopError(e)?.code;
    expect(code(apiError(401, "x"))).toBe("Unauthorized");
    expect(code(apiError(403, "x"))).toBe("Unauthorized");
    expect(code(apiError(404, "x"))).toBe("NotFound");
    expect(code(apiError(409, "x"))).toBe("Conflict");
    expect(code(apiError(429, "x"))).toBe("QuotaExceeded");
    expect(code(apiError(503, "x"))).toBe("Provider");
    expect(code(named("PollingTimeoutError", "t"))).toBe("Timeout");
    expect(code(new Error("plain"))).toBeUndefined();
  });
});
