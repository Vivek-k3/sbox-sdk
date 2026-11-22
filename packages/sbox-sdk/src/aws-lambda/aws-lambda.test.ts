/**
 * Offline tests for the AWS Lambda MicroVMs adapter.
 * - The control plane is a fake `@aws-sdk/client-lambda-microvms` (command
 *   classes + `client.send`, inputs typed with the SDK's own input types).
 * - The data plane is a fake fetch speaking the runner protocol (NDJSON exec,
 *   kill, raw files) over in-memory sandboxes, and it enforces per-port tokens.
 * - The real `runner/server.mjs` is also exercised on localhost.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import type * as AWS from "@aws-sdk/client-lambda-microvms";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  CallContext,
  DriverExec,
  DriverHandle,
} from "../adapter/index.js";
import { runConformance } from "../conformance/index.js";
import { createSandboxClient } from "../index.js";
import { memory } from "../memory/index.js";
import type { MemoryRaw } from "../memory/index.js";
import {
  AWS_LAMBDA_CAPS,
  awsLambda,
  idlePolicyFor,
  mapAwsLambdaError,
  mapMicrovmState,
  zipStore,
} from "./index.js";

// ---------------------------------------------------------------------------
// fake control plane
// ---------------------------------------------------------------------------

class AwsError extends Error {
  readonly $metadata: { httpStatusCode: number };
  constructor(name: string, status: number, message = name) {
    super(message);
    // oxlint-disable-next-line unicorn/custom-error-definition -- mirrors the SDK's error names
    this.name = name;
    this.$metadata = { httpStatusCode: status };
  }
}

interface Vm {
  id: string;
  endpoint: string;
  state: AWS.MicrovmState;
  input: AWS.RunMicrovmCommandInput;
  box: DriverHandle<MemoryRaw>;
  live: Map<string, DriverExec>;
  hookEnv: Record<string, string>;
  hookMeta: Record<string, string>;
}

interface Image {
  imageArn: string;
  name: string;
  state: AWS.MicrovmImageState;
  versions: { version: string; polls: number; input: unknown }[];
  tags: Record<string, string>;
}

class Cloud {
  readonly mem = memory({ idPrefix: "mvm" });
  readonly vms = new Map<string, Vm>();
  readonly images = new Map<string, Image>();
  readonly s3 = new Map<string, Uint8Array>();
  readonly tokens = new Map<string, { vm: string; ports: number[] }>();
  readonly sent: { name: string; input: unknown }[] = [];
  pageSize = 100;
  readonly ctx: CallContext = { attempt: 1, fetch: globalThis.fetch };
  #n = 0;

  async send(name: string, input: any): Promise<any> {
    this.sent.push({ input, name });
    if (!this.authorized) {
      throw new AwsError("UnrecognizedClientException", 403, "bad credentials");
    }
    const vm = (id: string) => {
      const v = this.vms.get(id);
      if (!v || v.state === "TERMINATED") {
        throw new AwsError("ResourceNotFoundException", 404);
      }
      return v;
    };
    switch (name) {
      case "RunMicrovmCommand": {
        const i = input as AWS.RunMicrovmCommandInput;
        const existing = [...this.vms.values()].find(
          (v) => i.clientToken && v.input.clientToken === i.clientToken
        );
        if (existing) {
          return this.vmOut(existing);
        }
        if (!i.imageIdentifier?.startsWith("arn:aws:lambda:")) {
          throw new AwsError("ValidationException", 400);
        }
        const id = `mvm-${++this.#n}`;
        const payload = JSON.parse(i.runHookPayload ?? "{}");
        const v: Vm = {
          box: await this.mem.create({ env: payload.env }, this.ctx),
          endpoint: `${id}.microvm.lambda.us-east-1.on.aws`,
          hookEnv: payload.env ?? {},
          hookMeta: payload.metadata ?? {},
          id,
          input: i,
          live: new Map(),
          state: "RUNNING",
        };
        this.vms.set(id, v);
        return this.vmOut(v);
      }
      case "GetMicrovmCommand": {
        return this.vmOut(vm(input.microvmIdentifier));
      }
      case "SuspendMicrovmCommand": {
        vm(input.microvmIdentifier).state = "SUSPENDED";
        return {};
      }
      case "ResumeMicrovmCommand": {
        vm(input.microvmIdentifier).state = "RUNNING";
        return {};
      }
      case "TerminateMicrovmCommand": {
        const v = vm(input.microvmIdentifier);
        v.state = "TERMINATED";
        await v.box.destroy(this.ctx);
        return {};
      }
      case "ListMicrovmsCommand": {
        const all = [...this.vms.values()];
        const start = Number(input.nextToken ?? 0);
        const size = Math.min(input.maxResults ?? 100, this.pageSize);
        const page = all.slice(start, start + size);
        return {
          items: page.map((v) => ({
            microvmId: v.id,
            startedAt: new Date(),
            state: v.state,
          })),
          nextToken:
            start + size < all.length ? String(start + size) : undefined,
        };
      }
      case "CreateMicrovmAuthTokenCommand": {
        const i = input as AWS.CreateMicrovmAuthTokenCommandInput;
        if ((i.expirationInMinutes ?? 0) > 60) {
          throw new AwsError("ValidationException", 400);
        }
        vm(i.microvmIdentifier!);
        const token = `jwe-${++this.#n}`;
        this.tokens.set(token, {
          ports: (i.allowedPorts ?? []).map((p) => p.port!),
          vm: i.microvmIdentifier!,
        });
        return { authToken: { "X-aws-proxy-auth": token } };
      }
      case "CreateMicrovmImageCommand": {
        const i = input as AWS.CreateMicrovmImageCommandInput;
        if ([...this.images.values()].some((x) => x.name === i.name)) {
          throw new AwsError("ConflictException", 409);
        }
        const img: Image = {
          imageArn: `arn:aws:lambda:us-east-1:123:microvm-image:${i.name}`,
          name: i.name!,
          state: "CREATING",
          tags: i.tags ?? {},
          versions: [{ input: i, polls: 0, version: "1" }],
        };
        this.images.set(img.imageArn, img);
        return {
          imageArn: img.imageArn,
          imageVersion: "1",
          name: img.name,
          state: img.state,
        };
      }
      case "GetMicrovmImageVersionCommand": {
        const img = this.images.get(input.imageIdentifier)!;
        const v = img.versions.find((x) => x.version === input.imageVersion)!;
        v.polls++;
        const state = v.polls > 2 ? "SUCCESSFUL" : "IN_PROGRESS";
        if (state === "SUCCESSFUL") {
          img.state = "CREATED";
        }
        return { imageArn: img.imageArn, imageVersion: v.version, state };
      }
      case "ListMicrovmImageBuildsCommand": {
        const img = this.images.get(input.imageIdentifier)!;
        const v = img.versions.find((x) => x.version === input.imageVersion)!;
        return {
          items: [
            {
              architecture: "ARM_64",
              buildId: "b1",
              buildState: v.polls > 2 ? "SUCCESSFUL" : "IN_PROGRESS",
              chipset: "GRAVITON",
            },
          ],
        };
      }
      case "ListMicrovmImagesCommand": {
        return {
          items: [...this.images.values()].map((x) => ({
            imageArn: x.imageArn,
            latestActiveImageVersion: x.state === "CREATED" ? "1" : undefined,
            name: x.name,
            state: x.state,
          })),
        };
      }
      case "GetMicrovmImageCommand": {
        const img =
          this.images.get(input.imageIdentifier) ??
          [...this.images.values()].find(
            (x) => x.name === input.imageIdentifier
          );
        if (!img) {
          throw new AwsError("ResourceNotFoundException", 404);
        }
        return {
          imageArn: img.imageArn,
          name: img.name,
          state: img.state,
          tags: img.tags,
        };
      }
      case "DeleteMicrovmImageCommand": {
        this.images.delete(input.imageIdentifier);
        return {};
      }
      default: {
        throw new Error(`fake: unexpected ${name}`);
      }
    }
  }

  authorized = true;

  vmOut(v: Vm) {
    return {
      endpoint: v.endpoint,
      idlePolicy: v.input.idlePolicy,
      imageArn: v.input.imageIdentifier,
      microvmId: v.id,
      startedAt: new Date(),
      state: v.state,
    };
  }

  // ---- data plane: the runner protocol ----------------------------------

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    );
    const headers = new Headers(init?.headers);
    const tok = this.tokens.get(headers.get("x-aws-proxy-auth") ?? "");
    const port = Number(headers.get("x-aws-proxy-port") ?? 8080);
    const v = [...this.vms.values()].find((x) => x.endpoint === url.hostname);
    if (!v || !tok || tok.vm !== v.id || !tok.ports.includes(port)) {
      return new Response("forbidden", { status: 403 });
    }
    if (v.state !== "RUNNING") {
      return new Response("bad gateway", { status: 502 });
    }
    if (port !== 8080) {
      return new Response(`app on ${port} ${url.pathname}`);
    }
    const path = url.pathname;
    const method = init?.method ?? "GET";
    if (method === "POST" && path === "/sbox/exec") {
      return this.exec(v, JSON.parse(String(init!.body)));
    }
    if (method === "POST" && path === "/sbox/kill") {
      const { id } = JSON.parse(String(init!.body));
      const ex = v.live.get(id);
      if (!ex)
        return Response.json({ error: "no such process" }, { status: 404 });
      await ex.kill("SIGKILL");
      return Response.json({ ok: true });
    }
    if (method === "GET" && path === "/sbox/ps") {
      return Response.json(
        [...v.live.keys()].map((id) => ({ cmd: "sh", id, pid: 1 }))
      );
    }
    if (method === "GET" && path === "/sbox/info") {
      return Response.json({ metadata: v.hookMeta, microvmId: v.id });
    }
    if (path === "/sbox/files") {
      const file = url.searchParams.get("path")!;
      if (method === "PUT") {
        const body = new Uint8Array(
          await new Response(init!.body).arrayBuffer()
        );
        await Promise.resolve(v.box.writeFile(file, body, this.ctx));
        return Response.json({ ok: true });
      }
      try {
        const data = await Promise.resolve(v.box.readFile(file, this.ctx));
        return new Response(new Uint8Array(data), {
          headers: { "content-type": "application/octet-stream" },
        });
      } catch {
        return Response.json({ error: "ENOENT" }, { status: 404 });
      }
    }
    return Response.json({ error: "unknown route" }, { status: 404 });
  };

  exec(
    v: Vm,
    body: {
      id: string;
      cmd: string;
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      stream?: boolean;
    }
  ): Response {
    const ex = v.box.exec(
      body.cmd,
      { cwd: body.cwd, env: { ...v.hookEnv, ...body.env } },
      this.ctx
    );
    v.live.set(body.id, ex);
    let timedOut = false;
    const timer = body.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          void ex.kill("SIGKILL");
        }, body.timeoutMs)
      : undefined;
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        for await (const ev of ex) {
          if (ev.type === "exit") {
            c.enqueue(
              enc.encode(
                `${JSON.stringify({ exitCode: ev.exitCode, timedOut, type: "exit" })}\n`
              )
            );
          } else {
            c.enqueue(enc.encode(`${JSON.stringify(ev)}\n`));
          }
        }
        clearTimeout(timer);
        v.live.delete(body.id);
        c.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/x-ndjson" },
    });
  }
}

const cloud = { current: new Cloud() };

const commandNames = [
  "RunMicrovmCommand",
  "GetMicrovmCommand",
  "SuspendMicrovmCommand",
  "ResumeMicrovmCommand",
  "TerminateMicrovmCommand",
  "ListMicrovmsCommand",
  "CreateMicrovmAuthTokenCommand",
  "CreateMicrovmImageCommand",
  "UpdateMicrovmImageCommand",
  "TagResourceCommand",
  "GetMicrovmImageCommand",
  "GetMicrovmImageVersionCommand",
  "ListMicrovmImagesCommand",
  "ListMicrovmImageBuildsCommand",
  "GetMicrovmImageBuildCommand",
  "DeleteMicrovmImageCommand",
] as const;

vi.mock("@aws-sdk/client-lambda-microvms", () => {
  const mod: Record<string, unknown> = {
    LambdaMicrovmsClient: class {
      readonly config = { region: async () => "us-east-1" };
      send(cmd: { _name: string; input: unknown }) {
        return cloud.current.send(cmd._name, cmd.input);
      }
    },
  };
  for (const name of commandNames) {
    mod[name] = class {
      readonly _name = name;
      readonly input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
    };
  }
  return mod;
});

vi.mock("@aws-sdk/client-s3", () => ({
  PutObjectCommand: class {
    readonly input: { Bucket: string; Key: string; Body: Uint8Array };
    constructor(input: { Bucket: string; Key: string; Body: Uint8Array }) {
      this.input = input;
    }
  },
  S3Client: class {
    async send(cmd: {
      input: { Bucket: string; Key: string; Body: Uint8Array };
    }) {
      cloud.current.s3.set(
        `${cmd.input.Bucket}/${cmd.input.Key}`,
        cmd.input.Body
      );
      return {};
    }
  },
}));

const IMAGE = "arn:aws:lambda:us-east-1:123:microvm-image:sbox-runner";
const make = (extra: Partial<Parameters<typeof awsLambda>[0]> = {}) =>
  awsLambda({
    buildRoleArn: "arn:aws:iam::123:role/Build",
    fetch: cloud.current.fetch,
    imageIdentifier: IMAGE,
    pollIntervalMs: 1,
    region: "us-east-1",
    s3Bucket: "bucket",
    ...extra,
  });
const fresh = () => (cloud.current = new Cloud());

describe("aws-lambda (MicroVMs) adapter (offline)", () => {
  it("declares truthful capabilities", () => {
    const p = make();
    expect(p.capabilities).toBe(AWS_LAMBDA_CAPS);
    expect(p.capabilities.stop).toBe("unsupported");
    expect(p.capabilities.setTimeout).toBe("unsupported");
    expect(p.flags.preservesMemoryOnPause).toBe(true);
    expect(p.flags.templateSources).toEqual(["dockerfile"]);
  });

  it("passes the offline conformance suite", async () => {
    fresh();
    const report = await runConformance(make(), {
      live: true,
      template: {
        source: {
          context: { "server.mjs": "// runner" },
          dockerfile:
            "FROM public.ecr.aws/lambda/microvms:al2023-minimal\nCOPY server.mjs /opt/sbox/\n",
        },
      },
    });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.checks.length).toBe(34);
  }, 60_000);

  it("enforces the 60-minute token limit", () => {
    expect(() => make({ tokenTtlMinutes: 61 })).toThrow(/1 to 60/);
    expect(() => make({ tokenTtlMinutes: 0 })).toThrow(/1 to 60/);
  });

  it("requires an image ARN at create time", async () => {
    fresh();
    const p = awsLambda({ region: "us-east-1" });
    await expect(
      p.create({}, { attempt: 1, fetch: globalThis.fetch })
    ).rejects.toMatchObject({
      code: "Validation",
    });
  });

  it("maps a rich spec onto RunMicrovm and applies env through the run hook", async () => {
    const c = fresh();
    const client = createSandboxClient({
      provider: make({
        executionRoleArn: "arn:role",
        logging: { disabled: {} },
      }),
      telemetry: false,
    });
    const sb = await client.create({
      env: { MODE: "dev" },
      idempotencyKey: "idem-1",
      lifecycle: {
        autoResume: false,
        idleTimeoutMs: 600_000,
        maxAgeMs: 3_600_000,
        onIdle: "pause",
      },
      metadata: { team: "x" },
      secrets: [{ envVar: "TOKEN", name: "tok", value: "s3cret" }],
    });
    const run = c.sent.find((s) => s.name === "RunMicrovmCommand")!
      .input as AWS.RunMicrovmCommandInput;
    expect(run).toMatchObject({
      clientToken: "idem-1",
      executionRoleArn: "arn:role",
      idlePolicy: {
        autoResumeEnabled: false,
        maxIdleDurationSeconds: 600,
        suspendedDurationSeconds: 3600,
      },
      imageIdentifier: IMAGE,
      logging: { disabled: {} },
      maximumDurationInSeconds: 3600,
    });
    expect(JSON.parse(run.runHookPayload!)).toEqual({
      env: { MODE: "dev", TOKEN: "s3cret" },
      metadata: { team: "x" },
    });
    expect((await sb.commands.run("echo $MODE")).stdout).toBe("dev\n");
    const tokenReq = c.sent.find(
      (s) => s.name === "CreateMicrovmAuthTokenCommand"
    )!.input as AWS.CreateMicrovmAuthTokenCommandInput;
    expect(tokenReq.allowedPorts).toEqual([{ port: 8080 }]); // never the hooks port
  });

  it("getInfo reads live state, including SUSPENDED", async () => {
    fresh();
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const sb = await client.create();
    await sb.pause();
    expect((await sb.getInfo()).state).toBe("paused");
    await sb.resume();
    expect((await sb.getInfo()).state).toBe("running");
  });

  it("previews use a port-scoped token with an expiry", async () => {
    const c = fresh();
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const sb = await client.create();
    const pv = await sb.ports!.expose(3000);
    expect(pv.url).toMatch(/^https:\/\/mvm-1\./);
    expect(pv.auth?.type).toBe("header");
    expect(pv.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
    const res = await sb.ports!.fetch(3000, "/hello");
    expect(await res.text()).toBe("app on 3000 /hello");
    const scoped = [...c.tokens.values()].map((t) => t.ports);
    expect(scoped).toContainEqual([3000]);
  });

  it("paginates list with nextToken", async () => {
    const c = fresh();
    c.pageSize = 2;
    const client = createSandboxClient({ provider: make(), telemetry: false });
    for (let i = 0; i < 5; i++) {
      await client.create({ metadata: { i: String(i % 2) } });
    }
    const ids = [];
    for await (const s of client.list()) {
      ids.push(s.id);
    }
    expect(ids).toHaveLength(5);
    const odd = [];
    for await (const s of client.list({ metadata: { i: "1" } })) {
      odd.push(s.id);
    }
    expect(odd).toHaveLength(2);
  });

  it("builds a template: zip with Dockerfile at the root, hooks enabled, tagged", async () => {
    const c = fresh();
    const client = createSandboxClient({ provider: make(), telemetry: false });
    const events: string[] = [];
    const ref = await client.templates!.build(
      {
        env: { A: "1" },
        name: "my-tpl",
        source: {
          context: { "app/server.mjs": "x" },
          dockerfile: "FROM scratch\n",
        },
      },
      { onEvent: (e) => events.push(e.type === "status" ? e.status : e.line) }
    );
    expect(ref.id).toBe("arn:aws:lambda:us-east-1:123:microvm-image:my-tpl");
    const create = c.sent.find((s) => s.name === "CreateMicrovmImageCommand")!
      .input as AWS.CreateMicrovmImageCommandInput;
    expect(create).toMatchObject({
      baseImageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1",
      buildRoleArn: "arn:aws:iam::123:role/Build",
      environmentVariables: { A: "1" },
      hooks: { microvmHooks: { run: "ENABLED" }, port: 9000 },
    });
    expect(create.codeArtifact).toEqual({
      uri: expect.stringMatching(/^s3:\/\/bucket\/sbox-templates\/my-tpl-/),
    });
    const zip = [...c.s3.values()][0]!;
    const text = new TextDecoder("latin1").decode(zip);
    expect(text.startsWith("PK\u0003\u0004")).toBe(true);
    expect(text).toContain("Dockerfile");
    expect(text).toContain("app/server.mjs");
    expect(events.some((e) => e.includes("build b1"))).toBe(true);
    // cache hit by content hash
    const again = await client.templates!.build({
      env: { A: "1" },
      name: "my-tpl",
      source: {
        context: { "app/server.mjs": "x" },
        dockerfile: "FROM scratch\n",
      },
    });
    expect(again.id).toBe(ref.id);
    expect(
      c.sent.filter((s) => s.name === "CreateMicrovmImageCommand")
    ).toHaveLength(1);
  });

  it("verifies with ListMicrovms(maxResults 1) and maps bad credentials", async () => {
    const c = fresh();
    expect(
      await createSandboxClient({ provider: make(), telemetry: false }).verify()
    ).toEqual({
      account: "us-east-1",
      ok: true,
      provider: "aws-lambda",
    });
    c.authorized = false;
    const bad = await createSandboxClient({
      provider: make(),
      telemetry: false,
    }).verify();
    expect(!bad.ok && bad.error.code).toBe("Unauthorized");
    expect(c.vms.size).toBe(0);
  });

  it("maps states, idle policies and errors", () => {
    expect(mapMicrovmState("PENDING")).toBe("creating");
    expect(mapMicrovmState("RUNNING")).toBe("running");
    expect(mapMicrovmState("SUSPENDING")).toBe("suspending");
    expect(mapMicrovmState("SUSPENDED")).toBe("paused");
    expect(mapMicrovmState("TERMINATING")).toBe("destroyed");
    expect(mapMicrovmState("TERMINATED")).toBe("destroyed");
    expect(idlePolicyFor(undefined, undefined, undefined)).toBeUndefined();
    expect(
      idlePolicyFor(
        { idleTimeoutMs: 1000, onIdle: "destroy" },
        undefined,
        undefined
      )
    ).toEqual({
      autoResumeEnabled: true,
      maxIdleDurationSeconds: 1,
      suspendedDurationSeconds: 1,
    });
    expect(
      mapAwsLambdaError(new AwsError("ResourceNotFoundException", 404))?.code
    ).toBe("NotFound");
    expect(
      mapAwsLambdaError(new AwsError("AccessDeniedException", 403))?.code
    ).toBe("Unauthorized");
    expect(
      mapAwsLambdaError(new AwsError("ThrottlingException", 429))
    ).toMatchObject({ code: "QuotaExceeded", retryable: true });
    expect(
      mapAwsLambdaError(new AwsError("ServiceQuotaExceededException", 402))
        ?.code
    ).toBe("QuotaExceeded");
    expect(
      mapAwsLambdaError(new AwsError("ConflictException", 409))?.code
    ).toBe("Conflict");
    expect(
      mapAwsLambdaError(new AwsError("InternalServerException", 500))
    ).toMatchObject({ code: "Provider", retryable: true });
  });

  it("writes a valid STORE zip", () => {
    const zip = zipStore(new Map([["a.txt", new TextEncoder().encode("hi")]]));
    const dv = new DataView(zip.buffer);
    expect(dv.getUint32(0, true)).toBe(0x04_03_4b_50);
    expect(dv.getUint32(zip.length - 22, true)).toBe(0x06_05_4b_50);
    expect(dv.getUint32(14, true)).toBe(0xd8_93_2a_ac); // crc32("hi")
  });
});

// ---------------------------------------------------------------------------
// the real reference runner, on localhost
// ---------------------------------------------------------------------------

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

describe("runner/server.mjs (localhost)", () => {
  let proc: ChildProcess;
  let base: string;
  let hooks: string;

  beforeAll(async () => {
    const [port, hooksPort] = [await freePort(), await freePort()];
    base = `http://127.0.0.1:${port}`;
    hooks = `http://127.0.0.1:${hooksPort}`;
    proc = spawn(
      process.execPath,
      [fileURLToPath(new URL("runner/server.mjs", import.meta.url))],
      {
        env: {
          ...process.env,
          HOOKS_PORT: String(hooksPort),
          PORT: String(port),
        },
        stdio: "ignore",
      }
    );
    for (let i = 0; i < 50; i++) {
      const ok = await fetch(`${base}/sbox/health`).then(
        (r) => r.ok,
        () => false
      );
      if (ok) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  afterAll(() => {
    proc.kill();
  });

  const execNd = async (body: Record<string, unknown>) => {
    const res = await fetch(`${base}/sbox/exec`, {
      body: JSON.stringify({ stream: true, ...body }),
      method: "POST",
    });
    return (await res.text())
      .trim()
      .split("\n")
      .map(
        (l) =>
          JSON.parse(l) as {
            type: string;
            data?: string;
            exitCode?: number;
            timedOut?: boolean;
          }
      );
  };

  it("applies runHookPayload env from the /run hook (hooks port only)", async () => {
    const hookPath = "/aws/lambda-microvms/runtime/v1/run";
    const r = await fetch(`${hooks}${hookPath}`, {
      body: JSON.stringify({
        microvmId: "mvm-x",
        runHookPayload: JSON.stringify({
          env: { SBOX_HOOK: "from-hook" },
          metadata: { a: "b" },
        }),
      }),
      method: "POST",
    });
    expect(r.status).toBe(200);
    expect((await fetch(`${hooks}/sbox/health`)).status).toBe(404);
    const lines = await execNd({
      cmd: "echo $SBOX_HOOK; echo err >&2; exit 3",
      id: "e1",
    });
    expect(lines).toEqual([
      { data: "from-hook\n", type: "stdout" },
      { data: "err\n", type: "stderr" },
      { exitCode: 3, timedOut: false, type: "exit" },
    ]);
    expect(await (await fetch(`${base}/sbox/info`)).json()).toEqual({
      metadata: { a: "b" },
      microvmId: "mvm-x",
    });
  });

  it("enforces timeoutMs and kill", async () => {
    const t = await execNd({ cmd: "sleep 5", id: "t1", timeoutMs: 200 });
    expect(t.at(-1)).toMatchObject({ timedOut: true, type: "exit" });
    const pending = execNd({ cmd: "sleep 5", id: "k1" });
    await new Promise((r) => setTimeout(r, 200));
    const k = await fetch(`${base}/sbox/kill`, {
      body: JSON.stringify({ id: "k1" }),
      method: "POST",
    });
    expect(k.status).toBe(200);
    expect((await pending).at(-1)).toMatchObject({
      exitCode: 137,
      type: "exit",
    });
  });

  it("round-trips binary files", async () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    const dir = `/tmp/sbox-runner-test-${process.pid}`;
    await fetch(`${base}/sbox/files?path=${dir}/a/b.bin`, {
      body: bytes,
      method: "PUT",
    });
    const got = new Uint8Array(
      await (
        await fetch(`${base}/sbox/files?path=${dir}/a/b.bin`)
      ).arrayBuffer()
    );
    expect([...got]).toEqual([...bytes]);
    expect((await fetch(`${base}/sbox/files?path=${dir}/missing`)).status).toBe(
      404
    );
    await execNd({ cmd: `rm -rf ${dir}`, id: "rm" });
  });
});
