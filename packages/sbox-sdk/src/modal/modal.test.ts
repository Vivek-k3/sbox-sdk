import { describe, expect, it } from "vitest";

import { MODAL_CAPS, modal } from "./index.js";

describe("modal adapter (offline)", () => {
  const p = modal({ tokenId: "id", tokenSecret: "secret" });

  it("declares its capabilities", () => {
    expect(p.name).toBe("modal");
    expect(p.capabilities).toBe(MODAL_CAPS);
    expect(p.capabilities.gpu).toBe("native");
    expect(p.capabilities.streaming).toBe("native");
    expect(p.capabilities.codeInterpreter).toBe("unsupported");
    expect(p.flags.previewModel).toBe("tunnel");
  });

  it("normalizes errors", () => {
    expect(p.mapError?.(new Error("resource not found"))?.code).toBe(
      "NotFound"
    );
    expect(p.mapError?.(new Error("invalid token"))?.code).toBe("Unauthorized");
  });
});
