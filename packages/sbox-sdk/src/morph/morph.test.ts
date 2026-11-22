/**
 * Offline tests for the Morph adapter. `morphcloud` is replaced by a fake that
 * mirrors the 0.0.20 SDK surface (method names + argument shapes from its
 * `.d.ts`), backed by `MiniShell` over an in-memory filesystem per VM.
 */
import type {
  Instance,
  InstanceHttpService,
  InstanceStartOptions,
  MorphCloudClient,
  Snapshot,
  SnapshotCreateOptions,
} from "morphcloud";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runConformance } from "../conformance/index.js";
import { createSandboxClient } from "../index.js";
import { MiniShell } from "../memory/shell.js";
import type { ShellFs } from "../memory/shell.js";
import { MORPH_CAPS, mapMorphError, mapMorphState, morph } from "./index.js";

// ---------------------------------------------------------------------------
// in-memory VM filesystem
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
const parent = (p: string): string => {
  const n = norm(p);
  return n.slice(0, n.lastIndexOf("/")) || "/";
};

class FakeFs implements ShellFs {
  files = new Map<string, Uint8Array>();
  dirs = new Set(["/", "/tmp", "/root"]);
  clone(): FakeFs {
    const f = new FakeFs();
    f.files = new Map(this.files);
    f.dirs = new Set(this.dirs);
    return f;
  }
  #mkp(d: string): void {
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
    const from = norm(a);
    const to = norm(b);
    const data = this.files.get(from);
    if (data) {
      this.files.delete(from);
      this.write(to, data);
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
          this.#mkp(to + d.slice(from.length));
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

// ---------------------------------------------------------------------------
// fake morphcloud SDK
// ---------------------------------------------------------------------------

const dec = new TextDecoder();
const httpErr = (status: number, what: string) =>
  new Error(
    `HTTP ${status} ${status === 404 ? "Not Found" : "Conflict"} for https://cloud.morph.so/api/${what}\nResponse Body: {}`
  );

let seq = 0;
const world = {
  calls: [] as { method: string; args: unknown }[],
  instances: new Map<string, FakeInstance>(),
  snapshots: new Map<string, FakeSnapshot>(),
};
const record = (method: string, args: unknown) =>
  world.calls.push({ args, method });
const callsOf = (method: string) =>
  world.calls.filter((c) => c.method === method).map((c) => c.args);

async function runIn(
  fs: FakeFs,
  cmd: string,
  io: {
    signal?: AbortSignal;
    onStdout?: (s: string) => void;
    onStderr?: (s: string) => void;
  } = {}
) {
  let stdout = "";
  let stderr = "";
  const exit_code = await new MiniShell(fs).run(cmd, {
    cwd: "/root",
    env: { HOME: "/root" },
    signal: io.signal ?? new AbortController().signal,
    stderr: (d) => {
      const s = dec.decode(d);
      stderr += s;
      io.onStderr?.(s);
    },
    stdin: new Uint8Array(),
    stdout: (d) => {
      const s = dec.decode(d);
      stdout += s;
      io.onStdout?.(s);
    },
  });
  return { exit_code, stderr, stdout };
}

class FakeSnapshot {
  readonly id = `snapshot_${++seq}`;
  readonly object = "snapshot" as const;
  readonly created = Math.floor(Date.now() / 1000);
  status = "ready" as Snapshot["status"];
  readonly spec = { diskSize: 0, memory: 0, vcpus: 0 };
  readonly refs = { imageId: "morphvm-minimal" };
  metadata: Record<string, string>;
  fs: FakeFs;
  digest?: string;
  constructor(
    fs: FakeFs,
    digest?: string,
    metadata: Record<string, string> = {}
  ) {
    this.fs = fs;
    this.digest = digest;
    this.metadata = { ...metadata };
    world.snapshots.set(this.id, this);
  }
  delete: Snapshot["delete"] = async () => {
    record("snapshot.delete", this.id);
    world.snapshots.delete(this.id);
  };
  setMetadata: Snapshot["setMetadata"] = async (m) => {
    Object.assign(this.metadata, m);
  };
  setup: Snapshot["setup"] = async (command) => {
    record("snapshot.setup", command);
    const digest = `${this.digest ?? this.id}>${command}`;
    const hit = [...world.snapshots.values()].find((s) => s.digest === digest);
    if (hit) {
      return hit as unknown as Snapshot;
    }
    const fs = this.fs.clone();
    const r = await runIn(fs, command);
    if (r.exit_code !== 0) {
      throw new Error(`Command exited with code ${r.exit_code}`);
    }
    return new FakeSnapshot(fs, digest) as unknown as Snapshot;
  };
}

class FakeInstance {
  readonly id = `morphvm_${++seq}`;
  readonly object = "instance" as const;
  readonly created = Math.floor(Date.now() / 1000);
  status: Instance["status"];
  readonly spec = { diskSize: 0, memory: 0, vcpus: 0 };
  readonly refs: Instance["refs"];
  networking: Instance["networking"] = { httpServices: [] };
  ttl: Instance["ttl"] = {};
  wakeOn: Instance["wakeOn"] = {};
  readonly metadata: Record<string, string>;
  readonly running = new Map<string, AbortController>();
  fs: FakeFs;
  constructor(
    fs: FakeFs,
    snapshotId: string,
    metadata: Record<string, string> = {},
    status: Instance["status"] = "ready" as Instance["status"]
  ) {
    this.fs = fs;
    this.status = status;
    this.refs = { imageId: "morphvm-minimal", snapshotId };
    this.metadata = { ...metadata };
    world.instances.set(this.id, this);
  }
  #assertReady(): void {
    if (this.status !== "ready" || !world.instances.has(this.id)) {
      throw httpErr(409, `instance/${this.id}`);
    }
  }
  exec: Instance["exec"] = async (command, options) => {
    this.#assertReady();
    const cmd = Array.isArray(command) ? command.join(" ") : command;
    const killed = /grep -qz 'SBOX_EXEC_ID=(\w+)'/.exec(cmd);
    if (killed) {
      // Model the VM's process table: kill the tagged process tree.
      record("exec.kill", killed[1]);
      this.running.get(killed[1]!)?.abort();
      return { exit_code: 0, stderr: "", stdout: "" };
    }
    const ac = new AbortController();
    const execId = /^SBOX_EXEC_ID=(\w+) /.exec(cmd)?.[1];
    if (execId) {
      this.running.set(execId, ac);
    }
    let timedOut = false;
    const timer = options?.timeout
      ? setTimeout(() => {
          timedOut = true;
          ac.abort();
        }, options.timeout * 1000)
      : undefined;
    try {
      const r = await runIn(this.fs, cmd, {
        onStderr: options?.onStderr,
        onStdout: options?.onStdout,
        signal: ac.signal,
      });
      if (timedOut) {
        throw new Error(
          `Command execution timed out after ${options?.timeout} seconds`
        );
      }
      return r;
    } finally {
      clearTimeout(timer);
      if (execId) {
        this.running.delete(execId);
      }
    }
  };
  stop: Instance["stop"] = async () => {
    record("instance.stop", this.id);
    for (const ac of this.running.values()) {
      ac.abort();
    }
    world.instances.delete(this.id);
  };
  pause: Instance["pause"] = async () => {
    this.#assertReady();
    this.status = "paused" as Instance["status"];
  };
  resume: Instance["resume"] = async () => {
    this.status = "ready" as Instance["status"];
  };
  setWakeOn: Instance["setWakeOn"] = async (wakeOnSsh, wakeOnHttp) => {
    record("instance.setWakeOn", { wakeOnHttp, wakeOnSsh });
    this.wakeOn = { wakeOnHttp, wakeOnSsh };
  };
  setTTL: Instance["setTTL"] = async (ttlSeconds, ttlAction) => {
    record("instance.setTTL", { ttlAction, ttlSeconds });
    this.ttl = { ttlAction, ttlSeconds };
  };
  snapshot: Instance["snapshot"] = async (options) => {
    record("instance.snapshot", options);
    return new FakeSnapshot(
      this.fs.clone(),
      options?.digest,
      options?.metadata
    ) as unknown as Snapshot;
  };
  branch: Instance["branch"] = async (count) => {
    const snap = new FakeSnapshot(this.fs.clone());
    const instances = Array.from(
      { length: count },
      () =>
        new FakeInstance(
          snap.fs.clone(),
          snap.id,
          {},
          "pending" as Instance["status"]
        ) as unknown as Instance
    );
    return { instances, snapshot: snap as unknown as Snapshot };
  };
  exposeHttpService: Instance["exposeHttpService"] = async (
    name,
    port,
    auth_mode
  ) => {
    record("instance.exposeHttpService", { auth_mode, name, port });
    const svc: InstanceHttpService = {
      name,
      port,
      url: `https://${name}-${this.id.replace("_", "-")}.http.cloud.morph.so`,
    };
    this.networking.httpServices = [
      ...this.networking.httpServices.filter((s) => s.name !== name),
      svc,
    ];
    return svc;
  };
  hideHttpService: Instance["hideHttpService"] = async (name) => {
    this.networking.httpServices = this.networking.httpServices.filter(
      (s) => s.name !== name
    );
  };
  waitUntilReady: Instance["waitUntilReady"] = async () => {
    if (this.status === "pending") {
      this.status = "ready" as Instance["status"];
    }
    if (this.status === "error") {
      throw new Error("Instance encountered an error");
    }
  };
  sshKey: Instance["sshKey"] = async () => ({
    object: "instance_ssh_key",
    password: "pw",
    private_key: "-----BEGIN OPENSSH PRIVATE KEY-----\nk\n",
    public_key: "ssh-ed25519 AAA",
  });
}

const asInst = (i: FakeInstance) => i as unknown as Instance;
const asSnap = (s: FakeSnapshot) => s as unknown as Snapshot;
const matches = (
  m: Record<string, string> | undefined,
  f?: Record<string, string>
) => !f || Object.entries(f).every(([k, v]) => m?.[k] === v);

class FakeMorphCloudClient {
  readonly baseUrl: string;
  readonly apiKey: string;
  constructor(o: { apiKey?: string; baseUrl?: string } = {}) {
    this.apiKey = o.apiKey ?? "";
    this.baseUrl = o.baseUrl ?? "https://cloud.morph.so/api";
  }
  snapshots: Pick<MorphCloudClient["snapshots"], "list" | "create" | "get"> = {
    create: async (o: SnapshotCreateOptions = {}) => {
      record("snapshots.create", o);
      return asSnap(new FakeSnapshot(new FakeFs(), o.digest, o.metadata));
    },
    get: async ({ snapshotId }) => {
      const s = world.snapshots.get(snapshotId);
      if (!s) {
        throw httpErr(404, `snapshot/${snapshotId}`);
      }
      return asSnap(s);
    },
    list: async (o = {}) => {
      record("snapshots.list", o);
      return [...world.snapshots.values()]
        .filter(
          (s) =>
            (!o.digest || s.digest === o.digest) &&
            matches(s.metadata, o.metadata)
        )
        .map(asSnap);
    },
  };
  instances: Pick<
    MorphCloudClient["instances"],
    "list" | "start" | "get" | "stop"
  > = {
    get: async ({ instanceId }) => {
      const i = world.instances.get(instanceId);
      if (!i) {
        throw httpErr(404, `instance/${instanceId}`);
      }
      return asInst(i);
    },
    list: async (o = {}) =>
      [...world.instances.values()]
        .filter((i) => matches(i.metadata, o.metadata))
        .map(asInst),
    start: async (o: InstanceStartOptions) => {
      record("instances.start", o);
      const s = world.snapshots.get(o.snapshotId);
      if (!s) {
        throw httpErr(404, `snapshot/${o.snapshotId}`);
      }
      const inst = new FakeInstance(s.fs.clone(), s.id, o.metadata);
      inst.ttl = { ttlAction: o.ttlAction, ttlSeconds: o.ttlSeconds };
      return asInst(inst);
    },
    stop: async ({ instanceId }) => {
      await world.instances.get(instanceId)?.stop();
    },
  };
}

vi.mock("morphcloud", () => ({ MorphCloudClient: FakeMorphCloudClient }));

beforeEach(() => {
  world.calls.length = 0;
});

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("morph adapter", () => {
  it("declares truthful caps", () => {
    const p = morph({ apiKey: "k" });
    expect(p.capabilities).toBe(MORPH_CAPS);
    expect(p.capabilities.pause).toBe("native");
    expect(p.capabilities.streaming).toBe("native");
    expect(p.capabilities.privatePreview).toBe("native");
    expect(p.flags.templateSources).toEqual([
      "dockerfile",
      "image",
      "snapshot",
    ]);
    expect(p.flags.resumeChangesId).toBe(false);
  });

  it("passes offline conformance (live checks on)", async () => {
    const report = await runConformance(morph({ apiKey: "k" }), {
      live: true,
      template: {
        source: {
          dockerfile:
            "FROM morphvm-minimal\nRUN mkdir -p /opt && echo built > /opt/marker\n",
        },
      },
    });
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed).toEqual([]);
    expect(report.checks.length).toBeGreaterThan(30);
  }, 60_000);

  it("maps a rich spec onto start() and reuses the base snapshot by digest", async () => {
    const client = createSandboxClient({
      provider: morph({ apiKey: "k" }),
      telemetry: false,
    });
    const spec = {
      env: { FOO: "bar baz" },
      lifecycle: {
        autoResume: true,
        maxAgeMs: 90_500,
        onIdle: "pause" as const,
      },
      metadata: { team: "a" },
      name: "box",
      ports: [3000],
      resources: { diskMB: 4096, memoryMB: 2048, vcpus: 2 },
      secrets: [{ envVar: "TOKEN", name: "tok", value: "s3cr3t" }],
      template: "morphvm-sandbox",
    };
    const sb = await client.create(spec);

    const [created] = callsOf("snapshots.create") as SnapshotCreateOptions[];
    expect(created).toMatchObject({
      diskSize: 4096,
      imageId: "morphvm-sandbox",
      memory: 2048,
      vcpus: 2,
    });
    expect(created?.digest).toMatch(/^sbox-base-[0-9a-f]{64}$/);

    const [start] = callsOf("instances.start") as InstanceStartOptions[];
    expect(start).toMatchObject({
      metadata: { "sbox-name": "box", team: "a" },
      ttlAction: "pause",
      ttlSeconds: 91,
    });
    expect(start?.metadata?.["sbox-idempotency-key"]).toBeTruthy();
    expect(callsOf("instance.setWakeOn")).toEqual([
      { wakeOnHttp: true, wakeOnSsh: true },
    ]);
    expect(callsOf("instance.exposeHttpService")).toEqual([
      { auth_mode: "none", name: "sbox-3000", port: 3000 },
    ]);

    const r = await sb.commands.run("echo $FOO $TOKEN");
    expect(r.stdout.trim()).toBe("bar baz s3cr3t");
    expect((await sb.getInfo()).name).toBe("box");

    // Second create with the same image+resources reuses the snapshot.
    const sb2 = await client.create(spec);
    expect(callsOf("snapshots.create")).toHaveLength(1);
    await sb.destroy();
    await sb2.destroy();
  });

  it("bakes cwd/env into the command sent to instance.exec (with a kill marker)", async () => {
    const client = createSandboxClient({
      provider: morph({ apiKey: "k" }),
      telemetry: false,
    });
    const sb = await client.create({ env: { BASE: "1" } });
    const inst = world.instances.get(sb.id)!;
    const seen: string[] = [];
    const orig = inst.exec;
    inst.exec = (cmd, o) => {
      seen.push(String(cmd));
      return orig(cmd, o);
    };
    await sb.commands.run("pwd", { cwd: "/tmp", env: { X: "y" } });
    expect(seen[0]).toMatch(/^SBOX_EXEC_ID=\w+ sh -c /);
    expect(seen[0]).toContain("export BASE=");
    expect(seen[0]).toContain("cd ");
    expect(seen[0]).toContain("/tmp");
    await sb.destroy();
  });

  it("an idempotency key returns the existing instance instead of a second VM", async () => {
    const client = createSandboxClient({
      provider: morph({ apiKey: "k" }),
      telemetry: false,
    });
    const a = await client.create({ idempotencyKey: "idem-1" });
    const b = await client.create({ idempotencyKey: "idem-1" });
    expect(b.id).toBe(a.id);
    expect(callsOf("instances.start")).toHaveLength(1);
    await a.destroy();
  });

  it("rejects spec fields Morph cannot honor", async () => {
    const client = createSandboxClient({
      provider: morph({ apiKey: "k" }),
      retry: { retries: 0 },
      telemetry: false,
    });
    await expect(
      client.create({ volumes: [{ id: "v", mountPath: "/data" }] })
    ).rejects.toMatchObject({ code: "Validation" });
    await expect(
      client.create({ network: { mode: "block-all" } })
    ).rejects.toMatchObject({ code: "Validation" });
    await expect(
      client.create({ secrets: [{ name: "vault-only" }] })
    ).rejects.toMatchObject({ code: "Validation" });
  });

  it("fork deletes the intermediate branch snapshot; snapshots keep their name", async () => {
    const client = createSandboxClient({
      provider: morph({ apiKey: "k" }),
      telemetry: false,
    });
    const sb = await client.create();
    const before = world.snapshots.size;
    const kids = await sb.fork({ count: 2 });
    expect(kids).toHaveLength(2);
    expect(world.snapshots.size).toBe(before);
    expect(callsOf("snapshot.delete")).toHaveLength(1);

    const ref = await sb.snapshots!.create({ name: "nightly" });
    expect(ref.name).toBe("nightly");
    expect(ref.includesMemory).toBe(true);
    expect(callsOf("instance.snapshot")[0]).toMatchObject({
      metadata: {
        "sbox-snapshot-name": "nightly",
        "sbox-source-instance": sb.id,
      },
    });
    const listed = await sb.snapshots!.list();
    expect(listed.map((s) => [s.id, s.name])).toEqual([[ref.id, "nightly"]]);
    await sb.snapshots!.delete(ref);
    expect(await sb.snapshots!.list()).toEqual([]);

    // Boot a new sandbox from a snapshot: restore = new instance.
    const snap2 = await sb.snapshots!.create();
    const restored = await client.create({ fromSnapshot: snap2 });
    expect(restored.id).not.toBe(sb.id);
    for (const s of [sb, restored, ...kids]) {
      await s.destroy();
    }
  });

  it("getInfo refreshes live status; pause/setTimeout/ssh are native", async () => {
    const client = createSandboxClient({
      provider: morph({ apiKey: "k" }),
      telemetry: false,
    });
    const sb = await client.create();
    expect((await sb.getInfo()).state).toBe("running");
    // Paused out-of-band (dashboard, TTL action): getInfo must not be stale.
    world.instances.get(sb.id)!.status = "paused" as Instance["status"];
    expect((await sb.getInfo()).state).toBe("paused");
    await sb.resume();
    await sb.pause();
    expect((await sb.getInfo()).state).toBe("paused");
    await sb.resume();

    await sb.setTimeout(30_000);
    expect(callsOf("instance.setTTL")).toEqual([
      { ttlAction: "stop", ttlSeconds: 30 },
    ]);
    const creds = await sb.ssh!.create();
    expect(creds).toMatchObject({
      host: "ssh.cloud.morph.so",
      port: 22,
      user: sb.id,
    });
    expect(creds.privateKey).toContain("PRIVATE KEY");
    await sb.destroy();
    await expect(sb.getInfo()).rejects.toMatchObject({ code: "NotFound" });
  });

  it("private previews use api_key header auth", async () => {
    const client = createSandboxClient({
      provider: morph({ apiKey: "morph_key" }),
      telemetry: false,
    });
    const sb = await client.create();
    const p = await sb.ports!.expose(8080, { visibility: "private" });
    expect(p.auth).toEqual({
      headers: { Authorization: "Bearer morph_key" },
      type: "header",
    });
    expect(callsOf("instance.exposeHttpService").at(-1)).toEqual({
      auth_mode: "api_key",
      name: "sbox-8080",
      port: 8080,
    });
    const pub = await sb.ports!.expose(8081);
    expect(pub.auth).toEqual({ type: "public" });
    await sb.destroy();
  });

  it("templates: dockerfile RUN chains via setup(); other instructions are rejected", async () => {
    const client = createSandboxClient({
      provider: morph({ apiKey: "k" }),
      telemetry: false,
    });
    const events: string[] = [];
    const ref = await client.templates!.build(
      {
        source: {
          dockerfile:
            "FROM morphvm-minimal\nRUN echo a > /a\nRUN echo b > /b\n",
        },
      },
      { onEvent: (e) => events.push(e.type === "status" ? e.status : e.line) }
    );
    expect(ref.id).toMatch(/^snapshot_/);
    expect(callsOf("snapshot.setup")).toEqual(["echo a > /a", "echo b > /b"]);
    expect(events).toContain("RUN echo a > /a");
    expect(await client.templates!.get(ref.cacheKey!)).toMatchObject({
      id: ref.id,
    });

    const sb = await client.create({ template: ref });
    expect((await sb.commands.run("cat /a /b")).stdout).toBe("a\nb\n");
    await sb.destroy();

    await expect(
      client.templates!.build({
        source: { dockerfile: "FROM morphvm-minimal\nCOPY . /app\n" },
      })
    ).rejects.toMatchObject({ code: "Validation" });
    await expect(
      client.templates!.build({ source: { dockerfile: "RUN echo no-from\n" } })
    ).rejects.toMatchObject({ code: "Validation" });
  });

  it("list honors metadata, state and limit", async () => {
    const p = morph({ apiKey: "k" });
    const client = createSandboxClient({ provider: p, telemetry: false });
    const a = await client.create({ metadata: { grp: "L" } });
    const b = await client.create({ metadata: { grp: "L" } });
    world.instances.get(b.id)!.status = "paused" as Instance["status"];
    const ids = async (f: Parameters<typeof client.list>[0]) => {
      const out: string[] = [];
      for await (const i of client.list(f)) {
        out.push(i.id);
      }
      return out;
    };
    expect(await ids({ metadata: { grp: "L" } })).toEqual([a.id, b.id]);
    expect(await ids({ metadata: { grp: "L" }, state: "paused" })).toEqual([
      b.id,
    ]);
    expect(await ids({ limit: 1, metadata: { grp: "L" } })).toEqual([a.id]);
    await a.destroy();
    await b.destroy();
  });

  it("maps statuses and errors", () => {
    expect(mapMorphState("pending")).toBe("creating");
    expect(mapMorphState("ready")).toBe("running");
    expect(mapMorphState("paused")).toBe("paused");
    expect(mapMorphState("saving")).toBe("suspending");
    expect(mapMorphState("error")).toBe("error");
    expect(mapMorphState("weird")).toBe("unknown");

    const code = (msg: string) => mapMorphError(new Error(msg))?.code;
    expect(code("HTTP 401 Unauthorized for x")).toBe("Unauthorized");
    expect(code("HTTP 403 Forbidden for x")).toBe("Unauthorized");
    expect(code("HTTP 404 Not Found for x")).toBe("NotFound");
    expect(code("HTTP 409 Conflict for x")).toBe("Conflict");
    expect(code("HTTP 429 Too Many Requests for x")).toBe("QuotaExceeded");
    expect(mapMorphError(new Error("HTTP 429 x"))?.retryable).toBe(true);
    expect(code("HTTP 500 Internal Server Error for x")).toBe("Provider");
    expect(code("Command execution timed out after 3 seconds")).toBe("Timeout");
    expect(code("something else")).toBeUndefined();
  });
});
