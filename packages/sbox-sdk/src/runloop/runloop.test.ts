import { describe, expect, it } from "vitest";

import { RUNLOOP_CAPS, runloop } from "./index.js";

describe("runloop adapter (offline)", () => {
  const p = runloop({ apiKey: "k" });

  it("declares its capabilities", () => {
    expect(p.name).toBe("runloop");
    expect(p.capabilities).toBe(RUNLOOP_CAPS);
    expect(p.capabilities.pause).toBe("native"); // suspend/resume
    expect(p.capabilities.snapshot).toBe("native"); // snapshotDisk
    expect(p.capabilities.fork).toBe("native"); // snapshot + boot N
    expect(p.capabilities.stop).toBe("unsupported"); // only suspend/shutdown
    expect(p.flags.preservesMemoryOnPause).toBe(true); // suspend preserves memory
    expect(p.flags.perCommandEnvCwd).toBe(false); // executeSync has no cwd/env
  });
});
