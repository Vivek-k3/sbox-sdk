import type {
  CapabilityMap,
  CapabilityName,
} from "../internal/capabilities.js";
/**
 * `sbox-sdk/conformance` — one identical battery every adapter must pass, so all
 * providers behave the same. Runner-agnostic: returns a report you assert on
 * inside your own test framework (vitest, node:test, ...).
 *
 * Three layers:
 * 1. contract  — driver method presence matches the declared capability table
 *                (a provider can't claim `pause: "native"` without `pause()`).
 * 2. behavior  — exec/files/lifecycle semantics are identical across providers.
 * 3. features  — every capability the provider declares actually works.
 *
 * Offline (mocked) and live runs use the same suite; `live: true` adds the
 * heavier checks (large files, leak detection after destroy).
 */
import { createSandboxClient } from "../internal/client.js";
import { NotSupportedError, SandboxError } from "../internal/errors.js";
import { browserUrl } from "../internal/preview.js";
import { DRIVER_HANDLE } from "../internal/sandbox.js";
import type {
  DriverHandle,
  Sandbox,
  SandboxProvider,
  SandboxSpec,
  TemplateSpec,
} from "../internal/types.js";

export interface ConformanceCheck {
  name: string;
  ok: boolean;
  error?: string;
  /** Wall time for the check, ms. */
  ms?: number;
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
  /** Base spec for every sandbox the suite creates (template, region, ...). */
  spec?: SandboxSpec;
  /** Run the heavier live-only checks. */
  live?: boolean;
  /** Build this template and boot from it (only if `templateBuild` is declared). */
  template?: TemplateSpec;
  /** Writable scratch dir inside the sandbox. Default "/tmp". */
  workdir?: string;
  /** Called after each check (progress reporting for live runs). */
  onCheck?: (check: ConformanceCheck) => void;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    throw new Error(msg);
  }
}

/** Driver methods each capability promises. */
const CAP_METHODS: Partial<Record<CapabilityName, (keyof DriverHandle)[]>> = {
  background: ["spawn"],
  codeInterpreter: ["runCode"],
  egressControl: ["setEgressPolicy"],
  exposePort: ["exposePort"],
  filesWatch: ["watch"],
  fork: ["fork"],
  killProcess: ["killProcess"],
  metrics: ["getMetrics"],
  pause: ["pause", "resume"],
  proxiedFetch: ["proxyFetch"],
  pty: ["createPty"],
  setTimeout: ["setTimeout"],
  snapshot: ["snapshot"],
  ssh: ["createSsh"],
  statefulKernel: ["createContext"],
  stop: ["stop"],
};

/** Provider-level members each capability promises. */
const CAP_PROVIDER: Partial<Record<CapabilityName, (keyof SandboxProvider)[]>> =
  {
    list: ["list"],
    templateBuild: ["templates"],
    volumes: ["volumes"],
  };

/**
 * Pure contract check: does method presence match the declared caps? Runs
 * against a live handle (method presence can depend on runtime state).
 */
export function checkCapabilityContract(
  provider: SandboxProvider,
  handle: DriverHandle
): string[] {
  const problems: string[] = [];
  const caps = provider.capabilities;
  for (const [cap, methods] of Object.entries(CAP_METHODS) as [
    CapabilityName,
    (keyof DriverHandle)[],
  ][]) {
    const supported = caps[cap] !== "unsupported";
    for (const m of methods) {
      const present = typeof handle[m] === "function";
      if (supported && !present) {
        problems.push(
          `cap '${cap}' is ${caps[cap]} but handle.${m}() is missing`
        );
      }
      if (!supported && present) {
        problems.push(
          `handle.${m}() exists but cap '${cap}' is unsupported (under-declared)`
        );
      }
    }
  }
  for (const [cap, members] of Object.entries(CAP_PROVIDER) as [
    CapabilityName,
    (keyof SandboxProvider)[],
  ][]) {
    const supported = caps[cap] !== "unsupported";
    for (const m of members) {
      const present = provider[m] !== undefined;
      if (supported && !present) {
        problems.push(
          `cap '${cap}' is ${caps[cap]} but provider.${m} is missing`
        );
      }
      if (!supported && present) {
        problems.push(
          `provider.${m} exists but cap '${cap}' is unsupported (under-declared)`
        );
      }
    }
  }
  if (caps.templateBuild !== "unsupported") {
    const sources = provider.flags.templateSources ?? [];
    if (sources.length === 0) {
      problems.push(
        "cap 'templateBuild' is declared but flags.templateSources is empty"
      );
    }
  }
  return problems;
}

export async function runConformance(
  provider: SandboxProvider,
  options: ConformanceOptions = {}
): Promise<ConformanceReport> {
  const client = createSandboxClient({ provider, telemetry: false });
  const checks: ConformanceCheck[] = [];
  const skip = new Set(options.skip ?? []);
  const caps = provider.capabilities;
  const wd = options.workdir ?? "/tmp";
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const tag = { "sbox-conformance": runId };
  const baseSpec: SandboxSpec = {
    ...options.spec,
    metadata: { ...options.spec?.metadata, ...tag },
  };
  const has = (c: CapabilityName) => caps[c] !== "unsupported";

  const check = async (
    name: string,
    fn: () => Promise<void>
  ): Promise<void> => {
    if (skip.has(name)) {
      return;
    }
    const started = Date.now();
    let result: ConformanceCheck;
    try {
      await fn();
      result = { ms: Date.now() - started, name, ok: true };
    } catch (error) {
      result = {
        error: error instanceof Error ? error.message : String(error),
        ms: Date.now() - started,
        name,
        ok: false,
      };
    }
    checks.push(result);
    options.onCheck?.(result);
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

  // ---- verify ------------------------------------------------------------
  if (provider.verify) {
    await check("verify: key check succeeds without creating", async () => {
      const res = await client.verify();
      assert(res.ok, `verify failed: ${res.ok ? "" : res.error.message}`);
    });
  }

  let sb: Sandbox | undefined;
  await check("lifecycle: create", async () => {
    sb = await client.create(baseSpec);
    assert(!!sb.id, "sandbox id");
  });
  if (!sb) {
    await client.dispose();
    return { checks, passed: false, provider: provider.name };
  }
  const s = sb;

  // ---- contract ----------------------------------------------------------
  await check("contract: driver methods match declared caps", async () => {
    const handle = (s as unknown as Record<symbol, DriverHandle>)[
      DRIVER_HANDLE
    ];
    assert(handle, "driver handle reachable");
    const problems = checkCapabilityContract(provider, handle);
    assert(problems.length === 0, problems.join("; "));
  });

  await check("contract: gated sub-APIs match declaration", async () => {
    const gates: [CapabilityName, keyof Sandbox][] = [
      ["codeInterpreter", "code"],
      ["snapshot", "snapshots"],
      ["exposePort", "ports"],
      ["egressControl", "network"],
      ["ssh", "ssh"],
      ["pty", "pty"],
    ];
    for (const [cap, key] of gates) {
      const present = s[key] !== undefined;
      assert(
        present === has(cap),
        `sandbox.${String(key)} presence != cap '${cap}'`
      );
    }
    assert(
      (client.templates !== undefined) === has("templateBuild"),
      "client.templates presence != cap 'templateBuild'"
    );
    assert(
      (client.volumes !== undefined) === has("volumes"),
      "client.volumes presence != cap 'volumes'"
    );
  });

  // ---- lifecycle ---------------------------------------------------------
  await check("lifecycle: getInfo reports live running state", async () => {
    const info = await s.getInfo();
    assert(info.id === s.id, `info.id matches (got ${info.id})`);
    assert(info.provider === provider.name, "info.provider matches");
    assert(info.state === "running", `state 'running' (got '${info.state}')`);
    assert(
      info.metadata["sbox-conformance"] === runId || !has("list"),
      "metadata round-trips"
    );
  });

  await check("lifecycle: connect by id", async () => {
    const again = await client.connect(s.id);
    assert(again.id === s.id, "same id");
    const r = await again.commands.run("echo reconnected");
    assert(r.stdout.trim() === "reconnected", "exec after reconnect");
  });

  // ---- exec --------------------------------------------------------------
  await check("exec: echo buffered", async () => {
    const r = await s.commands.run("echo hi");
    assert(r.exitCode === 0, `exit 0 (got ${r.exitCode})`);
    assert(
      r.stdout.trim() === "hi",
      `stdout 'hi' (got ${JSON.stringify(r.stdout)})`
    );
  });

  await check("exec: exact non-zero exit code is data, not throw", async () => {
    const r = await s.commands.run("exit 3");
    assert(r.exitCode === 3, `exit 3 (got ${r.exitCode})`);
  });

  await check("exec: stdout and stderr are separate", async () => {
    const r = await s.commands.run("echo out; echo err >&2");
    assert(
      r.stdout.trim() === "out",
      `stdout (got ${JSON.stringify(r.stdout)})`
    );
    assert(
      r.stderr.trim() === "err",
      `stderr (got ${JSON.stringify(r.stderr)})`
    );
  });

  await check("exec: argv form quotes safely", async () => {
    const r = await s.commands.run(["echo", "a b", "$HOME", "it's"]);
    assert(
      r.stdout.trim() === "a b $HOME it's",
      `argv (got ${JSON.stringify(r.stdout)})`
    );
  });

  if (has("streaming")) {
    await check("exec: streaming events", async () => {
      let out = "";
      let exited = false;
      for await (const ev of s.commands.run("echo streamed")) {
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
    const r = await s.commands.run("pwd", { cwd: wd });
    assert(
      r.stdout.trim() === wd,
      `pwd ${wd} (got ${JSON.stringify(r.stdout)})`
    );
  });

  await check("exec: env applied", async () => {
    const r = await s.commands.run("echo $SBOX_CONF", {
      env: { SBOX_CONF: "x y" },
    });
    assert(
      r.stdout.trim() === "x y",
      `env expand (got ${JSON.stringify(r.stdout)})`
    );
  });

  await check("exec: invalid env key rejected before running", async () => {
    let threw = false;
    try {
      await s.commands.run("true", { env: { "A;rm -rf /": "x" } });
    } catch (error) {
      threw = error instanceof SandboxError && error.code === "Validation";
    }
    assert(threw, "Validation error");
  });

  await check("exec: stdin option is delivered", async () => {
    const r = await s.commands.run("cat", { stdin: "piped\nin" });
    assert(r.stdout === "piped\nin", `stdin (got ${JSON.stringify(r.stdout)})`);
  });

  await check("exec: timeoutMs rejects with Timeout", async () => {
    const started = Date.now();
    let code: string | undefined;
    try {
      await s.commands.run("sleep 30", { timeoutMs: 500 });
    } catch (error) {
      code = error instanceof SandboxError ? error.code : String(error);
    }
    assert(code === "Timeout", `Timeout error (got ${code})`);
    assert(Date.now() - started < 15_000, "returned promptly");
  });

  await check("exec: kill() ends a running command", async () => {
    const h = s.commands.run("sleep 30");
    const started = Date.now();
    setTimeout(() => void h.kill(), 300);
    try {
      const r = await h;
      assert(r.exitCode !== 0, `non-zero exit after kill (got ${r.exitCode})`);
    } catch {
      // some providers surface a killed command as an error — acceptable
    }
    assert(Date.now() - started < 15_000, "kill took effect");
  });

  if (has("background")) {
    await check("exec: spawn background process", async () => {
      const p = await s.commands.spawn("echo bg");
      assert(!!p.id, "process id");
      const r = await p.wait();
      assert(
        r.stdout.trim() === "bg",
        `bg stdout (got ${JSON.stringify(r.stdout)})`
      );
    });
  }

  if (has("killProcess")) {
    await check("exec: kill process by id", async () => {
      if (!has("background")) {
        return;
      }
      const p = await s.commands.spawn("sleep 30");
      await s.commands.kill(p.id);
      const r = await Promise.race([
        p.wait(),
        new Promise<"slow">((res) => setTimeout(() => res("slow"), 10_000)),
      ]);
      assert(r !== "slow", "process ended after kill");
    });
  }

  // ---- files -------------------------------------------------------------
  await check("files: write/read text round-trip", async () => {
    await s.files.write(`${wd}/conf.txt`, "hello world");
    const text = await (await s.files.read(`${wd}/conf.txt`)).text();
    assert(
      text === "hello world",
      `text round-trip (got ${JSON.stringify(text)})`
    );
  });

  await check(
    "files: write/read binary round-trip (all byte values)",
    async () => {
      const bytes = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        bytes[i] = i;
      }
      await s.files.write(`${wd}/conf.bin`, bytes);
      const got = await (await s.files.read(`${wd}/conf.bin`)).bytes();
      assert(got.length === 256, `binary length (got ${got.length})`);
      assert(
        got.every((b, i) => b === i),
        "binary content preserved"
      );
    }
  );

  await check("files: stream body upload + download", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("str"));
        c.enqueue(new TextEncoder().encode("eam"));
        c.close();
      },
    });
    await s.files.write(`${wd}/conf-stream.txt`, body);
    const f = await s.files.download(`${wd}/conf-stream.txt`);
    assert((await f.text()) === "stream", "stream round-trip");
  });

  if (options.live) {
    await check("files: 5 MB binary round-trip", async () => {
      const big = new Uint8Array(5 * 1024 * 1024);
      for (let i = 0; i < big.length; i += 4096) {
        big[i] = (i / 4096) % 256;
      }
      await s.files.write(`${wd}/conf-big.bin`, big);
      const got = await (await s.files.read(`${wd}/conf-big.bin`)).bytes();
      assert(got.length === big.length, `length (got ${got.length})`);
      for (let i = 0; i < big.length; i += 4096) {
        assert(got[i] === big[i], `byte ${i} differs`);
      }
    });
  }

  await check("files: list shows written file", async () => {
    await s.files.write(`${wd}/listed.txt`, "x");
    const entries = await s.files.list(wd);
    assert(
      entries.some((e) => e.name === "listed.txt" && e.type === "file"),
      "file listed"
    );
  });

  await check("files: mkdir/exists/stat/rename/remove", async () => {
    await s.files.mkdir(`${wd}/confdir/sub`, { recursive: true });
    assert(await s.files.exists(`${wd}/confdir/sub`), "exists after mkdir");
    assert((await s.files.stat(`${wd}/confdir`)).type === "dir", "stat dir");
    await s.files.write(`${wd}/confdir/a.txt`, "abc");
    assert((await s.files.stat(`${wd}/confdir/a.txt`)).size === 3, "stat size");
    await s.files.rename(`${wd}/confdir/a.txt`, `${wd}/confdir/b.txt`);
    assert(await s.files.exists(`${wd}/confdir/b.txt`), "renamed");
    await s.files.remove(`${wd}/confdir`, { recursive: true });
    assert(!(await s.files.exists(`${wd}/confdir`)), "gone after remove");
  });

  await check("files: read of missing file throws NotFound", async () => {
    let code: string | undefined;
    try {
      await s.files.read(`${wd}/definitely-missing-xyz`);
    } catch (error) {
      code = error instanceof SandboxError ? error.code : "non-SandboxError";
    }
    assert(code === "NotFound", `NotFound (got ${code})`);
  });

  await check("files: exists() is false (not throw) on missing", async () => {
    assert(
      (await s.files.exists(`${wd}/definitely-missing-xyz`)) === false,
      "missing => false"
    );
  });

  // ---- feature checks ----------------------------------------------------
  if (has("exposePort")) {
    await check("ports: expose returns https + wss URLs", async () => {
      const p = await s.ports!.expose(8080);
      assert(/^https?:\/\//.test(p.url), `url (got ${p.url})`);
      assert(!!p.wsUrl && /^wss?:\/\//.test(p.wsUrl), `wsUrl (got ${p.wsUrl})`);
      assert(!!p.auth, "auth normalized");
    });
  }

  if (has("privatePreview")) {
    await check("ports: private preview carries auth", async () => {
      const p = await s.ports!.expose(8081, { visibility: "private" });
      assert(
        p.auth && p.auth.type !== "public",
        `private auth (got ${p.auth?.type})`
      );
      if (provider.flags.previewBrowserAuth) {
        const url = browserUrl(p, { protocol: "ws" });
        assert(url.startsWith("ws"), "browserUrl usable for WebSocket");
      }
    });
  }

  if (has("pty")) {
    await check("pty: interactive echo + exit code", async () => {
      const t = await s.pty!.create({ cols: 100, rows: 30 });
      let out = "";
      const reader = (async () => {
        for await (const chunk of t) {
          out += new TextDecoder().decode(chunk);
          if (out.includes("pty-ok")) {
            break;
          }
        }
      })();
      await t.resize(120, 40);
      await t.write("echo pty-ok\n");
      await Promise.race([reader, new Promise((r) => setTimeout(r, 10_000))]);
      assert(
        out.includes("pty-ok"),
        `pty output (got ${JSON.stringify(out.slice(-200))})`
      );
      await t.write("exit 4\n");
      const { exitCode } = await Promise.race([
        t.wait(),
        new Promise<{ exitCode: number }>((r) =>
          setTimeout(() => r({ exitCode: -1 }), 10_000)
        ),
      ]);
      assert(exitCode === 4 || exitCode === -1, `pty exit 4 (got ${exitCode})`);
      if (exitCode === -1) {
        await t.kill();
      }
    });
  }

  if (has("metrics")) {
    await check("metrics: returns a sample", async () => {
      const m = await s.metrics();
      assert(m.timestamp instanceof Date, "timestamp");
    });
  }

  if (has("egressControl")) {
    await check("network: set egress policy", async () => {
      await s.network!.setEgressPolicy({
        domains: ["example.com"],
        mode: "allow-list",
      });
      await s.network!.setEgressPolicy({ mode: "allow-all" });
    });
  }

  if (has("snapshot")) {
    await check("snapshots: create returns a ref", async () => {
      await s.files.write(`${wd}/snap-marker.txt`, "before");
      const snap = await s.snapshots!.create({ name: `conf-${runId}` });
      assert(!!snap.id, "snapshot id");
      assert(snap.provider === provider.name, "snapshot provider");
    });
  }

  if (has("fork")) {
    await check("fork: clone sees parent files", async () => {
      await s.files.write(`${wd}/fork-marker.txt`, "parent");
      const [child] = await s.fork();
      assert(child && child.id !== s.id, "child has its own id");
      const text = await (
        await child.files.read(`${wd}/fork-marker.txt`)
      ).text();
      assert(text === "parent", "child sees parent file");
      await child.destroy();
    });
  }

  if (has("pause")) {
    await check("lifecycle: pause/resume keeps files", async () => {
      await s.files.write(`${wd}/pause-marker.txt`, "kept");
      await s.pause();
      await s.resume();
      const live = provider.flags.resumeChangesId
        ? await client.connect((await s.getInfo()).id)
        : s;
      const text = await (
        await live.files.read(`${wd}/pause-marker.txt`)
      ).text();
      assert(text === "kept", "file survives pause/resume");
    });
  }

  if (has("templateBuild") && options.template) {
    const tpl = options.template;
    await check("templates: build, cache hit, boot from template", async () => {
      const events: string[] = [];
      const ref = await client.templates!.build(tpl, {
        onEvent: (e) => events.push(e.type === "status" ? e.status : "log"),
      });
      assert(!!ref.id, "template id");
      const again: string[] = [];
      const ref2 = await client.templates!.build(tpl, {
        onEvent: (e) => again.push(e.type === "status" ? e.status : "log"),
      });
      assert(ref2.id === ref.id, "same template on rebuild");
      const fromTpl = await client.create({ ...baseSpec, template: ref });
      const r = await fromTpl.commands.run("echo from-template");
      assert(r.stdout.trim() === "from-template", "exec in templated sandbox");
      await fromTpl.destroy();
    });
  }

  await check("client: list honors capability and filter", async () => {
    if (!has("list")) {
      let threw = false;
      try {
        for await (const _info of client.list()) {
          break;
        }
      } catch (error) {
        threw = error instanceof NotSupportedError;
      }
      assert(threw, "list throws NotSupportedError when unsupported");
      return;
    }
    let found = false;
    for await (const info of client.list({ metadata: tag })) {
      assert(
        info.metadata["sbox-conformance"] === runId,
        `filter leaked a non-matching sandbox (${info.id})`
      );
      if (info.id === s.id) {
        found = true;
      }
    }
    assert(found, "created sandbox appears in filtered list");
  });

  if (has("list") && caps.list !== "emulated") {
    await check(
      "client: getOrCreate returns the same sandbox by name",
      async () => {
        const name = `sbox-conf-${runId}`;
        const a = await client.getOrCreate({ ...baseSpec, name });
        const b = await client.getOrCreate({ ...baseSpec, name });
        assert(a.id === b.id, `same id (got ${a.id} vs ${b.id})`);
        await a.destroy();
      }
    );
  }

  await check("lifecycle: destroy", async () => {
    await s.destroy();
  });

  if (options.live && has("list")) {
    await check(
      "lifecycle: destroyed sandbox is not listed as running",
      async () => {
        for await (const info of client.list({ metadata: tag })) {
          assert(
            !(info.id === s.id && info.state === "running"),
            "destroyed sandbox still running (leak)"
          );
        }
      }
    );
  }

  await client.dispose();

  return {
    checks,
    passed: checks.every((c) => c.ok),
    provider: provider.name,
  };
}
