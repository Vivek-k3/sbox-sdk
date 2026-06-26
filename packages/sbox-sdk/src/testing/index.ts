/**
 * `sbox-sdk/testing` — offline test doubles. `memory()` is a full in-memory
 * provider; `failing()` always errors (to exercise retry/fallback paths).
 */
import { SandboxError } from "../adapter/index.js";
import type {
  CapabilityFlags,
  CapabilityMap,
  SandboxProvider,
} from "../adapter/index.js";

export { memory } from "../memory/index.js";
export type { MemoryOptions, MemoryCaps, MemoryRaw } from "../memory/index.js";

const FAILING_CAPS = {
  background: "unsupported",
  codeInterpreter: "unsupported",
  egressControl: "unsupported",
  exposePort: "unsupported",
  filesUpload: "unsupported",
  filesWatch: "unsupported",
  fork: "unsupported",
  gpu: "unsupported",
  killProcess: "unsupported",
  list: "unsupported",
  metrics: "unsupported",
  pause: "unsupported",
  privatePreview: "unsupported",
  proxiedFetch: "unsupported",
  pty: "unsupported",
  region: "unsupported",
  secretsVault: "unsupported",
  setTimeout: "unsupported",
  snapshot: "unsupported",
  ssh: "unsupported",
  statefulKernel: "unsupported",
  stdin: "unsupported",
  stop: "unsupported",
  streaming: "unsupported",
  volumes: "unsupported",
} as const satisfies CapabilityMap;

export type FailingCaps = typeof FAILING_CAPS;

const FAILING_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true,
  preservesDiskOnStop: false,
  preservesMemoryOnPause: false,
  previewModel: "none",
};

export interface FailingOptions {
  /** Error thrown on create()/connect(). Defaults to a retryable Provider error. */
  error?: SandboxError;
  name?: string;
}

/** A provider that always throws — useful for testing retry + fallback. */
export function failing(
  opts: FailingOptions = {}
): SandboxProvider<FailingCaps, never> {
  const o = opts;
  const err = (): SandboxError =>
    o.error ??
    new SandboxError("Provider", "failing provider always fails", {
      provider: o.name ?? "failing",
      retryable: true,
    });
  const provider: SandboxProvider<FailingCaps, never> = {
    capabilities: FAILING_CAPS,
    connect() {
      throw err();
    },
    create() {
      throw err();
    },
    flags: FAILING_FLAGS,
    name: o.name ?? "failing",
  };
  return provider;
}
