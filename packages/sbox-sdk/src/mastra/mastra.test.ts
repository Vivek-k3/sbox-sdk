import { describe, expect, it } from "vitest";

import { ai } from "../ai/index.js";
import { createSandboxClient } from "../internal/client.js";
import type { Sandbox } from "../internal/types.js";
import { memory } from "../memory/index.js";
import { mastra, toMastraTools } from "./index.js";

async function makeSandbox(): Promise<Sandbox> {
  return createSandboxClient({ provider: memory() }).create();
}

const EXPECTED = [
  "sbox_exec",
  "sbox_expose_port",
  "sbox_fs_list",
  "sbox_fs_read",
  "sbox_fs_remove",
  "sbox_fs_write",
  "sbox_lifecycle",
  "sbox_snapshot",
];

describe("toMastraTools", () => {
  it("returns Mastra tools keyed by id, capability-gated", async () => {
    const tools = toMastraTools(await makeSandbox());
    expect(Object.keys(tools).toSorted()).toEqual([...EXPECTED].toSorted());
    expect(tools.sbox_exec!.id).toBe("sbox_exec");
    expect(typeof tools.sbox_exec!.execute).toBe("function");
    expect(tools.sbox_run_code).toBeUndefined();
  });

  it("executes (fs round-trip)", async () => {
    const tools = toMastraTools(await makeSandbox());
    await tools.sbox_fs_write!.execute!({
      content: "mastra",
      path: "/tmp/m.txt",
    });
    const out = await tools.sbox_fs_read!.execute!({ path: "/tmp/m.txt" });
    expect(out).toBe("mastra");
  });

  it("denies a destructive call when onApprovalRequest returns false", async () => {
    const tools = toMastraTools(await makeSandbox(), {
      policy: { onApprovalRequest: async () => false },
    });
    const res = await tools.sbox_fs_remove!.execute!({ path: "/tmp/m.txt" });
    expect(String(res)).toMatch(/Approval denied/i);
  });
});

describe("ai({ framework: mastra() }) plugin", () => {
  it("shapes sandbox.tools as the Mastra map", async () => {
    const client = createSandboxClient({
      plugins: [ai({ framework: mastra() })],
      provider: memory(),
    });
    const sandbox = await client.create();
    expect(sandbox.tools.sbox_exec!.id).toBe("sbox_exec");
    expect(Object.keys(sandbox.tools)).toContain("sbox_fs_read");
  });
});
