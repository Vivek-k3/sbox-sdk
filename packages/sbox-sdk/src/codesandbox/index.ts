/**
 * `sbox-sdk/codesandbox`: adapter for the CodeSandbox SDK (`@codesandbox/sdk`).
 *
 * **Deprecated.** CodeSandbox's sandbox product moved to Together Sandbox; use
 * `sbox-sdk/together` instead. This adapter only receives crash/leak fixes and
 * will be removed in sbox-sdk 0.2.0.
 *
 * A "sandbox" is a CodeSandbox microVM. The SDK has two halves: a control object
 * (`sdk.sandboxes.*`) and a per-sandbox `client` from `sandbox.connect()` for
 * commands/fs/hosts. This adapter holds both.
 *
 * exec runs through `client.commands.runBackground` so output streams and
 * `kill()` really kills. CodeSandbox shells are PTYs: stdout and stderr arrive
 * merged (reported as stdout) and a non-zero exit surfaces as a `CommandError`,
 * which the adapter turns into a normal `exit` event. Filesystem is native
 * (`client.fs.*`). `pause()` = hibernate, `resume()` wakes and reconnects,
 * `destroy()` permanently deletes. Metadata is stored as `key=value` tags.
 *
 * Requires the optional peer dependency `@codesandbox/sdk`.
 */
import { AsyncQueue, defineProvider, SandboxError } from "../adapter/index.js";
import type {
  CapabilityFlags,
  CapabilityMap,
  DirEntry,
  DriverExec,
  DriverHandle,
  ExecOptions,
  FileInfo,
  OutputEvent,
  Preview,
  ResolvedSandboxSpec,
  SandboxInfo,
  SandboxProvider,
  SandboxState,
} from "../adapter/index.js";

type Mod = typeof import("@codesandbox/sdk");

// `@codesandbox/sdk@2.4.2` ships ESM declarations whose relative re-exports
// have no file extension, so under `moduleResolution: NodeNext` everything but
// the `CodeSandbox` class itself resolves to `any`. These views mirror the
// 2.4.2 `.d.ts` (Sandboxes, Sandbox, SandboxClient, Command, HostTokens) for
// the members this adapter uses.
export interface CsbCommand {
  onOutput(listener: (out: string) => void): { dispose(): void };
  waitUntilComplete(): Promise<string>;
  kill(): Promise<void>;
}
export interface CsbFsStat {
  type: "file" | "directory";
  isSymlink: boolean;
  size: number;
  mtime: number;
}
export interface CsbClient {
  readonly state:
    | "CONNECTED"
    | "CONNECTING"
    | "RECONNECTING"
    | "DISCONNECTED"
    | "HIBERNATED";
  dispose(): void;
  commands: {
    runBackground(
      command: string,
      opts?: { cwd?: string; env?: Record<string, string> }
    ): Promise<CsbCommand>;
  };
  fs: {
    readFile(path: string): Promise<Uint8Array>;
    writeFile(
      path: string,
      content: Uint8Array,
      opts?: { create?: boolean; overwrite?: boolean }
    ): Promise<void>;
    readdir(
      path: string
    ): Promise<
      { name: string; type: "file" | "directory"; isSymlink: boolean }[]
    >;
    stat(path: string): Promise<CsbFsStat>;
    rename(from: string, to: string, overwrite?: boolean): Promise<void>;
    remove(path: string, recursive?: boolean): Promise<void>;
  };
  hosts: { getUrl(port: number, protocol?: string): string };
}
/** The SDK's sandbox control object (`raw()` on a CodeSandbox sandbox). */
export interface CsbSandbox {
  id: string;
  connect(): Promise<CsbClient>;
  updateHibernationTimeout(timeoutSeconds: number): Promise<void>;
}
export interface CsbInfo {
  id: string;
  createdAt: Date;
  title?: string;
  tags: string[];
}
export interface CsbSdk {
  sandboxes: {
    create(opts?: {
      id?: string;
      title?: string;
      tags?: string[];
      hibernationTimeoutSeconds?: number;
    }): Promise<CsbSandbox>;
    resume(sandboxId: string): Promise<CsbSandbox>;
    hibernate(sandboxId: string): Promise<void>;
    delete(sandboxId: string): Promise<void>;
    get(sandboxId: string): Promise<CsbInfo>;
    list(opts?: {
      tags?: string[];
      status?: "running";
      limit?: number;
      pagination?: { page?: number; pageSize?: number };
    }): Promise<{
      sandboxes: CsbInfo[];
      pagination: { nextPage: number | null };
    }>;
    listRunning(): Promise<{ vms: { id: string | undefined }[] }>;
  };
  hosts: {
    createToken(
      sandboxId: string,
      opts: { expiresAt: Date }
    ): Promise<{ token: string; expiresAt: Date | null }>;
  };
}

export interface CodeSandboxOptions {
  /** API key. Defaults to `CSB_API_KEY`. */
  apiKey?: string;
  /** Default template/sandbox id to fork from when `spec.template` is unset. */
  templateId?: string;
}

export const CODESANDBOX_CAPS = {
  background: "unsupported",
  codeInterpreter: "unsupported",
  egressControl: "unsupported",
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "unsupported",
  fork: "unsupported",
  gpu: "unsupported",
  killProcess: "unsupported",
  list: "native",
  metrics: "unsupported",
  pause: "native",
  privatePreview: "native",
  proxiedFetch: "unsupported",
  pty: "unsupported",
  region: "unsupported",
  secretsVault: "unsupported",
  setTimeout: "native",
  snapshot: "unsupported",
  ssh: "unsupported",
  statefulKernel: "unsupported",
  stdin: "unsupported",
  stop: "unsupported",
  streaming: "native",
  volumes: "unsupported",
  templateBuild: "unsupported",
} as const satisfies CapabilityMap;

export type CodeSandboxCaps = typeof CODESANDBOX_CAPS;

const CODESANDBOX_FLAGS: CapabilityFlags = {
  exitCodeNative: true, // exit code recovered from CommandError
  perCommandEnvCwd: true, // commands.runBackground accepts { cwd, env }
  preservesDiskOnStop: false,
  preservesMemoryOnPause: true, // hibernate snapshots memory
  previewModel: "subdomain",
};

const PROVIDER = "codesandbox";
/** Private preview tokens are minted for this long. */
const PREVIEW_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

let cached: Mod | null = null;
async function loadCsb(): Promise<Mod> {
  cached ??= await import("@codesandbox/sdk");
  return cached;
}

let warned = false;
function warnDeprecated(): void {
  if (!warned) {
    warned = true;
    console.warn(
      "[sbox] sbox-sdk/codesandbox is deprecated: CodeSandbox sandboxes moved to Together Sandbox. Use sbox-sdk/together; this adapter will be removed in sbox-sdk 0.2.0."
    );
  }
}

/** `metadata` <-> CodeSandbox tags, encoded as `key=value`. */
export function metadataToTags(
  m: Record<string, string> | undefined
): string[] {
  return Object.entries(m ?? {}).map(([k, v]) => `${k}=${v}`);
}

export function tagsToMetadata(
  tags: readonly string[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tags) {
    const i = t.indexOf("=");
    if (i > 0) {
      out[t.slice(0, i)] = t.slice(i + 1);
    }
  }
  return out;
}

/** Connected-client state (+ running-VM membership) -> SandboxState. */
export function mapCsbState(
  clientState: string | undefined,
  running: boolean
): SandboxState {
  switch (clientState) {
    case "CONNECTED":
    case "CONNECTING":
    case "RECONNECTING": {
      return "running";
    }
    case "HIBERNATED": {
      return "paused";
    }
    default: {
      return running ? "running" : "stopped";
    }
  }
}

/** The SDK throws plain `Error`s with fixed suffixes (see its `handleResponse`). */
export function mapCsbError(err: unknown): SandboxError | undefined {
  if (err instanceof SandboxError) {
    return err;
  }
  if (!(err instanceof Error)) {
    return undefined;
  }
  const opts = { cause: err, provider: PROVIDER };
  const msg = err.message;
  if ((err as { type?: unknown }).type === "rate-limit") {
    return new SandboxError("QuotaExceeded", msg, { ...opts, retryable: true });
  }
  if (/: Sandbox not found$|\bnot found\b|ENOENT|no such file/i.test(msg)) {
    return new SandboxError("NotFound", msg, opts);
  }
  if (/: Unauthorized$|CSB_API_KEY is not set|\b401\b/i.test(msg)) {
    return new SandboxError("Unauthorized", msg, opts);
  }
  if (/overloaded|Bad gateway/i.test(msg)) {
    return new SandboxError("Provider", msg, { ...opts, retryable: true });
  }
  if (/timed? ?out/i.test(msg)) {
    return new SandboxError("Timeout", msg, opts);
  }
  return undefined;
}

const wrap = (e: unknown): SandboxError =>
  mapCsbError(e) ?? SandboxError.wrap(e, PROVIDER);

function mapFileType(type: string | undefined): "file" | "dir" | "symlink" {
  return type === "directory" ? "dir" : "file";
}

function toInfo(meta: CsbInfo, state: SandboxState, raw: unknown): SandboxInfo {
  return {
    createdAt: meta.createdAt,
    id: meta.id,
    metadata: tagsToMetadata(meta.tags),
    name: meta.title,
    provider: PROVIDER,
    raw,
    state,
  };
}

/**
 * @deprecated CodeSandbox sandboxes moved to Together Sandbox: use
 * `together()` from `sbox-sdk/together`. This adapter will be removed in
 * sbox-sdk 0.2.0.
 */
export const codesandbox = defineProvider<
  CodeSandboxCaps,
  CsbSandbox,
  CodeSandboxOptions
>((opts = {}) => {
  warnDeprecated();
  let sdkP: Promise<CsbSdk> | null = null;
  const getSdk = (): Promise<CsbSdk> => {
    sdkP ??= loadCsb().then((mod): CsbSdk => new mod.CodeSandbox(opts.apiKey));
    return sdkP;
  };

  const makeHandle = (
    sdk: CsbSdk,
    initialSb: CsbSandbox,
    initialClient: CsbClient
  ): DriverHandle<CsbSandbox> => {
    let sb = initialSb;
    let client = initialClient;
    let paused = false;

    return {
      async destroy(): Promise<void> {
        // shutdown() only stops the VM; delete() removes the sandbox.
        client.dispose();
        await sdk.sandboxes.delete(sb.id);
      },
      exec(cmd: string, options: ExecOptions): DriverExec {
        const queue = new AsyncQueue<OutputEvent>();
        let settled = false;
        let killFn: (() => Promise<void>) | undefined;
        let killRequested = false;
        const kill = async (): Promise<void> => {
          killRequested = true;
          if (!settled) {
            settled = true;
            queue.push({ exitCode: 137, signal: "SIGKILL", type: "exit" });
            queue.close();
          }
          await killFn?.();
        };
        void (async () => {
          const command = await client.commands.runBackground(cmd, {
            cwd: options.cwd,
            env: options.env,
          });
          killFn = () => command.kill();
          if (killRequested) {
            await command.kill();
            return;
          }
          const sub = command.onOutput((out) => {
            if (!settled && out) {
              // PTY line endings -> plain newlines.
              queue.push({
                data: out.replaceAll("\r\n", "\n"),
                type: "stdout",
              });
            }
          });
          let exitCode = 0;
          try {
            await command.waitUntilComplete();
          } catch (error: unknown) {
            // A non-zero exit is a CommandError carrying the exit code.
            const code =
              error instanceof Error && error.name === "CommandError"
                ? (error as Error & { exitCode?: unknown }).exitCode
                : undefined;
            if (typeof code === "number") {
              exitCode = code;
            } else {
              throw error;
            }
          } finally {
            sub.dispose();
          }
          if (!settled) {
            settled = true;
            queue.push({ exitCode, type: "exit" });
            queue.close();
          }
        })().catch((error: unknown) => {
          if (!settled) {
            settled = true;
            queue.fail(wrap(error));
          }
        });
        return {
          [Symbol.asyncIterator]: () => queue.iterator(),
          kill,
          pid: Promise.resolve(""),
        };
      },
      async exposePort(
        port: number,
        popts: { private?: boolean }
      ): Promise<Preview> {
        if (!popts.private) {
          return {
            auth: { type: "public" },
            port,
            url: client.hosts.getUrl(port),
          };
        }
        const token = await sdk.hosts.createToken(sb.id, {
          expiresAt: new Date(Date.now() + PREVIEW_TOKEN_TTL_MS),
        });
        return {
          auth: { param: "preview_token", token: token.token, type: "query" },
          expiresAt: token.expiresAt ?? undefined,
          port,
          url: `https://${sb.id}-${port}.csb.app`,
        };
      },
      async getInfo(): Promise<SandboxInfo> {
        const meta = await sdk.sandboxes.get(sb.id);
        if (paused) {
          return toInfo(meta, "paused", sb);
        }
        let running = false;
        if (client.state === "DISCONNECTED") {
          const { vms } = await sdk.sandboxes.listRunning();
          running = vms.some((vm) => vm.id === sb.id);
        }
        return toInfo(meta, mapCsbState(client.state, running), sb);
      },
      id: initialSb.id,
      async listDir(path: string): Promise<DirEntry[]> {
        const entries = await client.fs.readdir(path);
        const base = path.replace(/\/$/, "");
        return entries.map((e) => ({
          name: e.name,
          path: `${base}/${e.name}`,
          type: e.isSymlink ? "symlink" : mapFileType(e.type),
        }));
      },
      async pause(): Promise<void> {
        await sdk.sandboxes.hibernate(sb.id);
        paused = true;
      },
      get raw() {
        return sb;
      },
      async readFile(path: string): Promise<Uint8Array> {
        return new Uint8Array(await client.fs.readFile(path));
      },
      async remove(path: string, recursive: boolean): Promise<void> {
        await client.fs.remove(path, recursive);
      },
      async rename(from: string, to: string): Promise<void> {
        await client.fs.rename(from, to);
      },
      async resume(): Promise<void> {
        // Hibernation drops the session: resume and reconnect a fresh client.
        sb = await sdk.sandboxes.resume(sb.id);
        client.dispose();
        client = await sb.connect();
        paused = false;
      },
      async setTimeout(ttlMs: number): Promise<void> {
        await sb.updateHibernationTimeout(Math.max(1, Math.ceil(ttlMs / 1000)));
      },
      async stat(path: string): Promise<FileInfo> {
        const s = await client.fs.stat(path);
        return {
          mtime: s.mtime ? new Date(s.mtime) : undefined,
          path,
          size: s.size,
          type: s.isSymlink ? "symlink" : mapFileType(s.type),
        };
      },
      async writeFile(path: string, data: Uint8Array): Promise<void> {
        await client.fs.writeFile(path, data, {
          create: true,
          overwrite: true,
        });
      },
    };
  };

  const provider: SandboxProvider<CodeSandboxCaps, CsbSandbox> = {
    capabilities: CODESANDBOX_CAPS,
    async connect(id: string): Promise<DriverHandle<CsbSandbox>> {
      const sdk = await getSdk();
      const sb = await sdk.sandboxes.resume(id);
      return makeHandle(sdk, sb, await sb.connect());
    },
    async create(spec: ResolvedSandboxSpec): Promise<DriverHandle<CsbSandbox>> {
      const sdk = await getSdk();
      const idle = spec.lifecycle?.idleTimeoutMs ?? spec.lifecycle?.maxAgeMs;
      const sb = await sdk.sandboxes.create({
        hibernationTimeoutSeconds: idle ? Math.ceil(idle / 1000) : undefined,
        id: spec.template ?? opts.templateId,
        tags: spec.metadata ? metadataToTags(spec.metadata) : undefined,
        title: spec.name,
      });
      try {
        return makeHandle(sdk, sb, await sb.connect());
      } catch (error) {
        // Don't leak a sandbox we created but couldn't connect to.
        await sdk.sandboxes.delete(sb.id).catch(() => {});
        throw error;
      }
    },
    flags: CODESANDBOX_FLAGS,
    async *list(filter): AsyncIterable<SandboxInfo> {
      const sdk = await getSdk();
      const tags = filter?.metadata
        ? metadataToTags(filter.metadata)
        : undefined;
      const pageSize = 50;
      async function* pages(status?: "running") {
        let page: number | null = 1;
        while (page) {
          const res: Awaited<ReturnType<CsbSdk["sandboxes"]["list"]>> =
            await sdk.sandboxes.list({
              limit: pageSize,
              pagination: { page, pageSize },
              status,
              tags,
            });
          yield res.sandboxes;
          page = res.pagination.nextPage;
        }
      }
      // The list endpoint carries no status; the `running` filter does.
      const running = new Set<string>();
      for await (const batch of pages("running")) {
        for (const s of batch) {
          running.add(s.id);
        }
      }
      let n = 0;
      for await (const batch of pages(
        filter?.state === "running" ? "running" : undefined
      )) {
        for (const s of batch) {
          const i = toInfo(s, running.has(s.id) ? "running" : "stopped", s);
          if (filter?.state && i.state !== filter.state) {
            continue;
          }
          if (
            filter?.metadata &&
            !Object.entries(filter.metadata).every(
              ([k, v]) => i.metadata[k] === v
            )
          ) {
            continue;
          }
          if (filter?.limit !== undefined && n >= filter.limit) {
            return;
          }
          n++;
          yield i;
        }
      }
    },
    mapError: mapCsbError,
    name: PROVIDER,
    async verify() {
      const sdk = await getSdk();
      await sdk.sandboxes.list({
        limit: 1,
        pagination: { page: 1, pageSize: 1 },
      });
      return undefined;
    },
  };
  return provider;
});
