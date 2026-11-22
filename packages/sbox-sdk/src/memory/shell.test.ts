import { describe, expect, it } from "vitest";

import { MiniShell } from "./shell.js";
import type { ShellFs, ShellIo } from "./shell.js";

const dirs = new Set(["/", "/tmp", "/tmp/a"]);
const fs: ShellFs = {
  isDir: (p) => dirs.has(p),
  list: () => [],
  mkdir: () => null,
  read: () => null,
  remove: () => null,
  rename: () => null,
  stat: () => null,
  write: () => {},
};

function io(): ShellIo & { out: string[] } {
  const out: string[] = [];
  const dec = new TextDecoder();
  return {
    cwd: "/",
    env: {},
    out,
    signal: new AbortController().signal,
    stderr: () => {},
    stdin: new Uint8Array(),
    stdout: (d) => out.push(dec.decode(d)),
  };
}

describe("MiniShell cwd", () => {
  it("cd persists across a command list", async () => {
    const i = io();
    await new MiniShell(fs).run("cd /tmp && cd a; pwd", i);
    expect(i.out.join("")).toBe("/tmp/a\n");
  });

  it("cd persists across run() calls on the same io (PTY lines)", async () => {
    const sh = new MiniShell(fs);
    const i = io();
    await sh.run("cd /tmp", i);
    await sh.run("pwd", i);
    expect(i.out.join("")).toBe("/tmp\n");
  });

  it("sh -c runs in a subshell: cd does not leak out", async () => {
    const i = io();
    await new MiniShell(fs).run("sh -c 'cd /tmp'; pwd", i);
    expect(i.out.join("")).toBe("/\n");
  });

  it("a failing cd short-circuits &&", async () => {
    const i = io();
    const code = await new MiniShell(fs).run("cd /nope && echo ran", i);
    expect(code).toBe(1);
    expect(i.out.join("")).toBe("");
  });
});
