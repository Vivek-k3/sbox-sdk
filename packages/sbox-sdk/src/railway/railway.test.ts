import { describe, expect, it } from "vitest";

import { RAILWAY_CAPS, railway } from "./index.js";

describe("railway adapter (offline)", () => {
  const p = railway({ token: "t", environmentId: "e" });

  it("declares its capabilities", () => {
    expect(p.name).toBe("railway");
    expect(p.capabilities).toBe(RAILWAY_CAPS);
    expect(p.capabilities.streaming).toBe("native"); // onStdout/onStderr callbacks
    expect(p.capabilities.snapshot).toBe("native"); // checkpoint()
    expect(p.capabilities.fork).toBe("native"); // native fork()
    expect(p.capabilities.exposePort).toBe("unsupported"); // network-isolated
    expect(p.flags.perCommandEnvCwd).toBe(true); // exec takes { cwd, env }
    expect(p.flags.previewModel).toBe("none");
  });
});
