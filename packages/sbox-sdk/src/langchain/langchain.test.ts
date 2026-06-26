import { describe, expect, it } from "vitest";

import { ai } from "../ai/index.js";
import { createSandboxClient } from "../internal/client.js";
import type { Sandbox } from "../internal/types.js";
import { memory } from "../memory/index.js";
import { langchain, toLangChainTools } from "./index.js";

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

const find = (tools: ReturnType<typeof toLangChainTools>, name: string): any =>
  tools.find((t) => t.name === name);

describe("toLangChainTools", () => {
  it("returns structured tools keyed by name, capability-gated", async () => {
    const tools = toLangChainTools(await makeSandbox());
    expect(tools.map((t) => t.name).toSorted()).toEqual(
      [...EXPECTED].toSorted()
    );
    const exec = find(tools, "sbox_exec");
    expect(exec.name).toBe("sbox_exec");
    expect(typeof exec.invoke).toBe("function");
  });

  it("invokes a tool (fs round-trip)", async () => {
    const tools = toLangChainTools(await makeSandbox());
    await find(tools, "sbox_fs_write").invoke({
      content: "langchain",
      path: "/tmp/l.txt",
    });
    const out = await find(tools, "sbox_fs_read").invoke({
      path: "/tmp/l.txt",
    });
    expect(out).toBe("langchain");
  });

  it("denies a destructive call when onApprovalRequest returns false", async () => {
    const tools = toLangChainTools(await makeSandbox(), {
      policy: { onApprovalRequest: async () => false },
    });
    const res = await find(tools, "sbox_fs_remove").invoke({ path: "/x" });
    expect(String(res)).toMatch(/Approval denied/i);
  });
});

describe("ai({ framework: langchain() }) plugin", () => {
  it("shapes sandbox.tools as the LangChain tool array", async () => {
    const client = createSandboxClient({
      plugins: [ai({ framework: langchain() })],
      provider: memory(),
    });
    const sandbox = await client.create();
    expect(Array.isArray(sandbox.tools)).toBe(true);
    expect(sandbox.tools.map((t) => t.name)).toContain("sbox_exec");
  });
});
