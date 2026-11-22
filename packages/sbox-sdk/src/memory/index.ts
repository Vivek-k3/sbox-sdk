/**
 * `sbox-sdk/memory` — an in-memory sandbox provider. It is the zero-config
 * default for `createSandboxClient()` and the fixture the conformance suite runs
 * against. With `{ bareFs: true }` it hides the native filesystem methods so the
 * core's exec-based polyfills (ls/mkdir/rm/mv/stat) are exercised instead.
 */
import { AsyncQueue, SandboxError } from "../adapter/index.js";
import type {
  CapabilityFlags,
  CapabilityMap,
  DirEntry,
  DriverExec,
  DriverHandle,
  DriverProcess,
  DriverPty,
  DriverTemplates,
  DriverVolumes,
  ExecOptions,
  FileBody,
  FileInfo,
  LifecyclePolicy,
  OutputEvent,
  Preview,
  PtyOptions,
  ResolvedSandboxSpec,
  SandboxInfo,
  SandboxProvider,
  SandboxState,
  SnapshotRef,
  TemplateRef,
  VolumeInfo,
} from "../adapter/index.js";
import { MiniShell } from "./shell.js";
import type { ShellFs } from "./shell.js";

export interface MemoryOptions {
  /** Hide native fs methods to force the core's exec-based polyfills. */
  bareFs?: boolean;
  idPrefix?: string;
}

const MEMORY_CAPS = {
  background: "native",
  codeInterpreter: "unsupported",
  egressControl: "native",
  exposePort: "native",
  filesUpload: "native",
  filesWatch: "unsupported",
  fork: "native",
  gpu: "unsupported",
  killProcess: "native",
  list: "native",
  metrics: "native",
  pause: "native",
  privatePreview: "native",
  proxiedFetch: "unsupported",
  pty: "native",
  region: "unsupported",
  secretsVault: "unsupported",
  setTimeout: "native",
  snapshot: "native",
  ssh: "native",
  statefulKernel: "unsupported",
  stdin: "native",
  stop: "native",
  streaming: "native",
  volumes: "native",
  templateBuild: "native",
} as const satisfies CapabilityMap;

export type MemoryCaps = typeof MEMORY_CAPS;

const MEMORY_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true,
  preservesDiskOnStop: true,
  preservesMemoryOnPause: true,
  previewBrowserAuth: true,
  previewModel: "ip",
  templateSources: ["dockerfile", "image", "snapshot"],
};

interface MemSandbox {
  id: string;
  files: Map<string, Uint8Array>;
  dirs: Set<string>;
  env: Record<string, string>;
  metadata: Record<string, string>;
  state: SandboxState;
  createdAt: Date;
  ports: Map<number, Preview>;
  procCounter: number;
  processes: Map<string, { cmd: string }>;
  snapshots: Map<string, { files: Map<string, Uint8Array>; dirs: Set<string> }>;
  snapCounter: number;
  name?: string;
  template?: string;
  lifecycle?: LifecyclePolicy;
  egress?: import("../adapter/index.js").EgressPolicy;
  live: Map<string, AbortController>;
}

export type MemoryRaw = MemSandbox;

// --------------------------------------------------------------------------
// path helpers
// --------------------------------------------------------------------------

function normalizePath(p: string): string {
  const abs = p.startsWith("/") ? p : `/${p}`;
  const parts: string[] = [];
  for (const seg of abs.split("/")) {
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

function parentOf(p: string): string {
  const n = normalizePath(p);
  const i = n.lastIndexOf("/");
  return i <= 0 ? "/" : n.slice(0, i);
}

function baseName(p: string): string {
  const n = normalizePath(p);
  return n.slice(n.lastIndexOf("/") + 1);
}

function ancestors(dir: string): string[] {
  const out: string[] = [];
  let cur = normalizePath(dir);
  while (cur !== "/") {
    out.unshift(cur);
    cur = parentOf(cur);
  }
  return out;
}

// --------------------------------------------------------------------------
// pure fs ops shared by native methods + exec interpreter
// --------------------------------------------------------------------------

function fsWrite(sb: MemSandbox, path: string, data: Uint8Array): void {
  const p = normalizePath(path);
  for (const a of ancestors(parentOf(p))) {
    sb.dirs.add(a);
  }
  sb.files.set(p, data);
}

function fsRead(sb: MemSandbox, path: string): Uint8Array | null {
  return sb.files.get(normalizePath(path)) ?? null;
}

function fsList(sb: MemSandbox, dir: string): DirEntry[] | null {
  const d = normalizePath(dir);
  if (!sb.dirs.has(d)) {
    return null;
  }
  const seen = new Map<string, DirEntry>();
  for (const sub of sb.dirs) {
    if (sub !== d && parentOf(sub) === d) {
      const name = baseName(sub);
      seen.set(name, { name, path: sub, type: "dir" });
    }
  }
  for (const f of sb.files.keys()) {
    if (parentOf(f) === d) {
      const name = baseName(f);
      seen.set(name, { name, path: f, type: "file" });
    }
  }
  return [...seen.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

function fsMkdir(
  sb: MemSandbox,
  path: string,
  recursive: boolean
): string | null {
  const p = normalizePath(path);
  if (sb.dirs.has(p)) {
    return recursive ? null : `mkdir: cannot create '${path}': File exists`;
  }
  if (sb.files.has(p)) {
    return `mkdir: cannot create '${path}': File exists`;
  }
  if (!recursive && !sb.dirs.has(parentOf(p))) {
    return `mkdir: cannot create '${path}': No such file or directory`;
  }
  for (const a of ancestors(p)) {
    sb.dirs.add(a);
  }
  return null;
}

function fsRemove(
  sb: MemSandbox,
  path: string,
  recursive: boolean,
  force: boolean
): string | null {
  const p = normalizePath(path);
  if (sb.files.has(p)) {
    sb.files.delete(p);
    return null;
  }
  if (sb.dirs.has(p)) {
    if (!recursive) {
      return `rm: cannot remove '${path}': Is a directory`;
    }
    sb.dirs.delete(p);
    for (const d of [...sb.dirs]) {
      if (d.startsWith(`${p}/`)) {
        sb.dirs.delete(d);
      }
    }
    for (const f of [...sb.files.keys()]) {
      if (f.startsWith(`${p}/`)) {
        sb.files.delete(f);
      }
    }
    return null;
  }
  return force
    ? null
    : `rm: cannot remove '${path}': No such file or directory`;
}

function fsRename(sb: MemSandbox, from: string, to: string): string | null {
  const a = normalizePath(from);
  const b = normalizePath(to);
  if (sb.files.has(a)) {
    fsWrite(sb, b, sb.files.get(a)!);
    sb.files.delete(a);
    return null;
  }
  if (sb.dirs.has(a)) {
    for (const a2 of ancestors(b)) {
      sb.dirs.add(a2);
    }
    sb.dirs.add(b);
    for (const f of [...sb.files.keys()]) {
      if (f === a || f.startsWith(`${a}/`)) {
        fsWrite(sb, b + f.slice(a.length), sb.files.get(f)!);
        sb.files.delete(f);
      }
    }
    sb.dirs.delete(a);
    return null;
  }
  return `mv: cannot stat '${from}': No such file or directory`;
}

function fsStat(sb: MemSandbox, path: string): FileInfo | null {
  const p = normalizePath(path);
  if (sb.dirs.has(p)) {
    return { path: p, size: 0, type: "dir" };
  }
  const f = sb.files.get(p);
  if (f) {
    return { path: p, size: f.length, type: "file" };
  }
  return null;
}

// --------------------------------------------------------------------------
// exec over the mini shell
// --------------------------------------------------------------------------

function shellFs(sb: MemSandbox): ShellFs {
  return {
    isDir: (p) => sb.dirs.has(normalizePath(p)),
    list: (d) =>
      fsList(sb, d)?.map((e) => ({
        name: e.name,
        type: e.type === "dir" ? "dir" : "file",
      })) ?? null,
    mkdir: (p, r) => fsMkdir(sb, p, r),
    read: (p) => fsRead(sb, p),
    remove: (p, r, f) => fsRemove(sb, p, r, f),
    rename: (a, b) => fsRename(sb, a, b),
    stat: (p) => {
      const i = fsStat(sb, p);
      return i
        ? { size: i.size, type: i.type === "dir" ? "dir" : "file" }
        : null;
    },
    write: (p, d) => fsWrite(sb, p, d),
  };
}

const dec = new TextDecoder();

/** Start a script; returns a DriverExec whose events stream as the script runs. */
function startScript(
  sb: MemSandbox,
  id: string,
  command: string,
  opts: ExecOptions,
  stdinChunks?: Uint8Array[]
): DriverExec & { done: Promise<number>; pushStdin?: (d: Uint8Array) => void } {
  const q = new AsyncQueue<OutputEvent>();
  const ac = new AbortController();
  sb.live.set(id, ac);
  const opt = opts.stdin;
  const initial =
    typeof opt === "string"
      ? new TextEncoder().encode(opt)
      : opt instanceof Uint8Array
        ? opt
        : new Uint8Array();
  const shell = new MiniShell(shellFs(sb));
  const done = (async () => {
    // Give writeStdin() callers a tick to queue input before `cat` reads it.
    await Promise.resolve();
    const extra = stdinChunks ?? [];
    let total = initial.length;
    for (const c of extra) {
      total += c.length;
    }
    const stdin = new Uint8Array(total);
    stdin.set(initial, 0);
    let off = initial.length;
    for (const c of extra) {
      stdin.set(c, off);
      off += c.length;
    }
    const code = await shell.run(command, {
      cwd: opts.cwd ?? "/",
      env: { ...sb.env, ...opts.env },
      signal: ac.signal,
      stderr: (d) => q.push({ data: dec.decode(d), type: "stderr" }),
      stdin,
      stdout: (d) => q.push({ data: dec.decode(d), type: "stdout" }),
    });
    sb.live.delete(id);
    sb.processes.delete(id);
    q.push({ exitCode: code, type: "exit" });
    q.close();
    return code;
  })();
  return {
    [Symbol.asyncIterator]: () => q.iterator(),
    done,
    async kill() {
      ac.abort();
    },
    pid: Promise.resolve(id),
  };
}

// --------------------------------------------------------------------------
// provider
// --------------------------------------------------------------------------

export function memory(
  opts: MemoryOptions = {}
): SandboxProvider<MemoryCaps, MemoryRaw> {
  const o = opts;
  const bareFs = o.bareFs ?? false;
  const sandboxes = new Map<string, MemSandbox>();
  const templateStore = new Map<
    string,
    TemplateRef & { files: Map<string, Uint8Array> }
  >();
  const volumeStore = new Map<string, VolumeInfo>();
  let counter = 0;

  const spawnSandbox = (spec: ResolvedSandboxSpec): MemSandbox => {
    const id = `${o.idPrefix ?? "mem"}_${++counter}`;
    const sb: MemSandbox = {
      createdAt: new Date(),
      dirs: new Set(["/", "/tmp", "/home", "/app"]),
      egress: spec.network,
      env: { ...spec.env },
      files: new Map(),
      id,
      lifecycle: spec.lifecycle,
      live: new Map(),
      metadata: { ...spec.metadata },
      name: spec.name,
      ports: new Map(),
      procCounter: 0,
      processes: new Map(),
      snapCounter: 0,
      snapshots: new Map(),
      state: "running",
      template: spec.template,
    };
    if (spec.template) {
      const tpl = templateStore.get(spec.template);
      if (!tpl) {
        throw new SandboxError("NotFound", `no template ${spec.template}`, {
          provider: "memory",
        });
      }
      for (const [p, d] of tpl.files) {
        fsWrite(sb, p, d);
      }
    }
    if (spec.fromSnapshot) {
      for (const other of sandboxes.values()) {
        const snap = other.snapshots.get(spec.fromSnapshot);
        if (snap) {
          sb.files = new Map(snap.files);
          sb.dirs = new Set(snap.dirs);
        }
      }
    }
    sandboxes.set(id, sb);
    return sb;
  };

  const info = (sb: MemSandbox): SandboxInfo => ({
    createdAt: sb.createdAt,
    id: sb.id,
    metadata: sb.metadata,
    name: sb.name,
    provider: "memory",
    raw: sb,
    state: sb.state,
  });

  const assertRunning = (sb: MemSandbox): void => {
    if (sb.state !== "running") {
      throw new SandboxError("Conflict", `sandbox ${sb.id} is ${sb.state}`, {
        provider: "memory",
      });
    }
  };

  const makeHandle = (sb: MemSandbox): DriverHandle<MemSandbox> => {
    const ptys = new Map<string, DriverPty>();
    const required = {
      connectProcess: (processId: string): DriverProcess => {
        if (!sb.processes.has(processId)) {
          throw new SandboxError("NotFound", `no process ${processId}`, {
            provider: "memory",
          });
        }
        return {
          ...startScript(sb, `${processId}-view`, "true", {}),
          id: processId,
        };
      },
      connectPty: (id: string): DriverPty => {
        const p = ptys.get(id);
        if (!p) {
          throw new SandboxError("NotFound", `no pty ${id}`, {
            provider: "memory",
          });
        }
        return p;
      },
      createPty: (popts: PtyOptions): DriverPty => {
        const id = `pty${++sb.procCounter}`;
        const out = new AsyncQueue<Uint8Array>();
        const enc = new TextEncoder();
        const shell = new MiniShell(shellFs(sb));
        const env = { ...sb.env, ...popts.env };
        const io = {
          cwd: popts.cwd ?? "/",
          env,
          signal: new AbortController().signal,
          stderr: (d: Uint8Array) => out.push(d),
          stdin: new Uint8Array(),
          stdout: (d: Uint8Array) => out.push(d),
        };
        let line = "";
        let exitCode: number | undefined;
        let resolveExit!: (n: number) => void;
        const exited = new Promise<number>((r) => {
          resolveExit = r;
        });
        let chain = Promise.resolve();
        const finish = (code: number) => {
          if (exitCode === undefined) {
            exitCode = code;
            out.close();
            ptys.delete(id);
            resolveExit(code);
          }
        };
        const pty: DriverPty = {
          id,
          async kill() {
            finish(130);
          },
          output: { [Symbol.asyncIterator]: () => out.iterator() },
          async resize() {
            /* no-op for memory */
          },
          async wait() {
            return exited;
          },
          async write(data: Uint8Array) {
            if (exitCode !== undefined) {
              return;
            }
            const text = dec.decode(data);
            out.push(enc.encode(text.replaceAll("\n", "\r\n"))); // tty echo
            line += text;
            let nl = line.indexOf("\n");
            while (nl !== -1) {
              const cmd = line.slice(0, nl).replace(/\r$/, "");
              line = line.slice(nl + 1);
              if (/^\s*exit(\s|$)/.test(cmd)) {
                const code = Number(cmd.trim().split(/\s+/)[1] ?? 0) || 0;
                chain = chain.then(() => finish(code));
              } else {
                chain = chain.then(async () => {
                  await shell.run(cmd, io);
                });
              }
              nl = line.indexOf("\n");
            }
            await chain;
          },
        };
        ptys.set(id, pty);
        return pty;
      },
      createSsh: () => ({
        host: "127.0.0.1",
        port: 22,
        privateKey:
          "-----BEGIN OPENSSH PRIVATE KEY-----\nmemory\n-----END OPENSSH PRIVATE KEY-----\n",
        user: sb.id,
      }),
      deleteSnapshot: (ref: string): void => {
        sb.snapshots.delete(ref);
      },
      destroy: () => {
        for (const ac of sb.live.values()) {
          ac.abort();
        }
        sb.state = "destroyed";
        sandboxes.delete(sb.id);
      },
      exec: (cmd: string, execOpts: ExecOptions): DriverExec => {
        assertRunning(sb);
        const pending: Uint8Array[] = [];
        const ex = startScript(
          sb,
          `p${++sb.procCounter}`,
          cmd,
          execOpts,
          pending
        );
        return {
          ...ex,
          async writeStdin(d: Uint8Array) {
            pending.push(d);
          },
        };
      },
      exposePort: (port: number, eopts: { private?: boolean }): Preview => {
        const preview: Preview = eopts.private
          ? {
              auth: {
                param: "sbox_token",
                token: `tok_${sb.id}_${port}`,
                type: "query",
              },
              port,
              url: `https://${port}-${sb.id}.memory.local`,
            }
          : {
              auth: { type: "public" },
              port,
              url: `https://${port}-${sb.id}.memory.local`,
            };
        sb.ports.set(port, preview);
        return preview;
      },
      fork: (count: number): DriverHandle<MemSandbox>[] => {
        const out: DriverHandle<MemSandbox>[] = [];
        for (let i = 0; i < count; i++) {
          const clone = spawnSandbox({ env: sb.env, metadata: sb.metadata });
          clone.files = new Map(sb.files);
          clone.dirs = new Set(sb.dirs);
          out.push(makeHandle(clone));
        }
        return out;
      },
      getInfo: () => info(sb),
      getMetrics: () => {
        let bytes = 0;
        for (const f of sb.files.values()) {
          bytes += f.length;
        }
        return {
          cpuPercent: 0,
          diskUsedMB: bytes / 1_048_576,
          memoryTotalMB: 1024,
          memoryUsedMB: 0,
          raw: sb,
          timestamp: new Date(),
        };
      },
      id: sb.id,
      killProcess: (processId: string): void => {
        const ac = sb.live.get(processId);
        if (!ac && !sb.processes.has(processId)) {
          throw new SandboxError("NotFound", `no process ${processId}`, {
            provider: "memory",
          });
        }
        ac?.abort();
        sb.processes.delete(processId);
      },
      listPorts: (): Preview[] => [...sb.ports.values()],
      listProcesses: () =>
        [...sb.processes.entries()].map(([id, p]) => ({ cmd: p.cmd, id })),
      listSnapshots: (): SnapshotRef[] =>
        [...sb.snapshots.keys()].map((id) => ({
          id,
          includesMemory: false,
          provider: "memory",
          raw: sb,
        })),
      name: sb.name,
      pause: () => {
        sb.state = "paused";
      },
      raw: sb,
      readFile: (path: string): Uint8Array => {
        const data = fsRead(sb, path);
        if (!data) {
          throw new SandboxError("NotFound", `no such file: '${path}'`, {
            provider: "memory",
          });
        }
        return data;
      },
      restoreSnapshot: (ref: string): void => {
        const snap = sb.snapshots.get(ref);
        if (!snap) {
          throw new SandboxError("NotFound", `no snapshot ${ref}`, {
            provider: "memory",
          });
        }
        sb.files = new Map(snap.files);
        sb.dirs = new Set(snap.dirs);
      },
      resume: () => {
        sb.state = "running";
      },
      setEgressPolicy: (policy: import("../adapter/index.js").EgressPolicy) => {
        sb.egress = policy;
      },
      setTimeout: (ttlMs: number) => {
        sb.lifecycle = { ...sb.lifecycle, maxAgeMs: ttlMs };
      },
      snapshot: ({ name }: { name?: string }): SnapshotRef => {
        const id = `snap_${sb.id}_${++sb.snapCounter}`;
        sb.snapshots.set(id, {
          dirs: new Set(sb.dirs),
          files: new Map(sb.files),
        });
        return {
          createdAt: new Date(),
          id,
          includesMemory: false,
          name,
          provider: "memory",
          raw: sb,
        };
      },
      spawn: (cmd: string, execOpts: ExecOptions): DriverProcess => {
        assertRunning(sb);
        const id = `p${++sb.procCounter}`;
        sb.processes.set(id, { cmd });
        const pending: Uint8Array[] = [];
        return {
          ...startScript(sb, id, cmd, execOpts, pending),
          id,
          async writeStdin(d: Uint8Array) {
            pending.push(d);
          },
        };
      },
      stop: () => {
        sb.state = "stopped";
      },
      unexposePort: (port: number): void => {
        sb.ports.delete(port);
      },
      writeFile: (path: string, data: Uint8Array): void =>
        fsWrite(sb, path, data),
    };

    if (bareFs) {
      return required;
    }

    return {
      ...required,
      listDir: (path: string): DirEntry[] => {
        const entries = fsList(sb, path);
        if (!entries) {
          throw new SandboxError("NotFound", `not a directory: '${path}'`, {
            provider: "memory",
          });
        }
        return entries;
      },
      mkdir: (path: string, recursive: boolean): void => {
        const err = fsMkdir(sb, path, recursive);
        if (err) {
          throw new SandboxError("Provider", err, { provider: "memory" });
        }
      },
      remove: (path: string, recursive: boolean): void => {
        const err = fsRemove(sb, path, recursive, true);
        if (err) {
          throw new SandboxError("Provider", err, { provider: "memory" });
        }
      },
      rename: (from: string, to: string): void => {
        const err = fsRename(sb, from, to);
        if (err) {
          throw new SandboxError("NotFound", err, { provider: "memory" });
        }
      },
      stat: (path: string): FileInfo => {
        const i = fsStat(sb, path);
        if (!i) {
          throw new SandboxError("NotFound", `not found: '${path}'`, {
            provider: "memory",
          });
        }
        return i;
      },
      upload: async (path: string, data: FileBody): Promise<void> => {
        if (typeof data === "string") {
          fsWrite(sb, path, new TextEncoder().encode(data));
        } else if (data instanceof Uint8Array) {
          fsWrite(sb, path, data);
        } else {
          fsWrite(
            sb,
            path,
            new Uint8Array(await new Response(data).arrayBuffer())
          );
        }
      },
    };
  };

  /**
   * Template "build": a Dockerfile's `COPY <src> <dest>` lines copy context
   * files into the image; everything else is recorded but not executed.
   */
  const templates: DriverTemplates = {
    async build(spec, bopts) {
      const files = new Map<string, Uint8Array>();
      const { source } = spec;
      if ("dockerfile" in source && source.dockerfile !== undefined) {
        const { loadTemplateContext, parseDockerfile } =
          await import("../adapter/index.js");
        const ctx = await loadTemplateContext(source.context);
        for (const ins of parseDockerfile(source.dockerfile)) {
          bopts.onEvent({ line: ins.raw, step: ins.op, type: "log" });
          if (ins.op === "COPY") {
            const [src, dest] = ins.args.split(/\s+/);
            const data = src ? ctx.get(src.replace(/^\.\//, "")) : undefined;
            if (data && dest) {
              files.set(dest, data);
            }
          }
        }
      } else if ("snapshot" in source && source.snapshot !== undefined) {
        for (const other of sandboxes.values()) {
          const snap = other.snapshots.get(source.snapshot);
          if (snap) {
            for (const [p, d] of snap.files) {
              files.set(p, d);
            }
          }
        }
      }
      const ref = {
        cacheKey: spec.cacheKey,
        createdAt: new Date(),
        files,
        id: spec.name,
        name: spec.name,
        provider: "memory",
        raw: undefined,
      };
      templateStore.set(spec.name, ref);
      return ref;
    },
    async delete(id) {
      templateStore.delete(id);
    },
    async lookup(idOrKey) {
      for (const t of templateStore.values()) {
        if (t.id === idOrKey || t.cacheKey === idOrKey || t.name === idOrKey) {
          return t;
        }
      }
      return undefined;
    },
    async *list() {
      yield* templateStore.values();
    },
  };

  let volCounter = 0;
  const volumes: DriverVolumes = {
    async create(spec) {
      const v: VolumeInfo = {
        createdAt: new Date(),
        id: `vol_${++volCounter}`,
        name: spec.name,
        raw: undefined,
        region: spec.region,
        sizeMB: spec.sizeMB,
      };
      volumeStore.set(v.id, v);
      return v;
    },
    async delete(id) {
      volumeStore.delete(id);
    },
    async get(idOrName) {
      return (
        volumeStore.get(idOrName) ??
        [...volumeStore.values()].find((v) => v.name === idOrName)
      );
    },
    async *list() {
      yield* volumeStore.values();
    },
  };

  const provider: SandboxProvider<MemoryCaps, MemoryRaw> = {
    capabilities: MEMORY_CAPS,
    connect: (id) => {
      const sb = sandboxes.get(id);
      if (!sb) {
        throw new SandboxError("NotFound", `no sandbox ${id}`, {
          provider: "memory",
        });
      }
      return makeHandle(sb);
    },
    create: (spec) => makeHandle(spawnSandbox(spec)),
    flags: MEMORY_FLAGS,
    async *list(filter) {
      let n = 0;
      for (const sb of sandboxes.values()) {
        if (filter?.state && sb.state !== filter.state) {
          continue;
        }
        if (
          filter?.metadata &&
          !Object.entries(filter.metadata).every(
            ([k, v]) => sb.metadata[k] === v
          )
        ) {
          continue;
        }
        if (filter?.limit !== undefined && n >= filter.limit) {
          return;
        }
        n++;
        yield info(sb);
      }
    },
    name: "memory",
    templates,
    verify: () => ({ account: "memory" }),
    volumes,
  };
  return provider;
}
