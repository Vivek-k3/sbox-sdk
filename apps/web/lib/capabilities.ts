/**
 * Single source of truth for the homepage's provider/capability data.
 *
 * The levels here are transcribed verbatim from each adapter's `CapabilityMap`
 * in `packages/sbox-sdk/src/<provider>/index.ts`, so the matrix, the provider
 * rail, and the routing field can never drift from the real SDK.
 */

import generated from "./capabilities.generated.json";

export type Level = "native" | "emulated" | "unsupported";

export type CapabilityKey =
  | "list"
  | "stop"
  | "pause"
  | "setTimeout"
  | "background"
  | "streaming"
  | "killProcess"
  | "pty"
  | "stdin"
  | "filesWatch"
  | "filesUpload"
  | "codeInterpreter"
  | "statefulKernel"
  | "exposePort"
  | "privatePreview"
  | "egressControl"
  | "ssh"
  | "proxiedFetch"
  | "snapshot"
  | "fork"
  | "volumes"
  | "templateBuild"
  | "gpu"
  | "region"
  | "secretsVault"
  | "metrics";

export interface CapabilityGroup {
  /** Group label as it appears in the docs capability table. */
  group: string;
  caps: { key: CapabilityKey; label: string }[];
}

export const CAPABILITY_GROUPS: CapabilityGroup[] = [
  {
    caps: [
      { key: "list", label: "list" },
      { key: "stop", label: "stop" },
      { key: "pause", label: "pause" },
      { key: "setTimeout", label: "setTimeout" },
    ],
    group: "lifecycle",
  },
  {
    caps: [
      { key: "background", label: "background" },
      { key: "streaming", label: "streaming" },
      { key: "killProcess", label: "killProcess" },
      { key: "pty", label: "pty" },
      { key: "stdin", label: "stdin" },
    ],
    group: "exec",
  },
  {
    caps: [
      { key: "filesWatch", label: "filesWatch" },
      { key: "filesUpload", label: "filesUpload" },
    ],
    group: "filesystem",
  },
  {
    caps: [
      { key: "codeInterpreter", label: "codeInterpreter" },
      { key: "statefulKernel", label: "statefulKernel" },
    ],
    group: "code",
  },
  {
    caps: [
      { key: "exposePort", label: "exposePort" },
      { key: "privatePreview", label: "privatePreview" },
      { key: "egressControl", label: "egressControl" },
      { key: "ssh", label: "ssh" },
      { key: "proxiedFetch", label: "proxiedFetch" },
    ],
    group: "network",
  },
  {
    caps: [
      { key: "snapshot", label: "snapshot" },
      { key: "fork", label: "fork" },
      { key: "volumes", label: "volumes" },
      { key: "templateBuild", label: "templateBuild" },
    ],
    group: "snapshot",
  },
  {
    caps: [
      { key: "gpu", label: "gpu" },
      { key: "region", label: "region" },
      { key: "secretsVault", label: "secretsVault" },
      { key: "metrics", label: "metrics" },
    ],
    group: "meta",
  },
];

export const CAPABILITY_KEYS: CapabilityKey[] = CAPABILITY_GROUPS.flatMap((g) =>
  g.caps.map((c) => c.key)
);

export type PreviewModel =
  | "ip"
  | "subdomain"
  | "declaredPorts"
  | "wildcardDNS"
  | "tunnel"
  | "none";

export interface Provider {
  id: string;
  /** Display name. */
  name: string;
  /** Adapter import subpath, e.g. `sbox-sdk/e2b`. */
  subpath: string;
  /** Docs link. */
  href: string;
  /** One-line character note. */
  note: string;
  previewModel: PreviewModel;
  caps: Record<CapabilityKey, Level>;
  /** Private previews usable from a browser WebSocket. */
  previewBrowserAuth: boolean;
  templateSources: string[];
  deprecated: boolean;
}

/**
 * Capability levels + flags are GENERATED from the built SDK by
 * `pnpm --filter sbox-sdk gen:capabilities` (see packages/sbox-sdk/scripts).
 * Only display metadata lives here.
 */

interface GeneratedEntry {
  caps: Record<CapabilityKey, Level>;
  deprecated: boolean;
  flags: {
    previewBrowserAuth: boolean;
    previewModel: PreviewModel;
    templateSources: string[];
  };
  name: string;
}

const GEN = generated as unknown as Record<string, GeneratedEntry>;

const META: [id: string, name: string, note: string][] = [
  [
    "memory",
    "In-Memory",
    "Zero-config, in-process: the reference adapter, for tests.",
  ],
  [
    "docker",
    "Docker",
    "Local containers via the Engine API: OrbStack, Docker Desktop, Colima, Podman.",
  ],
  ["e2b", "E2B", "Firecracker microVMs, code interpreter, Template builds."],
  [
    "daytona",
    "Daytona",
    "Fast sandboxes with signed browser-safe previews and image builds.",
  ],
  [
    "vercel",
    "Vercel",
    "Named Firecracker sandboxes with snapshots, fork and Drives.",
  ],
  ["modal", "Modal", "Serverless containers, GPUs, connect-token previews."],
  [
    "tensorlake",
    "Tensorlake",
    "MicroVMs with memory snapshots, fork, PTY and GPUs.",
  ],
  [
    "superserve",
    "Superserve",
    "Firecracker microVMs, per-port previews, BuildSpec templates.",
  ],
  [
    "sprites",
    "Fly Sprites",
    "Named persistent VMs that pause when idle; checkpoints.",
  ],
  [
    "freestyle",
    "Freestyle",
    "KVM VMs with snapshots, fork and TLS credential injection.",
  ],
  [
    "together",
    "Together",
    "CodeSandbox successor: Dockerfile snapshots, hibernate/resume.",
  ],
  [
    "blaxel",
    "Blaxel",
    "Standby sandboxes with snapshots, fork and preview tokens.",
  ],
  ["beam", "Beam", "Serverless sandboxes with GPUs, images and snapshots."],
  [
    "railway",
    "Railway",
    "Isolated Debian VMs with checkpoints, fork and domains.",
  ],
  [
    "northflank",
    "Northflank",
    "Container services with snapshots, GPUs and PTY.",
  ],
  ["fly", "Fly Machines", "Raw Fly Machines over REST, volumes and secrets."],
  [
    "aws-lambda",
    "AWS Lambda MicroVMs",
    "Snapshotted microVMs built from a Dockerfile.",
  ],
  [
    "morph",
    "Morph",
    "Snapshot-chain VMs with branching (maintenance-only TS SDK).",
  ],
  [
    "cloudflare",
    "Cloudflare",
    "Container sandboxes on Workers (0.x, deprecated).",
  ],
  ["codesandbox", "CodeSandbox", "Deprecated: moved to Together Sandbox."],
  ["runloop", "Runloop", "Deprecated: the service is winding down."],
];

export const PROVIDERS: Provider[] = META.map(([id, name, note]) => {
  const g = GEN[id];
  if (!g) {
    throw new Error(`capabilities.generated.json has no entry for ${id}`);
  }
  return {
    caps: g.caps,
    deprecated: g.deprecated,
    href: `/adapters/${id}`,
    id,
    name,
    note,
    previewBrowserAuth: g.flags.previewBrowserAuth,
    previewModel: g.flags.previewModel,
    subpath: `sbox-sdk/${id}`,
    templateSources: g.flags.templateSources,
  };
});

/** How many capabilities a provider supports natively — used to size rail dots. */
export const nativeCount = (p: Provider): number =>
  CAPABILITY_KEYS.filter((k) => p.caps[k] === "native").length;

export const supportedCount = (p: Provider): number =>
  CAPABILITY_KEYS.filter((k) => p.caps[k] !== "unsupported").length;

export const LEVEL_LABEL: Record<Level, string> = {
  emulated: "emulated",
  native: "native",
  unsupported: "unsupported",
};

/**
 * Providers whose adapter targets a product still in beta/preview — surfaced as a
 * "Beta" badge next to the adapter's name. Keyed by provider id (the same id as
 * the page's `icon` frontmatter).
 */
export const BETA_PROVIDERS: ReadonlySet<string> = new Set([
  "railway",
  "together",
]);
