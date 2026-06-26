import { describe, expect, it } from "vitest";

import { NORTHFLANK_CAPS, northflank } from "./index.js";

describe("northflank adapter (offline)", () => {
  const p = northflank({ token: "t", projectId: "proj" });

  it("declares its capabilities", () => {
    expect(p.name).toBe("northflank");
    expect(p.capabilities).toBe(NORTHFLANK_CAPS);
    expect(p.capabilities.pause).toBe("native"); // scale-to-zero
    expect(p.capabilities.exposePort).toBe("native"); // public service port
    expect(p.capabilities.stop).toBe("unsupported");
    expect(p.capabilities.snapshot).toBe("unsupported"); // services platform
    expect(p.flags.perCommandEnvCwd).toBe(false); // exec session has no cwd/env
    expect(p.flags.preservesMemoryOnPause).toBe(false); // scale-to-zero loses memory
    expect(p.flags.previewModel).toBe("subdomain");
  });
});
