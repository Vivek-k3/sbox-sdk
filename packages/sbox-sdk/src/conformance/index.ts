import type { CapabilityMap } from "../internal/capabilities.js";
/**
 * `sbox-sdk/conformance` — one identical battery every adapter must pass, so all
 * providers behave the same. Runner-agnostic: returns a report you assert on
 * inside your own test framework (vitest, node:test, ...).
 */
import { createSandboxClient } from "../internal/client.js";
import { NotSupportedError } from "../internal/errors.js";
import type { SandboxProvider } from "../internal/types.js";

export interface ConformanceCheck {
  name: string;
  ok: boolean;
  error?: string;
}

export interface ConformanceReport {
  provider: string;
  checks: ConformanceCheck[];
  passed: boolean;
}

export interface ConformanceOptions {
  /** Assert the provider declares these exact capability levels. */
  expectedCaps?: Partial<CapabilityMap>;
  /** Skip checks by name (for genuinely-not-applicable providers). */
  skip?: string[];
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    throw new Error(msg);
  }
}

export async function runConformance(
  provider: SandboxProvider,
  options: ConformanceOptions = {}
): Promise<ConformanceReport> {
  const client = createSandboxClient({ provider });
  const checks: ConformanceCheck[] = [];
  const skip = new Set(options.skip ?? []);
  const caps = provider.capabilities;

  const check = async (
    name: string,
    fn: () => Promise<void>
  ): Promise<void> => {
    if (skip.has(name)) {
      return;
    }
    try {
      await fn();
      checks.push({ name, ok: true });
    } catch (error) {
      checks.push({
        error: error instanceof Error ? error.message : String(error),
        name,
        ok: false,
      });
    }
  };

  if (options.expectedCaps) {
    const expected = options.expectedCaps;
    await check("caps: declared levels match expected", async () => {
      for (const key of Object.keys(expected) as (keyof CapabilityMap)[]) {
        const actual = caps[key];
        assert(
          actual === expected[key],
          `cap '${key}' expected '${expected[key]}' got '${actual}'`
        );
      }
    });
  }

  const sb = await client.create({});

  await check("lifecycle: getInfo", async () => {
    const info = await sb.getInfo();
    assert(!!info.id, "info.id present");
    assert(info.provider === provider.name, "info.provider matches");
  });

  await check("exec: echo buffered", async () => {
    const r = await sb.commands.run("echo hi");
    assert(r.exitCode === 0, `exit 0 (got ${r.exitCode})`);
    assert(
      r.stdout.trim() === "hi",
      `stdout 'hi' (got ${JSON.stringify(r.stdout)})`
    );
    assert(
      typeof r.durationMs === "number" && r.durationMs >= 0,
      `durationMs >= 0 (got ${r.durationMs})`
    );
  });

  await check("exec: non-zero exit is data, not throw", async () => {
    const r = await sb.commands.run("false");
    assert(r.exitCode !== 0, `non-zero exit (got ${r.exitCode})`);
  });

  if (caps.streaming !== "unsupported") {
    await check("exec: streaming events", async () => {
      let out = "";
      let exited = false;
      for await (const ev of sb.commands.run("echo streamed")) {
        if (ev.type === "stdout") {
          out += ev.data;
        }
        if (ev.type === "exit") {
          exited = true;
        }
      }
      assert(
        out.trim() === "streamed",
        `streamed stdout (got ${JSON.stringify(out)})`
      );
      assert(exited, "saw exit event");
    });
  }

  await check("exec: cwd applied", async () => {
    const r = await sb.commands.run("pwd", { cwd: "/tmp" });
    assert(
      r.stdout.includes("/tmp"),
      `pwd in /tmp (got ${JSON.stringify(r.stdout)})`
    );
  });

  await check("exec: env applied", async () => {
    const r = await sb.commands.run("echo $SBOX_CONF", {
      env: { SBOX_CONF: "xyz" },
    });
    assert(
      r.stdout.trim() === "xyz",
      `env expand (got ${JSON.stringify(r.stdout)})`
    );
  });

  await check("files: write/read text round-trip", async () => {
    await sb.files.write("/tmp/conf.txt", "hello world");
    const f = await sb.files.read("/tmp/conf.txt");
    const text = await f.text();
    assert(
      text === "hello world",
      `text round-trip (got ${JSON.stringify(text)})`
    );
  });

  await check("files: write/read binary round-trip", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await sb.files.write("/tmp/conf.bin", bytes);
    const got = await (await sb.files.read("/tmp/conf.bin")).bytes();
    assert(got.length === bytes.length, `binary length (got ${got.length})`);
    assert(got[0] === 0 && got[4] === 255, "binary content preserved");
  });

  await check("files: list shows written file", async () => {
    await sb.files.write("/tmp/listed.txt", "x");
    const entries = await sb.files.list("/tmp");
    assert(
      entries.some((e) => e.name === "listed.txt"),
      "file listed"
    );
  });

  await check("files: mkdir/exists/remove", async () => {
    await sb.files.mkdir("/tmp/confdir", { recursive: true });
    assert(await sb.files.exists("/tmp/confdir"), "exists after mkdir");
    await sb.files.remove("/tmp/confdir", { recursive: true });
    assert(!(await sb.files.exists("/tmp/confdir")), "gone after remove");
  });

  await check("files: exists() is false (not throw) on missing", async () => {
    const e = await sb.files.exists("/tmp/definitely-missing-xyz");
    assert(e === false, "missing => false");
  });

  await check("caps: code gating matches declaration", async () => {
    if (caps.codeInterpreter === "unsupported") {
      assert(sb.code === undefined, "code undefined");
    } else {
      assert(sb.code !== undefined, "code present");
    }
  });

  await check("caps: snapshots gating matches declaration", async () => {
    if (caps.snapshot === "unsupported") {
      assert(sb.snapshots === undefined, "snapshots undefined");
    } else {
      assert(sb.snapshots !== undefined, "snapshots present");
    }
  });

  await check("caps: ports gating matches declaration", async () => {
    if (caps.exposePort === "unsupported") {
      assert(sb.ports === undefined, "ports undefined");
    } else {
      assert(sb.ports !== undefined, "ports present");
    }
  });

  await check("caps: network gating matches declaration", async () => {
    if (caps.egressControl === "unsupported") {
      assert(sb.network === undefined, "network undefined");
    } else {
      assert(sb.network !== undefined, "network present");
    }
  });

  if (caps.snapshot !== "unsupported") {
    await check("snapshots: create returns a ref", async () => {
      const snap = await sb.snapshots!.create({ name: "conf-ck" });
      assert(!!snap.id, "snapshot id");
    });
  }

  if (caps.pause !== "unsupported") {
    await check("lifecycle: pause/resume", async () => {
      await sb.pause();
      await sb.resume();
    });
  }

  await check("client: list honors capability", async () => {
    if (caps.list === "unsupported") {
      let threw = false;
      try {
        for await (const _info of client.list()) {
          break;
        }
      } catch (error) {
        threw = error instanceof NotSupportedError;
      }
      assert(threw, "list throws NotSupportedError when unsupported");
    } else {
      for await (const _info of client.list()) {
        break;
      }
    }
  });

  await check("lifecycle: destroy", async () => {
    await sb.destroy();
  });

  await check("lifecycle: create + destroy a fresh sandbox", async () => {
    const s2 = await client.create({});
    assert(!!s2.id, "fresh id");
    await s2.destroy();
  });

  await client.dispose();

  return {
    checks,
    passed: checks.every((c) => c.ok),
    provider: provider.name,
  };
}
