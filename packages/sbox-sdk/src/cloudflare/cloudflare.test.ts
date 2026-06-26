import { describe, expect, it } from "vitest";

import { CLOUDFLARE_CAPS, cloudflare } from "./index.js";

// Cloudflare sandboxes only run inside a Worker, so conformance is validated
// live in a Worker harness, not here. Offline we assert provider metadata.
describe("cloudflare adapter (offline)", () => {
  const provider = cloudflare({ binding: {}, hostname: "example.com" });

  it("exposes the cloudflare provider with the declared capabilities", () => {
    expect(provider.name).toBe("cloudflare");
    expect(provider.capabilities).toBe(CLOUDFLARE_CAPS);
    expect(provider.capabilities.codeInterpreter).toBe("native");
    expect(provider.capabilities.proxiedFetch).toBe("native");
    expect(provider.capabilities.list).toBe("unsupported");
    expect(provider.flags.previewModel).toBe("wildcardDNS");
  });

  it("does not implement list() (Durable Objects are not enumerable)", () => {
    expect(provider.list).toBeUndefined();
  });

  it("normalizes not-found errors", () => {
    expect(provider.mapError?.(new Error("object not found"))?.code).toBe(
      "NotFound"
    );
  });
});
