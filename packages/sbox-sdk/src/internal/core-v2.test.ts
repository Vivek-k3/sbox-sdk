import { describe, expect, it } from "vitest";

import { memory } from "../memory/index.js";
import { createSandboxClient } from "./client.js";
import { NotSupportedError, SandboxError } from "./errors.js";
import { browserUrl, normalizePreview } from "./preview.js";
import { buildExecCommand } from "./shell.js";
import { parseDockerfile, tarContext, templateCacheKey } from "./templates.js";
import type { SandboxProvider } from "./types.js";

const emulated = { exitCodeNative: false, perCommandEnvCwd: false };
const native = { exitCodeNative: true, perCommandEnvCwd: true };

describe("buildExecCommand", () => {
  it("passes through untouched when nothing needs emulating", () => {
    const b = buildExecCommand("ls", { cwd: "/x" }, native);
    expect(b.command).toBe("ls");
    expect(b.execOptions.cwd).toBe("/x");
  });

  it("aborts when cd fails instead of running in the wrong dir", () => {
    const b = buildExecCommand("rm -rf build", { cwd: "/nope" }, emulated);
    // `cd X && ... && { cmd }` — the command is chained with &&, never `;`
    const inner = b.command;
    expect(inner).toMatch(/cd .*\/nope.* && \{ rm -rf build/);
    expect(inner).not.toMatch(/cd [^&]*; rm/);
    expect(b.execOptions.cwd).toBeUndefined();
  });

  it("rejects env keys that could inject shell", () => {
    expect(() =>
      buildExecCommand("true", { env: { "A;touch /pwn": "1" } }, emulated)
    ).toThrow(SandboxError);
    expect(() =>
      buildExecCommand("true", { env: { "$(x)": "1" } }, native)
    ).toThrow(/invalid environment variable/);
  });

  it("pipes buffered stdin through base64 and strips it from options", () => {
    const b = buildExecCommand("cat", { stdin: "hé\n" }, native);
    expect(b.command).toContain("base64 -d");
    expect(b.execOptions.stdin).toBeUndefined();
  });

  it("appends the exit marker last so it reports the real status", () => {
    const b = buildExecCommand("false", { cwd: "/tmp" }, emulated);
    expect(b.parseExitMarker).toBe(true);
    expect(b.command).toMatch(/\}; echo __sbox_rc=\$\?'$/);
  });
});

describe("templates helpers", () => {
  it("cache key is stable and content-sensitive", async () => {
    const a = await templateCacheKey({
      source: { context: { "a.txt": "1" }, dockerfile: "FROM x" },
    });
    const b = await templateCacheKey({
      source: { context: { "a.txt": "1" }, dockerfile: "FROM x" },
    });
    const c = await templateCacheKey({
      source: { context: { "a.txt": "2" }, dockerfile: "FROM x" },
    });
    const d = await templateCacheKey({
      resources: { memoryMB: 2048 },
      source: { context: { "a.txt": "1" }, dockerfile: "FROM x" },
    });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });

  it("parses Dockerfiles with continuations and comments", () => {
    const ins = parseDockerfile(
      "# base\nFROM debian:bookworm\nRUN apt-get update && \\\n  apt-get install -y curl\n\ncopy a /b\n"
    );
    expect(ins.map((i) => i.op)).toEqual(["FROM", "RUN", "COPY"]);
    expect(ins[1]!.args).toBe("apt-get update &&  apt-get install -y curl");
  });

  it("writes a valid ustar archive", () => {
    const tar = tarContext(
      new Map([["dir/hello.txt", new TextEncoder().encode("hi")]])
    );
    expect(tar.length % 512).toBe(0);
    expect(new TextDecoder().decode(tar.subarray(0, 13))).toBe("dir/hello.txt");
    expect(new TextDecoder().decode(tar.subarray(257, 262))).toBe("ustar");
    expect(new TextDecoder().decode(tar.subarray(512, 514))).toBe("hi");
  });
});

describe("previews", () => {
  it("derives wss from https and defaults to public auth", () => {
    const p = normalizePreview({ port: 80, url: "https://a.example.com/x" });
    expect(p.wsUrl).toBe("wss://a.example.com/x");
    expect(p.auth).toEqual({ type: "public" });
  });

  it("bakes query tokens into browser URLs, refuses header-only auth", () => {
    const q = browserUrl(
      {
        auth: { param: "tkn", token: "s3cret", type: "query" },
        port: 6080,
        url: "https://p.example.com",
      },
      { path: "/websockify?x=1", protocol: "ws" }
    );
    expect(q).toBe("wss://p.example.com/websockify?x=1&tkn=s3cret");
    expect(() =>
      browserUrl({ port: 1, token: "t", url: "https://h.example.com" })
    ).toThrow(NotSupportedError);
  });
});

describe("client v2", () => {
  it("builds an inline template once and reuses it by content hash", async () => {
    const provider = memory();
    let builds = 0;
    const tpl = provider.templates!;
    const counting: SandboxProvider = {
      ...provider,
      templates: {
        ...tpl,
        build: (spec, opts, ctx) => {
          builds++;
          return tpl.build(spec, opts, ctx);
        },
      },
    } as SandboxProvider;
    const client = createSandboxClient({
      provider: counting,
      telemetry: false,
    });
    const template = {
      source: {
        context: { "hello.txt": "hey" },
        dockerfile: "FROM x\nCOPY hello.txt /app/hello.txt",
      },
    };
    const events: string[] = [];
    const [a, b] = await Promise.all([
      client.create({ onTemplateEvent: (e) => events.push(e.type), template }),
      client.create({ template }),
    ]);
    const c = await client.create({ template });
    expect(builds).toBe(1);
    expect(events).toContain("log");
    for (const sb of [a, b, c]) {
      expect(await (await sb.files.read("/app/hello.txt")).text()).toBe("hey");
    }
  });

  it("rejects template sources the provider does not accept", async () => {
    const provider = memory();
    const client = createSandboxClient({
      provider: {
        ...provider,
        flags: { ...provider.flags, templateSources: ["image"] },
      },
      telemetry: false,
    });
    await expect(
      client.templates!.build({ source: { dockerfile: "FROM x" } })
    ).rejects.toBeInstanceOf(NotSupportedError);
  });

  it("emulates getOrCreate via list + metadata", async () => {
    const provider = memory();
    const { getOrCreate: _drop, ...noNative } = provider;
    const client = createSandboxClient({
      provider: noNative,
      telemetry: false,
    });
    const a = await client.getOrCreate({ name: "desk" });
    const b = await client.getOrCreate({ name: "desk" });
    const other = await client.getOrCreate({ name: "other" });
    expect(a.id).toBe(b.id);
    expect(other.id).not.toBe(a.id);
  });

  it("connect({ resume: true }) wakes a paused sandbox", async () => {
    const client = createSandboxClient({ telemetry: false });
    const sb = await client.create();
    await sb.pause();
    const again = await client.connect(sb.id, { resume: true });
    expect((await again.getInfo()).state).toBe("running");
  });

  it("maps deprecated ttlMs/onIdle into lifecycle", async () => {
    let seen: unknown;
    const provider = memory();
    const client = createSandboxClient({
      provider: {
        ...provider,
        create: (spec, ctx) => {
          seen = spec;
          return provider.create(spec, ctx);
        },
      },
      telemetry: false,
    });
    await client.create({ onIdle: "pause", ttlMs: 60_000 });
    expect(seen).toMatchObject({
      lifecycle: { maxAgeMs: 60_000, onIdle: "pause" },
      onIdle: "pause",
      ttlMs: 60_000,
    });
  });

  it("verify() reports success and NotSupported without throwing", async () => {
    expect(
      await createSandboxClient({ telemetry: false }).verify()
    ).toMatchObject({
      ok: true,
    });
    const { verify: _v, ...noVerify } = memory();
    const res = await createSandboxClient({
      provider: noVerify,
      telemetry: false,
    }).verify();
    expect(res.ok).toBe(false);
  });

  it("ports.fetch never exposes a port publicly as a side effect", async () => {
    const calls: string[] = [];
    const client = createSandboxClient({
      fetch: (async (url: string) => {
        calls.push(String(url));
        return new Response("ok");
      }) as typeof fetch,
      telemetry: false,
    });
    const sb = await client.create();
    await sb.ports!.fetch(3000, "/health");
    const listed = await sb.ports!.list();
    expect(listed[0]!.auth?.type).toBe("query");
    expect(calls[0]).toContain("sbox_token=");
  });

  it("gates resume on the pause or stop capability", async () => {
    const provider = memory();
    const client = createSandboxClient({
      provider: {
        ...provider,
        capabilities: {
          ...provider.capabilities,
          pause: "unsupported",
          stop: "unsupported",
        },
      } as unknown as typeof provider,
      telemetry: false,
    });
    const sb = await client.create();
    await expect(sb.resume()).rejects.toBeInstanceOf(NotSupportedError);
  });
});

describe("provider-level error normalization", () => {
  it("routes create errors through mapError and retries mapped retryable ones", async () => {
    const base = memory();
    let calls = 0;
    const client = createSandboxClient({
      provider: {
        ...base,
        create: (spec, ctx) => {
          calls++;
          if (calls === 1) {
            throw new Error("rate limited (429)");
          }
          return base.create(spec, ctx);
        },
        mapError: (e) =>
          e instanceof Error && e.message.includes("429")
            ? new SandboxError("QuotaExceeded", e.message, {
                provider: "memory",
              })
            : undefined,
      },
      retry: { delayMs: () => 0 },
      telemetry: false,
    });
    await client.create();
    expect(calls).toBe(2);
  });

  it("does NOT retry unmapped native create errors (avoids duplicate VMs)", async () => {
    const base = memory();
    let calls = 0;
    const client = createSandboxClient({
      provider: {
        ...base,
        create: () => {
          calls++;
          throw new Error("something odd");
        },
      },
      retry: { delayMs: () => 0 },
      telemetry: false,
    });
    const err = await client.create().catch((e: unknown) => e);
    expect(calls).toBe(1);
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).retryable).toBe(false);
  });
});
