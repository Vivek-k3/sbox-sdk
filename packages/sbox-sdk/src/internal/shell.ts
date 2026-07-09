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

/** POSIX-ish env var name: letter/underscore, then letters/digits/underscores. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  /** The ExecOptions to pass to the adapter (cwd/env stripped if baked into the command). */
  execOptions: ExecOptions;
  /** Whether the core should parse an exit-code marker out of stdout. */
  parseExitMarker: boolean;
}

/**
 * Unconditionally bake cwd/env into a compound shell string — no `sh -c` wrapper
 * and no exit marker. `buildExecCommand` uses this for providers that can't take
 * per-command cwd/env; the tail-streaming path uses it for every provider, so the
 * detached inner command carries its own environment.
 */
export function bakeCwdEnv(
  rawCmd: string,
  cwd: string | undefined,
  env: Record<string, string> | undefined
): string {
  let inner = rawCmd;
  if (env && Object.keys(env).length > 0) {
    const exports = Object.entries(env)
      .map(([k, v]) => {
        if (!ENV_KEY_RE.test(k)) {
          throw new SandboxError(
            "Validation",
            `invalid environment variable name: ${JSON.stringify(k)}`
          );
        }
        return `export ${k}=${shellQuote(v)};`;
      })
      .join(" ");
    inner = `${exports} ${inner}`;
  }
  if (cwd) {
    inner = `cd ${shellQuote(cwd)} && ${inner}`;
  }
  return inner;
}

/**
 * Decide how a command is executed given a provider's behavioral flags:
 * - native cwd/env  -> pass cwd/env straight through as ExecOptions
 * - emulated cwd/env -> bake `cd ... && export ...; cmd` into a `sh -c` string
 * - non-native exit code -> append `; echo __sbox_rc=$?` for the core to parse
 */
export function buildExecCommand(
  rawCmd: string,
  opts: ExecOptions,
  flags: CapabilityFlags
): BuiltExec {
  const needsExitMarker = !flags.exitCodeNative;
  const hasCwd = !!opts.cwd;
  const hasEnv = !!opts.env && Object.keys(opts.env).length > 0;
  const emulateCwdEnv = !flags.perCommandEnvCwd && (hasCwd || hasEnv);

  if (!emulateCwdEnv && !needsExitMarker) {
    return { command: rawCmd, execOptions: opts, parseExitMarker: false };
  }

  let inner = rawCmd;
  if (needsExitMarker) {
    inner = `${inner}; echo ${EXIT_MARKER}=$?`;
  }
  if (emulateCwdEnv) {
    inner = bakeCwdEnv(inner, opts.cwd, opts.env);
  }

  // Strip the now-baked cwd/env from the options handed to the adapter.
  const execOptions: ExecOptions = { ...opts };
  if (emulateCwdEnv) {
    delete execOptions.cwd;
    delete execOptions.env;
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
