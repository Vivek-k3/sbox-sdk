/**
 * Wires a provider's `DriverHandle` into the public namespaced `Sandbox`:
 * builds the sub-API facades, enforces capability gating (fail-fast
 * NotSupportedError + type-level `undefined`), and silently polyfills universal
 * filesystem ops via `exec` where the adapter doesn't implement them natively.
 */
import {
  assertCapability,
  freezeCapabilities,
  isCapable,
} from "./capabilities.js";
import type { CapabilityMap } from "./capabilities.js";
import { NotSupportedError, SandboxError } from "./errors.js";
import { createExecHandle, deferredExec } from "./exec.js";
import type { PluginSetupContext, SandboxPlugin } from "./plugin.js";
import { normalizePreview } from "./preview.js";
import {
  buildExecCommand,
  joinCmd,
  parseLsOutput,
  parseStatOutput,
  shellQuote,
} from "./shell.js";
import { durationBucket, errorCode } from "./telemetry.js";
import type { TelemetryEventName, TelemetryReporter } from "./telemetry.js";
import type {
  CallContext,
  CodeAPI,
  CommandsAPI,
  DriverExec,
  DriverHandle,
  DriverProcess,
  DriverPty,
  ExecOptions,
  ExecResult,
  FileBody,
  FilesAPI,
  NetworkAPI,
  OutputEvent,
  PortsAPI,
  Process,
  PtyAPI,
  PtySession,
  Sandbox,
  SandboxProvider,
  SnapshotRef,
  SnapshotsAPI,
  SshAPI,
  StoredFile,
} from "./types.js";

/**
 * Hidden key exposing the adapter handle on a built sandbox. Used by the
 * conformance suite to check method presence against declared capabilities.
 * Not part of the public API.
 */
export const DRIVER_HANDLE: unique symbol = Symbol.for("sbox.driverHandle");

export interface BuildSandboxBase {
  fetch: typeof fetch;
  emulate?: (keyof CapabilityMap)[];
  defaultMetadata?: Record<string, string>;
  /** Plugins to graft onto every sandbox (applied here so forks inherit them). */
  plugins?: readonly SandboxPlugin[];
  telemetry?: TelemetryReporter;
}

export function buildSandbox<Caps extends CapabilityMap, Raw>(
  provider: SandboxProvider<Caps, Raw>,
  handle: DriverHandle<Raw>,
  base: BuildSandboxBase,
  setup: PluginSetupContext = {}
): Sandbox<Caps, Raw> {
  const caps = freezeCapabilities(provider.capabilities, provider.flags);
  const { name } = provider;

  const mkCtx = (signal?: AbortSignal): CallContext => ({
    attempt: 1,
    fetch: base.fetch,
    metadata: base.defaultMetadata,
    signal,
  });

  const wrapErr = (e: unknown): SandboxError =>
    provider.mapError?.(e) ?? SandboxError.wrap(e, name);

  const trackOutcome = (
    event: TelemetryEventName,
    startedAt: number,
    ok: boolean,
    extra: Record<string, string | number | boolean | null | undefined> = {}
  ): void => {
    base.telemetry?.track(event, {
      duration_bucket: durationBucket(Date.now() - startedAt),
      ok,
      provider: name,
      ...extra,
    });
  };

  const guard = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      throw wrapErr(error);
    }
  };

  /**
   * Start an exec through the adapter. Buffered stdin is piped in by the shell
   * builder; a stdin stream is drained first (deferred start).
   */
  const startExec = (
    command: string,
    opts: ExecOptions,
    via: "exec" | "spawn" = "exec"
  ): { source: DriverExec; parseExitMarker: boolean } => {
    const launch = (o: ExecOptions) => {
      const built = buildExecCommand(command, o, provider.flags);
      return { built, ctx: mkCtx(o.signal) };
    };
    if (opts.stdin instanceof ReadableStream) {
      const stream = opts.stdin;
      const marker = !provider.flags.exitCodeNative;
      return {
        parseExitMarker: marker,
        source: deferredExec(async () => {
          const bytes = await drain(stream);
          const { built, ctx } = launch({ ...opts, stdin: bytes });
          return via === "spawn"
            ? await handle.spawn!(built.command, built.execOptions, ctx)
            : handle.exec(built.command, built.execOptions, ctx);
        }),
      };
    }
    const { built, ctx } = launch(opts);
    return {
      parseExitMarker: built.parseExitMarker,
      source:
        via === "spawn"
          ? deferredExec(async () =>
              handle.spawn!(built.command, built.execOptions, ctx)
            )
          : handle.exec(built.command, built.execOptions, ctx),
    };
  };

  const runExec = (
    command: string,
    opts: ExecOptions = {}
  ): Promise<ExecResult> => {
    const { source, parseExitMarker } = startExec(command, opts);
    return createExecHandle(source, {
      mapError: wrapErr,
      parseExitMarker,
      provider: name,
      timeoutMs: opts.timeoutMs,
    });
  };

  const commands: CommandsAPI = {
    async connect(processId) {
      if (!handle.connectProcess) {
        throw new NotSupportedError(name, "commands.connect");
      }
      const proc = await guard(() =>
        handle.connectProcess!(processId, mkCtx())
      );
      return makeProcess(proc, wrapErr);
    },
    async kill(processId, signal) {
      if (!handle.killProcess) {
        throw new NotSupportedError(name, "commands.kill");
      }
      await guard(() => handle.killProcess!(processId, signal, mkCtx()));
    },
    async list() {
      if (!handle.listProcesses) {
        throw new NotSupportedError(name, "commands.list");
      }
      return guard(() => handle.listProcesses!(mkCtx()));
    },
    run(cmd, opts = {}) {
      const createdAt = Date.now();
      const { source, parseExitMarker } = startExec(joinCmd(cmd), opts);
      return createExecHandle(source, {
        mapError: wrapErr,
        onComplete: (outcome) => {
          base.telemetry?.track("command_run", {
            duration_bucket: durationBucket(outcome.durationMs),
            error_code: outcome.error ? errorCode(outcome.error) : undefined,
            exit_code:
              typeof outcome.exitCode === "number"
                ? outcome.exitCode
                : undefined,
            ok: outcome.ok,
            provider: name,
            start_delay_bucket: durationBucket(
              Math.max(0, Date.now() - createdAt - outcome.durationMs)
            ),
          });
        },
        onStderr: opts.onStderr,
        onStdout: opts.onStdout,
        parseExitMarker,
        provider: name,
        timeoutMs: opts.timeoutMs,
      });
    },
    async spawn(cmd, opts = {}) {
      assertCapability(name, caps, "background", "commands.spawn");
      if (!handle.spawn) {
        throw new NotSupportedError(name, "commands.spawn");
      }
      const { source, parseExitMarker } = startExec(
        joinCmd(cmd),
        opts,
        "spawn"
      );
      // Resolve the process id up front so `Process.id` is synchronous.
      const proc = (await guard(async () => {
        const id = await source.pid;
        return Object.assign(source, { id });
      })) as DriverProcess;
      return makeProcess(proc, wrapErr, parseExitMarker);
    },
  };

  const files: FilesAPI = {
    async download(path) {
      if (handle.download) {
        const stream = await guard(() => handle.download!(path, mkCtx()));
        return storedFileFromStream(path, stream);
      }
      return files.read(path);
    },
    async exists(path) {
      try {
        await files.stat(path);
        return true;
      } catch (error) {
        if (error instanceof SandboxError && error.code === "NotFound") {
          return false;
        }
        throw error;
      }
    },
    async list(path) {
      if (handle.listDir) {
        return guard(() => handle.listDir!(path, mkCtx()));
      }
      const res = await runExec(`ls -1Ap ${shellQuote(path)}`);
      if (res.exitCode !== 0) {
        throw new SandboxError("NotFound", `cannot list '${path}'`, {
          provider: name,
        });
      }
      return parseLsOutput(res.stdout, path);
    },
    async mkdir(path, opts) {
      if (handle.mkdir) {
        await guard(() =>
          handle.mkdir!(path, opts?.recursive ?? false, mkCtx())
        );
        return;
      }
      const res = await runExec(
        `mkdir ${opts?.recursive ? "-p " : ""}${shellQuote(path)}`
      );
      if (res.exitCode !== 0) {
        throw new SandboxError("Provider", `mkdir failed: ${res.stderr}`, {
          provider: name,
        });
      }
    },
    async read(path) {
      const bytes = await guard(() => handle.readFile(path, mkCtx()));
      return storedFileFromBytes(path, bytes);
    },
    async remove(path, opts) {
      if (handle.remove) {
        await guard(() =>
          handle.remove!(path, opts?.recursive ?? false, mkCtx())
        );
        return;
      }
      const res = await runExec(
        `rm ${opts?.recursive ? "-rf " : "-f "}${shellQuote(path)}`
      );
      if (res.exitCode !== 0) {
        throw new SandboxError("Provider", `rm failed: ${res.stderr}`, {
          provider: name,
        });
      }
    },
    async rename(from, to) {
      if (handle.rename) {
        await guard(() => handle.rename!(from, to, mkCtx()));
        return;
      }
      const res = await runExec(`mv ${shellQuote(from)} ${shellQuote(to)}`);
      if (res.exitCode !== 0) {
        throw new SandboxError("Provider", `mv failed: ${res.stderr}`, {
          provider: name,
        });
      }
    },
    async stat(path) {
      if (handle.stat) {
        return guard(() => handle.stat!(path, mkCtx()));
      }
      const res = await runExec(`stat -c '%F|%s|%Y' ${shellQuote(path)}`);
      if (res.exitCode !== 0) {
        throw new SandboxError("NotFound", `not found: '${path}'`, {
          provider: name,
        });
      }
      const parsed = parseStatOutput(res.stdout);
      if (!parsed) {
        throw new SandboxError("Provider", `cannot stat '${path}'`, {
          provider: name,
        });
      }
      return {
        mtime: parsed.mtime,
        path,
        size: parsed.size,
        type: parsed.type,
      };
    },
    async upload(path, body) {
      if (handle.upload) {
        await guard(() => handle.upload!(path, body, mkCtx()));
        return;
      }
      await files.write(path, body);
    },
    async watch(path, cb, opts) {
      assertCapability(name, caps, "filesWatch", "files.watch");
      if (!handle.watch) {
        throw new NotSupportedError(name, "files.watch");
      }
      const stop = await guard(() =>
        handle.watch!(path, cb, opts?.recursive ?? false, mkCtx())
      );
      return {
        close: async () => {
          await stop();
        },
      };
    },
    async write(path, data) {
      if (data instanceof ReadableStream && handle.upload) {
        await guard(() => handle.upload!(path, data, mkCtx()));
        return;
      }
      const bytes = await toBytes(data);
      await guard(() => handle.writeFile(path, bytes, mkCtx()));
    },
  };

  const code: CodeAPI = {
    async createContext(opts) {
      assertCapability(name, caps, "codeInterpreter", "code.createContext");
      if (!handle.createContext) {
        throw new NotSupportedError(name, "code.createContext");
      }
      return guard(() => handle.createContext!(opts ?? {}, mkCtx()));
    },
    async runCode(codeStr, opts) {
      assertCapability(name, caps, "codeInterpreter", "code.runCode");
      if (!handle.runCode) {
        throw new NotSupportedError(name, "code.runCode");
      }
      return guard(() => handle.runCode!(codeStr, opts ?? {}, mkCtx()));
    },
  };

  const ports: PortsAPI = {
    async expose(port, opts) {
      assertCapability(name, caps, "exposePort", "ports.expose");
      if (!handle.exposePort) {
        throw new NotSupportedError(name, "ports.expose");
      }
      const isPrivate = opts?.visibility === "private" || opts?.private;
      if (isPrivate) {
        assertCapability(name, caps, "privatePreview", "ports.expose(private)");
      }
      const preview = await guard(() =>
        handle.exposePort!(port, { private: !!isPrivate }, mkCtx())
      );
      return normalizePreview(preview);
    },
    async fetch(port, path, init) {
      if (handle.proxyFetch) {
        return guard(() => handle.proxyFetch!(port, path, init, mkCtx()));
      }
      // Never make a port public as a side effect: reuse an existing preview,
      // or expose PRIVATELY when the provider supports it.
      let preview: import("./types.js").Preview | undefined;
      if (handle.listPorts) {
        const listed = await ports.list();
        preview = listed.find((p) => p.port === port);
      }
      if (!preview && isCapable(caps, "privatePreview")) {
        preview = await ports.expose(port, { visibility: "private" });
      }
      if (!preview) {
        throw new NotSupportedError(
          name,
          `ports.fetch (port ${port} is not exposed; call ports.expose(${port}) first)`
        );
      }
      const p = normalizePreview(preview);
      const url = new URL(path ?? "/", p.url);
      const headers = new Headers(init?.headers);
      if (p.auth?.type === "header") {
        for (const [k, v] of Object.entries(p.auth.headers)) {
          headers.set(k, v);
        }
      } else if (p.auth?.type === "query") {
        url.searchParams.set(p.auth.param, p.auth.token);
      }
      return base.fetch(url.toString(), { ...init, headers });
    },
    async list() {
      if (!handle.listPorts) {
        throw new NotSupportedError(name, "ports.list");
      }
      const listed = await guard(() => handle.listPorts!(mkCtx()));
      return listed.map(normalizePreview);
    },
    async unexpose(port) {
      if (!handle.unexposePort) {
        throw new NotSupportedError(name, "ports.unexpose");
      }
      await guard(() => handle.unexposePort!(port, mkCtx()));
    },
  };

  const snapshots: SnapshotsAPI = {
    async create(opts) {
      assertCapability(name, caps, "snapshot", "snapshots.create");
      if (!handle.snapshot) {
        throw new NotSupportedError(name, "snapshots.create");
      }
      return guard(() =>
        handle.snapshot!({ mode: opts?.mode, name: opts?.name }, mkCtx())
      );
    },
    async delete(ref) {
      if (!handle.deleteSnapshot) {
        throw new NotSupportedError(name, "snapshots.delete");
      }
      await guard(() => handle.deleteSnapshot!(refId(ref), mkCtx()));
    },
    async fork(count) {
      return forkImpl(count ?? 1);
    },
    async list() {
      if (!handle.listSnapshots) {
        throw new NotSupportedError(name, "snapshots.list");
      }
      return guard(() => handle.listSnapshots!(mkCtx()));
    },
    async restore(ref) {
      if (!handle.restoreSnapshot) {
        throw new NotSupportedError(name, "snapshots.restore");
      }
      await guard(() => handle.restoreSnapshot!(refId(ref), mkCtx()));
    },
  };

  const forkImpl = async (count: number): Promise<Sandbox<Caps, Raw>[]> => {
    assertCapability(name, caps, "fork", "fork");
    if (!handle.fork) {
      throw new NotSupportedError(name, "fork");
    }
    const handles = await guard(() => handle.fork!(count, mkCtx()));
    return handles.map((h) => buildSandbox(provider, h, base, setup));
  };

  const ssh: SshAPI = {
    async create() {
      assertCapability(name, caps, "ssh", "ssh.create");
      if (!handle.createSsh) {
        throw new NotSupportedError(name, "ssh.create");
      }
      return guard(() => handle.createSsh!(mkCtx()));
    },
  };

  const pty: PtyAPI = {
    async connect(id) {
      assertCapability(name, caps, "pty", "pty.connect");
      if (!handle.connectPty) {
        throw new NotSupportedError(name, "pty.connect");
      }
      return makePty(await guard(() => handle.connectPty!(id, mkCtx())));
    },
    async create(opts = {}) {
      assertCapability(name, caps, "pty", "pty.create");
      if (!handle.createPty) {
        throw new NotSupportedError(name, "pty.create");
      }
      return makePty(
        await guard(() =>
          handle.createPty!({ cols: 80, rows: 24, ...opts }, mkCtx())
        )
      );
    },
  };

  const network: NetworkAPI = {
    createSsh: () => ssh.create(),
    async setEgressPolicy(policy) {
      assertCapability(name, caps, "egressControl", "network.setEgressPolicy");
      if (!caps.flags.egressModes.includes(policy.mode)) {
        throw new NotSupportedError(
          name,
          `network.setEgressPolicy({ mode: "${policy.mode}" })`
        );
      }
      if (!handle.setEgressPolicy) {
        throw new NotSupportedError(name, "network.setEgressPolicy");
      }
      await guard(() => handle.setEgressPolicy!(policy, mkCtx()));
    },
  };

  type S = Sandbox<Caps, Raw>;
  const sandbox: S = {
    can: (<K extends keyof CapabilityMap>(cap: K) =>
      isCapable(caps, cap)) as S["can"],
    capabilities: caps,
    code: (isCapable(caps, "codeInterpreter") ? code : undefined) as S["code"],
    commands,
    async fork(opts) {
      return forkImpl(opts?.count ?? 1);
    },
    async metrics() {
      assertCapability(name, caps, "metrics", "metrics");
      if (!handle.getMetrics) {
        throw new NotSupportedError(name, "metrics");
      }
      return guard(() => handle.getMetrics!(mkCtx()));
    },
    destroy: async () => {
      const startedAt = Date.now();
      try {
        await guard(() => handle.destroy(mkCtx()));
        trackOutcome("sandbox_destroy", startedAt, true);
      } catch (error) {
        trackOutcome("sandbox_destroy", startedAt, false, {
          error_code: errorCode(error),
        });
        throw error;
      }
    },
    files,
    getInfo: () => guard(() => handle.getInfo(mkCtx())),
    id: handle.id,
    name: handle.name,
    network: (isCapable(caps, "egressControl")
      ? network
      : undefined) as S["network"],
    async pause() {
      assertCapability(name, caps, "pause", "pause");
      if (!handle.pause) {
        throw new NotSupportedError(name, "pause");
      }
      await guard(() => handle.pause!(mkCtx()));
    },
    ports: (isCapable(caps, "exposePort") ? ports : undefined) as S["ports"],
    pty: (isCapable(caps, "pty") ? pty : undefined) as S["pty"],
    provider: name,
    raw: () => handle.raw,
    async resume() {
      // resume() wakes a paused OR stopped/archived sandbox.
      if (!isCapable(caps, "pause") && !isCapable(caps, "stop")) {
        throw new NotSupportedError(name, "resume");
      }
      if (!handle.resume) {
        throw new NotSupportedError(name, "resume");
      }
      await guard(() => handle.resume!(mkCtx()));
    },
    async setTimeout(ttlMs) {
      assertCapability(name, caps, "setTimeout", "setTimeout");
      if (!handle.setTimeout) {
        throw new NotSupportedError(name, "setTimeout");
      }
      await guard(() => handle.setTimeout!(ttlMs, mkCtx()));
    },
    snapshots: (isCapable(caps, "snapshot")
      ? snapshots
      : undefined) as S["snapshots"],
    ssh: (isCapable(caps, "ssh") ? ssh : undefined) as S["ssh"],
    async stop() {
      assertCapability(name, caps, "stop", "stop");
      if (!handle.stop) {
        throw new NotSupportedError(name, "stop");
      }
      await guard(() => handle.stop!(mkCtx()));
    },
  };

  Object.defineProperty(sandbox, DRIVER_HANDLE, {
    enumerable: false,
    value: handle,
  });

  // Plugins: graft contributions onto the sandbox (e.g. `sandbox.tools`), and
  // wrap destroy() to run onDestroy hooks first.
  const { plugins } = base;
  if (plugins && plugins.length > 0) {
    const asBase = sandbox as Sandbox;
    for (const p of plugins) {
      if (p.extend) {
        Object.assign(sandbox, p.extend(asBase, setup));
      }
    }
    const teardown = plugins.filter((p) => p.onDestroy);
    if (teardown.length > 0) {
      const inner = sandbox.destroy.bind(sandbox);
      sandbox.destroy = async (): Promise<void> => {
        for (const p of teardown) {
          await p.onDestroy?.(asBase);
        }
        await inner();
      };
    }
  }

  return sandbox;
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

function refId(ref: SnapshotRef | string): string {
  return typeof ref === "string" ? ref : ref.id;
}

async function toBytes(body: FileBody): Promise<Uint8Array> {
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  return drain(body);
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function storedFileFromBytes(path: string, bytes: Uint8Array): StoredFile {
  return {
    async bytes() {
      return bytes;
    },
    path,
    stream() {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    async text() {
      return new TextDecoder().decode(bytes);
    },
  };
}

function storedFileFromStream(
  path: string,
  stream: ReadableStream<Uint8Array>
): StoredFile {
  let buffered: Promise<Uint8Array> | undefined;
  let streamed = false;
  const bytes = (): Promise<Uint8Array> => {
    if (streamed) {
      return Promise.reject(
        new SandboxError(
          "Validation",
          "file body was already consumed as a stream"
        )
      );
    }
    buffered ??= drain(stream);
    return buffered;
  };
  return {
    bytes,
    path,
    stream() {
      if (buffered) {
        const pending = buffered;
        return new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(await pending);
            controller.close();
          },
        });
      }
      streamed = true;
      return stream;
    },
    async text() {
      return new TextDecoder().decode(await bytes());
    },
  };
}

function makePty(d: DriverPty): PtySession {
  return {
    [Symbol.asyncIterator]: () => d.output[Symbol.asyncIterator](),
    id: d.id,
    kill: () => d.kill(),
    resize: (cols, rows) => d.resize(cols, rows),
    async wait() {
      return { exitCode: await d.wait() };
    },
    write: (data) =>
      d.write(typeof data === "string" ? new TextEncoder().encode(data) : data),
  };
}

function makeProcess(
  proc: DriverProcess,
  mapError: (e: unknown) => SandboxError,
  parseExitMarker = false
): Process {
  const handle = createExecHandle(proc, { mapError, parseExitMarker });
  return {
    id: proc.id,
    kill: (signal) => proc.kill(signal),
    stderr: filterText(handle, "stderr"),
    stdout: filterText(handle, "stdout"),
    wait: () => handle,
    async writeStdin(data) {
      await handle.writeStdin(data);
    },
    async closeStdin() {
      await handle.closeStdin();
    },
  };
}

function filterText(
  handle: AsyncIterable<OutputEvent>,
  kind: "stdout" | "stderr"
): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const ev of handle) {
        if (ev.type === kind) {
          yield ev.data;
        }
      }
    },
  };
}
