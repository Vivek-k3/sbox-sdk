/**
 * Live conformance runner: `pnpm test:live` (optionally `SBOX_LIVE=e2b,docker`).
 * Discovers every `src/<provider>/live.ts` and runs the full suite against the
 * real API for providers whose credentials are present. Sandboxes are tagged
 * with `sbox-conformance=<run id>` and destroyed at the end.
 */
import { describe, expect, it } from "vitest";

import { runConformance } from "../conformance/index.js";
import type { LiveConfig } from "./types.js";

const modules = import.meta.glob<{ live: LiveConfig }>("../*/live.ts", {
  eager: true,
});
const only = process.env.SBOX_LIVE?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const configs = Object.values(modules)
  .map((m) => m.live)
  .filter((c) => !only || only.includes(c.name));

describe("live conformance", () => {
  if (configs.length === 0) {
    it.skip("no live providers selected", () => {});
  }
  for (const cfg of configs) {
    const missing = cfg.env.filter((k) => !process.env[k]);
    it.runIf(missing.length === 0)(
      `${cfg.name}${missing.length ? ` (missing ${missing.join(", ")})` : ""}`,
      async (ctx) => {
        if (cfg.available && !(await cfg.available())) {
          ctx.skip();
          return;
        }
        const provider = await cfg.make();
        const report = await runConformance(provider, {
          ...cfg.conformance,
          live: true,
          onCheck: (c) =>
            console.log(
              `[${cfg.name}] ${c.ok ? "ok  " : "FAIL"} ${c.name} (${c.ms}ms)${c.error ? ` — ${c.error}` : ""}`
            ),
        });
        const failed = report.checks.filter((c) => !c.ok);
        expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
      },
      15 * 60_000
    );
  }
});
