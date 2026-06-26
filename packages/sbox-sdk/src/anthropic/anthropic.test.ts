import { describe, expect, it } from "vitest";

import { ai } from "../ai/index.js";
import { createSandboxClient } from "../internal/client.js";
import type { Sandbox } from "../internal/types.js";
import { memory } from "../memory/index.js";
import { anthropic, toAnthropicTools } from "./index.js";

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

const find = (tools: ReturnType<typeof toAnthropicTools>, name: string): any =>
  tools.find((t) => t.name === name);

describe("toAnthropicTools", () => {
  it("returns runnable Claude tools, capability-gated", async () => {
    const tools = toAnthropicTools(await makeSandbox());
    expect(tools.map((t) => t.name).toSorted()).toEqual(
      [...EXPECTED].toSorted()
    );
    const exec = find(tools, "sbox_exec");
    expect(typeof exec.run).toBe("function");
    expect(exec.input_schema.type).toBe("object");
  });

  it("runs a tool (fs round-trip)", async () => {
    const tools = toAnthropicTools(await makeSandbox());
    const write = find(tools, "sbox_fs_write");
    const read = find(tools, "sbox_fs_read");
    await write.run({ content: "claude", path: "/tmp/a.txt" });
    expect(await read.run({ path: "/tmp/a.txt" })).toBe("claude");
  });

  it("denies a destructive call when onApprovalRequest returns false", async () => {
    const tools = toAnthropicTools(await makeSandbox(), {
      policy: { onApprovalRequest: async () => false },
    });
    const res = await find(tools, "sbox_fs_remove").run({ path: "/x" });
    expect(String(res)).toMatch(/Approval denied/i);
  });
});

describe("ai({ framework: anthropic() }) plugin", () => {
  it("shapes sandbox.tools as the Claude tool array", async () => {
    const client = createSandboxClient({
      plugins: [ai({ framework: anthropic() })],
      provider: memory(),
    });
    const sandbox = await client.create();
    expect(Array.isArray(sandbox.tools)).toBe(true);
    expect(sandbox.tools.map((t) => t.name)).toContain("sbox_exec");
  });
});
