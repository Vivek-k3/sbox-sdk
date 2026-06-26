/**
 * The single source of truth for what a provider can do. Each provider declares
 * a static `CapabilityMap` literal; from it we derive (A) type-level gating via
 * `Gated<>`, (B) the runtime read-model on `sandbox.capabilities`, and (C)
 * fail-fast enforcement via `assertCapability`.
 */
import { NotSupportedError } from "./errors.js";

export type CapabilityLevel = "native" | "emulated" | "unsupported";

/** Static, declarative table per provider. Drives type-level + runtime gating. */
export interface CapabilityMap {
  // lifecycle
  list: CapabilityLevel;
  stop: CapabilityLevel;
  pause: CapabilityLevel;
  setTimeout: CapabilityLevel;
  // exec
  background: CapabilityLevel;
  streaming: CapabilityLevel;
  killProcess: CapabilityLevel;
  pty: CapabilityLevel;
  stdin: CapabilityLevel;
  // filesystem
  filesWatch: CapabilityLevel;
  filesUpload: CapabilityLevel;
  // code interpreter
  codeInterpreter: CapabilityLevel;
  statefulKernel: CapabilityLevel;
  // network
  exposePort: CapabilityLevel;
  privatePreview: CapabilityLevel;
  egressControl: CapabilityLevel;
  ssh: CapabilityLevel;
  proxiedFetch: CapabilityLevel;
  // snapshot
  snapshot: CapabilityLevel;
  fork: CapabilityLevel;
  volumes: CapabilityLevel;
  // meta
  gpu: CapabilityLevel;
  region: CapabilityLevel;
  secretsVault: CapabilityLevel;
  metrics: CapabilityLevel;
}

export type CapabilityName = keyof CapabilityMap;

export type PreviewModel =
  | "subdomain"
  | "tunnel"
  | "declaredPorts"
  | "wildcardDNS"
  | "ip"
  | "none";

/** Behavioral flags that aren't present/absent — they change semantics. */
export interface CapabilityFlags {
  preservesMemoryOnPause: boolean;
  preservesDiskOnStop: boolean;
  /** false => core wraps exec in `sh -c 'cd <cwd> && KEY=v <cmd>'`. */
  perCommandEnvCwd: boolean;
  /** false => core synthesizes exit code via `; echo __sbox_rc=$?`. */
  exitCodeNative: boolean;
  previewModel: PreviewModel;
}

/** Runtime read-model surfaced on every sandbox + client. */
export interface Capabilities {
  readonly map: Readonly<CapabilityMap>;
  readonly flags: Readonly<CapabilityFlags>;
}

/** Gated sub-API: the real interface when supported/emulated, else `undefined`. */
export type Gated<L extends CapabilityLevel, API> = L extends "unsupported"
  ? undefined
  : API;

const ALL_CAPABILITY_NAMES: readonly CapabilityName[] = [
  "list",
  "stop",
  "pause",
  "setTimeout",
  "background",
  "streaming",
  "killProcess",
  "pty",
  "stdin",
  "filesWatch",
  "filesUpload",
  "codeInterpreter",
  "statefulKernel",
  "exposePort",
  "privatePreview",
  "egressControl",
  "ssh",
  "proxiedFetch",
  "snapshot",
  "fork",
  "volumes",
  "gpu",
  "region",
  "secretsVault",
  "metrics",
];

const DEFAULT_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true,
  preservesDiskOnStop: false,
  preservesMemoryOnPause: false,
  previewModel: "none",
};

/** A baseline map of all-`unsupported`, for providers to spread overrides onto. */
export function baseCapabilities(): CapabilityMap {
  const map = {} as CapabilityMap;
  for (const name of ALL_CAPABILITY_NAMES) {
    map[name] = "unsupported";
  }
  return map;
}

export function defaultFlags(
  overrides: Partial<CapabilityFlags> = {}
): CapabilityFlags {
  return { ...DEFAULT_FLAGS, ...overrides };
}

/** Build a frozen runtime read-model from a provider's static declaration. */
export function freezeCapabilities(
  map: CapabilityMap,
  flags: CapabilityFlags
): Capabilities {
  return {
    flags: Object.freeze({ ...flags }),
    map: Object.freeze({ ...map }),
  };
}

export function isCapable(caps: Capabilities, name: CapabilityName): boolean {
  return caps.map[name] !== "unsupported";
}

/** Throw NotSupportedError up front if a capability is unsupported. */
export function assertCapability(
  provider: string,
  caps: Capabilities,
  name: CapabilityName,
  feature: string = name
): void {
  if (caps.map[name] === "unsupported") {
    throw new NotSupportedError(provider, feature);
  }
}
