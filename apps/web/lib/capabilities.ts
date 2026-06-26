/**
 * Single source of truth for the homepage's provider/capability data.
 *
 * The levels here are transcribed verbatim from each adapter's `CapabilityMap`
 * in `packages/sbox-sdk/src/<provider>/index.ts`, so the matrix, the provider
 * rail, and the routing field can never drift from the real SDK.
 */

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
  | "tunnel";

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
}

// Shorthand so the maps below read like the source adapters.
const n: Level = "native";
const e: Level = "emulated";
const u: Level = "unsupported";

export const PROVIDERS: Provider[] = [
  {
    caps: {
      background: n,
      codeInterpreter: u,
      egressControl: u,
      exposePort: e,
      filesUpload: n,
      filesWatch: u,
      fork: n,
      gpu: u,
      killProcess: n,
      list: n,
      metrics: u,
      pause: n,
      privatePreview: u,
      proxiedFetch: u,
      pty: u,
      region: u,
      secretsVault: u,
      setTimeout: n,
      snapshot: n,
      ssh: u,
      statefulKernel: u,
      stdin: u,
      stop: n,
      streaming: n,
      volumes: u,
    },
    href: "/adapters/memory",
    id: "memory",
    name: "In-Memory",
    note: "Zero-config, in-process — for tests.",
    previewModel: "ip",
    subpath: "sbox-sdk/memory",
  },
  {
    caps: {
      background: n,
      codeInterpreter: n,
      egressControl: u,
      exposePort: n,
      filesUpload: n,
      filesWatch: n,
      fork: u,
      gpu: u,
      killProcess: n,
      list: n,
      metrics: n,
      pause: n,
      privatePreview: u,
      proxiedFetch: u,
      pty: u,
      region: u,
      secretsVault: u,
      setTimeout: n,
      snapshot: n,
      ssh: u,
      statefulKernel: n,
      stdin: u,
      stop: u,
      streaming: n,
      volumes: u,
    },
    href: "/adapters/e2b",
    id: "e2b",
    name: "E2B",
    note: "Richest surface — code interpreter + snapshots.",
    previewModel: "subdomain",
    subpath: "sbox-sdk/e2b",
  },
  {
    caps: {
      background: n,
      codeInterpreter: u,
      egressControl: u,
      exposePort: n,
      filesUpload: n,
      filesWatch: u,
      fork: u,
      gpu: u,
      killProcess: u,
      list: u,
      metrics: u,
      pause: u,
      privatePreview: u,
      proxiedFetch: u,
      pty: u,
      region: u,
      secretsVault: u,
      setTimeout: u,
      snapshot: u,
      ssh: u,
      statefulKernel: u,
      stdin: u,
      stop: u,
      streaming: n,
      volumes: u,
    },
    href: "/adapters/vercel",
    id: "vercel",
    name: "Vercel",
    note: "Stop auto-snapshots the filesystem.",
    previewModel: "declaredPorts",
    subpath: "sbox-sdk/vercel",
  },
  {
    caps: {
      background: u,
      codeInterpreter: n,
      egressControl: u,
      exposePort: n,
      filesUpload: n,
      filesWatch: u,
      fork: u,
      gpu: u,
      killProcess: u,
      list: u,
      metrics: u,
      pause: u,
      privatePreview: u,
      proxiedFetch: n,
      pty: u,
      region: u,
      secretsVault: u,
      setTimeout: n,
      snapshot: u,
      ssh: u,
      statefulKernel: n,
      stdin: u,
      stop: u,
      streaming: n,
      volumes: u,
    },
    href: "/adapters/cloudflare",
    id: "cloudflare",
    name: "Cloudflare",
    note: "Durable-Object backed; proxied fetch.",
    previewModel: "wildcardDNS",
    subpath: "sbox-sdk/cloudflare",
  },
  {
    caps: {
      background: u,
      codeInterpreter: n,
      egressControl: u,
      exposePort: n,
      filesUpload: n,
      filesWatch: u,
      fork: u,
      gpu: u,
      killProcess: u,
      list: n,
      metrics: u,
      pause: n,
      privatePreview: n,
      proxiedFetch: u,
      pty: u,
      region: n,
      secretsVault: u,
      setTimeout: n,
      snapshot: u,
      ssh: u,
      statefulKernel: u,
      stdin: u,
      stop: n,
      streaming: e,
      volumes: u,
    },
    href: "/adapters/daytona",
    id: "daytona",
    name: "Daytona",
    note: "Regioned, pausable dev environments.",
    previewModel: "subdomain",
    subpath: "sbox-sdk/daytona",
  },
  {
    caps: {
      background: u,
      codeInterpreter: u,
      egressControl: u,
      exposePort: n,
      filesUpload: n,
      filesWatch: u,
      fork: u,
      gpu: n,
      killProcess: u,
      list: n,
      metrics: u,
      pause: u,
      privatePreview: u,
      proxiedFetch: u,
      pty: u,
      region: u,
      secretsVault: u,
      setTimeout: u,
      snapshot: u,
      ssh: u,
      statefulKernel: u,
      stdin: u,
      stop: u,
      streaming: n,
      volumes: u,
    },
    href: "/adapters/modal",
    id: "modal",
    name: "Modal",
    note: "GPU-native compute.",
    previewModel: "tunnel",
    subpath: "sbox-sdk/modal",
  },
  {
    caps: {
      background: u,
      codeInterpreter: u,
      egressControl: u,
      exposePort: n,
      filesUpload: n,
      filesWatch: u,
      fork: u,
      gpu: u,
      killProcess: u,
      list: n,
      metrics: u,
      pause: n,
      privatePreview: u,
      proxiedFetch: u,
      pty: u,
      region: n,
      secretsVault: u,
      setTimeout: u,
      snapshot: u,
      ssh: u,
      statefulKernel: u,
      stdin: u,
      stop: n,
      streaming: e,
      volumes: u,
    },
    href: "/adapters/fly",
    id: "fly",
    name: "Fly",
    note: "Machines API; regioned, pausable.",
    previewModel: "subdomain",
    subpath: "sbox-sdk/fly",
  },
  {
    caps: {
      background: u,
      codeInterpreter: u,
      egressControl: u,
      exposePort: n,
      filesUpload: n,
      filesWatch: u,
      fork: u,
      gpu: u,
      killProcess: u,
      list: n,
      metrics: u,
      pause: n,
      privatePreview: n,
      proxiedFetch: u,
      pty: u,
      region: n,
      secretsVault: u,
      setTimeout: u,
      snapshot: u,
      ssh: u,
      statefulKernel: u,
      stdin: u,
      stop: u,
      streaming: e,
      volumes: u,
    },
    href: "/adapters/aws-lambda",
    id: "aws-lambda",
    name: "AWS Lambda",
    note: "MicroVMs; suspend preserves memory + disk.",
    previewModel: "tunnel",
    subpath: "sbox-sdk/aws-lambda",
  },
];

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
