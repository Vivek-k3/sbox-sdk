import { describe, expect, it, vi } from "vitest";

import { createSandboxClient } from "../index.js";
import { CODESANDBOX_CAPS, codesandbox } from "./index.js";

describe("codesandbox adapter (offline)", () => {
  const p = codesandbox({ apiKey: "k" });

  it("declares its capabilities", () => {
    expect(p.name).toBe("codesandbox");
    expect(p.capabilities).toBe(CODESANDBOX_CAPS);
    expect(p.capabilities.pause).toBe("native"); // hibernate/resume
    expect(p.capabilities.setTimeout).toBe("native"); // hibernation timeout
    expect(p.capabilities.privatePreview).toBe("native"); // preview tokens
    expect(p.capabilities.codeInterpreter).toBe("unsupported");
    expect(p.flags.perCommandEnvCwd).toBe(true); // commands.run takes cwd/env
    expect(p.flags.preservesMemoryOnPause).toBe(true); // hibernate snapshots memory
  });
});

// End-to-end through the real core, with the SDK module mocked. Exercises the
// custom exec path: commands.run THROWS a CommandError on non-zero exit, which
// the adapter must turn into a normal exit event (never a throw), plus the
// native fs round-trip and a port preview URL.
const files = new Map<string, Uint8Array>();

class FakeClient {
  commands = {
    run: (cmd: string) => {
      if (cmd.includes("fail")) {
        // shape of @codesandbox/sdk CommandError
        return Promise.reject(
          Object.assign(new Error("command failed"), {
            exitCode: 3,
            output: "boom",
          })
        );
      }
      return Promise.resolve("hi\n");
    },
  };
  fs = {
    readFile: (path: string) => {
      const b = files.get(path);
      if (!b) {
        return Promise.reject(new Error("ENOENT"));
      }
      return Promise.resolve(b);
    },
    writeFile: (path: string, data: Uint8Array) => {
      files.set(path, data);
      return Promise.resolve();
    },
    readdir: () => Promise.resolve([]),
    stat: () => Promise.resolve({ type: "file", size: 0 }),
    rename: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  };
  hosts = { getUrl: (port: number) => `https://sb-${port}.csb.app` };
}

class FakeSandbox {
  id = "csb-1";
  connect() {
    return Promise.resolve(new FakeClient());
  }
  updateHibernationTimeout() {
    return Promise.resolve();
  }
}

vi.mock("@codesandbox/sdk", () => ({
  CodeSandbox: class {
    sandboxes = {
      create: () => Promise.resolve(new FakeSandbox()),
      resume: () => Promise.resolve(new FakeSandbox()),
      hibernate: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
      list: () => Promise.resolve({ sandboxes: [] }),
    };
  },
}));

describe("codesandbox adapter (e2e via mocked SDK)", () => {
  it("runs commands (incl. non-zero), round-trips a file, exposes a port", async () => {
    const client = createSandboxClient({ provider: codesandbox({ apiKey: "k" }) });
    const sandbox = await client.create();
    expect(sandbox.id).toBe("csb-1");

    const ok = await sandbox.commands.run("echo hi");
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toBe("hi\n");

    // A non-zero exit must surface as an ExecResult, NOT a thrown error.
    const bad = await sandbox.commands.run("please fail");
    expect(bad.exitCode).toBe(3);
    expect(bad.stderr).toContain("boom");

    await sandbox.files.write("/project/x.txt", "payload");
    const f = await sandbox.files.read("/project/x.txt");
    expect(await f.text()).toBe("payload");

    const preview = await sandbox.ports?.expose(3000);
    expect(preview?.url).toBe("https://sb-3000.csb.app");
  });
});
