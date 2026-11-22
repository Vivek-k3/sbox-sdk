/**
 * `cloud()` against an in-process `createGatewayHandler()` routing to memory
 * providers. The fetch shim hands requests straight to the handler, so this
 * exercises the full wire protocol (JSON, NDJSON streams, raw file bodies)
 * without a network.
 */
import { describe, expect, it } from "vitest";

import { runConformance } from "../conformance/index.js";
import { createSandboxClient } from "../internal/client.js";
import { SandboxError } from "../internal/errors.js";
import { memory } from "../memory/index.js";
import { router } from "../router/index.js";
import { cloud } from "./index.js";
import { createGatewayHandler } from "./server.js";
import type { GatewayEvent, GatewayHandlerOptions } from "./server.js";

const KEY = "sbox_test_key";
const BASE = "https://gateway.test/api";

function gateway(extra: Partial<GatewayHandlerOptions> = {}) {
  const events: GatewayEvent[] = [];
  // Providers persist across requests, like a real account's sandboxes do.
  const a = memory({ idPrefix: "a" });
  const b = memory({ idPrefix: "b" });
  const handler = createGatewayHandler({
    basePath: "/api",
    onEvent: (e) => {
      events.push(e);
    },
    resolve: (req, { requires }) => {
      if (req.headers.get("authorization") !== `Bearer ${KEY}`) {
        throw new SandboxError("Unauthorized", "bad api key");
      }
      return router({
        candidates: [
          { name: "a", provider: a },
          { name: "b", provider: b },
        ],
        requires,
      });
    },
    ...extra,
  });
  const fetchShim: typeof fetch = (input, init) =>
    handler(new Request(input as string, init));
  return { events, fetch: fetchShim };
}

describe("cloud: conformance", () => {
  it("passes the shared suite through the gateway protocol", async () => {
    const gw = gateway();
    const provider = await cloud({
      apiKey: KEY,
      baseUrl: BASE,
      fetch: gw.fetch,
    });
    const report = await runConformance(provider, { live: true });
    const failed = report.checks.filter((c) => !c.ok);
    expect(JSON.stringify(failed, null, 2)).toBe("[]");
  });
});

describe("cloud: session", () => {
  it("rejects a bad API key with Unauthorized", async () => {
    const gw = gateway();
    await expect(
      cloud({ apiKey: "nope", baseUrl: BASE, fetch: gw.fetch })
    ).rejects.toMatchObject({ code: "Unauthorized" });
  });

  it("requires a key and defaults to the hosted gateway", async () => {
    await expect(cloud({ baseUrl: BASE })).rejects.toMatchObject({
      code: "Unauthorized",
    });
    const urls: string[] = [];
    await cloud({
      apiKey: KEY,
      fetch: (input) => {
        urls.push(String(input));
        return Promise.reject(new Error("offline"));
      },
    }).catch(() => undefined);
    expect(urls[0]).toBe("https://api.sbox-sdk.dev/v1/session");
  });

  it("forwards `requires` so the gateway routes on it", async () => {
    const gw = gateway();
    await expect(
      cloud({ apiKey: KEY, baseUrl: BASE, fetch: gw.fetch, requires: ["gpu"] })
    ).rejects.toMatchObject({ code: "Validation" });
  });

  it("reports capabilities the wire can't carry as unsupported", async () => {
    const gw = gateway();
    const p = await cloud({ apiKey: KEY, baseUrl: BASE, fetch: gw.fetch });
    expect(p.capabilities.pty).toBe("unsupported");
    expect(p.capabilities.templateBuild).toBe("unsupported");
    expect(p.capabilities.snapshot).toBe("native");
    expect(p.routes).toEqual(["a", "b"]);
  });
});

describe("cloud: usage events", () => {
  it("emits create, exec, file and destroy events for analytics", async () => {
    const gw = gateway();
    const client = createSandboxClient({
      provider: await cloud({ apiKey: KEY, baseUrl: BASE, fetch: gw.fetch }),
      telemetry: false,
    });
    const sb = await client.create();
    const res = await sb.commands.run("echo hi");
    expect(res.stdout.trim()).toBe("hi");
    await sb.files.write("/tmp/f.txt", "abc");
    expect(await (await sb.files.read("/tmp/f.txt")).text()).toBe("abc");
    await sb.destroy();
    // Events are fire-and-forget; let them flush.
    await new Promise((r) => setTimeout(r, 0));
    const types = gw.events.map((e) => e.type);
    expect(types).toContain("sandbox.create");
    expect(types).toContain("exec");
    expect(types).toContain("files.write");
    expect(types).toContain("files.read");
    expect(types.at(-1)).toBe("sandbox.destroy");
    const exec = gw.events.find((e) => e.type === "exec");
    expect(exec).toMatchObject({ exitCode: 0, ok: true });
  });

  it("a throwing onEvent never breaks a request", async () => {
    const gw = gateway({
      onEvent: () => {
        throw new Error("analytics down");
      },
    });
    const client = createSandboxClient({
      provider: await cloud({ apiKey: KEY, baseUrl: BASE, fetch: gw.fetch }),
      telemetry: false,
    });
    const sb = await client.create();
    expect((await sb.commands.run("echo ok")).exitCode).toBe(0);
  });
});

describe("cloud: errors", () => {
  it("round-trips SandboxError codes across the wire", async () => {
    const gw = gateway();
    const client = createSandboxClient({
      provider: await cloud({ apiKey: KEY, baseUrl: BASE, fetch: gw.fetch }),
      telemetry: false,
    });
    await expect(client.connect("a:does-not-exist")).rejects.toMatchObject({
      code: "NotFound",
    });
  });
});
