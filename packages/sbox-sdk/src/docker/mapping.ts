/**
 * Pure mapping between sbox types and Docker Engine API JSON: labels and
 * filters, container status, the `ResolvedSandboxSpec` -> container-create
 * body, exec wrappers, path-stat decoding and stats -> metrics. No I/O here,
 * so all of it is unit-tested offline.
 */
import { SandboxError } from "../adapter/index.js";
import type {
  FileInfo,
  ResolvedSandboxSpec,
  ResourceSpec,
  SandboxMetrics,
  SandboxState,
} from "../adapter/index.js";

// ---------------------------------------------------------------------------
// Engine API shapes (the subset this adapter reads/writes)
// ---------------------------------------------------------------------------

export interface PortBinding {
  HostIp?: string;
  HostPort?: string;
}

export interface MountSpec {
  Type: "volume" | "bind" | "tmpfs";
  Source?: string;
  Target: string;
  ReadOnly?: boolean;
}

export interface DeviceRequest {
  Driver?: string;
  Count?: number;
  DeviceIDs?: string[];
  Capabilities?: string[][];
}

export interface HostConfig {
  Init?: boolean;
  NanoCpus?: number;
  Memory?: number;
  ShmSize?: number;
  PortBindings?: Record<string, PortBinding[]>;
  Mounts?: MountSpec[];
  NetworkMode?: string;
  DeviceRequests?: DeviceRequest[];
}

export interface ContainerCreateBody {
  Image: string;
  Cmd?: string[];
  Entrypoint?: string[] | null;
  Env?: string[];
  WorkingDir?: string;
  User?: string;
  Labels: Record<string, string>;
  ExposedPorts?: Record<string, Record<string, never>>;
  HostConfig: HostConfig;
}

export interface ContainerInspect {
  Id: string;
  Name: string;
  Created: string;
  Image: string;
  State: {
    Status: string;
    Running?: boolean;
    Paused?: boolean;
    OOMKilled?: boolean;
    ExitCode?: number;
  };
  Config: {
    Image: string;
    User?: string;
    Env?: string[] | null;
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
    WorkingDir?: string;
    Labels?: Record<string, string> | null;
    ExposedPorts?: Record<string, Record<string, never>> | null;
  };
  HostConfig: HostConfig;
  NetworkSettings: {
    Ports?: Record<string, PortBinding[] | null> | null;
    Networks?: Record<string, { IPAddress?: string }> | null;
  };
}

export interface ContainerSummary {
  Id: string;
  Names?: string[];
  Image: string;
  Labels?: Record<string, string> | null;
  State: string;
  Status?: string;
  Created: number;
}

export interface ImageInspect {
  Id: string;
  RepoTags?: string[] | null;
  Created?: string;
  Config?: { Labels?: Record<string, string> | null } | null;
}

export interface ImageSummary {
  Id: string;
  RepoTags?: string[] | null;
  Labels?: Record<string, string> | null;
  Created: number;
}

// ---------------------------------------------------------------------------
// labels + filters
// ---------------------------------------------------------------------------

export const LABEL = {
  cacheKey: "sbox.cacheKey",
  forkImage: "sbox.forkImage",
  forkOf: "sbox.forkOf",
  idempotency: "sbox.idempotency",
  managed: "sbox.managed",
  meta: "sbox.meta.",
  name: "sbox.name",
  readyCmd: "sbox.readyCmd",
  resources: "sbox.resources",
  snapshot: "sbox.snapshot",
  snapshotKind: "sbox.snapshot.kind",
  snapshotName: "sbox.snapshot.name",
  snapshotSource: "sbox.snapshot.source",
  startCmd: "sbox.startCmd",
  template: "sbox.template",
  templateName: "sbox.template.name",
} as const;

function assertLabelKey(key: string): void {
  if (!key || key.includes("=")) {
    throw new SandboxError(
      "Validation",
      `invalid metadata key ${JSON.stringify(key)} (must be non-empty, no '=')`,
      { provider: "docker" }
    );
  }
}

/** `{a: "1"}` -> `{"sbox.meta.a": "1"}`. */
export function metadataLabels(
  metadata: Record<string, string> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadata ?? {})) {
    assertLabelKey(k);
    out[`${LABEL.meta}${k}`] = v;
  }
  return out;
}

/** Inverse of `metadataLabels`; empty values (blanked by commit) are dropped. */
export function metadataFromLabels(
  labels: Record<string, string> | null | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels ?? {})) {
    if (k.startsWith(LABEL.meta) && v !== "") {
      out[k.slice(LABEL.meta.length)] = v;
    }
  }
  return out;
}

/** Docker status values for each sbox state (`[]` = nothing can match). */
export function statusFilter(state: SandboxState): string[] {
  switch (state) {
    case "running": {
      return ["running"];
    }
    case "paused": {
      return ["paused"];
    }
    case "stopped": {
      return ["exited", "created"];
    }
    case "creating": {
      return ["restarting"];
    }
    case "destroyed": {
      return ["removing"];
    }
    case "error": {
      return ["dead"];
    }
    default: {
      return [];
    }
  }
}

/** Build the `filters` JSON for `GET /containers/json`. */
export function containerFilters(f: {
  metadata?: Record<string, string>;
  state?: SandboxState;
  name?: string;
  idempotencyKey?: string;
}): Record<string, string[]> {
  const label = [`${LABEL.managed}=true`];
  for (const [k, v] of Object.entries(metadataLabels(f.metadata))) {
    label.push(`${k}=${v}`);
  }
  if (f.name !== undefined) {
    label.push(`${LABEL.name}=${f.name}`);
  }
  if (f.idempotencyKey !== undefined) {
    label.push(`${LABEL.idempotency}=${f.idempotencyKey}`);
  }
  const out: Record<string, string[]> = { label };
  if (f.state) {
    out.status = statusFilter(f.state);
  }
  return out;
}

/** Map Docker's `State.Status` onto `SandboxState`. */
export function mapStatus(status: string | undefined): SandboxState {
  switch (status) {
    case "running": {
      return "running";
    }
    case "paused": {
      return "paused";
    }
    // Created-but-never-started can be started like a stopped container.
    case "created":
    case "exited": {
      return "stopped";
    }
    case "restarting": {
      return "creating";
    }
    case "removing": {
      return "destroyed";
    }
    case "dead": {
      return "error";
    }
    default: {
      return "unknown";
    }
  }
}

// ---------------------------------------------------------------------------
// names + refs
// ---------------------------------------------------------------------------

/** Make a string safe for a container name (`[a-zA-Z0-9][a-zA-Z0-9_.-]*`). */
export function sanitizeName(s: string, max = 63): string {
  const cleaned = s
    .replaceAll(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .slice(0, max)
    .replace(/[-.]+$/, "");
  return cleaned || "sbx";
}

/** Lower-case repository component (`[a-z0-9]+([._-][a-z0-9]+)*`). */
export function sanitizeRepo(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/[._-]{2,}/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "")
    .slice(0, 100);
  return cleaned || "sbx";
}

/** Image tag (`[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}`). */
export function sanitizeTag(s: string): string {
  const cleaned = s
    .replaceAll(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 128);
  return cleaned || "latest";
}

/** Deterministic short hash (two 32-bit polynomial hashes), 12 hex chars. */
export function shortHash(s: string): string {
  const M = 4_294_967_296;
  let h1 = 7;
  let h2 = 11;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    h1 = (h1 * 31 + c) % M;
    h2 = (h2 * 131 + c + 1) % M;
  }
  return (
    h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")
  ).slice(0, 12);
}

/** Deterministic container name for an idempotency key. */
export function containerNameFor(
  name: string | undefined,
  key: string
): string {
  return `sbox-${sanitizeName(name ?? "sbx", 40)}-${shortHash(key)}`;
}

/** Split an image reference into `fromImage` + `tag` for `POST /images/create`. */
export function parseImageRef(ref: string): { fromImage: string; tag: string } {
  if (ref.includes("@")) {
    return { fromImage: ref, tag: "" };
  }
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  if (colon > slash) {
    return { fromImage: ref.slice(0, colon), tag: ref.slice(colon + 1) };
  }
  return { fromImage: ref, tag: "latest" };
}

/** Registry host for an image ref (`docker.io` when none is given). */
export function registryOf(ref: string): string {
  const first = ref.split("/")[0] ?? "";
  if (
    ref.includes("/") &&
    (first.includes(".") || first.includes(":") || first === "localhost")
  ) {
    return first;
  }
  return "https://index.docker.io/v1/";
}

/** `X-Registry-Auth` header value (base64url JSON). */
export function registryAuthHeader(
  ref: string,
  auth: { username: string; password: string }
): string {
  const json = JSON.stringify({
    password: auth.password,
    serveraddress: registryOf(ref),
    username: auth.username,
  });
  const b64 = btoa(String.fromCodePoint(...new TextEncoder().encode(json)));
  return b64.replaceAll("+", "-").replaceAll("/", "_");
}

/** Preferred human ref for an image: an `sbox/` tag, any tag, else the id. */
export function imageRefId(img: {
  Id: string;
  RepoTags?: string[] | null;
}): string {
  const tags = (img.RepoTags ?? []).filter((t) => t !== "<none>:<none>");
  return tags.find((t) => t.startsWith("sbox/")) ?? tags[0] ?? img.Id;
}

// ---------------------------------------------------------------------------
// exec helpers
// ---------------------------------------------------------------------------

const PID_PRINT = String.raw`printf '\036SBOXPID:%s\036' "$$"`;

/**
 * Wrap a command so the shell first prints its own pid as a marker on stderr,
 * then `exec`s the command (keeping that pid). Docker's exec-inspect `Pid` is
 * in the daemon's pid namespace, not the container's, so it can't be used.
 */
export function execWrapper(cmd: string): string[] {
  return ["sh", "-c", `${PID_PRINT} >&2; exec sh -c "$1"`, "sbox-exec", cmd];
}

/** PTY variant: the marker goes to the TTY; default is a login bash/sh. */
export function ptyWrapper(cmd: string | undefined): string[] {
  return [
    "sh",
    "-c",
    `${PID_PRINT}; if [ -n "$1" ]; then exec sh -c "$1"; elif command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi`,
    "sbox-pty",
    cmd ?? "",
  ];
}

/** Normalize a signal name: `"SIGTERM"`/`"term"`/`"15"` -> `"TERM"`/`"15"`. */
export function signalName(sig: string | undefined, fallback = "KILL"): string {
  const s = (sig ?? fallback).toUpperCase().replace(/^SIG/, "");
  if (!/^[A-Z0-9]+$/.test(s)) {
    throw new SandboxError(
      "Validation",
      `invalid signal ${JSON.stringify(sig)}`,
      {
        provider: "docker",
      }
    );
  }
  return s;
}

/**
 * Shell script that signals `pid` and every descendant. The tree is collected
 * first (via /proc PPid) so children reparented on the parent's death are not
 * missed. Needs only `sh`, `grep`, `cut` and `kill`.
 */
export function killTreeScript(pid: string, sig: string): string {
  if (!/^\d+$/.test(pid)) {
    throw new SandboxError("Validation", `invalid pid ${JSON.stringify(pid)}`, {
      provider: "docker",
    });
  }
  return [
    String.raw`t(){ echo "$1"; for c in $(grep -ls "^PPid:[[:space:]]*$1\$" /proc/[0-9]*/status 2>/dev/null | cut -d/ -f3); do t "$c"; done; }`,
    `kill -${signalName(sig)} $(t ${pid}) 2>/dev/null`,
    "true",
  ].join("; ");
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

/** Normalize to an absolute, `..`-free path. */
export function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of (p.startsWith("/") ? p : `/${p}`).split("/")) {
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return `/${parts.join("/")}`;
}

export function dirnameOf(p: string): string {
  const n = normalizePath(p);
  const i = n.lastIndexOf("/");
  return i <= 0 ? "/" : n.slice(0, i);
}

export function basenameOf(p: string): string {
  const n = normalizePath(p);
  return n.slice(n.lastIndexOf("/") + 1);
}

const GO_MODE_DIR = 2 ** 31;
const GO_MODE_SYMLINK = 2 ** 27;

/** Decode the `X-Docker-Container-Path-Stat` header (base64 JSON, Go FileMode). */
export function parsePathStat(header: string, path: string): FileInfo {
  const bin = atob(header.trim());
  const json = new TextDecoder().decode(
    Uint8Array.from(bin, (c) => c.codePointAt(0) ?? 0)
  );
  const st = JSON.parse(json) as {
    name?: string;
    size?: number;
    mode?: number;
    mtime?: string;
    linkTarget?: string;
  };
  const mode = st.mode ?? 0;
  const type =
    Math.floor(mode / GO_MODE_DIR) % 2 === 1
      ? "dir"
      : Math.floor(mode / GO_MODE_SYMLINK) % 2 === 1
        ? "symlink"
        : "file";
  const mtime = st.mtime ? new Date(st.mtime) : undefined;
  return {
    mtime: mtime && !Number.isNaN(mtime.getTime()) ? mtime : undefined,
    path,
    size: type === "dir" ? 0 : (st.size ?? 0),
    type,
  };
}

// ---------------------------------------------------------------------------
// spec -> container create body
// ---------------------------------------------------------------------------

export interface CreateContext {
  /** Image (template id, snapshot ref or default). */
  image: string;
  /** Labels on that image (template metadata such as `sbox.startCmd`). */
  imageLabels?: Record<string, string> | null;
  idempotencyKey?: string;
  /** Keep-alive command when the image has no sbox start command. */
  defaultCommand: string[] | "image";
  /** Host IP published ports bind to. */
  bindIp: string;
  /** Source for `secrets` that carry no inline value (the host env). */
  hostEnv?: Record<string, string | undefined>;
}

function resourcesFrom(
  spec: ResolvedSandboxSpec,
  imageLabels: Record<string, string> | null | undefined
): ResourceSpec | undefined {
  if (spec.resources) {
    return spec.resources;
  }
  const raw = imageLabels?.[LABEL.resources];
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as ResourceSpec;
  } catch {
    return undefined;
  }
}

/**
 * Map a resolved spec to a `POST /containers/create` body. Throws Validation
 * for things Docker cannot express (allow-list egress, egress-injected
 * secrets, missing secret values).
 */
export function buildCreateBody(
  spec: ResolvedSandboxSpec,
  ctx: CreateContext
): ContainerCreateBody {
  const labels: Record<string, string> = {
    // Always set (possibly blank) so labels inherited from a snapshot image
    // never make this container answer to someone else's key or name.
    [LABEL.idempotency]: ctx.idempotencyKey ?? "",
    [LABEL.managed]: "true",
    ...metadataLabels(spec.metadata),
    [LABEL.name]: spec.name ?? "",
  };

  const env: string[] = [];
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    env.push(`${k}=${v}`);
  }
  for (const s of spec.secrets ?? []) {
    if (s.mode === "egress") {
      throw new SandboxError(
        "Validation",
        `secret '${s.name}' uses mode "egress", which needs an egress proxy; docker only supports env secrets`,
        { provider: "docker" }
      );
    }
    const value = s.value ?? ctx.hostEnv?.[s.name];
    if (value === undefined) {
      throw new SandboxError(
        "Validation",
        `secret '${s.name}' has no value and is not set in the host environment`,
        { provider: "docker" }
      );
    }
    env.push(`${s.envVar ?? s.name}=${value}`);
  }

  const host: HostConfig = { Init: true };
  const res = resourcesFrom(spec, ctx.imageLabels);
  if (res?.vcpus !== undefined) {
    host.NanoCpus = Math.round(res.vcpus * 1e9);
  }
  if (res?.memoryMB !== undefined) {
    host.Memory = Math.round(res.memoryMB * 1_048_576);
  }
  if (res?.shmMB !== undefined) {
    host.ShmSize = Math.round(res.shmMB * 1_048_576);
  }
  if (res?.gpu !== undefined || res?.gpuCount !== undefined) {
    const ids =
      res.gpu && /^\d+(,\d+)*$/.test(res.gpu) ? res.gpu.split(",") : undefined;
    host.DeviceRequests = [
      {
        Capabilities: [["gpu"]],
        ...(ids
          ? { DeviceIDs: ids }
          : { Count: res.gpuCount ?? (res.gpu === "all" ? -1 : 1) }),
      },
    ];
  }

  let exposed: Record<string, Record<string, never>> | undefined;
  if (spec.ports && spec.ports.length > 0) {
    exposed = {};
    host.PortBindings = {};
    for (const port of spec.ports) {
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new SandboxError("Validation", `invalid port ${port}`, {
          provider: "docker",
        });
      }
      exposed[`${port}/tcp`] = {};
      host.PortBindings[`${port}/tcp`] = [{ HostIp: ctx.bindIp, HostPort: "" }];
    }
  }

  if (spec.volumes && spec.volumes.length > 0) {
    host.Mounts = spec.volumes.map((v) => ({
      ReadOnly: v.readOnly ?? false,
      Source: v.id,
      Target: v.mountPath,
      // An absolute host path is a bind mount; anything else a named volume.
      Type: v.id.startsWith("/") ? "bind" : "volume",
    }));
  }

  const net = spec.network;
  if (net) {
    if (net.mode === "allow-list") {
      throw new SandboxError(
        "Validation",
        "docker cannot enforce an egress allow-list; use mode 'block-all' or 'allow-all'",
        { provider: "docker" }
      );
    }
    if (net.deny || (net.inject && net.inject.length > 0)) {
      throw new SandboxError(
        "Validation",
        "docker does not support egress deny rules or credential injection",
        { provider: "docker" }
      );
    }
    if (net.mode === "block-all") {
      host.NetworkMode = "none";
    }
  }

  const body: ContainerCreateBody = {
    HostConfig: host,
    Image: ctx.image,
    Labels: labels,
  };
  const startCmd = ctx.imageLabels?.[LABEL.startCmd];
  if (startCmd) {
    body.Cmd = ["sh", "-c", startCmd];
  } else if (ctx.defaultCommand !== "image") {
    body.Cmd = [...ctx.defaultCommand];
  }
  if (env.length > 0) {
    body.Env = env;
  }
  if (exposed) {
    body.ExposedPorts = exposed;
  }
  return body;
}

// ---------------------------------------------------------------------------
// stats -> metrics
// ---------------------------------------------------------------------------

export interface ContainerStats {
  read?: string;
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: Record<string, number>;
  };
}

/** `docker stats`-style CPU% (all cores = 100% * n) and memory (minus page cache). */
export function computeMetrics(stats: ContainerStats): SandboxMetrics {
  const cpu = stats.cpu_stats;
  const pre = stats.precpu_stats;
  let cpuPercent: number | undefined;
  const cpuDelta =
    (cpu?.cpu_usage?.total_usage ?? 0) - (pre?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (cpu?.system_cpu_usage ?? 0) - (pre?.system_cpu_usage ?? 0);
  const online = cpu?.online_cpus ?? cpu?.cpu_usage?.percpu_usage?.length ?? 1;
  if (sysDelta > 0 && cpuDelta >= 0 && pre?.system_cpu_usage) {
    cpuPercent = (cpuDelta / sysDelta) * online * 100;
  } else if (pre?.system_cpu_usage) {
    cpuPercent = 0;
  }
  const mem = stats.memory_stats;
  let memoryUsedMB: number | undefined;
  let memoryTotalMB: number | undefined;
  if (mem?.usage !== undefined) {
    const cache =
      mem.stats?.inactive_file ??
      mem.stats?.total_inactive_file ??
      mem.stats?.cache ??
      0;
    memoryUsedMB = Math.max(0, mem.usage - cache) / 1_048_576;
  }
  if (mem?.limit !== undefined) {
    memoryTotalMB = mem.limit / 1_048_576;
  }
  const ts = stats.read ? new Date(stats.read) : new Date();
  return {
    cpuPercent,
    memoryTotalMB,
    memoryUsedMB,
    raw: stats,
    timestamp:
      Number.isNaN(ts.getTime()) || ts.getFullYear() < 2000 ? new Date() : ts,
  };
}
