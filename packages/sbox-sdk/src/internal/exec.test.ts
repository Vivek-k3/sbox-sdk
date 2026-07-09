import { describe, expect, it } from "vitest";

import { createExecHandle } from "./exec.js";
import type { DriverExec, OutputEvent } from "./types.js";

function scriptedExec(events: OutputEvent[]): DriverExec {
  return {
    async kill() {},
    pid: Promise.resolve("1"),
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe("createExecHandle", () => {
  it("includes durationMs on the awaited ExecResult", async () => {
    const handle = createExecHandle(
      scriptedExec([
        { data: "hi\n", type: "stdout" },
        { exitCode: 0, type: "exit" },
      ])
    );

    const result = await handle;
    expect(result.stdout).toBe("hi\n");
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.durationMs).toBe("number");
  });

  it("passes the same durationMs to onComplete", async () => {
    let completed:
      | { durationMs: number; exitCode?: number; ok: boolean }
      | undefined;
    const handle = createExecHandle(
      scriptedExec([
        { data: "ok\n", type: "stdout" },
        { exitCode: 0, type: "exit" },
      ]),
      {
        onComplete: (outcome) => {
          completed = outcome;
        },
      }
    );

    const result = await handle;
    expect(completed).toBeDefined();
    expect(completed?.ok).toBe(true);
    expect(completed?.exitCode).toBe(0);
    expect(completed?.durationMs).toBe(result.durationMs);
  });
});
