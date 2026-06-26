import { describe, expect, it } from "vitest";

import { createSandboxClient } from "../internal/client.js";
import type { SandboxPlugin } from "../internal/plugin.js";
import type { Sandbox } from "../internal/types.js";
import { memory } from "../memory/index.js";
import { createSandboxTools, decide } from "./index.js";
import type { ToolSpec } from "./index.js";

async function makeSandbox(): Promise<Sandbox> {
  const client = createSandboxClient({ provider: memory() });
  return client.create();
}

describe("createSandboxTools — capability gating", () => {
  it("includes universal tools and gated tools the provider supports", async () => {
    const sandbox = await makeSandbox();
    const names = createSandboxTools(sandbox)
      .map((t) => t.name)
      .toSorted();
    // memory(): codeInterpreter + egressControl unsupported -> those tools absent;
    // exposePort (emulated) + snapshot (native) -> present.
    expect(names).toEqual(
      [
        "sbox_exec",
        "sbox_expose_port",
        "sbox_fs_list",
        "sbox_fs_read",
        "sbox_fs_remove",
        "sbox_fs_write",
        "sbox_lifecycle",
        "sbox_snapshot",
      ].toSorted()
    );
    expect(names).not.toContain("sbox_run_code");
    expect(names).not.toContain("sbox_set_egress");
  });

  it("honors `only` and `forbid`", async () => {
    const sandbox = await makeSandbox();
    expect(
      createSandboxTools(sandbox, { only: ["sbox_exec"] }).map((t) => t.name)
    ).toEqual(["sbox_exec"]);
    const forbidden = createSandboxTools(sandbox, {
      policy: { forbid: ["sbox_fs_remove"] },
    });
    expect(forbidden.find((t) => t.name === "sbox_fs_remove")).toBeUndefined();
  });
});

describe("tool execution against the in-memory provider", () => {
  it("round-trips a file through fs_write + fs_read", async () => {
    const sandbox = await makeSandbox();
    const tools = createSandboxTools(sandbox);
    const write = tools.find((t) => t.name === "sbox_fs_write")!;
    const read = tools.find((t) => t.name === "sbox_fs_read")!;

    const w = await write.execute(
      { content: "hello sbox", path: "/tmp/hi.txt" },
      { sandbox }
    );
    expect(w.ok).toBe(true);

    const r = await read.execute({ path: "/tmp/hi.txt" }, { sandbox });
    expect(r.ok).toBe(true);
    expect(r.text).toBe("hello sbox");
  });

  it("returns a tool-level error (never throws) on bad input", async () => {
    const sandbox = await makeSandbox();
    const read = createSandboxTools(sandbox).find(
      (t) => t.name === "sbox_fs_read"
    )!;
    const r = await read.execute({ notPath: 1 }, { sandbox });
    expect(r.ok).toBe(false);
    expect(r.isError).toBe(true);
  });
});

describe("policy decisions", () => {
  it("asks for destructive, allows safe, by default", async () => {
    const sandbox = await makeSandbox();
    const tools = createSandboxTools(sandbox);
    const remove = tools.find((t) => t.name === "sbox_fs_remove")!;
    const read = tools.find((t) => t.name === "sbox_fs_read")!;
    expect(decide(remove, { path: "/x" }, { sandbox })).toBe("ask");
    expect(decide(read, { path: "/x" }, { sandbox })).toBe("allow");
  });

  it("refines risk per verb for multi-verb tools", async () => {
    const sandbox = await makeSandbox();
    const lifecycle = createSandboxTools(sandbox).find(
      (t) => t.name === "sbox_lifecycle"
    )!;
    expect(decide(lifecycle, { action: "destroy" }, { sandbox })).toBe("ask");
    expect(decide(lifecycle, { action: "getInfo" }, { sandbox })).toBe("allow");
  });
});

describe("plugin system", () => {
  const toolsPlugin: SandboxPlugin<{ tools: ToolSpec[] }> = {
    extend: (sandbox) => ({ tools: createSandboxTools(sandbox) }),
    kind: "ai-provider",
    name: "test:tools",
  };

  it("an ai-provider plugin shapes `sandbox.tools`", async () => {
    const client = createSandboxClient({
      plugins: [toolsPlugin],
      provider: memory(),
    });
    const sandbox = await client.create();
    // typed: sandbox.tools is ToolSpec[] via plugin inference
    expect(Array.isArray(sandbox.tools)).toBe(true);
    expect(sandbox.tools.length).toBe(8);
  });

  it("throws on a second ai-provider plugin", () => {
    const second: SandboxPlugin = { kind: "ai-provider", name: "test:second" };
    expect(() =>
      createSandboxClient({
        plugins: [toolsPlugin, second],
        provider: memory(),
      })
    ).toThrow(/one AI-provider/i);
  });

  it("runs onCreate and onDestroy lifecycle hooks", async () => {
    let created = false;
    let destroyed = false;
    const lc: SandboxPlugin = {
      name: "test:lifecycle",
      onCreate: () => {
        created = true;
      },
      onDestroy: () => {
        destroyed = true;
      },
    };
    const client = createSandboxClient({ plugins: [lc], provider: memory() });
    const sandbox = await client.create();
    expect(created).toBe(true);
    expect(destroyed).toBe(false);
    await sandbox.destroy();
    expect(destroyed).toBe(true);
  });
});
