/**
 * Offline tests for tail-exec: a real `/bin/sh` transport for script correctness,
 * plus a scripted fake transport for failure paths.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { CapabilityLevel } from "./capabilities.js";
import { bytesToBase64 } from "./encoding.js";
import { SandboxError } from "./errors.js";
import { createExecHandle } from "./exec.js";
import { AsyncQueue } from "./stream.js";
import {
  buildTailPoll,
  createTailExec,
  resolveStreaming,
  shouldTailStream,
  TAIL_FAIL,
  TAIL_OK,
} from "./tail-exec.js";
import type { TailExecConfig, TailProbeState } from "./tail-exec.js";
import type { DriverExec, ExecOptions, OutputEvent } from "./types.js";

const enc = new TextEncoder();
const b64 = (s: string): string => bytesToBase64(enc.encode(s));

interface ExecLogEntry {
  cmd: string;
  opts: ExecOptions;
}

/** Which phase a generated command belongs to (the scripts are ours, so this is exact). */
function classify(cmd: string): string {
  if (cmd.includes("printf O:")) {
    return "poll";
  }
  if (cmd.includes("nohup")) {
    return "launch";
  }
  if (cmd.includes("/.probe")) {
    return "probe";
  }
  if (cmd.includes("kill -s")) {
    return "kill";
  }
  if (cmd.includes("rm -rf")) {
    return "cleanup";
  }
  return "other";
}

function fromEvents(events: OutputEvent[]): DriverExec {
  const q = new AsyncQueue<OutputEvent>();
  for (const ev of events) {
    q.push(ev);
  }
  q.close();
  return {
    kill: () => Promise.resolve(),
    pid: Promise.resolve(""),
    [Symbol.asyncIterator]: () => q.iterator(),
  };
}

/** A fire-once DriverExec, exactly like the providers this feature targets. */
function canned(stdout: string, exitCode = 0, stderr = ""): DriverExec {
  const events: OutputEvent[] = [];
  if (stdout) {
    events.push({ data: stdout, type: "stdout" });
  }
  if (stderr) {
    events.push({ data: stderr, type: "stderr" });
  }
  events.push({ exitCode, type: "exit" });
  return fromEvents(events);
}

function thrower(reason: unknown): DriverExec {
  const q = new AsyncQueue<OutputEvent>();
  q.fail(reason);
  return {
    kill: () => Promise.resolve(),
    pid: Promise.resolve(""),
    [Symbol.asyncIterator]: () => q.iterator(),
  };
}

/** Shape a poll response the way the poll script prints it. */
function pollResp(
  out: string,
  err: string,
  state: string,
  pid = "4242"
): string {
  return `O:${b64(out)}\nE:${b64(err)}\nP:${pid}\nR:${state}\n`;
}

async function drain(source: DriverExec): Promise<OutputEvent[]> {
  const events: OutputEvent[] = [];
  for await (const ev of source) {
    events.push(ev);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Fixture 1 — real /bin/sh
// ---------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "sbox-tail-"));
afterAll(() => rmSync(scratch, { force: true, recursive: true }));

function realShExec(log: ExecLogEntry[]) {
  return (cmd: string, opts: ExecOptions): DriverExec => {
    log.push({ cmd, opts });
    const q = new AsyncQueue<OutputEvent>();
    execFile(
      "/bin/sh",
      ["-c", cmd],
      { maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (stdout) {
          q.push({ data: stdout, type: "stdout" });
        }
        if (stderr) {
          q.push({ data: stderr, type: "stderr" });
        }
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : 0;
        q.push({ exitCode: code, type: "exit" });
        q.close();
      }
    );
    return {
      kill: () => Promise.resolve(),
      pid: Promise.resolve(""),
      [Symbol.asyncIterator]: () => q.iterator(),
    };
  };
}

function realTail(
  command: string,
  overrides: Partial<TailExecConfig> = {}
): { source: DriverExec; log: ExecLogEntry[] } {
  const log: ExecLogEntry[] = [];
  const transportExec = realShExec(log);
  const source = createTailExec({
    command,
    fallbackExec: () => {
      log.push({ cmd: `FALLBACK:${command}`, opts: {} });
      return transportExec(command, {});
    },
    maxPollMs: 60,
    minPollMs: 20,
    opts: {},
    probeState: {},
    tmpDir: scratch,
    transportExec,
    ...overrides,
  });
  return { log, source };
}

describe("tail-exec over a real /bin/sh", () => {
  it("streams output incrementally rather than all at once", async () => {
    const { source } = realTail("echo one; sleep 0.5; echo two");
    const stamps: { at: number; ev: OutputEvent }[] = [];
    const t0 = Date.now();
    for await (const ev of source) {
      stamps.push({ at: Date.now() - t0, ev });
    }

    const firstOne = stamps.find(
      (s) => s.ev.type === "stdout" && s.ev.data.includes("one")
    );
    const firstTwo = stamps.find(
      (s) => s.ev.type === "stdout" && s.ev.data.includes("two")
    );
    const exit = stamps.find((s) => s.ev.type === "exit");

    expect(firstOne).toBeDefined();
    expect(firstTwo).toBeDefined();
    expect(exit).toBeDefined();
    expect(firstOne!.at).toBeLessThan(firstTwo!.at);
    expect(exit!.at - firstOne!.at).toBeGreaterThan(300);
  }, 20_000);

  it("separates stdout from stderr and synthesizes the exit code", async () => {
    const { source } = realTail("echo out; echo err >&2; exit 7");
    const result = await createExecHandle(source);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
    expect(result.exitCode).toBe(7);
    expect(result.exitCodeSynthesized).toBe(true);
  }, 20_000);

  it("reports exit 0 and non-zero exits as data, never throwing", async () => {
    expect((await createExecHandle(realTail("true").source)).exitCode).toBe(0);
    expect((await createExecHandle(realTail("false").source)).exitCode).toBe(1);
  }, 20_000);

  it("records the status of a command that calls `exit` explicitly", async () => {
    const result = await createExecHandle(realTail("echo bye; exit 3").source);
    expect(result.stdout.trim()).toBe("bye");
    expect(result.exitCode).toBe(3);
  }, 20_000);

  it("reports shell syntax errors as command results", async () => {
    const result = await createExecHandle(
      realTail("echo 'unterminated").source
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toBe("");
    expect(result.exitCodeSynthesized).toBe(true);
  }, 20_000);

  it("survives quoting torture in the user command", async () => {
    const cmd = `echo "it's \\$HOME \\\`x\\\` fine" # trailing\necho second`;
    const result = await createExecHandle(realTail(cmd).source);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("it's $HOME `x` fine");
    expect(result.stdout).toContain("second");
  }, 20_000);

  it("bakes cwd/env into the command and sends neither to the transport", async () => {
    const { log, source } = realTail("pwd; echo $SBOX_X", {
      opts: { cwd: scratch, env: { SBOX_X: "hello" } },
    });
    const result = await createExecHandle(source);
    expect(result.stdout).toContain(scratch);
    expect(result.stdout).toContain("hello");

    expect(log.length).toBeGreaterThan(1);
    for (const entry of log) {
      expect(entry.opts.cwd).toBeUndefined();
      expect(entry.opts.env).toBeUndefined();
    }
  }, 20_000);

  it("drains output larger than maxChunkBytes across polls", async () => {
    const n = 50_000;
    const { source } = realTail(`yes a | head -c ${n}`, {
      maxChunkBytes: 4096,
    });
    const result = await createExecHandle(source);
    expect(result.stdout.length).toBe(n);
    expect(result.exitCode).toBe(0);
  }, 30_000);

  it("decodes multibyte UTF-8 split across poll boundaries", async () => {
    // maxChunkBytes:3 guarantees a 3-byte "€" straddles a poll boundary.
    const { source } = realTail("printf '€€€€'", { maxChunkBytes: 3 });
    const result = await createExecHandle(source);
    expect(result.stdout).toBe("€€€€");
  }, 30_000);

  it("passes NUL bytes through the stream", async () => {
    const { source } = realTail(`printf 'a\\000b'`);
    const result = await createExecHandle(source);
    const NUL = String.fromCodePoint(0);
    expect(result.stdout).toBe(`a${NUL}b`);
  }, 20_000);

  it("kill() terminates the command and reports the signal", async () => {
    const { log, source } = realTail("sleep 30");
    setTimeout(() => void source.kill("SIGTERM"), 600);
    const events = await drain(source);
    const exit = events.find((e) => e.type === "exit");
    expect(exit).toMatchObject({ signal: "TERM", type: "exit" });
    expect((exit as { exitCode: number }).exitCode).toBe(143);
    expect(log.some((e) => classify(e.cmd) === "kill")).toBe(true);
  }, 30_000);

  it("removes its run directory when the command finishes", async () => {
    const { log, source } = realTail("echo done");
    await createExecHandle(source);
    // cleanup is fire-and-forget; give the sidecar exec a tick to be issued.
    await new Promise((r) => setTimeout(r, 50));
    expect(log.some((e) => classify(e.cmd) === "cleanup")).toBe(true);
  }, 20_000);

  it("exposes the real in-sandbox pid", async () => {
    const { source } = realTail("sleep 0.3");
    const pid = await source.pid;
    expect(Number(pid)).toBeGreaterThan(0);
    await createExecHandle(source);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Fixture 2 — scripted transport
// ---------------------------------------------------------------------------

interface ScriptedOpts {
  probe?: () => DriverExec;
  launch?: () => DriverExec;
  poll?: (n: number) => DriverExec;
  strict?: boolean;
  opts?: ExecOptions;
  bootTimeoutMs?: number;
}

function scripted(o: ScriptedOpts = {}) {
  const log: ExecLogEntry[] = [];
  let polls = 0;
  const transportExec = (cmd: string, opts: ExecOptions): DriverExec => {
    log.push({ cmd, opts });
    switch (classify(cmd)) {
      case "probe":
        return (o.probe ?? (() => canned(TAIL_OK)))();
      case "launch":
        return (o.launch ?? (() => canned(TAIL_OK)))();
      case "poll": {
        polls += 1;
        return (o.poll ?? (() => canned(pollResp("", "", "0"))))(polls);
      }
      default:
        return canned("");
    }
  };
  const source = createTailExec({
    bootTimeoutMs: o.bootTimeoutMs ?? 5000,
    command: "USER_CMD",
    fallbackExec: () => {
      log.push({ cmd: "FALLBACK:USER_CMD", opts: {} });
      return canned("fell-back", 0);
    },
    minPollMs: 1,
    maxPollMs: 2,
    opts: o.opts ?? {},
    probeState: {},
    strict: o.strict,
    tmpDir: "/tmp/.sbox",
    transportExec,
  });
  return { log, source };
}

const ranUserCmd = (log: ExecLogEntry[]): number =>
  log.filter((e) => e.cmd.startsWith("FALLBACK:")).length;

describe("tail-exec fallback and failure taxonomy", () => {
  it("falls back to plain exec when the probe fails, running the command exactly once", async () => {
    const { log, source } = scripted({ probe: () => canned(TAIL_FAIL) });
    const result = await createExecHandle(source);
    expect(result.stdout).toBe("fell-back");
    expect(ranUserCmd(log)).toBe(1);
    expect(log.some((e) => classify(e.cmd) === "launch")).toBe(false);
  });

  it("falls back when the probe exec throws", async () => {
    const { log, source } = scripted({
      probe: () => thrower(new Error("transport down")),
    });
    expect((await createExecHandle(source)).stdout).toBe("fell-back");
    expect(ranUserCmd(log)).toBe(1);
  });

  it("falls back on a pre-spawn launch failure, before the command could start", async () => {
    const { log, source } = scripted({ launch: () => canned(TAIL_FAIL) });
    expect((await createExecHandle(source)).stdout).toBe("fell-back");
    expect(ranUserCmd(log)).toBe(1);
    expect(log.some((e) => classify(e.cmd) === "poll")).toBe(false);
  });

  it("NEVER re-runs the command when the launch exec throws", async () => {
    const { log, source } = scripted({
      launch: () => thrower(new Error("socket reset")),
    });
    await expect(createExecHandle(source)).rejects.toThrow(/unknown state/);
    expect(ranUserCmd(log)).toBe(0);
  });

  it("NEVER re-runs the command when the launch sentinel is missing", async () => {
    const { log, source } = scripted({ launch: () => canned("garbage") });
    await expect(createExecHandle(source)).rejects.toThrow(/no sentinel/);
    expect(ranUserCmd(log)).toBe(0);
  });

  it("errors after repeated poll failures instead of falling back", async () => {
    const { log, source } = scripted({
      poll: () => thrower(new Error("poll boom")),
    });
    await expect(createExecHandle(source)).rejects.toThrow(/poll boom/);
    expect(ranUserCmd(log)).toBe(0);
    expect(log.filter((e) => classify(e.cmd) === "poll")).toHaveLength(3);
  });

  it("errors when the wrapper vanishes without writing an exit status", async () => {
    const { source } = scripted({
      poll: () => canned(pollResp("", "", "gone")),
    });
    await expect(createExecHandle(source)).rejects.toThrow(
      /without an exit status/
    );
  });

  it("waits through the boot window instead of failing on a not-yet-written pid", async () => {
    const { source } = scripted({
      poll: (n) => {
        if (n <= 2) {
          return canned(pollResp("", "", "boot", "0"));
        }
        if (n === 3) {
          return canned(pollResp("up", "", "run"));
        }
        return canned(pollResp("", "", "0"));
      },
    });
    const result = await createExecHandle(source);
    expect(result.stdout).toBe("up");
    expect(result.exitCode).toBe(0);
  });

  it("gives up if the wrapper never leaves the boot state", async () => {
    const { source } = scripted({
      bootTimeoutMs: 30,
      poll: () => canned(pollResp("", "", "boot", "0")),
    });
    await expect(createExecHandle(source)).rejects.toThrow(/failed to start/);
  }, 20_000);

  it("treats an unparseable poll response as a failure, not an infinite loop", async () => {
    const { source } = scripted({
      poll: () => canned("this is not a valid poll response"),
    });
    await expect(createExecHandle(source)).rejects.toThrow(/unparseable/);
  }, 20_000);

  it("emits pending output before the exit event", async () => {
    const { source } = scripted({
      poll: (n) => {
        if (n === 1) {
          return canned(pollResp("hello ", "warn", "run"));
        }
        if (n === 2) {
          return canned(pollResp("world", "", "0"));
        }
        return canned(pollResp("", "", "0"));
      },
    });
    const result = await createExecHandle(source);
    expect(result.stdout).toBe("hello world");
    expect(result.stderr).toBe("warn");
    expect(result.exitCode).toBe(0);
    expect(result.exitCodeSynthesized).toBe(true);
  });

  it("in strict mode, throws instead of falling back", async () => {
    const { log, source } = scripted({
      probe: () => canned(TAIL_FAIL),
      strict: true,
    });
    await expect(createExecHandle(source)).rejects.toThrow(
      /streaming mode "tail"/
    );
    expect(ranUserCmd(log)).toBe(0);
  });

  it("enforces timeoutMs itself, killing and reporting a Timeout", async () => {
    let killed = false;
    const log: ExecLogEntry[] = [];
    const transportExec = (cmd: string, opts: ExecOptions): DriverExec => {
      log.push({ cmd, opts });
      switch (classify(cmd)) {
        case "probe":
        case "launch":
          return canned(TAIL_OK);
        case "kill":
          killed = true;
          return canned("");
        case "poll":
          return canned(pollResp("", "", killed ? "gone" : "run"));
        default:
          return canned("");
      }
    };
    const source = createTailExec({
      command: "sleep 100",
      fallbackExec: () => canned("fell-back"),
      maxPollMs: 2,
      minPollMs: 1,
      opts: { timeoutMs: 30 },
      probeState: {},
      tmpDir: "/tmp/.sbox",
      transportExec,
    });

    const err = await createExecHandle(source).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe("Timeout");
    expect((err as SandboxError).timedOut).toBe(true);
    expect(killed).toBe(true);
  }, 20_000);

  it("aborts promptly, killing the command and cleaning up", async () => {
    const ac = new AbortController();
    const { log, source } = scripted({
      opts: { signal: ac.signal },
      poll: () => canned(pollResp("", "", "run")),
    });
    setTimeout(() => ac.abort(), 20);
    const err = await createExecHandle(source).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).aborted).toBe(true);
    expect(log.some((e) => classify(e.cmd) === "kill")).toBe(true);
    expect(log.some((e) => classify(e.cmd) === "cleanup")).toBe(true);
  }, 20_000);

  it("probes once per sandbox, not once per command", async () => {
    const log: ExecLogEntry[] = [];
    const probeState: TailProbeState = {};
    let polls = 0;
    const transportExec = (cmd: string, opts: ExecOptions): DriverExec => {
      log.push({ cmd, opts });
      if (classify(cmd) !== "poll") {
        return canned(TAIL_OK);
      }
      polls += 1;
      // First poll delivers the bytes; the next reports the drain is complete.
      return canned(
        polls % 2 === 1 ? pollResp("x", "", "0") : pollResp("", "", "0")
      );
    };
    const mk = () =>
      createTailExec({
        command: "echo x",
        fallbackExec: () => canned(""),
        maxPollMs: 2,
        minPollMs: 1,
        opts: {},
        probeState,
        tmpDir: "/tmp/.sbox",
        transportExec,
      });

    await createExecHandle(mk());
    await createExecHandle(mk());
    expect(log.filter((e) => classify(e.cmd) === "probe")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Templates + selection
// ---------------------------------------------------------------------------

describe("tail-exec templates", () => {
  it("converts consumed byte offsets to 1-based tail offsets", () => {
    const script = buildTailPoll("/tmp/.sbox/run", 0, 12, 4096);
    expect(script).toContain("tail -c +1 ");
    expect(script).toContain("tail -c +13 ");
    expect(script).toContain("head -c 4096");
  });

  it("snapshots rc before draining, so a late exit cannot hide output", () => {
    const script = buildTailPoll("/tmp/.sbox/run", 0, 0, 8);
    expect(script.indexOf('if [ -f "$d/rc" ]')).toBeLessThan(
      script.indexOf("printf O:")
    );
  });
});

describe("tail-exec selection", () => {
  const base = {
    exitCodeNative: true,
    opts: {} as ExecOptions,
    streamingCapability: "emulated" as CapabilityLevel,
  };

  it("engages for emulated providers in auto and tail modes", () => {
    expect(shouldTailStream({ ...base, mode: "auto" })).toBe(true);
    expect(shouldTailStream({ ...base, mode: "tail" })).toBe(true);
  });

  it("never engages for native or unsupported providers", () => {
    for (const streamingCapability of [
      "native",
      "unsupported",
    ] as CapabilityLevel[]) {
      expect(
        shouldTailStream({ ...base, mode: "auto", streamingCapability })
      ).toBe(false);
    }
  });

  it("respects the off mode and the per-call opt-out", () => {
    expect(shouldTailStream({ ...base, mode: "off" })).toBe(false);
    expect(
      shouldTailStream({ ...base, mode: "auto", opts: { stream: false } })
    ).toBe(false);
  });

  it("bypasses the tail path when stdin is supplied", () => {
    expect(
      shouldTailStream({ ...base, mode: "auto", opts: { stdin: "data" } })
    ).toBe(false);
  });

  it("skips providers whose exit codes are not transport-native", () => {
    expect(
      shouldTailStream({ ...base, exitCodeNative: false, mode: "auto" })
    ).toBe(false);
  });

  it("fills in the default streaming mode", () => {
    expect(resolveStreaming(undefined).mode).toBe("auto");
    expect(resolveStreaming({ mode: "tail" }).mode).toBe("tail");
    expect(resolveStreaming({ mode: "off" }).mode).toBe("off");
    expect(resolveStreaming({ minPollMs: 5 })).toEqual({
      minPollMs: 5,
      mode: "auto",
    });
  });

  it("rejects invalid polling options before building shell snippets", () => {
    expect(() => resolveStreaming({ maxChunkBytes: 0 })).toThrow(
      /maxChunkBytes/
    );
    expect(() => resolveStreaming({ maxPollMs: 10, minPollMs: 20 })).toThrow(
      /minPollMs/
    );
    expect(() =>
      createTailExec({
        command: "echo x",
        fallbackExec: () => canned(""),
        maxChunkBytes: Number.POSITIVE_INFINITY,
        opts: {},
        probeState: {},
        transportExec: () => canned(""),
      })
    ).toThrow(/maxChunkBytes/);
  });
});
