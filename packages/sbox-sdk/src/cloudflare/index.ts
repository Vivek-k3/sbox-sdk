import type { Sandbox as CFSandbox } from "@cloudflare/sandbox";

/**
 * `sbox-sdk/cloudflare` — adapter for `@cloudflare/sandbox`. Unlike API-key
 * providers, Cloudflare sandboxes run INSIDE a Cloudflare Worker against a
 * Durable Object / Container binding. So the factory takes the binding, and
 * `create()` is get-or-create (no imperative create; ids are names). This is the
 * edge-portability stress test: the core stays fetch-only, no `node:` imports.
 *
 * Usage (inside a Worker):
 * ```ts
 * import { createSandboxClient } from "sbox-sdk";
 * import { cloudflare } from "sbox-sdk/cloudflare";
 * const client = createSandboxClient({ provider: cloudflare({ binding: env.Sandbox, hostname: "example.com" }) });
 * ```
 * Requires the optional peer dependency `@cloudflare/sandbox`, and you must
 * `export { Sandbox } from "@cloudflare/sandbox"` from your Worker entry.
 */
import {
  AsyncQueue,
  defineProvider,
  NotSupportedError,
  SandboxError,
} from "../adapter/index.js";
import type {
  CallContext,
  CapabilityFlags,
  CapabilityMap,
  CodeExecution,
  DirEntry,
  DriverExec,
  DriverHandle,
  ExecOptions,
  KernelContext,
  OutputEvent,
  Preview,
  SandboxInfo,
  SandboxProvider,
  SandboxSpec,
} from "../adapter/index.js";

export interface CloudflareOptions {
  /** The Durable Object namespace binding for your exported Sandbox class. */
  binding: unknown;
  /** Your Worker's domain — required to build preview URLs for exposed ports. */
  hostname?: string;
}

export const CLOUDFLARE_CAPS = {
  background: "unsupported",
  codeInterpreter: "native",
  egressControl: "unsupported",
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "unsupported",
  fork: "unsupported",
  gpu: "unsupported",
  killProcess: "unsupported",
  list: "unsupported",
  metrics: "unsupported",
  pause: "unsupported",
  privatePreview: "unsupported",
  proxiedFetch: "native",
  pty: "unsupported",
  region: "unsupported",
  secretsVault: "unsupported",
  setTimeout: "native",
  snapshot: "unsupported",
  ssh: "unsupported",
  statefulKernel: "native",
  stdin: "unsupported",
  stop: "unsupported",
  streaming: "native",
  volumes: "unsupported",
} as const satisfies CapabilityMap;

export type CloudflareCaps = typeof CLOUDFLARE_CAPS;

const CLOUDFLARE_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true,
  preservesDiskOnStop: false,
  preservesMemoryOnPause: false,
  previewModel: "wildcardDNS",
};

type CFModule = typeof import("@cloudflare/sandbox");
let cached: CFModule | null = null;
async function loadCF(): Promise<CFModule> {
  if (!cached) {
    cached = (await import("@cloudflare/sandbox")) as unknown as CFModule;
  }
  return cached;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.codePointAt(i) ?? 0;
  }
  return out;
}

function mapResult(r: unknown): {
  mime: Record<string, string>;
  text?: string;
} {
  const rr = r as Record<string, unknown>;
  const mime: Record<string, string> = {};
  const put = (key: string, mt: string): void => {
    const v = rr[key];
    if (typeof v === "string") {
      mime[mt] = v;
    }
  };
  put("text", "text/plain");
  put("html", "text/html");
  put("png", "image/png");
  put("jpeg", "image/jpeg");
  put("svg", "image/svg+xml");
  put("markdown", "text/markdown");
  return { mime, text: typeof rr.text === "string" ? rr.text : undefined };
}

function mapCFError(e: unknown): SandboxError | undefined {
  const msg = e instanceof Error ? e.message : String(e);
  if (/not ?found/i.test(msg)) {
    return new SandboxError("NotFound", msg, {
      cause: e,
      provider: "cloudflare",
    });
  }
  if (/unauthor|forbidden/i.test(msg)) {
    return new SandboxError("Unauthorized", msg, {
      cause: e,
      provider: "cloudflare",
    });
  }
  if (/timeout|timed out/i.test(msg)) {
    return new SandboxError("Timeout", msg, {
      cause: e,
      provider: "cloudflare",
    });
  }
  return undefined;
}

export const cloudflare = defineProvider<
  CloudflareCaps,
  CFSandbox,
  CloudflareOptions
>((opts) => {
  const getStub = async (id: string): Promise<CFSandbox> => {
    const mod = await loadCF();
    const getSandbox = mod.getSandbox as unknown as (
      ns: unknown,
      id: string,
      o?: unknown
    ) => CFSandbox;
    return getSandbox(opts.binding, id);
  };

  const makeHandle = (
    stub: CFSandbox,
    id: string,
    defaultEnv?: Record<string, string>
  ): DriverHandle<CFSandbox> => {
    const s = stub as unknown as {
      exec(
        cmd: string,
        o?: unknown
      ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
      readFile(
        path: string,
        o?: unknown
      ): Promise<{ content: string; encoding?: string }>;
      writeFile(
        path: string,
        content: ReadableStream<Uint8Array> | string,
        o?: unknown
      ): Promise<unknown>;
      mkdir(path: string, o?: { recursive?: boolean }): Promise<unknown>;
      deleteFile(path: string): Promise<unknown>;
      renameFile(from: string, to: string): Promise<unknown>;
      listFiles(
        path: string,
        o?: unknown
      ): Promise<{
        files: {
          name: string;
          path?: string;
          type?: string;
          isDirectory?: boolean;
        }[];
      }>;
      exposePort(
        port: number,
        o: { hostname: string; name?: string }
      ): Promise<{ url: string; port: number }>;
      unexposePort(port: number): Promise<unknown>;
      getExposedPorts(
        hostname: string
      ): Promise<{ url: string; port: number }[]>;
      containerFetch(
        url: string,
        init: RequestInit,
        port?: number
      ): Promise<Response>;
      createCodeContext(o?: unknown): Promise<{ id: string }>;
      runCode(
        code: string,
        o?: unknown
      ): Promise<{
        results?: unknown[];
        logs?: { stdout?: string[]; stderr?: string[] };
        error?: { name: string; value: string; traceback?: string };
      }>;
      setSleepAfter(after: string | number): Promise<void>;
      destroy(): Promise<void>;
    };
    const contexts = new Map<string, unknown>();

    return {
      async createContext(options: {
        language?: string;
      }): Promise<KernelContext> {
        const c = await s.createCodeContext({ language: options.language });
        contexts.set(c.id, c);
        return { id: c.id, language: options.language ?? "python" };
      },
      async destroy(): Promise<void> {
        await s.destroy();
      },
      exec(cmd: string, options: ExecOptions): DriverExec {
        const queue = new AsyncQueue<OutputEvent>();
        void s
          .exec(cmd, {
            cwd: options.cwd,
            env: { ...defaultEnv, ...options.env },
            onOutput: (stream: "stdout" | "stderr", data: string) =>
              queue.push({ type: stream, data }),
            stream: true,
            timeout: options.timeoutMs,
          })
          .then((res) => {
            queue.push({ exitCode: res.exitCode, type: "exit" });
            queue.close();
          })
          .catch((error) =>
            queue.fail(
              mapCFError(error) ?? SandboxError.wrap(error, "cloudflare")
            )
          );
        return {
          pid: Promise.resolve(""),
          async kill() {
            /* buffered exec has no kill handle */
          },
          [Symbol.asyncIterator]: () => queue.iterator(),
        };
      },
      exposePort(port: number): Promise<Preview> {
        if (!opts.hostname) {
          throw new NotSupportedError(
            "cloudflare",
            "ports.expose (set `hostname` in cloudflare({...}) options)"
          );
        }
        return s
          .exposePort(port, { hostname: opts.hostname })
          .then((r) => ({ port: r.port, url: r.url }));
      },
      getInfo(): SandboxInfo {
        return {
          id,
          metadata: {},
          provider: "cloudflare",
          raw: stub,
          state: "running",
        };
      },
      id,
      async listDir(path: string): Promise<DirEntry[]> {
        const r = await s.listFiles(path);
        return r.files.map((f) => ({
          name: f.name,
          path: f.path ?? `${path}/${f.name}`,
          type:
            f.isDirectory || f.type === "directory" || f.type === "dir"
              ? "dir"
              : "file",
        }));
      },
      async listPorts(): Promise<Preview[]> {
        if (!opts.hostname) {
          return [];
        }
        const ports = await s.getExposedPorts(opts.hostname);
        return ports.map((p) => ({ port: p.port, url: p.url }));
      },
      async mkdir(path: string, recursive: boolean): Promise<void> {
        await s.mkdir(path, { recursive });
      },
      proxyFetch(
        port: number,
        path: string | undefined,
        init: RequestInit | undefined
      ): Promise<Response> {
        const url = `http://localhost:${port}${path ?? "/"}`;
        return s.containerFetch(url, init ?? {}, port);
      },
      raw: stub,
      async readFile(path: string): Promise<Uint8Array> {
        const r = await s.readFile(path);
        return r.encoding === "base64"
          ? base64ToBytes(r.content)
          : new TextEncoder().encode(r.content);
      },
      async remove(path: string): Promise<void> {
        await s.deleteFile(path);
      },
      async rename(from: string, to: string): Promise<void> {
        await s.renameFile(from, to);
      },
      async runCode(
        code: string,
        options: { context?: KernelContext; language?: string }
      ): Promise<CodeExecution> {
        const realContext = options.context
          ? contexts.get(options.context.id)
          : undefined;
        const exec = await s.runCode(code, {
          context: realContext,
          language: options.language,
        });
        return {
          error: exec.error
            ? {
                name: exec.error.name,
                value: exec.error.value,
                traceback: exec.error.traceback,
              }
            : undefined,
          logs: {
            stderr: exec.logs?.stderr ?? [],
            stdout: exec.logs?.stdout ?? [],
          },
          results: (exec.results ?? []).map(mapResult),
        };
      },
      async setTimeout(ttlMs: number): Promise<void> {
        await s.setSleepAfter(ttlMs);
      },
      async unexposePort(port: number): Promise<void> {
        await s.unexposePort(port);
      },
      async writeFile(path: string, data: Uint8Array): Promise<void> {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(data);
            controller.close();
          },
        });
        await s.writeFile(path, stream);
      },
    };
  };

  const provider: SandboxProvider<CloudflareCaps, CFSandbox> = {
    name: "cloudflare",
    capabilities: CLOUDFLARE_CAPS,
    flags: CLOUDFLARE_FLAGS,
    mapError: mapCFError,

    async create(
      spec: SandboxSpec,
      ctx: CallContext
    ): Promise<DriverHandle<CFSandbox>> {
      // get-or-create: the id IS the name. Use idempotencyKey so retries hit
      // the same Durable Object instead of orphaning a new one.
      const id =
        spec.name ?? ctx.idempotencyKey ?? globalThis.crypto.randomUUID();
      return makeHandle(await getStub(id), id, spec.env);
    },

    async connect(id: string): Promise<DriverHandle<CFSandbox>> {
      return makeHandle(await getStub(id), id);
    },
    // NOTE: no `list` — Durable Objects are not enumerable (caps.list = unsupported).
  };
  return provider;
});
