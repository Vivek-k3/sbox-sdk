import { describe, expect, it } from "vitest";

import { MORPH_CAPS, morph } from "./index.js";

describe("morph adapter (offline)", () => {
  const p = morph({ apiKey: "k" });

  it("declares its capabilities", () => {
    expect(p.name).toBe("morph");
    expect(p.capabilities).toBe(MORPH_CAPS);
    expect(p.capabilities.snapshot).toBe("native"); // instance.snapshot()
    expect(p.capabilities.fork).toBe("native"); // instance.branch()
    expect(p.capabilities.pause).toBe("unsupported"); // no pause/resume state
    expect(p.capabilities.exposePort).toBe("native");
    expect(p.flags.perCommandEnvCwd).toBe(false); // exec(cmd) has no cwd/env
    expect(p.flags.previewModel).toBe("subdomain");
  });
});
