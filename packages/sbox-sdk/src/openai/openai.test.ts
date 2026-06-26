import { describe, expect, it } from "vitest";

import { ai } from "../ai/index.js";
import { createSandboxClient } from "../internal/client.js";
import type { Sandbox } from "../internal/types.js";
import { memory } from "../memory/index.js";
import { openaiAgents, toOpenAITools } from "./index.js";

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

// FunctionTool helpers (the Tool union only exposes some fields on FunctionTool).
const find = (tools: ReturnType<typeof toOpenAITools>, name: string): any =>
  tools.find((t) => t.name === name);

describe("toOpenAITools", () => {
  it("returns an array of strict function tools, capability-gated", async () => {
    const tools = toOpenAITools(await makeSandbox());
    expect(tools.map((t) => t.name).toSorted()).toEqual(
      [...EXPECTED].toSorted()
    );
    const exec = find(tools, "sbox_exec");
    expect(exec.type).toBe("function");
    expect(exec.strict).toBe(true);
    expect(exec.parameters.type).toBe("object");
    // optional zod fields are coerced to nullable+required for OpenAI strict mode
    expect(exec.parameters.required).toContain("cwd");
    expect(exec.parameters.additionalProperties).toBe(false);
  });

  it("wires native needsApproval from the policy", async () => {
    const tools = toOpenAITools(await makeSandbox());
    const remove = find(tools, "sbox_fs_remove");
    const read = find(tools, "sbox_fs_read");
    expect(await remove.needsApproval({}, { path: "/x" })).toBe(true); // destructive
    expect(await read.needsApproval({}, { path: "/x" })).toBe(false); // safe
  });

  it("invokes through the tool (fs round-trip)", async () => {
    const tools = toOpenAITools(await makeSandbox());
    const write = find(tools, "sbox_fs_write");
    const read = find(tools, "sbox_fs_read");
    await write.invoke(
      {},
      JSON.stringify({ content: "openai", path: "/tmp/o.txt" })
    );
    const out = await read.invoke({}, JSON.stringify({ path: "/tmp/o.txt" }));
    expect(out).toBe("openai");
  });
});

describe("ai({ framework: openaiAgents() }) plugin", () => {
  it("shapes sandbox.tools as a tool array", async () => {
    const client = createSandboxClient({
      plugins: [ai({ framework: openaiAgents() })],
      provider: memory(),
    });
    const sandbox = await client.create();
    expect(Array.isArray(sandbox.tools)).toBe(true);
    expect(sandbox.tools.map((t) => t.name)).toContain("sbox_exec");
  });
});
