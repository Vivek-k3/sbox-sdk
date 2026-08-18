/**
 * Provider-agnostic live streaming. Most providers expose only a *fire-once*
 * exec: the command runs to completion and the whole output arrives in one
 * chunk. This module makes those providers stream by running the user's command
 * detached inside the sandbox — stdout and stderr redirected to files — and then
 * tailing those files with a loop of short, ordinary execs. Each poll returns
 * only the bytes written since the last one, so output surfaces as it is
 * produced. It also gives those providers a working `kill()`, real pids, proper
 * stderr separation, and freedom from the transport's request timeout.
 *
 * The result is a plain `DriverExec`, so everything above that boundary — the
 * pump in `exec.ts`, the await/for-await duality, `onStdout`/`onStderr`, the byte
 * streams — is untouched and provider-agnostic already.
 *
 * SAFETY: the user's command must never run twice. Falling back to the plain
 * buffered exec is legal only *before* the command could have started, i.e. from
 * a failed probe or from LAUNCH's pre-spawn failure sentinel. Every later
 * failure errors the handle instead. Commands are not assumed idempotent.
 *
 * Web-standard only (no `node:` imports) — the core also runs inside a Worker.
 */
import type { CapabilityLevel } from "./capabilities.js";
import { base64ToBytes } from "./encoding.js";
import { SandboxError } from "./errors.js";
import { createExecHandle } from "./exec.js";
import { bakeCwdEnv, shellQuote } from "./shell.js";
import { AsyncQueue } from "./stream.js";
import type {
  DriverExec,
  ExecOptions,
  OutputEvent,
  StreamingMode,
  StreamingOptions,
} from "./types.js";

export const TAIL_OK = "__sbox_tail_ok";
export const TAIL_FAIL = "__sbox_tail_fail";
export const DEFAULT_TMP_DIR = "/tmp/.sbox";

const DEFAULT_MIN_POLL_MS = 150;
const DEFAULT_MAX_POLL_MS = 1000;
const DEFAULT_MAX_CHUNK_BYTES = 262_144;
const BACKOFF_FACTOR = 1.5;

const PROBE_TIMEOUT_MS = 15_000;
const LAUNCH_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 30_000;
const SIDECAR_TIMEOUT_MS = 15_000;

/** Consecutive failed polls tolerated before the handle errors. */
const MAX_POLL_FAILURES = 3;
/** Consecutive `R:gone` reads required before we believe the wrapper died. */
const GONE_CONFIRMATIONS = 2;
/** How long the wrapper may sit in `R:boot` before we give up on it. */
const DEFAULT_BOOT_TIMEOUT_MS = 10_000;
/** Grace between TERM and KILL when a timeout or abort fires. */
const KILL_GRACE_MS = 2000;

const OUT_RE = /^O:([A-Za-z0-9+/=]*)$/m;
const ERR_RE = /^E:([A-Za-z0-9+/=]*)$/m;
const PID_RE = /^P:(.*)$/m;
const STATE_RE = /^R:(.*)$/m;
const RC_RE = /^-?\d+$/;

const SIGNAL_NUMBERS: Record<string, number> = {
  HUP: 1,
  INT: 2,
  QUIT: 3,
  KILL: 9,
  TERM: 15,
};

/**
 * Normalizes a signal name.
 *
 * @param signal - The signal name to normalize
 * @returns The uppercase signal name with an optional `SIG` prefix removed, or `TERM` when no signal is provided
 */
function normalizeSignal(signal: string | undefined): string {
  if (!signal) {
    return "TERM";
  }
  const bare = signal.startsWith("SIG") ? signal.slice(3) : signal;
  return bare.toUpperCase();
}

/**
 * Converts a signal name to its numeric value.
 *
 * @param signal - The signal name to convert
 * @returns The numeric signal value, or `15` for unknown signals
 */
function signalNumber(signal: string): number {
  return SIGNAL_NUMBERS[normalizeSignal(signal)] ?? 15;
}

/**
 * Validates that a value is a positive finite integer.
 *
 * @param name - The configuration field name used in the error message
 * @param value - The value to validate
 * @returns The validated value
 */
function positiveInteger(name: string, value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new SandboxError(
      "Validation",
      `streaming.${name} must be a positive finite integer`
    );
  }
  return value;
}

/**
 * Validates an optional positive integer.
 *
 * @param name - The value name used in validation errors
 * @param value - The value to validate
 * @returns The validated integer, or `undefined` when no value is provided
 */
function optionalPositiveInteger(
  name: string,
  value: number | undefined
): number | undefined {
  return value === undefined ? undefined : positiveInteger(name, value);
}

// ---------------------------------------------------------------------------
// Shell templates
// ---------------------------------------------------------------------------

/**
 * Wraps a script for execution with `sh -c`.
 *
 * @param script - The shell script to wrap
 * @returns The wrapped command string
 */
export function shWrap(script: string): string {
  return `sh -c ${shellQuote(script)}`;
}

/**
 * Builds a shell probe for tail-streaming support.
 *
 * @param tmpDir - Temporary directory to create and test inside the sandbox
 * @returns A shell script that prints `TAIL_OK` when the required file operations and utilities are available, or `TAIL_FAIL` otherwise
 */
export function buildTailProbe(tmpDir: string): string {
  const qt = shellQuote(tmpDir);
  return [
    `if mkdir -p ${qt} 2>/dev/null && : > ${qt}/.probe 2>/dev/null \\`,
    "   && printf abc | head -c 1 >/dev/null 2>&1 \\",
    "   && printf abc | tail -c +2 >/dev/null 2>&1 \\",
    "   && printf abc | base64 >/dev/null 2>&1 \\",
    "   && printf 'a\\nb' | tr -d '\\n' >/dev/null 2>&1",
    `then echo ${TAIL_OK}; else echo ${TAIL_FAIL}; fi`,
  ].join("\n");
}

/**
 * Builds the detached wrapper script that runs the user command and records its process ID, output, and exit code.
 *
 * @param dir - The run directory for wrapper state files
 * @param bakedUserCmd - The shell-quoted user command to execute inside the wrapper
 */
export function buildTailInner(dir: string, bakedUserCmd: string): string {
  const qd = shellQuote(dir);
  const qu = shellQuote(bakedUserCmd);
  return [
    `printf %s $$ > ${qd}/pid.tmp && mv ${qd}/pid.tmp ${qd}/pid`,
    `( sh -c ${qu}`,
    `) </dev/null >>${qd}/out 2>>${qd}/err`,
    `printf %s $? > ${qd}/rc.tmp && mv ${qd}/rc.tmp ${qd}/rc`,
  ].join("\n");
}

/**
 * Builds the launch script for the detached tail-stream wrapper.
 *
 * @param dir - Run directory for wrapper state and output files
 * @param innerCmd - Shell command that runs the wrapper body
 * @returns A shell script that initializes the run directory, starts the wrapper detached, and prints a launch sentinel
 */
export function buildTailLaunch(dir: string, innerCmd: string): string {
  const qd = shellQuote(dir);
  const qi = shellQuote(innerCmd);
  return [
    `d=${qd}`,
    'if ! mkdir -p "$d" 2>/dev/null || ! : > "$d/out" 2>/dev/null || ! : > "$d/err" 2>/dev/null; then',
    `  echo ${TAIL_FAIL}; exit 0`,
    "fi",
    'printf %s 0 > "$d/pid"',
    "if command -v setsid >/dev/null 2>&1; then",
    `  nohup setsid sh -c ${qi} >/dev/null 2>&1 </dev/null &`,
    "else",
    `  nohup sh -c ${qi} >/dev/null 2>&1 </dev/null &`,
    "fi",
    `echo ${TAIL_OK}`,
  ].join("\n");
}

/**
 * Builds a poll script that returns newly written output bytes and wrapper state.
 *
 * @param dir - Run directory containing the wrapper files
 * @param outOff - Byte offset for stdout
 * @param errOff - Byte offset for stderr
 * @param cap - Maximum number of bytes to read from each channel
 * @returns A shell script that emits base64-encoded stdout and stderr chunks, the wrapper PID, and `R:*` state
 */
export function buildTailPoll(
  dir: string,
  outOff: number,
  errOff: number,
  cap: number
): string {
  const qd = shellQuote(dir);
  return [
    `d=${qd}`,
    'if [ -f "$d/rc" ]; then r=$(cat "$d/rc"); else r=; fi',
    "printf O:",
    `tail -c +${outOff + 1} "$d/out" 2>/dev/null | head -c ${cap} | base64 | tr -d '\\n'`,
    "printf '\\nE:'",
    `tail -c +${errOff + 1} "$d/err" 2>/dev/null | head -c ${cap} | base64 | tr -d '\\n'`,
    "printf '\\n'",
    'p=$(cat "$d/pid" 2>/dev/null) || p=',
    `printf 'P:%s\\n' "$p"`,
    `if [ -n "$r" ]; then printf 'R:%s\\n' "$r"`,
    'elif [ -z "$p" ] || [ "$p" = 0 ]; then echo R:boot',
    'elif kill -0 "$p" 2>/dev/null; then echo R:run',
    "else echo R:gone",
    "fi",
  ].join("\n");
}

/**
 * Builds a shell command that signals the recorded wrapper process.
 *
 * @param sig - The signal name to send.
 * @returns A shell script that sends the signal to the wrapper's process group when possible, otherwise to the wrapper process itself.
 */
export function buildTailKill(dir: string, sig: string): string {
  const qd = shellQuote(dir);
  const s = normalizeSignal(sig);
  return [
    `d=${qd}; p=$(cat "$d/pid" 2>/dev/null)`,
    `[ -n "$p" ] && [ "$p" != 0 ] && { kill -s ${s} -- "-$p" 2>/dev/null || kill -s ${s} "$p" 2>/dev/null; }`,
    "true",
  ].join("\n");
}

/**
 * Removes the run directory and its contents.
 *
 * @param dir - The directory to remove
 * @returns A shell command that deletes `dir` recursively
 */
export function buildTailCleanup(dir: string): string {
  return `rm -rf ${shellQuote(dir)}`;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface TailProbeState {
  promise?: Promise<boolean>;
}

export interface ResolvedStreaming extends StreamingOptions {
  mode: StreamingMode;
}

/**
 * Applies defaults and validates streaming settings.
 *
 * @param streaming - Streaming configuration to normalize
 * @returns The resolved streaming configuration with default values applied
 */
export function resolveStreaming(
  streaming: StreamingOptions | undefined
): ResolvedStreaming {
  const resolved: ResolvedStreaming = {
    ...streaming,
    mode: streaming?.mode ?? "auto",
  };
  const minPollMs = optionalPositiveInteger("minPollMs", streaming?.minPollMs);
  const maxPollMs = optionalPositiveInteger("maxPollMs", streaming?.maxPollMs);
  const maxChunkBytes = optionalPositiveInteger(
    "maxChunkBytes",
    streaming?.maxChunkBytes
  );
  if (minPollMs !== undefined) {
    resolved.minPollMs = minPollMs;
  }
  if (maxPollMs !== undefined) {
    resolved.maxPollMs = maxPollMs;
  }
  if (maxChunkBytes !== undefined) {
    resolved.maxChunkBytes = maxChunkBytes;
  }
  if (
    minPollMs !== undefined &&
    maxPollMs !== undefined &&
    minPollMs > maxPollMs
  ) {
    throw new SandboxError(
      "Validation",
      "streaming.minPollMs must be less than or equal to streaming.maxPollMs"
    );
  }
  return resolved;
}

/**
 * Determines whether the in-sandbox tail streaming path applies.
 *
 * @returns `true` when tail streaming is enabled for the current request, `false` otherwise.
 */
export function shouldTailStream(args: {
  mode: StreamingMode;
  streamingCapability: CapabilityLevel;
  exitCodeNative: boolean;
  opts: ExecOptions;
}): boolean {
  const { mode, streamingCapability, exitCodeNative, opts } = args;
  return (
    (mode === "auto" || mode === "tail") &&
    streamingCapability === "emulated" &&
    exitCodeNative &&
    opts.stream !== false &&
    opts.stdin === undefined
  );
}

export interface TailExecConfig {
  transportExec: (cmd: string, opts: ExecOptions) => DriverExec;
  fallbackExec: () => DriverExec;
  command: string;
  opts: ExecOptions;
  probeState: TailProbeState;
  strict?: boolean;
  tmpDir?: string;
  minPollMs?: number;
  maxPollMs?: number;
  maxChunkBytes?: number;
  bootTimeoutMs?: number;
}

/** Poll states the sandbox may report. */
const VALID_STATES = new Set(["run", "boot", "gone"]);

interface PollReading {
  out: Uint8Array;
  err: Uint8Array;
  pid: string;
  state: string;
}

type LaunchOutcome = "ok" | "prespawn-fail";

/**
 * Sleeps until the delay elapses or the abort signal fires.
 *
 * @param ms - The delay in milliseconds
 * @param signal - An abort signal that can end the wait early
 * @returns Resolves when the delay completes or the signal is aborted
 */
function sleepUntil(ms: number, signal?: AbortSignal): Promise<void> {
  const held: { id?: ReturnType<typeof setTimeout>; onAbort?: () => void } = {};
  const sleep = new Promise<void>((resolve) => {
    held.id = setTimeout(resolve, ms);
  });
  if (!signal) {
    return sleep;
  }
  const aborted = new Promise<void>((resolve) => {
    held.onAbort = () => resolve();
    signal.addEventListener("abort", held.onAbort, { once: true });
  });
  return Promise.race([sleep, aborted]).finally(() => {
    clearTimeout(held.id);
    if (held.onAbort) {
      signal.removeEventListener("abort", held.onAbort);
    }
  });
}

/**
 * Delays for the requested duration.
 *
 * @param signal - Aborts the delay early when already aborted or during the wait
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) {
    return Promise.resolve();
  }
  return sleepUntil(ms, signal);
}

class TailExec implements DriverExec {
  readonly #cfg: TailExecConfig;
  readonly #queue = new AsyncQueue<OutputEvent>();
  readonly #dir: string;
  readonly #tmpDir: string;
  readonly #minPollMs: number;
  readonly #maxPollMs: number;
  readonly #cap: number;
  readonly #bootTimeoutMs: number;

  readonly #outDecoder = new TextDecoder();
  readonly #errDecoder = new TextDecoder();

  #outOff = 0;
  #errOff = 0;

  readonly pid: Promise<string>;
  #resolvePid!: (v: string) => void;
  #pidResolved = false;

  /** Set once the user requested a kill. */
  #killSignal: string | undefined;
  #killRequested: string | undefined;
  #launched = false;
  #timedOut = false;
  #settled = false;
  #fallback: DriverExec | undefined;

  constructor(cfg: TailExecConfig) {
    this.#cfg = cfg;
    this.#tmpDir = cfg.tmpDir ?? DEFAULT_TMP_DIR;
    this.#dir = `${this.#tmpDir}/${globalThis.crypto.randomUUID()}`;
    this.#minPollMs =
      optionalPositiveInteger("minPollMs", cfg.minPollMs) ??
      DEFAULT_MIN_POLL_MS;
    this.#maxPollMs =
      optionalPositiveInteger("maxPollMs", cfg.maxPollMs) ??
      DEFAULT_MAX_POLL_MS;
    if (this.#minPollMs > this.#maxPollMs) {
      throw new SandboxError(
        "Validation",
        "streaming.minPollMs must be less than or equal to streaming.maxPollMs"
      );
    }
    this.#cap =
      optionalPositiveInteger("maxChunkBytes", cfg.maxChunkBytes) ??
      DEFAULT_MAX_CHUNK_BYTES;
    this.#bootTimeoutMs =
      optionalPositiveInteger("bootTimeoutMs", cfg.bootTimeoutMs) ??
      DEFAULT_BOOT_TIMEOUT_MS;
    this.pid = new Promise<string>((resolve) => {
      this.#resolvePid = resolve;
    });
    // Eager, like every adapter's exec.
    void this.#drive();
  }

  [Symbol.asyncIterator](): AsyncIterator<OutputEvent> {
    return this.#queue.iterator();
  }

  async kill(signal?: string): Promise<void> {
    if (this.#fallback) {
      await this.#fallback.kill(signal);
      return;
    }
    const sig = normalizeSignal(signal);
    this.#killSignal = sig;
    this.#killRequested = sig;
    if (this.#launched) {
      await this.#sidecar(buildTailKill(this.#dir, sig));
    }
  }

  async #sidecar(script: string): Promise<void> {
    try {
      await this.#run(shWrap(script), {
        timeoutMs: SIDECAR_TIMEOUT_MS,
        ...(this.#cfg.opts.user ? { user: this.#cfg.opts.user } : {}),
      });
    } catch {
      // Sidecars must not mask the real outcome.
    }
  }

  #run(cmd: string, opts: ExecOptions) {
    return createExecHandle(this.#cfg.transportExec(cmd, opts));
  }

  /** Transport options for plumbing execs. */
  #plumbingOpts(timeoutMs: number, signal?: AbortSignal): ExecOptions {
    const { user } = this.#cfg.opts;
    return {
      timeoutMs,
      ...(user ? { user } : {}),
      ...(signal ? { signal } : {}),
    };
  }

  async #drive(): Promise<void> {
    try {
      const { signal } = this.#cfg.opts;
      if (signal?.aborted) {
        this.#fail(
          new SandboxError("Provider", "command aborted", {
            aborted: true,
            cause: signal.reason,
          })
        );
        return;
      }
      if (!(await this.#probe())) {
        await this.#bail("sandbox cannot host in-sandbox streaming");
        return;
      }
      if ((await this.#launch()) === "prespawn-fail") {
        await this.#bail("could not create the in-sandbox run directory");
        return;
      }
      this.#launched = true;
      if (this.#killRequested) {
        await this.#sidecar(buildTailKill(this.#dir, this.#killRequested));
      }
      await this.#pollLoop();
    } catch (error) {
      this.#fail(error);
    }
  }

  async #bail(reason: string): Promise<void> {
    if (this.#cfg.strict) {
      throw new SandboxError(
        "Provider",
        `streaming mode "tail" was requested but ${reason}`
      );
    }
    const source = this.#cfg.fallbackExec();
    this.#fallback = source;
    void source.pid.then((p) => this.#setPid(p)).catch(() => this.#setPid(""));
    if (this.#killRequested) {
      void source.kill(this.#killRequested).catch(() => {});
    }
    try {
      for await (const ev of source) {
        this.#queue.push(ev);
      }
      this.#queue.close();
    } catch (error) {
      this.#queue.fail(error);
    }
  }

  #probe(): Promise<boolean> {
    const { probeState } = this.#cfg;
    probeState.promise ??= (async () => {
      try {
        const res = await this.#run(
          shWrap(buildTailProbe(this.#tmpDir)),
          this.#plumbingOpts(PROBE_TIMEOUT_MS)
        );
        return res.exitCode === 0 && res.stdout.includes(TAIL_OK);
      } catch {
        return false;
      }
    })();
    return probeState.promise;
  }

  async #launch(): Promise<LaunchOutcome> {
    const { command, opts } = this.#cfg;
    const baked = bakeCwdEnv(command, opts.cwd, opts.env);
    const script = buildTailLaunch(this.#dir, buildTailInner(this.#dir, baked));

    let stdout: string;
    try {
      const res = await this.#run(
        shWrap(script),
        this.#plumbingOpts(LAUNCH_TIMEOUT_MS, opts.signal)
      );
      stdout = res.stdout;
    } catch (error) {
      if (opts.signal?.aborted) {
        throw new SandboxError("Provider", "command aborted", {
          aborted: true,
          cause: error,
        });
      }
      // Spawn may or may not have happened; re-running is unacceptable.
      throw new SandboxError(
        "Provider",
        "streaming launch failed in an unknown state; refusing to re-run the command",
        { cause: error }
      );
    }

    if (stdout.includes(TAIL_FAIL)) {
      return "prespawn-fail";
    }
    if (stdout.includes(TAIL_OK)) {
      return "ok";
    }
    throw new SandboxError(
      "Provider",
      "streaming launch produced no sentinel; refusing to re-run the command"
    );
  }

  async #poll(): Promise<PollReading> {
    const script = buildTailPoll(
      this.#dir,
      this.#outOff,
      this.#errOff,
      this.#cap
    );
    const res = await this.#run(
      shWrap(script),
      this.#plumbingOpts(POLL_TIMEOUT_MS, this.#cfg.opts.signal)
    );
    const { stdout } = res;
    const outM = OUT_RE.exec(stdout);
    const errM = ERR_RE.exec(stdout);
    const state = (STATE_RE.exec(stdout)?.[1] ?? "").trim();
    if (!(outM && errM) || !(RC_RE.test(state) || VALID_STATES.has(state))) {
      throw new SandboxError("Provider", "unparseable streaming poll response");
    }
    return {
      err: base64ToBytes(errM[1] ?? ""),
      out: base64ToBytes(outM[1] ?? ""),
      pid: (PID_RE.exec(stdout)?.[1] ?? "").trim(),
      state,
    };
  }

  async #pollLoop(): Promise<void> {
    const { signal, timeoutMs } = this.#cfg.opts;
    const deadline = timeoutMs
      ? Date.now() + timeoutMs
      : Number.POSITIVE_INFINITY;

    let wait = this.#minPollMs;
    let failures = 0;
    let gone = 0;
    let rc: number | undefined;
    let hardKillAt = Number.POSITIVE_INFINITY;
    const bootDeadline = Date.now() + this.#bootTimeoutMs;
    let booted = false;

    for (;;) {
      if (signal?.aborted) {
        this.#killSignal = "TERM";
        await this.#sidecar(buildTailKill(this.#dir, "TERM"));
        this.#fail(
          new SandboxError("Provider", "command aborted", {
            aborted: true,
            cause: signal.reason,
          })
        );
        return;
      }
      if (!this.#timedOut && Date.now() > deadline) {
        this.#timedOut = true;
        this.#killSignal = "TERM";
        hardKillAt = Date.now() + KILL_GRACE_MS;
        await this.#sidecar(buildTailKill(this.#dir, "TERM"));
      } else if (this.#timedOut && Date.now() > hardKillAt) {
        hardKillAt = Number.POSITIVE_INFINITY;
        this.#killSignal = "KILL";
        await this.#sidecar(buildTailKill(this.#dir, "KILL"));
      }

      let reading: PollReading;
      try {
        reading = await this.#poll();
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures >= MAX_POLL_FAILURES) {
          this.#fail(error);
          return;
        }
        await delay(wait, signal);
        continue;
      }

      if (reading.pid && reading.pid !== "0") {
        this.#setPid(reading.pid);
      }

      const got = this.#emit(reading);
      const clipped =
        reading.out.length >= this.#cap || reading.err.length >= this.#cap;

      if (RC_RE.test(reading.state)) {
        rc = Number(reading.state);
      }

      if (
        got > 0 ||
        rc !== undefined ||
        reading.state === "run" ||
        (reading.pid && reading.pid !== "0")
      ) {
        booted = true;
      }

      if (rc !== undefined) {
        if (got > 0) {
          continue;
        }
        await this.#finish(rc);
        return;
      }

      if (got > 0) {
        gone = 0;
        wait = this.#minPollMs;
      } else if (reading.state === "gone") {
        gone += 1;
        if (gone >= GONE_CONFIRMATIONS) {
          await this.#finishGone();
          return;
        }
      } else {
        gone = 0;
        if (!booted && Date.now() > bootDeadline) {
          this.#fail(
            new SandboxError(
              "Provider",
              "streaming wrapper failed to start inside the sandbox"
            )
          );
          return;
        }
      }

      if (clipped) {
        continue;
      }
      await delay(wait, signal);
      if (got === 0) {
        wait = Math.min(this.#maxPollMs, Math.ceil(wait * BACKOFF_FACTOR));
      }
    }
  }

  /** Decode a poll's bytes into events. Returns raw byte count. */
  #emit(reading: PollReading): number {
    if (reading.out.length > 0) {
      this.#outOff += reading.out.length;
      const data = this.#outDecoder.decode(reading.out, { stream: true });
      if (data) {
        this.#queue.push({ data, type: "stdout" });
      }
    }
    if (reading.err.length > 0) {
      this.#errOff += reading.err.length;
      const data = this.#errDecoder.decode(reading.err, { stream: true });
      if (data) {
        this.#queue.push({ data, type: "stderr" });
      }
    }
    return reading.out.length + reading.err.length;
  }

  /** Flush the streaming decoders. */
  #flush(): void {
    const out = this.#outDecoder.decode();
    if (out) {
      this.#queue.push({ data: out, type: "stdout" });
    }
    const err = this.#errDecoder.decode();
    if (err) {
      this.#queue.push({ data: err, type: "stderr" });
    }
  }

  async #finish(exitCode: number): Promise<void> {
    if (this.#timedOut) {
      this.#fail(
        new SandboxError(
          "Timeout",
          `command timed out after ${this.#cfg.opts.timeoutMs}ms`
        )
      );
      return;
    }
    this.#flush();
    this.#settled = true;
    this.#queue.push({
      exitCode,
      synthesized: true,
      type: "exit",
      ...(this.#killSignal ? { signal: this.#killSignal } : {}),
    });
    this.#queue.close();
    await this.#cleanup();
  }

  /** The wrapper is gone and never wrote an rc. */
  async #finishGone(): Promise<void> {
    if (this.#killSignal) {
      await this.#finish(128 + signalNumber(this.#killSignal));
      return;
    }
    this.#fail(
      new SandboxError(
        "Provider",
        "streamed command ended without an exit status"
      )
    );
  }

  #fail(error: unknown): void {
    if (this.#settled) {
      return;
    }
    this.#settled = true;
    this.#setPid("");
    this.#queue.fail(error);
    void this.#cleanup();
  }

  #cleanup(): Promise<void> {
    this.#setPid("");
    return this.#sidecar(buildTailCleanup(this.#dir));
  }

  #setPid(value: string): void {
    if (!this.#pidResolved) {
      this.#pidResolved = true;
      this.#resolvePid(value);
    }
  }
}

/**
 * Creates a tail-streaming exec driver.
 *
 * @param cfg - Tail streaming configuration
 * @returns A `DriverExec` that streams output from the sandboxed wrapper
 */
export function createTailExec(cfg: TailExecConfig): DriverExec {
  return new TailExec(cfg);
}
