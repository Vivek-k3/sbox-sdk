import { describe, expect, it } from "vitest";

import { createSandboxClient } from "../index.js";
import { FLY_CAPS, fly } from "./index.js";

describe("fly adapter (offline)", () => {
  const p = fly({ apiToken: "t", appName: "app" });

  it("declares its capabilities", () => {
    expect(p.name).toBe("fly");
    expect(p.capabilities).toBe(FLY_CAPS);
    expect(p.flags.perCommandEnvCwd).toBe(false); // /exec has no per-call cwd/env
    expect(p.flags.preservesDiskOnStop).toBe(false); // rootfs resets on stop
  });
});

// End-to-end through the real core, using an injected fetch (no network).
function json(obj: unknown, status = 200): Response {
  return Response.json(obj, {
    status,
    headers: { "content-type": "application/json" },
  });
}
function fakeFly(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const path = url.pathname;
    const method = init?.method ?? "GET";
    if (method === "POST" && path.endsWith("/machines")) {
      return json({ id: "m-1", state: "created" });
    }
    if (path.includes("/wait")) {
      return json({ ok: true });
    }
    if (path.endsWith("/exec")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        command: string[];
      };
      const cmd = body.command[2] ?? "";
      if (cmd.startsWith("base64 ")) {
        return json({ stdout: btoa("file-bytes"), stderr: "", exit_code: 0 });
      }
      if (cmd.includes("base64 -d")) {
        return json({ stdout: "", stderr: "", exit_code: 0 });
      }
      return json({ stdout: "ran\n", stderr: "", exit_code: 0 });
    }
    return json({ error: "unexpected" }, 404);
  }) as typeof fetch;
}

describe("fly adapter (e2e via injected fetch)", () => {
  it("creates, execs (buffered) and round-trips a file through the core", async () => {
    const client = createSandboxClient({
      provider: fly({ apiToken: "t", appName: "app", fetch: fakeFly() }),
    });
    const sandbox = await client.create();
    expect(sandbox.id).toBe("m-1");

    const res = await sandbox.commands.run("echo hi");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("ran\n");

    await sandbox.files.write("/tmp/x.txt", "file-bytes");
    const f = await sandbox.files.read("/tmp/x.txt");
    expect(await f.text()).toBe("file-bytes");
  });
});
