import { describe, expect, it } from "vitest";

import { ai } from "../ai/index.js";
import { createSandboxClient } from "../internal/client.js";
import type { Sandbox } from "../internal/types.js";
import { memory } from "../memory/index.js";
import { aiSdk, toAISDKTools, toolApproval } from "./index.js";

// Minimal ToolCallOptions the AI SDK passes to execute().
const callOpts = { messages: [], toolCallId: "t1" } as never;

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

describe("toAISDKTools", () => {
  it("returns a tool map keyed by tool name, capability-gated", async () => {
    const tools = toAISDKTools(await makeSandbox());
    expect(Object.keys(tools).toSorted()).toEqual([...EXPECTED].toSorted());
    expect(typeof tools.sbox_exec!.execute).toBe("function");
    expect(tools.sbox_run_code).toBeUndefined();
  });

  it("executes through the AI SDK wrapper (fs round-trip)", async () => {
    const tools = toAISDKTools(await makeSandbox());
    await tools.sbox_fs_write!.execute!(
      { content: "hey", path: "/tmp/x.txt" },
      callOpts
    );
    const out = await tools.sbox_fs_read!.execute!(
      { path: "/tmp/x.txt" },
      callOpts
    );
    expect(out).toBe("hey");
  });

  it("denies a destructive call when onApprovalRequest returns false", async () => {
    const tools = toAISDKTools(await makeSandbox(), {
      policy: { onApprovalRequest: async () => false },
    });
    const res = await tools.sbox_fs_remove!.execute!(
      { path: "/tmp/x.txt" },
      callOpts
    );
    expect(String(res)).toMatch(/Approval denied/i);
  });

  it("allows a destructive call when onApprovalRequest returns true", async () => {
    const sandbox = await makeSandbox();
    const tools = toAISDKTools(sandbox, {
      policy: { onApprovalRequest: async () => true },
    });
    await tools.sbox_fs_write!.execute!(
      { content: "z", path: "/tmp/y.txt" },
      callOpts
    );
    const res = await tools.sbox_fs_remove!.execute!(
      { path: "/tmp/y.txt" },
      callOpts
    );
    expect(String(res)).toMatch(/Removed/i);
  });

  it("honors policy.forbid", async () => {
    const tools = toAISDKTools(await makeSandbox(), {
      policy: { forbid: ["sbox_fs_remove"] },
    });
    expect(tools.sbox_fs_remove).toBeUndefined();
  });
});

describe("ai({ framework: aiSdk() }) plugin", () => {
  it("shapes sandbox.tools as the AI SDK map", async () => {
    const client = createSandboxClient({
      plugins: [ai({ framework: aiSdk() })],
      provider: memory(),
    });
    const sandbox = await client.create();
    expect(Object.keys(sandbox.tools)).toContain("sbox_fs_read");
    expect(typeof sandbox.tools.sbox_exec!.execute).toBe("function");
  });
});

describe("toolApproval (AI SDK v7 forward-compat)", () => {
  it("maps ask-tools to 'user-approval' and others to undefined", async () => {
    const sandbox = await makeSandbox();
    const map = toolApproval(sandbox);
    expect(await map.sbox_fs_remove!({ path: "/x" })).toBe("user-approval"); // destructive -> ask
    expect(await map.sbox_fs_read!({ path: "/x" })).toBeUndefined(); // safe -> allow
  });
});
