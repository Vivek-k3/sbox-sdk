import { describe, expect, it } from "vitest";

import { runConformance } from "../conformance/index.js";
import { DAYTONA_CAPS, daytona } from "./index.js";

describe("daytona adapter (offline)", () => {
  const p = daytona({ apiKey: "k" });

  it("declares its capabilities", () => {
    expect(p.name).toBe("daytona");
    expect(p.capabilities).toBe(DAYTONA_CAPS);
    expect(p.capabilities.codeInterpreter).toBe("native");
    expect(p.capabilities.pause).toBe("native");
    expect(p.capabilities.stop).toBe("native");
    expect(p.flags.preservesMemoryOnPause).toBe(true);
  });

  it("normalizes not-found errors", () => {
    expect(p.mapError?.(new Error("sandbox not found"))?.code).toBe("NotFound");
  });
});

const LIVE = !!process.env.DAYTONA_API_KEY;
describe.runIf(LIVE)("daytona live conformance", () => {
  it("passes the shared conformance suite", async () => {
    const report = await runConformance(
      daytona({ apiKey: process.env.DAYTONA_API_KEY! }),
      {
        expectedCaps: {},
      }
    );
    expect(report.passed).toBe(true);
  }, 180_000);
});
