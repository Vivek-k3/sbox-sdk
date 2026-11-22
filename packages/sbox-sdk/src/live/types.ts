/**
 * Live-test registry entry. Each adapter ships `src/<provider>/live.ts`
 * exporting `live: LiveConfig`; `pnpm test:live` runs the conformance suite
 * against every provider whose `env` vars are all set (or `available()` is
 * true). Never published (excluded from the build).
 */
import type { ConformanceOptions } from "../conformance/index.js";
import type { SandboxProvider } from "../internal/types.js";

export interface LiveConfig {
  /** Must match the provider's `name`. */
  name: string;
  /** Env vars that must ALL be set for this provider to run. */
  env: string[];
  /** Extra availability probe (e.g. docker daemon reachable). */
  available?: () => Promise<boolean>;
  make: () => Promise<SandboxProvider> | SandboxProvider;
  /** Passed through to `runConformance` (spec, template, skip, workdir). */
  conformance?: Omit<ConformanceOptions, "live" | "onCheck">;
}
