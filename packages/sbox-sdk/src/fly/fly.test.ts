/**
 * Offline tests for the Fly Machines adapter. `FakeFly` is an in-memory Fly
 * Machines API served through an injected `fetch`: it routes the same paths,
 * methods and JSON bodies as https://api.machines.dev/v1 (see the OpenAPI spec),
 * and each machine's `/exec` runs on the in-memory provider's MiniShell so shell
 * semantics (exit codes, stderr, sleep/kill, files) are real.
 */
import { describe, expect, it } from "vitest";

import { shellQuote } from "../adapter/index.js";
import type {
  CallContext,
  DriverExec,
  DriverHandle,
} from "../adapter/index.js";
import { runConformance } from "../conformance/index.js";
import { createSandboxClient } from "../index.js";
import { memory } from "../memory/index.js";
import type { MemoryRaw } from "../memory/index.js";
import { FLY_CAPS, fly, mapFlyError, mapFlyState } from "./index.js";
import type { FlyMachine, FlyMachineConfig } from "./index.js";

interface Running {
  pid: number;
  command: string;
  exec: DriverExec;
}

interface FakeMachine {
  machine: FlyMachine;
  box: DriverHandle<MemoryRaw>;
  procs: Map<number, Running>;
}

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Headers;
}

/**
 * MiniShell's `cd` does not carry into the next command of a list, so lift the
 * core's `sh -c 'cd <dir> && …'` wrapper (perCommandEnvCwd: false) into the
 * in-memory exec's native cwd. A real `sh` needs no help here.
 */
function splitCwd(script: string): { cwd?: string; rest: string } {
  const outer = /^sh -c '((?:[^']|'\\'')*)'$/s.exec(script);
  if (!outer) {
    return { rest: script };
  }
  const inner = outer[1]!.replaceAll("'\\''", "'");
  const cd = /^cd '((?:[^']|'\\'')*)' && /.exec(inner);
  if (!cd) {
    return { rest: script };
  }
  return {
    cwd: cd[1]!.replaceAll("'\\''", "'"),
    rest: inner.slice(cd[0].length),
  };
}

const json = (obj: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(obj, { headers, status });

class FakeFly {
  readonly mem = memory({ idPrefix: "mvm" });
  readonly machines = new Map<string, FakeMachine>();
  readonly volumes = new Map<string, Record<string, unknown>>();
  readonly secrets = new Map<string, string>();
  readonly requests: Recorded[] = [];
  /** Page size for list endpoints (exercise `fly-next-cursor`). */
  pageSize = 1000;
  /** Max JSON stdout per /exec before a 413 `exec_output_too_large`. */
  outputLimit = Number.POSITIVE_INFINITY;
  #pid = 100;
  #n = 0;
  #secretsVersion = 0;
  readonly ctx: CallContext = { attempt: 1, fetch: globalThis.fetch };

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    );
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init?.headers);
    this.requests.push({
      body,
      headers,
      method,
      path: url.pathname,
      query: url.searchParams,
    });
    if (url.hostname !== "api.machines.dev") {
      const target = headers.get("fly-force-instance-id");
      return new Response(`hello from ${target ?? "any"} ${url.pathname}`);
    }
    if (headers.get("authorization") !== "Bearer t") {
      return json({ error: "unauthorized" }, 401);
    }
    return this.route(method, url, body, init?.signal ?? undefined);
  };

  async route(
    method: string,
    url: URL,
    body: any,
    signal?: AbortSignal
  ): Promise<Response> {
    const p = url.pathname.replace(/^\/v1/, "");
    const q = url.searchParams;
    let m: RegExpMatchArray | null;
    if (method === "GET" && p === "/apps/app") {
      return json({ name: "app", organization: { slug: "personal" } });
    }
    if ((m = p.match(/^\/apps\/app\/secrets\/([^/]+)$/)) && method === "POST") {
      this.secrets.set(m[1]!, body.value);
      return json({ name: m[1], version: ++this.#secretsVersion }, 201);
    }
    if (p === "/apps/app/machines" && method === "POST") {
      const id = `m${++this.#n}`;
      const box = await this.mem.create({ env: body.config.env }, this.ctx);
      const machine: FlyMachine = {
        config: body.config,
        created_at: new Date().toISOString(),
        id,
        name: body.name ?? `gen-${id}`,
        region: body.region ?? "iad",
        state: "created",
      };
      this.machines.set(id, { box, machine, procs: new Map() });
      queueMicrotask(() => (machine.state = "started"));
      return json(machine);
    }
    if (p === "/apps/app/machines" && method === "GET") {
      let all = [...this.machines.values()].map((x) => x.machine);
      for (const [k, v] of q) {
        if (k.startsWith("metadata.")) {
          const key = k.slice("metadata.".length);
          all = all.filter((x) => x.config?.metadata?.[key] === v);
        }
      }
      if (q.get("state")) {
        const states = q.get("state")!.split(",");
        all = all.filter((x) => states.includes(x.state ?? ""));
      }
      const start = Number(q.get("cursor") ?? 0);
      const size = Math.min(Number(q.get("limit") ?? 1000), this.pageSize);
      const page = all.slice(start, start + size);
      const next = start + size < all.length ? String(start + size) : null;
      return json(page, 200, next ? { "fly-next-cursor": next } : {});
    }
    if ((m = p.match(/^\/apps\/app\/machines\/([^/]+)(\/[a-z]+)?$/))) {
      const fm = this.machines.get(m[1]!);
      if (!fm) {
        return json({ error: "machine not found" }, 404);
      }
      return this.machineRoute(fm, method, m[2] ?? "", q, body, signal);
    }
    if (p === "/apps/app/volumes" && method === "POST") {
      const id = `vol_${++this.#n}`;
      const v = {
        id,
        name: body.name,
        region: body.region,
        size_gb: body.size_gb,
        state: "created",
      };
      this.volumes.set(id, v);
      return json(v);
    }
    if (p === "/apps/app/volumes" && method === "GET") {
      return json([...this.volumes.values()]);
    }
    if ((m = p.match(/^\/apps\/app\/volumes\/([^/]+)$/))) {
      const v = this.volumes.get(m[1]!);
      if (!v) {
        return json({ error: "not found" }, 404);
      }
      if (method === "DELETE") {
        this.volumes.delete(m[1]!);
      }
      return json(v);
    }
    return json({ error: `unexpected ${method} ${p}` }, 404);
  }

  async machineRoute(
    fm: FakeMachine,
    method: string,
    suffix: string,
    q: URLSearchParams,
    body: any,
    signal?: AbortSignal
  ): Promise<Response> {
    const mach = fm.machine;
    switch (`${method} ${suffix}`) {
      case "GET ": {
        return json(mach);
      }
      case "POST ": {
        mach.config = body.config as FlyMachineConfig;
        mach.state = "started"; // update = replace + restart
        return json(mach);
      }
      case "DELETE ": {
        await fm.box.destroy(this.ctx);
        this.machines.delete(mach.id);
        return json({ ok: true });
      }
      case "GET /wait": {
        await Promise.resolve();
        return json({ ok: true, state: q.get("state") });
      }
      case "POST /stop": {
        mach.state = "stopped";
        return json({ ok: true });
      }
      case "POST /suspend": {
        mach.state = "suspended";
        return json({ ok: true });
      }
      case "POST /start": {
        mach.state = "started";
        return json({ ok: true });
      }
      case "GET /ps": {
        return json(
          [...fm.procs.values()].map((r) => ({
            command: r.command,
            pid: r.pid,
          }))
        );
      }
      case "POST /exec": {
        if (mach.state !== "started") {
          return json({ error: "machine not started" }, 412);
        }
        return this.exec(fm, body, signal);
      }
      default: {
        return json({ error: `unexpected ${method} ${suffix}` }, 404);
      }
    }
  }

  async exec(
    fm: FakeMachine,
    body: { command: string[]; stdin?: string; timeout?: number },
    signal?: AbortSignal
  ): Promise<Response> {
    const argv = body.command;
    if (argv[0] === "kill") {
      const target = fm.procs.get(Number(argv.at(-1)));
      await target?.exec.kill("SIGKILL");
      return json({ exit_code: target ? 0 : 1, stderr: "", stdout: "" });
    }
    if (argv[0] === "stat" && argv[2] === "%s") {
      const data = await Promise.resolve(fm.box.readFile(argv[3]!, this.ctx));
      return json({ exit_code: 0, stdout: `${data.length}\n` });
    }
    const script =
      argv[0] === "sh" && argv[1] === "-c"
        ? argv[2]!
        : argv.map(shellQuote).join(" ");
    if (script.startsWith("k(){")) {
      // The adapter's /proc tree-kill helper: MiniShell has no functions or
      // `for`, and the fake's processes have no children; the follow-up
      // `kill -s KILL <pid>` (handled above) does the work.
      return json({ exit_code: 0, stderr: "", stdout: "" });
    }
    const dd =
      /^dd if='(.+)' bs=(\d+) skip=(\d+) count=1 2>\/dev\/null \| base64$/.exec(
        script
      );
    if (dd) {
      const data = await Promise.resolve(fm.box.readFile(dd[1]!, this.ctx));
      const bs = Number(dd[2]);
      const chunk = data.subarray(Number(dd[3]) * bs, (Number(dd[3]) + 1) * bs);
      let bin = "";
      for (const b of chunk) {
        bin += String.fromCodePoint(b);
      }
      return json({ exit_code: 0, stdout: btoa(bin) });
    }
    const { cwd, rest } = splitCwd(script);
    const pid = ++this.#pid;
    const ex = fm.box.exec(rest, { cwd, stdin: body.stdin }, this.ctx);
    fm.procs.set(pid, { command: argv.join(" "), exec: ex, pid });
    const timer = setTimeout(() => void ex.kill(), (body.timeout ?? 10) * 1000);
    signal?.addEventListener("abort", () => void ex.kill(), { once: true });
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
    fm.procs.delete(pid);
    if (signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    if (stdout.length > this.outputLimit) {
      return json(
        { error: "output too large", status: "exec_output_too_large" },
        413
      );
    }
    return json({ exit_code: code, exit_signal: 0, stderr, stdout });
  }
}

const make = (fake: FakeFly, extra: Partial<Parameters<typeof fly>[0]> = {}) =>
  fly({
    apiToken: "t",
    appName: "app",
    fetch: fake.fetch,
    region: "iad",
    ...extra,
  });

describe("fly adapter (offline)", () => {
  it("declares truthful capabilities and flags", () => {
    const p = fly({ apiToken: "t", appName: "app" });
    expect(p.name).toBe("fly");
    expect(p.capabilities).toBe(FLY_CAPS);
    expect(p.capabilities.gpu).toBe("unsupported");
    expect(p.flags.perCommandEnvCwd).toBe(false);
    expect(p.flags.preservesDiskOnStop).toBe(true); // rootfs.persist=always
    expect(
      fly({ apiToken: "t", appName: "a", persistRootfs: false }).flags
        .preservesDiskOnStop
    ).toBe(false);
  });

  it("passes the offline conformance suite through the fake Machines API", async () => {
    const fake = new FakeFly();
    const report = await runConformance(make(fake), { live: true });
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed).toEqual([]);
    expect(report.checks.length).toBe(32);
  }, 60_000);

  it("maps a rich spec onto the create request", async () => {
    const fake = new FakeFly();
    const client = createSandboxClient({
      provider: make(fake),
      telemetry: false,
    });
    await client.create({
      env: { A: "1" },
      idempotencyKey: "idem-1",
      lifecycle: { autoResume: true, onIdle: "pause" },
      metadata: { team: "x" },
      name: "box",
      ports: [3000, 8080],
      region: "ams",
      resources: { diskMB: 4096, memoryMB: 300, vcpus: 2 },
      secrets: [{ name: "TOKEN", value: "s3cret" }],
      template: "node:22",
      volumes: [{ id: "vol_1", mountPath: "/data" }],
    });
    const req = fake.requests.find(
      (r) => r.method === "POST" && r.path === "/v1/apps/app/machines"
    );
    const b = req!.body as { config: FlyMachineConfig } & Record<
      string,
      unknown
    >;
    expect(b.name).toBe("box");
    expect(b.region).toBe("ams");
    expect(b.min_secrets_version).toBe(1);
    expect(fake.secrets.get("TOKEN")).toBe("s3cret");
    expect(b.config.image).toBe("node:22");
    expect(b.config.init).toEqual({ exec: ["sleep", "inf"] });
    expect(b.config.restart).toEqual({ policy: "no" });
    expect(b.config.rootfs).toEqual({ persist: "always", size_gb: 4 });
    expect(b.config.guest).toEqual({
      cpu_kind: "shared",
      cpus: 2,
      memory_mb: 512,
    });
    expect(b.config.env).toEqual({ A: "1" });
    expect(b.config.metadata).toEqual({ "sbox-idem": "idem-1", team: "x" });
    expect(b.config.mounts).toEqual([{ path: "/data", volume: "vol_1" }]);
    expect(
      b.config.services?.map((s) => [
        s.internal_port,
        s.ports?.[0]?.port,
        s.autostop,
      ])
    ).toEqual([
      [3000, 443, "suspend"],
      [8080, 8080, "suspend"],
    ]);
  });

  it("is idempotent on retried creates with the same key", async () => {
    const fake = new FakeFly();
    const p = make(fake);
    const ctx = { attempt: 1, fetch: fake.fetch, idempotencyKey: "k1" };
    const a = await p.create({}, ctx);
    const b = await p.create({}, { ...ctx, attempt: 2 });
    expect(b.id).toBe(a.id);
    expect(fake.machines.size).toBe(1);
  });

  it("rejects GPUs and egress policies before any request", async () => {
    const fake = new FakeFly();
    const p = make(fake);
    await expect(
      p.create({ resources: { gpu: "A100" } }, fake.ctx)
    ).rejects.toMatchObject({ code: "Validation" });
    await expect(
      p.create({ network: { mode: "block-all" } }, fake.ctx)
    ).rejects.toMatchObject({ code: "Validation" });
  });

  it("paginates list via fly-next-cursor and honors filters", async () => {
    const fake = new FakeFly();
    fake.pageSize = 2;
    const client = createSandboxClient({
      provider: make(fake),
      telemetry: false,
    });
    for (let i = 0; i < 5; i++) {
      await client.create({ metadata: { i: String(i % 2) } });
    }
    const all = [];
    for await (const s of client.list()) {
      all.push(s.id);
    }
    expect(all).toHaveLength(5);
    expect(
      fake.requests.filter(
        (r) => r.path === "/v1/apps/app/machines" && r.query.get("cursor")
      ).length
    ).toBeGreaterThan(0);
    const odd = [];
    for await (const s of client.list({ metadata: { i: "1" } })) {
      odd.push(s.metadata.i);
    }
    expect(odd).toEqual(["1", "1"]);
    const limited = [];
    for await (const s of client.list({ limit: 3 })) {
      limited.push(s);
    }
    expect(limited).toHaveLength(3);
  });

  it("previews route to this machine with the fly-force-instance-id header", async () => {
    const fake = new FakeFly();
    const client = createSandboxClient({
      provider: make(fake),
      telemetry: false,
    });
    const sb = await client.create();
    const pv = await sb.ports!.expose(8080);
    expect(pv.url).toBe("https://app.fly.dev");
    expect(pv.auth).toEqual({
      headers: { "fly-force-instance-id": sb.id },
      type: "header",
    });
    const second = await sb.ports!.expose(9000);
    expect(second.url).toBe("https://app.fly.dev:9000");
    const res = await sb.ports!.fetch(8080, "/hi");
    expect(await res.text()).toBe(`hello from ${sb.id} /hi`);
    await sb.ports!.unexpose(9000);
    expect((await sb.ports!.list()).map((p) => p.port)).toEqual([8080]);
  });

  it("writes files through the exec stdin field, never argv", async () => {
    const fake = new FakeFly();
    const client = createSandboxClient({
      provider: make(fake),
      telemetry: false,
    });
    const sb = await client.create();
    const big = new Uint8Array(2 * 1024 * 1024).fill(7);
    await sb.files.write("/tmp/deep/big.bin", big);
    const writes = fake.requests.filter(
      (r) => r.path.endsWith("/exec") && (r.body as { stdin?: string }).stdin
    );
    expect(writes.length).toBe(3); // 768 KiB chunks
    for (const w of writes) {
      expect(
        JSON.stringify((w.body as { command: string[] }).command).length
      ).toBeLessThan(200);
    }
    expect(
      (await (await sb.files.read("/tmp/deep/big.bin")).bytes()).length
    ).toBe(big.length);
  });

  it("falls back to chunked reads when /exec output is too large", async () => {
    const fake = new FakeFly();
    const client = createSandboxClient({
      provider: make(fake),
      telemetry: false,
    });
    const sb = await client.create();
    const data = new Uint8Array(2_000_000);
    for (let i = 0; i < data.length; i++) {
      data[i] = i % 251;
    }
    await sb.files.write("/tmp/r.bin", data);
    fake.outputLimit = 1_000_000;
    const got = await (await sb.files.read("/tmp/r.bin")).bytes();
    expect(got.length).toBe(data.length);
    expect(got.every((b, i) => b === i % 251)).toBe(true);
  });

  it("lists and kills processes via /ps", async () => {
    const fake = new FakeFly();
    const client = createSandboxClient({
      provider: make(fake),
      telemetry: false,
    });
    const sb = await client.create();
    const h = sb.commands.run("sleep 30");
    await new Promise((r) => setTimeout(r, 50));
    const procs = await sb.commands.list();
    expect(procs).toHaveLength(1);
    await sb.commands.kill(procs[0]!.id);
    await expect(h).resolves.toMatchObject({ exitCode: 143 });
  });

  it("manages volumes", async () => {
    const fake = new FakeFly();
    const client = createSandboxClient({
      provider: make(fake),
      telemetry: false,
    });
    const v = await client.volumes!.create({ name: "My-Data", sizeMB: 3000 });
    expect(v).toMatchObject({ name: "my_data", region: "iad", sizeMB: 3072 });
    expect((await client.volumes!.get("my_data"))?.id).toBe(v.id);
    await client.volumes!.delete(v);
    expect(await client.volumes!.get(v.id)).toBeUndefined();
  });

  it("verifies with GET /apps/{app}", async () => {
    const fake = new FakeFly();
    const ok = await createSandboxClient({
      provider: make(fake),
      telemetry: false,
    }).verify();
    expect(ok).toEqual({ account: "personal", ok: true, provider: "fly" });
    const bad = await createSandboxClient({
      provider: fly({ apiToken: "nope", appName: "app", fetch: fake.fetch }),
      telemetry: false,
    }).verify();
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error.code).toBe("Unauthorized");
    expect(fake.machines.size).toBe(0);
  });

  it("maps every machine state", () => {
    expect(mapFlyState("started")).toBe("running");
    expect(mapFlyState("suspended")).toBe("paused");
    expect(mapFlyState("suspending")).toBe("suspending");
    expect(mapFlyState("stopping")).toBe("stopped");
    expect(mapFlyState("failed")).toBe("error");
    expect(mapFlyState("archived")).toBe("archived");
    expect(mapFlyState("destroying")).toBe("destroyed");
    expect(mapFlyState("replacing")).toBe("creating");
    expect(mapFlyState("bogus")).toBe("unknown");
  });

  it("maps HTTP errors", async () => {
    const statusOf = async (status: number, body = "") => {
      const p = fly({
        apiToken: "t",
        appName: "app",
        fetch: async () => new Response(body, { status }),
      });
      try {
        await p.connect("x", { attempt: 1, fetch: globalThis.fetch });
      } catch (error) {
        return mapFlyError(error);
      }
      return undefined;
    };
    expect((await statusOf(401))?.code).toBe("Unauthorized");
    expect((await statusOf(403))?.code).toBe("Unauthorized");
    expect((await statusOf(404))?.code).toBe("NotFound");
    expect((await statusOf(409))?.code).toBe("Conflict");
    expect(await statusOf(429)).toMatchObject({
      code: "QuotaExceeded",
      retryable: true,
    });
    expect(
      (await statusOf(400, '{"status":"insufficient_capacity"}'))?.code
    ).toBe("QuotaExceeded");
    expect((await statusOf(408))?.code).toBe("Timeout");
    expect(await statusOf(503)).toMatchObject({
      code: "Provider",
      retryable: true,
    });
    expect(mapFlyError(new DOMException("x", "AbortError"))?.code).toBe(
      "Timeout"
    );
  });
});
