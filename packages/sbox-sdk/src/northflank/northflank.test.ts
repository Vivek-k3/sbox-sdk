/**
 * Offline tests for the Northflank adapter against a fake `@northflank/js-client`.
 * The fake mirrors the SDK's method names and argument shapes (`{ parameters,
 * data, options }`, `exec.execServiceSession(params, data)`, the streaming file
 * copy API, container snapshots, metrics) and backs every service with an
 * in-memory sandbox so exec/files/PTY behave like a real shell.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type * as NF from "@northflank/js-client";
import { describe, expect, it, vi } from "vitest";

import type { CallContext, DriverHandle, DriverPty } from "../adapter/index.js";
import { runConformance } from "../conformance/index.js";
import { createSandboxClient } from "../index.js";
import { memory } from "../memory/index.js";
import type { MemoryRaw } from "../memory/index.js";
import {
  decodeTemplate,
  mapNorthflankError,
  mapNorthflankState,
  NORTHFLANK_CAPS,
  northflank,
  pickPlan,
} from "./index.js";
import type { NorthflankClient } from "./index.js";

type C = NorthflankClient;
type Arg<F> = F extends (a: infer A, ...rest: never[]) => unknown ? A : never;

class FakeApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    // oxlint-disable-next-line unicorn/custom-error-definition -- mirrors the SDK's error names
    this.name = "NorthflankApiCallError";
    this.status = status;
  }
}

/** Same lift as the Fly fake: MiniShell's `cd` doesn't persist across `&&`. */
function splitCwd(script: string): { cwd?: string; rest: string } {
  const outer = /^sh -c '((?:[^']|'\\'')*)'$/s.exec(script);
  if (!outer) {
    return { rest: script };
  }
  const inner = outer[1]!.replaceAll("'\\''", "'");
  const cd = /^cd '((?:[^']|'\\'')*)' && /.exec(inner);
  return cd
    ? { cwd: cd[1]!.replaceAll("'\\''", "'"), rest: inner.slice(cd[0].length) }
    : { rest: script };
}

interface Port {
  id: string;
  name: string;
  internalPort: number;
  protocol: "HTTP" | "HTTP/2" | "TCP" | "UDP";
  public: boolean;
  dns?: string;
  domains: { name: string }[];
  security?: {
    credentials?: { username: string; password: string; type: "basic-auth" }[];
  };
}

interface Svc {
  id: string;
  name: string;
  description?: string;
  image: string;
  env: Record<string, string>;
  instances: number;
  box: DriverHandle<MemoryRaw>;
  ports: Port[];
  createdAt: string;
  data: Arg<C["create"]["service"]["deployment"]>["data"];
}

/** Commands look like `sh -c '<wrapper recording $$ in pidfile>' sbox <cmd>`. */
// oxlint-disable-next-line unicorn/prefer-event-target -- the SDK's ExecCommand is an EventEmitter
class FakeSession extends EventEmitter implements NF.ExecCommand {
  readonly stdOut = new PassThrough();
  readonly stdErr = new PassThrough();
  readonly stdIn = new PassThrough();
  readonly #result: Promise<{
    exitCode: number;
    status: "Success" | "Failure";
  }>;
  pty?: DriverPty;
  constructor(result: Promise<number>) {
    super();
    this.#result = result.then((exitCode) => ({
      exitCode,
      status: exitCode === 0 ? "Success" : "Failure",
    }));
  }
  waitForCommandResult = () => this.#result;
  start = () => this.#result;
  sendInputToCurrentCommand = async (input: string) => {
    await this.pty?.write(new TextEncoder().encode(input));
  };
  resizeTerminal = async (size: { rows?: number; columns?: number }) => {
    await this.pty?.resize(size.columns ?? 80, size.rows ?? 24);
  };
}

class World {
  readonly mem = memory({ idPrefix: "nf" });
  readonly services = new Map<string, Svc>();
  readonly snapshots = new Map<
    string,
    { serviceId: string; createdAt: string; polled: number }
  >();
  readonly volumes: Arg<C["update"]["volume"]>[] = [];
  readonly calls: { name: string; arg: unknown }[] = [];
  readonly killers = new Map<string, () => Promise<void>>();
  pageSize = 100;
  readonly ctx: CallContext = { attempt: 1, fetch: globalThis.fetch };
  #n = 0;

  svc(p: { serviceId: string }): Svc {
    const s = this.services.get(p.serviceId);
    if (!s) {
      throw new FakeApiError(404, `service ${p.serviceId} not found`);
    }
    return s;
  }

  async newBox(env: Record<string, string>, fromSnapshot?: string) {
    return this.mem.create({ env, fromSnapshot }, this.ctx);
  }

  serviceResult(s: Svc) {
    return {
      createdAt: s.createdAt,
      deployment: { external: { imagePath: s.image }, instances: s.instances },
      description: s.description,
      id: s.id,
      name: s.name,
      serviceType: "deployment" as const,
      status: {
        deployment: {
          reason:
            s.instances === 0 ? ("SCALING" as const) : ("DEPLOYING" as const),
          status: "COMPLETED" as const,
        },
      },
    };
  }

  nextId(prefix: string) {
    return `${prefix}-${++this.#n}`;
  }
}

const world = { current: new World(), token: "t" };
const ok = <T>(
  data: T,
  pagination?: { hasNextPage: boolean; cursor?: string }
) => ({
  data,
  ...(pagination ? { pagination: { ...pagination, count: 0 } } : {}),
});

class FakeContextProvider {
  token = "";
  addContext(c: { name: string; token: string }) {
    this.token = c.token;
  }
}

class FakeApiClient {
  readonly #w = world.current;
  constructor(ctx: FakeContextProvider) {
    if (ctx.token !== world.token) {
      // The real client fails on the first call; emulate per request.
      this.#bad = true;
    }
  }
  #bad = false;
  #auth(name: string, arg: unknown) {
    this.#w.calls.push({ arg, name });
    if (this.#bad) {
      throw new FakeApiError(401, "Unauthorized");
    }
  }

  get = {
    containerSnapshot: async (o: Arg<C["get"]["containerSnapshot"]>) => {
      this.#auth("get.containerSnapshot", o);
      const s = this.#w.snapshots.get(o.parameters.snapshotId);
      if (!s) {
        throw new FakeApiError(404, "snapshot not found");
      }
      s.polled++;
      return ok({
        createdAt: s.createdAt,
        id: o.parameters.snapshotId,
        state: s.polled > 1 ? "succeeded" : "running",
      });
    },
    project: async (o: Arg<C["get"]["project"]>) => {
      this.#auth("get.project", o);
      return ok({ id: o.parameters.projectId, name: "Sandbox Project" });
    },
    service: Object.assign(
      async (o: Arg<C["get"]["service"]>) => {
        this.#auth("get.service", o);
        return ok(this.#w.serviceResult(this.#w.svc(o.parameters)));
      },
      {
        ports: async (o: Arg<C["get"]["service"]["ports"]>) => {
          this.#auth("get.service.ports", o);
          return ok({ ports: this.#w.svc(o.parameters).ports });
        },
      }
    ),
  };

  list = {
    containerSnapshots: async (o: Arg<C["list"]["containerSnapshots"]>) => {
      this.#auth("list.containerSnapshots", o);
      return ok({
        containerSnapshots: [...this.#w.snapshots.entries()]
          .filter(([, s]) => s.serviceId === o.options?.serviceId)
          .map(([id, s]) => ({
            createdAt: s.createdAt,
            id,
            state: "succeeded",
          })),
      });
    },
    services: async (o: Arg<C["list"]["services"]>) => {
      this.#auth("list.services", o);
      const all = [...this.#w.services.values()];
      const start = Number(o.options?.cursor ?? 0);
      const size = Math.min(o.options?.per_page ?? 50, this.#w.pageSize);
      const page = all
        .slice(start, start + size)
        .map((s) => this.#w.serviceResult(s));
      const more = start + size < all.length;
      return ok(
        { services: page },
        { cursor: more ? String(start + size) : undefined, hasNextPage: more }
      );
    },
  };

  create = {
    containerSnapshot: async (o: Arg<C["create"]["containerSnapshot"]>) => {
      this.#auth("create.containerSnapshot", o);
      const s = this.#w.svc(o.parameters);
      const ref = await Promise.resolve(s.box.snapshot!({}, this.#w.ctx));
      this.#w.snapshots.set(ref.id, {
        createdAt: new Date().toISOString(),
        polled: 0,
        serviceId: s.id,
      });
      return ok({ id: ref.id, state: "scheduled" });
    },
    service: {
      deployment: async (o: Arg<C["create"]["service"]["deployment"]>) => {
        this.#auth("create.service.deployment", o);
        const { data } = o;
        if (this.#w.services.has(data.name)) {
          throw new FakeApiError(409, `service ${data.name} already exists`);
        }
        if (!data.billing.deploymentPlan || !("external" in data.deployment)) {
          throw new FakeApiError(400, "invalid deployment");
        }
        const env = (data.runtimeEnvironment ?? {}) as Record<string, string>;
        const restore = data.deployment.containerSnapshot?.restoreFrom;
        const svc: Svc = {
          box: await this.#w.newBox(env, restore),
          createdAt: new Date().toISOString(),
          data,
          description: data.description,
          env,
          id: data.name,
          image: data.deployment.external.imagePath,
          instances: data.deployment.instances,
          name: data.name,
          ports: (data.ports ?? []).map((p) => ({
            ...p,
            dns: `${p.name}--${data.name}.code.run`,
            domains: [],
            id: this.#w.nextId("port"),
            public: p.public ?? false,
          })),
        };
        this.#w.services.set(svc.id, svc);
        return ok({ id: svc.id });
      },
    },
  };

  update = {
    service: {
      ports: async (o: Arg<C["update"]["service"]["ports"]>) => {
        this.#auth("update.service.ports", o);
        const s = this.#w.svc(o.parameters);
        // Replaces the whole list, like the real endpoint.
        s.ports = o.data.ports.map((p) => ({
          ...p,
          dns: `${p.name}--${s.id}.code.run`,
          domains: (p.domains ?? []).map((name) => ({ name })),
          id: p.id ?? this.#w.nextId("port"),
          public: p.public ?? false,
          security: p.security as Port["security"],
        }));
        return ok({});
      },
    },
    volume: async (o: Arg<C["update"]["volume"]>) => {
      this.#auth("update.volume", o);
      this.#w.volumes.push(o);
      return ok({});
    },
  };

  patch = {
    service: {
      deployment: async (o: Arg<C["patch"]["service"]["deployment"]>) => {
        this.#auth("patch.service.deployment", o);
        const s = this.#w.svc(o.parameters);
        const from = o.data.deployment?.containerSnapshot?.restoreFrom;
        if (from) {
          await Promise.resolve(s.box.restoreSnapshot!(from, this.#w.ctx));
        }
        return ok({});
      },
    },
  };

  pause = {
    service: async (o: Arg<C["pause"]["service"]>) => {
      this.#auth("pause.service", o);
      const s = this.#w.svc(o.parameters);
      s.instances = 0;
      await s.box.destroy(this.#w.ctx); // scale-to-zero drops the container
      return ok({});
    },
  };

  resume = {
    service: async (o: Arg<C["resume"]["service"]>) => {
      this.#auth("resume.service", o);
      if (!o.data) {
        throw new FakeApiError(400, "data required");
      }
      const s = this.#w.svc(o.parameters);
      s.instances = o.data.instances ?? 1;
      s.box = await this.#w.newBox(s.env);
      return ok({});
    },
  };

  delete = {
    containerSnapshot: async (o: Arg<C["delete"]["containerSnapshot"]>) => {
      this.#auth("delete.containerSnapshot", o);
      this.#w.snapshots.delete(o.parameters.snapshotId);
      return ok({});
    },
    service: async (o: Arg<C["delete"]["service"]>) => {
      this.#auth("delete.service", o);
      const s = this.#w.svc(o.parameters);
      await s.box.destroy(this.#w.ctx);
      this.#w.services.delete(s.id);
      return ok({});
    },
  };

  metrics = {
    getServiceMetrics: async (o: Arg<C["metrics"]["getServiceMetrics"]>) => {
      this.#auth("metrics.getServiceMetrics", o);
      this.#w.svc(o.parameters);
      const entry = (metricId: string, metricUnit: string, value: number) => ({
        metricInfo: { metricId, metricUnit },
        values: [
          {
            data: [{ ts: new Date(), value }],
            metadata: { containerId: "c1" },
          },
        ],
      });
      return ok({
        cpu: entry("cpu", "vCPU", 0.25),
        memory: entry("memory", "mb", 128),
      });
    },
  };

  exec = {
    execServiceCommand: async (
      p: Arg<C["exec"]["execServiceCommand"]>,
      d: { command: string | string[] }
    ) => {
      this.#auth("exec.execServiceCommand", d);
      const s = this.#w.svc(p);
      const script = Array.isArray(d.command) ? d.command[2]! : d.command;
      const pidFile = /p=\$\(cat '([^']+)'/.exec(script)?.[1];
      if (pidFile) {
        // The adapter's /proc tree-kill helper (MiniShell has no functions).
        await this.#w.killers.get(pidFile)?.();
        return {
          commandResult: { exitCode: 0, status: "Success" as const },
          stdErr: "",
          stdOut: "",
        };
      }
      let out = "";
      let err = "";
      let code = 0;
      for await (const ev of s.box.exec(script, {}, this.#w.ctx)) {
        if (ev.type === "stdout") out += ev.data;
        else if (ev.type === "stderr") err += ev.data;
        else code = ev.exitCode;
      }
      return {
        commandResult: {
          exitCode: code,
          status: code === 0 ? ("Success" as const) : ("Failure" as const),
        },
        stdErr: err,
        stdOut: out,
      };
    },
    execServiceSession: async (
      p: Arg<C["exec"]["execServiceSession"]>,
      d: {
        command?: string | string[];
        tty?: boolean;
        ttyColumns?: number;
        ttyRows?: number;
        shell?: string;
      }
    ): Promise<NF.ExecCommand> => {
      this.#auth("exec.execServiceSession", d);
      const s = this.#w.svc(p);
      const argv = d.command as string[];
      if (argv[0] !== "sh" || argv[1] !== "-c" || argv[3] !== "sbox") {
        throw new Error(`unexpected command ${JSON.stringify(argv)}`);
      }
      const pidFile = /^echo \$\$ > '([^']+)';/.exec(argv[2]!)![1]!;
      if (d.tty) {
        const pty = await Promise.resolve(
          s.box.createPty!({ cols: d.ttyColumns, rows: d.ttyRows }, this.#w.ctx)
        );
        const sess = new FakeSession(pty.wait());
        sess.pty = pty;
        void (async () => {
          for await (const chunk of pty.output)
            sess.stdOut.write(Buffer.from(chunk));
        })();
        this.#w.killers.set(pidFile, () => pty.kill());
        return sess;
      }
      const { cwd, rest } = splitCwd(argv[4]!);
      const ex = s.box.exec(rest, { cwd }, this.#w.ctx);
      this.#w.killers.set(pidFile, () => ex.kill("SIGKILL"));
      // The pump references the session it feeds, so hold it in a ref.
      const ref: { sess?: FakeSession } = {};
      const sess = new FakeSession(
        (async () => {
          let code = 0;
          for await (const ev of ex) {
            if (ev.type === "stdout") ref.sess!.stdOut.write(ev.data);
            else if (ev.type === "stderr") ref.sess!.stdErr.write(ev.data);
            else code = ev.exitCode;
          }
          this.#w.killers.delete(pidFile);
          return code;
        })()
      );
      ref.sess = sess;
      sess.stdIn.on(
        "data",
        (c: Buffer) => void ex.writeStdin?.(new Uint8Array(c))
      );
      return sess;
    },
  };

  upload = {
    serviceStream: {
      files: async (
        p: Arg<C["upload"]["serviceStream"]["files"]>,
        o: {
          source: string | Buffer | NodeJS.ReadableStream;
          remotePath: string;
        }
      ) => {
        this.#auth("upload.serviceStream.files", o);
        if (!Buffer.isBuffer(o.source)) {
          throw new TypeError("fake expects a Buffer source");
        }
        await Promise.resolve(
          this.#w
            .svc(p)
            .box.writeFile(o.remotePath, new Uint8Array(o.source), this.#w.ctx)
        );
      },
    },
  };

  download = {
    serviceStream: {
      files: async (
        p: Arg<C["download"]["serviceStream"]["files"]>,
        o: { remotePath: string }
      ) => {
        this.#auth("download.serviceStream.files", o);
        let data: Uint8Array;
        try {
          data = await Promise.resolve(
            this.#w.svc(p).box.readFile(o.remotePath, this.#w.ctx)
          );
        } catch {
          throw new Error(`Remote path '${o.remotePath}' must be a file.`);
        }
        const fileStream = new PassThrough();
        fileStream.end(Buffer.from(data));
        return { completionPromise: Promise.resolve(true), fileStream };
      },
    },
  };
}

vi.mock("@northflank/js-client", () => ({
  ApiClient: FakeApiClient,
  ApiClientInMemoryContextProvider: FakeContextProvider,
  MetricType: { Cpu: "cpu", Memory: "memory" },
  NorthflankApiCallError: FakeApiError,
}));

const make = (extra: Partial<Parameters<typeof northflank>[0]> = {}) =>
  northflank({ pollIntervalMs: 1, projectId: "proj", token: "t", ...extra });

const fresh = () => {
  world.current = new World();
  return world.current;
};

describe("northflank adapter (offline)", () => {
  it("declares truthful capabilities", () => {
    const p = make();
    expect(p.name).toBe("northflank");
    expect(p.capabilities).toBe(NORTHFLANK_CAPS);
    expect(p.flags.perCommandEnvCwd).toBe(false);
    expect(p.flags.preservesMemoryOnPause).toBe(false);
    expect(p.flags.templateSources).toEqual(["image"]);
  });

  it("passes the offline conformance suite through the fake SDK", async () => {
    fresh();
    const report = await runConformance(make(), {
      live: true,
      // Northflank pause = scale to zero: the ephemeral disk is dropped.
      skip: ["lifecycle: pause/resume keeps files"],
      template: { source: { image: "node:22-bookworm" } },
    });
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed).toEqual([]);
    expect(report.checks.length).toBe(36);
  }, 60_000);

  it("maps a rich spec onto create.service.deployment", async () => {
    const w = fresh();
    const client = createSandboxClient({ provider: make(), telemetry: false });
    await client.create({
      env: { A: "1" },
      lifecycle: { maxAgeMs: 3_600_000 },
      metadata: { team: "x" },
      name: "My Box",
      ports: [3000],
      resources: {
        diskMB: 4096,
        gpu: "nvidia-l4",
        gpuCount: 1,
        memoryMB: 6000,
        shmMB: 1024,
        vcpus: 2,
      },
      secrets: [{ envVar: "TOKEN", name: "tok", value: "s3cret" }],
      template: "python:3.12",
      volumes: [{ id: "vol-1", mountPath: "/data" }],
    });
    const svc = w.services.get("my-box")!;
    const d = svc.data;
    expect(d.name).toBe("my-box");
    expect(d.description).toBe('sbox:{"team":"x"}');
    expect(d.billing).toEqual({
      deploymentPlan: "nf-compute-200-8",
      gpu: {
        configuration: { gpuCount: 1, gpuType: "nvidia-l4" },
        enabled: true,
      },
    });
    expect(d.createOptions).toEqual({
      expiryTime: 3600,
      volumesToAttach: ["vol-1"],
    });
    expect(d.runtimeEnvironment).toEqual({ A: "1", TOKEN: "s3cret" });
    expect(d.ports).toEqual([
      { internalPort: 3000, name: "p3000", protocol: "HTTP", public: true },
    ]);
    expect(d.deployment).toMatchObject({
      docker: { configType: "customCommand", customCommand: "sleep infinity" },
      external: { imagePath: "python:3.12" },
      instances: 1,
      storage: { ephemeralStorage: { storageSize: 4096 }, shmSize: 1024 },
    });
    expect(w.volumes[0]?.data).toEqual({
      mounts: [{ containerMountPath: "/data" }],
    });
  });

  it("reuses the service on a retried create (deterministic name from the key)", async () => {
    const w = fresh();
    const p = make();
    const ctx = { attempt: 1, fetch: globalThis.fetch, idempotencyKey: "k1" };
    const a = await p.create({}, ctx);
    const b = await p.create({}, { ...ctx, attempt: 2 });
    expect(a.id).toBe(b.id);
    expect(w.services.size).toBe(1);
  });

  it("merges ports instead of replacing them, and private previews carry basic auth", async () => {
    const w = fresh();
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const sb = await client.create({ ports: [3000] });
    const pub = await sb.ports!.expose(8080);
    expect(pub).toMatchObject({
      auth: { type: "public" },
      url: `https://p8080--${sb.id}.code.run`,
    });
    const priv = await sb.ports!.expose(9000, { visibility: "private" });
    expect(priv.auth?.type).toBe("header");
    const ports = w.services.get(sb.id)!.ports.map((p) => p.internalPort);
    expect(ports.toSorted()).toEqual([3000, 8080, 9000]);
    await sb.ports!.unexpose(8080);
    expect((await sb.ports!.list()).map((p) => p.port).toSorted()).toEqual([
      3000, 9000,
    ]);
  });

  it("streams exec output and kills via the recorded pid", async () => {
    fresh();
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const sb = await client.create();
    const seen: string[] = [];
    for await (const ev of sb.commands.run("echo a; echo b >&2; exit 5")) {
      seen.push(
        ev.type === "exit"
          ? `exit:${ev.exitCode}`
          : `${ev.type}:${ev.data.trim()}`
      );
    }
    expect(seen).toEqual(["stdout:a", "stderr:b", "exit:5"]);
  });

  it("paginates list and resolves paused state", async () => {
    const w = fresh();
    w.pageSize = 2;
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await client.create({ metadata: { i: String(i % 2) } })).id);
    }
    const paused = await client.connect(ids[0]!);
    await paused.pause();
    const states: Record<string, string> = {};
    for await (const s of client.list()) {
      states[s.id] = s.state;
    }
    expect(Object.keys(states)).toHaveLength(5);
    expect(states[ids[0]!]).toBe("paused");
    const odd = [];
    for await (const s of client.list({ metadata: { i: "1" } })) {
      odd.push(s.id);
    }
    expect(odd).toHaveLength(2);
    expect(
      w.calls.filter((c) => c.name === "list.services").length
    ).toBeGreaterThanOrEqual(3);
  });

  it("forks and restores via container snapshots", async () => {
    fresh();
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const sb = await client.create();
    await sb.files.write("/tmp/x.txt", "one");
    const snap = await sb.snapshots!.create({ name: "s1" });
    expect(snap.includesMemory).toBe(false);
    await sb.files.write("/tmp/x.txt", "two");
    await sb.snapshots!.restore(snap);
    expect(await (await sb.files.read("/tmp/x.txt")).text()).toBe("one");
    expect((await sb.snapshots!.list()).map((s) => s.id)).toContain(snap.id);
    const fromSnap = await client.create({ fromSnapshot: snap.id });
    expect(await (await fromSnap.files.read("/tmp/x.txt")).text()).toBe("one");
  });

  it("reports metrics", async () => {
    fresh();
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const m = await (await client.create()).metrics();
    expect(m).toMatchObject({ cpuPercent: 25, memoryUsedMB: 128 });
  });

  it("verifies with get.project and never creates", async () => {
    const w = fresh();
    expect(
      await createSandboxClient({ provider: make(), telemetry: false }).verify()
    ).toEqual({
      account: "Sandbox Project",
      ok: true,
      provider: "northflank",
    });
    const bad = await createSandboxClient({
      provider: make({ token: "nope" }),
      telemetry: false,
    }).verify();
    expect(!bad.ok && bad.error.code).toBe("Unauthorized");
    expect(w.services.size).toBe(0);
  });

  it("encodes image templates with their env/startCmd", async () => {
    const w = fresh();
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const ref = await client.templates!.build({
      env: { X: "y" },
      source: { image: "node:22" },
      startCmd: "node server.js",
    });
    expect(decodeTemplate(ref.id)).toEqual({
      extras: { env: { X: "y" }, startCmd: "node server.js" },
      image: "node:22",
    });
    const sb = await client.create({ template: ref });
    const d = w.services.get(sb.id)!.data;
    expect(d.runtimeEnvironment).toEqual({ X: "y" });
    expect(d.deployment).toMatchObject({
      docker: { customCommand: "node server.js" },
      external: { imagePath: "node:22" },
    });
    await expect(
      client.templates!.build({ source: { dockerfile: "FROM x" } })
    ).rejects.toMatchObject({ code: "NotSupported" });
  });

  it("maps states, plans and errors", () => {
    expect(
      mapNorthflankState({ reason: "DEPLOYING", status: "COMPLETED" }, 1)
    ).toBe("running");
    expect(
      mapNorthflankState({ reason: "DEPLOYING", status: "IN_PROGRESS" })
    ).toBe("creating");
    expect(mapNorthflankState({ reason: "DEPLOYING", status: "PENDING" })).toBe(
      "creating"
    );
    expect(mapNorthflankState({ reason: "DEPLOYING", status: "FAILED" })).toBe(
      "error"
    );
    expect(
      mapNorthflankState({ reason: "SCALING", status: "COMPLETED" }, 0)
    ).toBe("paused");
    expect(
      mapNorthflankState({ reason: "SCALING", status: "IN_PROGRESS" }, 0)
    ).toBe("suspending");
    expect(pickPlan()).toBe("nf-compute-200");
    expect(pickPlan(0.5)).toBe("nf-compute-50");
    expect(pickPlan(1, 3000)).toBe("nf-compute-100-4");
    expect(mapNorthflankError(new FakeApiError(401, "x"))?.code).toBe(
      "Unauthorized"
    );
    expect(mapNorthflankError(new FakeApiError(404, "x"))?.code).toBe(
      "NotFound"
    );
    expect(mapNorthflankError(new FakeApiError(409, "x"))?.code).toBe(
      "Conflict"
    );
    expect(mapNorthflankError(new FakeApiError(429, "x"))).toMatchObject({
      code: "QuotaExceeded",
      retryable: true,
    });
    expect(
      mapNorthflankError(new Error("Remote path '/x' must be a file."))?.code
    ).toBe("NotFound");
    expect(mapNorthflankError(new FakeApiError(503, "x"))).toMatchObject({
      code: "Provider",
      retryable: true,
    });
  });
});
