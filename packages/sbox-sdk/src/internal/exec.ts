/**
 * Adapts a raw adapter `DriverExec` (an AsyncIterable of output events) into the
 * public `ExecHandle` — which is simultaneously awaitable (buffered ExecResult)
 * and async-iterable (live OutputEvent stream), and also exposes byte streams.
 * A single internal pump drives all consumers, so awaiting and streaming the
 * same handle never double-consumes the source.
 */
import { SandboxError } from "./errors.js";
import type {
  DriverExec,
  ExecHandle,
  ExecResult,
  OutputEvent,
} from "./types.js";

export interface ExecHandleOptions {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onComplete?: (outcome: {
    durationMs: number;
    error?: unknown;
    exitCode?: number;
    ok: boolean;
  }) => void;
  /** Parse `__sbox_rc=N` out of stdout to synthesize the exit code. */
  parseExitMarker?: boolean;
  /** Normalize errors thrown while iterating the source. */
  mapError?: (err: unknown) => SandboxError;
}

const MARKER_RE = /__sbox_rc=(-?\d+)/;
const MARKER_STRIP_RE = /\n?__sbox_rc=-?\d+\s*/g;

class ExecHandleImpl implements ExecHandle {
  readonly #source: DriverExec;
  readonly #opts: ExecHandleOptions;
  readonly #events: OutputEvent[] = [];
  #wakers: (() => void)[] = [];
  #startedPump = false;
  #startedAt = 0;
  #done = false;
  #error: unknown = null;
  #exitCode = 0;
  #synthExit = 0;
  #synthesized = false;

  readonly #resultPromise: Promise<ExecResult>;
  #resolveResult!: (r: ExecResult) => void;
  #rejectResult!: (e: unknown) => void;

  constructor(source: DriverExec, opts: ExecHandleOptions = {}) {
    this.#source = source;
    this.#opts = opts;
    this.#resultPromise = new Promise<ExecResult>((res, rej) => {
      this.#resolveResult = res;
      this.#rejectResult = rej;
    });
  }

  #notify(): void {
    const wakers = this.#wakers;
    this.#wakers = [];
    for (const w of wakers) {
      w();
    }
  }

  #nextTick(): Promise<void> {
    return new Promise<void>((resolve) => this.#wakers.push(resolve));
  }

  #ensureStarted(): void {
    if (this.#startedPump) {
      return;
    }
    this.#startedPump = true;
    this.#startedAt = Date.now();
    void this.#pump();
  }

  #start(): Promise<ExecResult> {
    this.#ensureStarted();
    return this.#resultPromise;
  }

  async #pump(): Promise<void> {
    try {
      for await (const ev of this.#source) {
        this.#handle(ev);
      }
      this.#finish(null);
    } catch (error) {
      this.#finish(error);
    }
  }

  #handle(ev: OutputEvent): void {
    if (ev.type === "exit") {
      this.#exitCode = ev.exitCode;
      this.#events.push(ev);
      this.#notify();
      return;
    }

    let { data } = ev;
    if (ev.type === "stdout" && this.#opts.parseExitMarker) {
      const m = MARKER_RE.exec(data);
      if (m && m[1] !== undefined) {
        this.#synthExit = Number(m[1]);
        this.#synthesized = true;
        data = data.replace(MARKER_STRIP_RE, "");
      }
    }

    if (data.length === 0) {
      return;
    }
    this.#events.push({ data, type: ev.type });
    if (ev.type === "stdout") {
      this.#opts.onStdout?.(data);
    } else {
      this.#opts.onStderr?.(data);
    }
    this.#notify();
  }

  #durationMs(): number {
    return Math.max(0, Date.now() - this.#startedAt);
  }

  #finish(err: unknown): void {
    this.#done = true;
    if (err !== null && err !== undefined) {
      this.#error = this.#opts.mapError
        ? this.#opts.mapError(err)
        : SandboxError.wrap(err);
      this.#complete({
        durationMs: this.#durationMs(),
        error: this.#error,
        ok: false,
      });
      this.#rejectResult(this.#error);
      this.#notify();
      return;
    }
    let stdout = "";
    let stderr = "";
    for (const ev of this.#events) {
      if (ev.type === "stdout") {
        stdout += ev.data;
      } else if (ev.type === "stderr") {
        stderr += ev.data;
      }
    }
    const durationMs = this.#durationMs();
    const result: ExecResult = {
      durationMs,
      exitCode: this.#synthesized ? this.#synthExit : this.#exitCode,
      stderr,
      stdout,
      ...(this.#synthesized ? { exitCodeSynthesized: true } : {}),
    };
    this.#complete({
      durationMs,
      exitCode: result.exitCode,
      ok: result.exitCode === 0,
    });
    this.#resolveResult(result);
    this.#notify();
  }

  #complete(outcome: {
    durationMs: number;
    error?: unknown;
    exitCode?: number;
    ok: boolean;
  }): void {
    try {
      this.#opts.onComplete?.(outcome);
    } catch {
      // Observers must not affect command behavior.
    }
  }

  // ---- Promise<ExecResult> ----
  then<TResult1 = ExecResult, TResult2 = never>(
    onfulfilled?:
      | ((value: ExecResult) => TResult1 | PromiseLike<TResult1>)
      | undefined
      | null,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | undefined
      | null
  ): Promise<TResult1 | TResult2> {
    return this.#start().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?:
      | ((reason: unknown) => TResult | PromiseLike<TResult>)
      | undefined
      | null
  ): Promise<ExecResult | TResult> {
    return this.#start().catch(onrejected);
  }

  finally(onfinally?: (() => void) | undefined | null): Promise<ExecResult> {
    return this.#start().finally(onfinally);
  }

  readonly [Symbol.toStringTag] = "ExecHandle";

  // ---- AsyncIterable<OutputEvent> ----
  async *[Symbol.asyncIterator](): AsyncIterator<OutputEvent> {
    this.#ensureStarted();
    let i = 0;
    for (;;) {
      while (i < this.#events.length) {
        const ev = this.#events[i];
        i++;
        if (ev) {
          yield ev;
        }
      }
      if (this.#done) {
        if (this.#error) {
          throw this.#error;
        }
        return;
      }
      await this.#nextTick();
    }
  }

  // ---- ExecHandle extras ----
  get pid(): Promise<string> {
    this.#ensureStarted();
    return this.#source.pid;
  }

  #makeStream(kind: "stdout" | "stderr"): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    const self = this;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          while (i < self.#events.length) {
            const ev = self.#events[i];
            i++;
            if (ev && ev.type === kind) {
              controller.enqueue(enc.encode(ev.data));
              return;
            }
          }
          if (self.#done) {
            if (self.#error) {
              controller.error(self.#error);
            } else {
              controller.close();
            }
            return;
          }
          await self.#nextTick();
        }
      },
      start: () => self.#ensureStarted(),
    });
  }

  get stdout(): ReadableStream<Uint8Array> {
    return this.#makeStream("stdout");
  }

  get stderr(): ReadableStream<Uint8Array> {
    return this.#makeStream("stderr");
  }

  async kill(signal?: string): Promise<void> {
    await this.#source.kill(signal);
  }

  async writeStdin(data: string | Uint8Array): Promise<void> {
    if (!this.#source.writeStdin) {
      throw new SandboxError("NotSupported", "stdin is not supported");
    }
    const bytes =
      typeof data === "string" ? new TextEncoder().encode(data) : data;
    await this.#source.writeStdin(bytes);
  }
}

export function createExecHandle(
  source: DriverExec,
  opts?: ExecHandleOptions
): ExecHandle {
  return new ExecHandleImpl(source, opts);
}
