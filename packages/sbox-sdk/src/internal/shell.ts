/**
 * Shell emulation primitives. These build command STRINGS that run INSIDE the
 * remote sandbox via the adapter's `exec` — there is no local `child_process`
 * here. All interpolated values are single-quoted with `shellQuote` so user
 * input cannot break out of the intended command.
 */
import type { CapabilityFlags } from "./capabilities.js";
import { SandboxError } from "./errors.js";
import type { DirEntry, ExecOptions } from "./types.js";

export const EXIT_MARKER = "__sbox_rc";

/** POSIX-safe single-quote escaping: wrap in '...', and encode embedded quotes. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function joinCmd(cmd: string | string[]): string {
  return Array.isArray(cmd) ? cmd.map(shellQuote).join(" ") : cmd;
}

export interface BuiltExec {
  /** The command string to hand to the adapter's exec. */
  command: string;
  /** The ExecOptions to pass to the adapter (cwd/env/stdin stripped if baked in). */
  execOptions: ExecOptions;
  /** Whether the core should parse an exit-code marker out of stdout. */
  parseExitMarker: boolean;
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Throw on env var names that could break out of an `export K=...`. */
export function assertEnvKeys(env: Record<string, string> | undefined): void {
  if (!env) {
    return;
  }
  for (const key of Object.keys(env)) {
    if (!ENV_KEY_RE.test(key)) {
      throw new SandboxError(
        "Validation",
        `invalid environment variable name: ${JSON.stringify(key)}`
      );
    }
  }
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x80_00) {
    bin += String.fromCodePoint(...bytes.subarray(i, i + 0x80_00));
  }
  return btoa(bin);
}

/**
 * Decide how a command is executed given a provider's behavioral flags:
 * - native cwd/env  -> pass cwd/env straight through as ExecOptions
 * - emulated cwd/env -> bake `cd ... && export ... && { cmd; }` into `sh -c`
 * - non-native exit code -> append `; echo __sbox_rc=$?` for the core to parse
 * - buffered stdin (string/bytes) -> pipe it in via `printf <b64> | base64 -d`
 *
 * A failing `cd` aborts the command (it never runs in the wrong directory).
 */
export function buildExecCommand(
  rawCmd: string,
  opts: ExecOptions,
  flags: Pick<CapabilityFlags, "exitCodeNative" | "perCommandEnvCwd">
): BuiltExec {
  assertEnvKeys(opts.env);
  const needsExitMarker = !flags.exitCodeNative;
  const hasCwd = !!opts.cwd;
  const hasEnv = !!opts.env && Object.keys(opts.env).length > 0;
  const emulateCwdEnv = !flags.perCommandEnvCwd && (hasCwd || hasEnv);
  const stdin = opts.stdin;
  const pipeStdin = typeof stdin === "string" || stdin instanceof Uint8Array;

  if (!emulateCwdEnv && !needsExitMarker && !pipeStdin) {
    return { command: rawCmd, execOptions: opts, parseExitMarker: false };
  }

  let inner = `{ ${rawCmd}
}`;
  if (pipeStdin) {
    const bytes =
      typeof stdin === "string" ? new TextEncoder().encode(stdin) : stdin;
    inner = `printf '%s' ${shellQuote(bytesToB64(bytes))} | base64 -d | ${inner}`;
  }
  if (emulateCwdEnv) {
    const prefix: string[] = [];
    if (hasCwd) {
      prefix.push(`cd ${shellQuote(opts.cwd as string)}`);
    }
    if (hasEnv) {
      for (const [k, v] of Object.entries(opts.env as Record<string, string>)) {
        prefix.push(`export ${k}=${shellQuote(v)}`);
      }
    }
    inner = `${prefix.join(" && ")} && ${inner}`;
  }
  if (needsExitMarker) {
    inner = `${inner}; echo ${EXIT_MARKER}=$?`;
  }

  // Strip what is now baked into the command from the adapter's options.
  const execOptions: ExecOptions = { ...opts };
  if (emulateCwdEnv) {
    delete execOptions.cwd;
    delete execOptions.env;
  }
  if (pipeStdin) {
    delete execOptions.stdin;
  }

  return {
    command: `sh -c ${shellQuote(inner)}`,
    execOptions,
    parseExitMarker: needsExitMarker,
  };
}

/** Parse `ls -1Ap <dir>` output (names; dirs have a trailing slash) into DirEntry[]. */
export function parseLsOutput(output: string, dir: string): DirEntry[] {
  const base = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  const entries: DirEntry[] = [];
  for (const line of output.split("\n")) {
    const name = line.trimEnd();
    if (!name) {
      continue;
    }
    const isDir = name.endsWith("/");
    const clean = isDir ? name.slice(0, -1) : name;
    entries.push({
      name: clean,
      path: `${base}/${clean}`,
      type: isDir ? "dir" : "file",
    });
  }
  return entries;
}

/** Parse `stat -c '%F|%s|%Y' <path>` (GNU coreutils, Linux sandboxes). */
export function parseStatOutput(
  output: string
): { type: "file" | "dir" | "symlink"; size: number; mtime?: Date } | null {
  const parts = output.trim().split("|");
  if (parts.length < 2) {
    return null;
  }
  const kind = parts[0] ?? "";
  const size = Number(parts[1] ?? "0");
  const mtimeEpoch = parts[2] ? Number(parts[2]) : undefined;
  const type =
    kind === "directory"
      ? "dir"
      : kind.includes("symbolic")
        ? "symlink"
        : "file";
  return {
    mtime: mtimeEpoch ? new Date(mtimeEpoch * 1000) : undefined,
    size: Number.isFinite(size) ? size : 0,
    type,
  };
}
