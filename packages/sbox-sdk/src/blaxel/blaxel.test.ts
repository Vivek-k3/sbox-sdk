import { describe, expect, it } from "vitest";

import { BLAXEL_CAPS, blaxel } from "./index.js";

describe("blaxel adapter (offline)", () => {
  const p = blaxel({ apiKey: "k", workspace: "w" });

  it("declares its capabilities", () => {
    expect(p.name).toBe("blaxel");
    expect(p.capabilities).toBe(BLAXEL_CAPS);
    expect(p.capabilities.exposePort).toBe("native");
    expect(p.capabilities.privatePreview).toBe("native"); // public:false previews
    expect(p.capabilities.region).toBe("native");
    expect(p.capabilities.volumes).toBe("native");
    expect(p.capabilities.snapshot).toBe("unsupported");
    expect(p.flags.perCommandEnvCwd).toBe(false); // exec has no per-call env
    expect(p.flags.preservesMemoryOnPause).toBe(true); // perpetual standby
  });
});
