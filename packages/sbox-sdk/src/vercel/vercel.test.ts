import { describe, expect, it } from "vitest";

import { runConformance } from "../conformance/index.js";
import { VERCEL_CAPS, vercel } from "./index.js";

describe("vercel adapter (offline)", () => {
  const provider = vercel({ projectId: "proj", teamId: "team", token: "t" });

  it("exposes the vercel provider with the declared capabilities", () => {
    expect(provider.name).toBe("vercel");
    expect(provider.capabilities).toBe(VERCEL_CAPS);
    expect(provider.capabilities.codeInterpreter).toBe("unsupported");
    expect(provider.capabilities.exposePort).toBe("native");
    expect(provider.flags.previewModel).toBe("declaredPorts");
    expect(provider.flags.preservesDiskOnStop).toBe(true);
  });

  it("normalizes auth errors to Unauthorized", () => {
    expect(provider.mapError?.(new Error("invalid token"))?.code).toBe(
      "Unauthorized"
    );
  });
});

// Live integration — runs only with Vercel credentials in env.
const LIVE =
  !!process.env.VERCEL_TOKEN &&
  !!process.env.VERCEL_TEAM_ID &&
  !!process.env.VERCEL_PROJECT_ID;
describe.runIf(LIVE)("vercel live conformance", () => {
  it("passes the shared conformance suite against a real sandbox", async () => {
    const report = await runConformance(
      vercel({
        projectId: process.env.VERCEL_PROJECT_ID!,
        teamId: process.env.VERCEL_TEAM_ID!,
        token: process.env.VERCEL_TOKEN!,
      }),
      { expectedCaps: { codeInterpreter: "unsupported" } }
    );
    const failed = report.checks.filter((c) => !c.ok);
    expect(JSON.stringify(failed, null, 2)).toBe("[]");
    expect(report.passed).toBe(true);
  }, 180_000);
});
