import { describe, expect, it } from "vitest";

import { createSandboxClient } from "../internal/client.js";
import { AllProvidersFailedError } from "../internal/errors.js";
import { memory } from "../memory/index.js";
import { failing } from "../testing/index.js";
import { runConformance } from "./index.js";

describe("memory provider conformance", () => {
  it("passes with native fs", async () => {
    const report = await runConformance(memory(), {
      expectedCaps: { codeInterpreter: "unsupported", snapshot: "native" },
    });
    const failed = report.checks.filter((c) => !c.ok);
    expect(JSON.stringify(failed, null, 2)).toBe("[]");
    expect(report.passed).toBe(true);
  });

  it("passes with bare fs (exercises exec-based polyfills)", async () => {
    const report = await runConformance(memory({ bareFs: true }));
    const failed = report.checks.filter((c) => !c.ok);
    expect(JSON.stringify(failed, null, 2)).toBe("[]");
    expect(report.passed).toBe(true);
  });
});

describe("client behavior", () => {
  it("defaults to the in-memory provider with zero config", async () => {
    const client = createSandboxClient();
    expect(client.provider).toBe("memory");
    const sb = await client.create();
    const r = await sb.commands.run("echo zero-config");
    expect(r.stdout.trim()).toBe("zero-config");
  });

  it("await buffers and for-await streams the SAME run() handle", async () => {
    const client = createSandboxClient();
    const sb = await client.create();
    const buffered = await sb.commands.run("echo abc");
    expect(buffered.stdout.trim()).toBe("abc");

    let streamed = "";
    for await (const ev of sb.commands.run("echo def")) {
      if (ev.type === "stdout") {
        streamed += ev.data;
      }
    }
    expect(streamed.trim()).toBe("def");
  });

  it("retries a transient create failure then succeeds via fallback (with idempotencyKey)", async () => {
    const client = createSandboxClient({
      fallback: [memory()],
      provider: failing(),
      retry: { retries: 0 },
    });
    const sb = await client.create({ idempotencyKey: "k1" });
    expect(sb.provider).toBe("memory");
  });

  it("does NOT fall back without an idempotencyKey (avoids orphaned VMs)", async () => {
    const client = createSandboxClient({
      fallback: [memory()],
      provider: failing(),
      retry: { retries: 0 },
    });
    await expect(client.create()).rejects.toThrow();
  });

  it("aggregates fallback failures into AllProvidersFailedError", async () => {
    const client = createSandboxClient({
      fallback: [failing({ name: "b" })],
      provider: failing({ name: "a" }),
      retry: { retries: 0 },
    });
    await expect(
      client.create({ idempotencyKey: "k2" })
    ).rejects.toBeInstanceOf(AllProvidersFailedError);
  });
});
