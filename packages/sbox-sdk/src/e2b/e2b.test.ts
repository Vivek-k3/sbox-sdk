import { describe, expect, it } from "vitest";

import { runConformance } from "../conformance/index.js";
import { E2B_CAPS, e2b } from "./index.js";

describe("e2b adapter (offline)", () => {
  const provider = e2b({ apiKey: "test-key" });

  it("exposes the e2b provider with the declared capabilities", () => {
    expect(provider.name).toBe("e2b");
    expect(provider.capabilities).toBe(E2B_CAPS);
    expect(provider.capabilities.codeInterpreter).toBe("native");
    expect(provider.capabilities.snapshot).toBe("native");
    expect(provider.capabilities.stop).toBe("unsupported");
    expect(provider.flags.previewModel).toBe("subdomain");
    expect(provider.flags.perCommandEnvCwd).toBe(true);
  });

  it("normalizes auth errors to Unauthorized", () => {
    const mapped = provider.mapError?.(new Error("Invalid API key provided"));
    expect(mapped?.code).toBe("Unauthorized");
  });

  it("normalizes rate-limit errors to a retryable QuotaExceeded", () => {
    const mapped = provider.mapError?.(new Error("rate limit exceeded"));
    expect(mapped?.code).toBe("QuotaExceeded");
    expect(mapped?.retryable).toBe(true);
  });

  it("leaves unknown errors for the core to wrap", () => {
    expect(provider.mapError?.(new Error("weird"))).toBeUndefined();
  });
});

// Live integration — runs only when E2B_API_KEY is set (skipped on CI/forks).
const LIVE = !!process.env.E2B_API_KEY;
describe.runIf(LIVE)("e2b live conformance", () => {
  it("passes the shared conformance suite against a real sandbox", async () => {
    const report = await runConformance(
      e2b({ apiKey: process.env.E2B_API_KEY! }),
      {
        expectedCaps: { codeInterpreter: "native", snapshot: "native" },
      }
    );
    const failed = report.checks.filter((c) => !c.ok);
    expect(JSON.stringify(failed, null, 2)).toBe("[]");
    expect(report.passed).toBe(true);
  }, 120_000);
});
