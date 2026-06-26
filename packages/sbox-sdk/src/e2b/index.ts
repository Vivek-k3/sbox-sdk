import type { Sandbox as E2BSandbox } from "@e2b/code-interpreter";

/**
 * `sbox-sdk/e2b` — adapter for E2B (@e2b/code-interpreter). The canonical
 * reference adapter: richest capability set (code interpreter, snapshots,
 * ports, pause/resume). The heavy SDK is lazy-imported inside create()/connect()
 * so importing this subpath stays cheap. Requires the optional peer
 * dependency `@e2b/code-interpreter`.
 */
import {
  AsyncQueue,
  defineProvider,
  numExit,
  SandboxError,
} from "../adapter/index.js";
import type {
  CapabilityFlags,
  CapabilityMap,
  DirEntry,
  DriverExec,
  DriverHandle,
  DriverProcess,
  ExecOptions,
  FileBody,
  FileInfo,
  FsEvent,
  KernelContext,
  ListFilter,
  CallContext,
  CodeExecution,
  OutputEvent,
  Preview,
  SandboxInfo,
  SandboxProvider,
  SandboxSpec,
  SnapshotRef,
  ProcessInfo,
} from "../adapter/index.js";

export interface E2BOptions {
  apiKey: string;
  /** Self-hosted E2B domain, if not the default cloud. */
  domain?: string;
}

export const E2B_CAPS = {
  background: "native",
  codeInterpreter: "native",
  egressControl: "unsupported",
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "native",
  fork: "unsupported",
  gpu: "unsupported",
  killProcess: "native",
  list: "native",
  metrics: "native",
  pause: "native",
  privatePreview: "unsupported",
  proxiedFetch: "unsupported",
  pty: "unsupported",
  region: "unsupported",
  secretsVault: "unsupported",
  setTimeout: "native",
  snapshot: "native",
  ssh: "unsupported",
  statefulKernel: "native",
  stdin: "unsupported",
  stop: "unsupported",
  streaming: "native",
  volumes: "unsupported",
} as const satisfies CapabilityMap;

export type E2BCaps = typeof E2B_CAPS;

const E2B_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true,
  preservesDiskOnStop: false,
  preservesMemoryOnPause: true,
  previewModel: "subdomain",
};

// --------------------------------------------------------------------------
// lazy module loader (memoized)
// --------------------------------------------------------------------------

type E2BModule = typeof import("@e2b/code-interpreter");
let cached: E2BModule | null = null;
async function loadE2B(): Promise<E2BModule> {
  if (!cached) {
    cached = (await import("@e2b/code-interpreter")) as unknown as E2BModule;
  }
  return cached;
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(
    b.byteOffset,
    b.byteOffset + b.byteLength
  ) as ArrayBuffer;
}

function mapFsEvent(type: unknown): FsEvent["type"] {
  const t = String(type).toLowerCase();
  if (t.includes("create")) {
    return "create";
  }
  if (t.includes("remove") || t.includes("delete")) {
    return "delete";
  }
  return "modify";
}

function mapResult(r: unknown): {
  mime: Record<string, string>;
  text?: string;
} {
  const rr = r as Record<string, unknown>;
  const mime: Record<string, string> = {};
  const put = (key: string, mimeType: string): void => {
    const v = rr[key];
    if (typeof v === "string") {
      mime[mimeType] = v;
    }
  };
  put("text", "text/plain");
  put("html", "text/html");
  put("markdown", "text/markdown");
  put("svg", "image/svg+xml");
  put("png", "image/png");
  put("jpeg", "image/jpeg");
  put("pdf", "application/pdf");
  put("latex", "text/latex");
  if (rr.json !== undefined) {
    mime["application/json"] =
      typeof rr.json === "string" ? rr.json : JSON.stringify(rr.json);
  }
  return { mime, text: typeof rr.text === "string" ? rr.text : undefined };
}

function mapExecution(exec: {
  results: unknown[];
  logs: { stdout: string[]; stderr: string[] };
  error?: { name: string; value: string; traceback?: string };
}): CodeExecution {
  return {
    error: exec.error
      ? {
          name: exec.error.name,
          traceback: exec.error.traceback,
          value: exec.error.value,
        }
      : undefined,
    logs: { stderr: exec.logs.stderr, stdout: exec.logs.stdout },
    results: exec.results.map(mapResult),
  };
}

function mapE2BError(e: unknown): SandboxError | undefined {
  const name =
    e && typeof e === "object" && "name" in e
      ? String((e as { name?: unknown }).name)
      : "";
  const msg = e instanceof Error ? e.message : String(e);
  const hay = `${name} ${msg}`;
  if (/notfound|not found/i.test(hay)) {
    return new SandboxError("NotFound", msg, { cause: e, provider: "e2b" });
  }
  if (/auth|unauthorized|api ?key|forbidden/i.test(hay)) {
    return new SandboxError("Unauthorized", msg, { cause: e, provider: "e2b" });
  }
  if (/ratelimit|rate limit|quota|too many/i.test(hay)) {
    return new SandboxError("QuotaExceeded", msg, {
      cause: e,
      provider: "e2b",
      retryable: true,
    });
  }
  if (/timeout|timed out/i.test(hay)) {
    return new SandboxError("Timeout", msg, { cause: e, provider: "e2b" });
  }
  return undefined;
}

// --------------------------------------------------------------------------
// provider
// --------------------------------------------------------------------------

export const e2b = defineProvider<E2BCaps, E2BSandbox, E2BOptions>((opts) => {
  const makeHandle = (initial: E2BSandbox): DriverHandle<E2BSandbox> => {
    let current = initial;
    const contexts = new Map<string, unknown>();

    const runStreaming = (cmd: string, options: ExecOptions): DriverExec => {
      const queue = new AsyncQueue<OutputEvent>();
      let killer: (() => Promise<unknown>) | null = null;
      const handleP = current.commands
        .run(cmd, {
          background: true,
          cwd: options.cwd,
          envs: options.env,
          onStderr: (data) => queue.push({ data, type: "stderr" }),
          onStdout: (data) => queue.push({ data, type: "stdout" }),
          timeoutMs: options.timeoutMs,
        })
        .then((handle) => {
          killer = () => handle.kill();
          void (async () => {
            try {
              const res = await handle.wait();
              queue.push({ exitCode: res.exitCode, type: "exit" });
            } catch (error) {
              queue.push({ exitCode: numExit(error), type: "exit" });
            }
            queue.close();
          })();
          return handle;
        })
        .catch((error) => {
          queue.fail(mapE2BError(error) ?? SandboxError.wrap(error, "e2b"));
          return null;
        });
      return {
        pid: handleP.then((h) => (h ? String(h.pid) : "")),
        kill: async () => {
          await handleP;
          if (killer) {
            await killer();
          }
        },
        [Symbol.asyncIterator]: () => queue.iterator(),
      };
    };

    const handle: DriverHandle<E2BSandbox> = {
      async createContext(options: {
        language?: string;
        cwd?: string;
      }): Promise<KernelContext> {
        const c = await current.createCodeContext({
          cwd: options.cwd,
          language: options.language as never,
        });
        const { id } = c as { id: string };
        contexts.set(id, c);
        return { id, language: options.language ?? "python" };
      },
      async deleteSnapshot(ref: string): Promise<void> {
        const { Sandbox } = await loadE2B();
        await Sandbox.deleteSnapshot(ref, { apiKey: opts.apiKey });
      },
      async destroy(): Promise<void> {
        await current.kill();
      },
      exec(cmd: string, options: ExecOptions): DriverExec {
        return runStreaming(cmd, options);
      },
      exposePort(port: number): Preview {
        const host = current.getHost(port);
        return { port, url: `https://${host}` };
      },
      async getInfo(): Promise<SandboxInfo> {
        const i = await current.getInfo();
        return {
          createdAt: i.startedAt,
          id: current.sandboxId,
          metadata: i.metadata,
          name: i.name,
          provider: "e2b",
          raw: i,
          state: "running",
        };
      },
      get id() {
        return current.sandboxId;
      },
      async killProcess(processId: string): Promise<void> {
        await current.commands.kill(Number(processId));
      },
      async listDir(path: string): Promise<DirEntry[]> {
        const entries = await current.files.list(path);
        return entries.map((e) => ({
          name: e.name,
          path: e.path ?? `${path}/${e.name}`,
          type: e.type === "dir" ? "dir" : "file",
        }));
      },
      async listProcesses(): Promise<ProcessInfo[]> {
        const ps = await current.commands.list();
        return ps.map((p) => ({
          cmd: p.cmd ?? p.args?.join(" ") ?? "",
          id: String(p.pid),
        }));
      },
      async mkdir(path: string): Promise<void> {
        await current.files.makeDir(path);
      },
      async pause(_ctx: CallContext): Promise<void> {
        const { Sandbox } = await loadE2B();
        await Sandbox.pause(current.sandboxId, { apiKey: opts.apiKey });
      },
      get raw() {
        return current;
      },
      readFile(path: string): Promise<Uint8Array> {
        return current.files.read(path, { format: "bytes" });
      },
      async remove(path: string): Promise<void> {
        await current.files.remove(path);
      },
      async rename(from: string, to: string): Promise<void> {
        await current.files.rename(from, to);
      },
      async resume(): Promise<void> {
        const { Sandbox } = await loadE2B();
        current = (await Sandbox.connect(current.sandboxId, {
          apiKey: opts.apiKey,
        })) as E2BSandbox;
      },
      async runCode(
        code: string,
        options: {
          context?: KernelContext;
          language?: string;
          onStdout?: (chunk: string) => void;
          onStderr?: (chunk: string) => void;
        }
      ): Promise<CodeExecution> {
        const realContext = options.context
          ? contexts.get(options.context.id)
          : undefined;
        const common = {
          onStderr: options.onStderr
            ? (m: { line: string }) => options.onStderr!(m.line)
            : undefined,
          onStdout: options.onStdout
            ? (m: { line: string }) => options.onStdout!(m.line)
            : undefined,
        };
        const exec = realContext
          ? await current.runCode(code, {
              ...common,
              context: realContext as never,
            })
          : await current.runCode(code, {
              ...common,
              language: options.language as never,
            });
        return mapExecution(exec);
      },
      async setTimeout(ttlMs: number): Promise<void> {
        await current.setTimeout(ttlMs);
      },
      async snapshot(options: { name?: string }): Promise<SnapshotRef> {
        const snap = await current.createSnapshot({ name: options.name });
        return {
          id: snap.snapshotId,
          name: options.name,
          provider: "e2b",
          raw: snap,
        };
      },
      async spawn(cmd: string, options: ExecOptions): Promise<DriverProcess> {
        const queue = new AsyncQueue<OutputEvent>();
        const handle2 = await current.commands.run(cmd, {
          background: true,
          cwd: options.cwd,
          envs: options.env,
          onStderr: (data) => queue.push({ type: "stderr", data }),
          onStdout: (data) => queue.push({ type: "stdout", data }),
          timeoutMs: options.timeoutMs,
        });
        void (async () => {
          try {
            const res = await handle2.wait();
            queue.push({ exitCode: res.exitCode, type: "exit" });
          } catch (error) {
            queue.push({ type: "exit", exitCode: numExit(error) });
          }
          queue.close();
        })();
        const pid = String(handle2.pid);
        return {
          id: pid,
          pid: Promise.resolve(pid),
          kill: async () => {
            await handle2.kill();
          },
          [Symbol.asyncIterator]: () => queue.iterator(),
        };
      },
      async stat(path: string): Promise<FileInfo> {
        const e = await current.files.getInfo(path);
        return {
          mtime: e.modifiedTime,
          path: e.path ?? path,
          size: e.size,
          type: e.type === "dir" ? "dir" : "file",
        };
      },
      async upload(path: string, data: FileBody): Promise<void> {
        if (typeof data === "string") {
          await current.files.write(path, data);
        } else if (data instanceof Uint8Array) {
          await current.files.write(path, toArrayBuffer(data));
        } else {
          await current.files.write(path, data);
        }
      },
      async watch(
        path: string,
        cb: (e: FsEvent) => void,
        recursive: boolean
      ): Promise<() => Promise<void>> {
        const wh = await current.files.watchDir(
          path,
          (ev) => {
            const { name } = ev as { name?: string };
            cb({
              path: name ? `${path}/${name}` : path,
              type: mapFsEvent((ev as { type?: unknown }).type),
            });
          },
          { recursive }
        );
        return async () => {
          await wh.stop();
        };
      },
      async writeFile(path: string, data: Uint8Array): Promise<void> {
        await current.files.write(path, toArrayBuffer(data));
      },
    };

    return handle;
  };

  const provider: SandboxProvider<E2BCaps, E2BSandbox> = {
    capabilities: E2B_CAPS,
    async connect(id: string): Promise<DriverHandle<E2BSandbox>> {
      const { Sandbox } = await loadE2B();
      const native = await Sandbox.connect(id, { apiKey: opts.apiKey });
      return makeHandle(native as E2BSandbox);
    },
    async create(
      spec: SandboxSpec,
      ctx: CallContext
    ): Promise<DriverHandle<E2BSandbox>> {
      const { Sandbox } = await loadE2B();
      const createOpts = {
        apiKey: opts.apiKey,
        domain: opts.domain,
        envs: spec.env,
        metadata: {
          ...spec.metadata,
          ...(ctx.idempotencyKey ? { _sboxIdem: ctx.idempotencyKey } : {}),
        },
        timeoutMs: spec.ttlMs,
      };
      const native = spec.template
        ? await Sandbox.create(spec.template, createOpts)
        : await Sandbox.create(createOpts);
      return makeHandle(native as E2BSandbox);
    },
    flags: E2B_FLAGS,
    async *list(filter: ListFilter | undefined, _ctx: CallContext) {
      const { Sandbox } = await loadE2B();
      const pg = Sandbox.list({ apiKey: opts.apiKey });
      let count = 0;
      while (pg.hasNext) {
        const items = await pg.nextItems();
        for (const it of items) {
          yield {
            createdAt: it.startedAt,
            id: it.sandboxId,
            metadata: it.metadata,
            name: it.name,
            provider: "e2b",
            raw: it,
            state: "running" as const,
          };
          count++;
          if (filter?.limit !== undefined && count >= filter.limit) {
            return;
          }
        }
      }
    },
    mapError: mapE2BError,
    name: "e2b",
  };

  return provider;
});
