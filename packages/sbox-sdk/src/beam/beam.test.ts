import { describe, expect, it } from "vitest";

import { BEAM_CAPS, beam } from "./index.js";

describe("beam adapter (offline)", () => {
  const p = beam({ token: "t", workspaceId: "w" });

  it("declares its capabilities", () => {
    expect(p.name).toBe("beam");
    expect(p.capabilities).toBe(BEAM_CAPS);
    expect(p.capabilities.gpu).toBe("native"); // first-class GPU
    expect(p.capabilities.snapshot).toBe("native"); // instance.snapshot()
    expect(p.capabilities.fork).toBe("native"); // snapshot + createFromSnapshot
    expect(p.capabilities.setTimeout).toBe("native"); // updateTtl
    expect(p.capabilities.list).toBe("unsupported");
    expect(p.flags.perCommandEnvCwd).toBe(true); // exec takes { cwd, env }
    expect(p.flags.previewModel).toBe("subdomain");
  });
});
