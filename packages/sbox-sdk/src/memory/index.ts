/**
 * `sbox-sdk/memory` — an in-memory sandbox provider. It is the zero-config
 * default for `createSandboxClient()` and the fixture the conformance suite runs
 * against. With `{ bareFs: true }` it hides the native filesystem methods so the
 * core's exec-based polyfills (ls/mkdir/rm/mv/stat) are exercised instead.
 */
import { SandboxError } from "../adapter/index.js";
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
  Preview,
  SandboxInfo,
  SandboxProvider,
  SandboxSpec,
  SandboxState,
  SnapshotRef,
} from "../adapter/index.js";

export interface MemoryOptions {
  /** Hide native fs methods to force the core's exec-based polyfills. */
  bareFs?: boolean;
  idPrefix?: string;
}

const MEMORY_CAPS = {
  background: "native",
  codeInterpreter: "unsupported",
  egressControl: "unsupported",
  exposePort: "emulated",
  filesUpload: "native",
  filesWatch: "unsupported",
  fork: "native",
  gpu: "unsupported",
  killProcess: "native",
  list: "native",
  metrics: "unsupported",
  pause: "native",
  privatePreview: "unsupported",
  proxiedFetch: "unsupported",
  pty: "unsupported",
  region: "unsupported",
  secretsVault: "unsupported",
  setTimeout: "native",
  snapshot: "native",
  ssh: "unsupported",
  statefulKernel: "unsupported",
  stdin: "unsupported",
  stop: "native",
  streaming: "native",
  volumes: "unsupported",
} as const satisfies CapabilityMap;

export type MemoryCaps = typeof MEMORY_CAPS;

const MEMORY_FLAGS: CapabilityFlags = {
  exitCodeNative: true,
  perCommandEnvCwd: true,
  preservesDiskOnStop: true,
  preservesMemoryOnPause: true,
  previewModel: "ip",
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

function resolvePath(cwd: string, p: string): string {
  return p.startsWith("/") ? normalizePath(p) : normalizePath(`${cwd}/${p}`);
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
// minimal in-memory shell for exec()
// --------------------------------------------------------------------------

interface MiniResult {
  stdout: string;
  stderr: string;
  exit: number;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let has = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      has = true;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === " " || ch === "\t") {
      if (has) {
        tokens.push(cur);
        cur = "";
        has = false;
      }
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) {
    tokens.push(cur);
  }
  return tokens;
}

function expandVars(s: string, env: Record<string, string>): string {
  return s.replaceAll(
    /\$\{(\w+)\}|\$(\w+)/g,
    (_m, a: string, b: string) => env[a ?? b] ?? ""
  );
}

function runMemCommand(
  sb: MemSandbox,
  command: string,
  opts: ExecOptions
): MiniResult {
  const cwd = opts.cwd ?? "/";
  const env = { ...sb.env, ...opts.env };
  const argv = tokenize(expandVars(command, env));
  const [cmd] = argv;
  const ok = (stdout = ""): MiniResult => ({ exit: 0, stderr: "", stdout });
  const operands = argv.slice(1).filter((a) => !a.startsWith("-"));

  switch (cmd) {
    case undefined: {
      return ok();
    }
    case "true": {
      return ok();
    }
    case "false": {
      return { exit: 1, stderr: "", stdout: "" };
    }
    case "exit": {
      return { exit: Number(argv[1] ?? 0) || 0, stderr: "", stdout: "" };
    }
    case "pwd": {
      return ok(`${cwd}\n`);
    }
    case "echo": {
      let args = argv.slice(1);
      let nl = true;
      if (args[0] === "-n") {
        nl = false;
        args = args.slice(1);
      }
      return ok(args.join(" ") + (nl ? "\n" : ""));
    }
    case "printf": {
      return ok(
        (operands[0] ?? "").replaceAll(/\\n/g, "\n").replaceAll(/\\t/g, "\t")
      );
    }
    case "env": {
      return ok(
        `${Object.entries(env)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n")}\n`
      );
    }
    case "cat": {
      let out = "";
      for (const f of operands) {
        const data = fsRead(sb, resolvePath(cwd, f));
        if (!data) {
          return {
            exit: 1,
            stderr: `cat: ${f}: No such file or directory\n`,
            stdout: "",
          };
        }
        out += new TextDecoder().decode(data);
      }
      return ok(out);
    }
    case "touch": {
      for (const f of operands) {
        fsWrite(sb, resolvePath(cwd, f), new Uint8Array());
      }
      return ok();
    }
    case "ls": {
      const entries = fsList(sb, resolvePath(cwd, operands[0] ?? "."));
      if (!entries) {
        return {
          exit: 2,
          stderr: `ls: cannot access '${operands[0] ?? "."}': No such file or directory\n`,
          stdout: "",
        };
      }
      const names = entries.map((e) =>
        e.type === "dir" ? `${e.name}/` : e.name
      );
      return ok(names.length ? `${names.join("\n")}\n` : "");
    }
    case "mkdir": {
      const recursive = argv.includes("-p");
      const err = fsMkdir(sb, resolvePath(cwd, operands[0] ?? ""), recursive);
      return err ? { exit: 1, stderr: `${err}\n`, stdout: "" } : ok();
    }
    case "rm": {
      const flags = argv.filter((a) => a.startsWith("-")).join("");
      const recursive = flags.includes("r") || flags.includes("R");
      const force = flags.includes("f");
      for (const f of operands) {
        const err = fsRemove(sb, resolvePath(cwd, f), recursive, force);
        if (err) {
          return { exit: 1, stderr: `${err}\n`, stdout: "" };
        }
      }
      return ok();
    }
    case "mv": {
      if (operands.length < 2) {
        return { exit: 1, stderr: "mv: missing operand\n", stdout: "" };
      }
      const err = fsRename(
        sb,
        resolvePath(cwd, operands[0]!),
        resolvePath(cwd, operands[1]!)
      );
      return err ? { exit: 1, stderr: `${err}\n`, stdout: "" } : ok();
    }
    case "stat": {
      const target = argv.at(-1) ?? "";
      const info = fsStat(sb, resolvePath(cwd, target));
      if (!info) {
        return {
          exit: 1,
          stderr: `stat: cannot statx '${target}': No such file or directory\n`,
          stdout: "",
        };
      }
      const kind = info.type === "dir" ? "directory" : "regular file";
      return ok(`${kind}|${info.size}|0\n`);
    }
    default: {
      return { exit: 127, stderr: `sh: ${cmd}: not found\n`, stdout: "" };
    }
  }
}

function toDriverExec(pid: string, r: MiniResult): DriverExec {
  return {
    pid: Promise.resolve(pid),
    async kill() {
      /* nothing to kill in memory */
    },
    async *[Symbol.asyncIterator]() {
      if (r.stdout) {
        yield { data: r.stdout, type: "stdout" };
      }
      if (r.stderr) {
        yield { data: r.stderr, type: "stderr" };
      }
      yield { exitCode: r.exit, type: "exit" };
    },
  };
}

// --------------------------------------------------------------------------
// provider
// --------------------------------------------------------------------------

export function memory(
  opts: MemoryOptions = {}
): SandboxProvider<MemoryCaps, MemoryRaw> {
  {
    const o = opts;
    const bareFs = o.bareFs ?? false;
    const sandboxes = new Map<string, MemSandbox>();
    let counter = 0;

    const spawnSandbox = (spec: SandboxSpec): MemSandbox => {
      const id = `${o.idPrefix ?? "mem"}_${++counter}`;
      const sb: MemSandbox = {
        createdAt: new Date(),
        dirs: new Set(["/", "/tmp", "/home", "/app"]),
        env: { ...spec.env },
        files: new Map(),
        id,
        metadata: { ...spec.metadata },
        ports: new Map(),
        procCounter: 0,
        processes: new Map(),
        snapCounter: 0,
        snapshots: new Map(),
        state: "running",
      };
      sandboxes.set(id, sb);
      return sb;
    };

    const info = (sb: MemSandbox): SandboxInfo => ({
      createdAt: sb.createdAt,
      id: sb.id,
      metadata: sb.metadata,
      provider: "memory",
      raw: sb,
      state: sb.state,
    });

    const makeHandle = (sb: MemSandbox): DriverHandle<MemSandbox> => {
      const required = {
        connectProcess: (processId: string): DriverProcess => ({
          ...toDriverExec(processId, { exit: 0, stderr: "", stdout: "" }),
          id: processId,
        }),
        deleteSnapshot: (ref: string): void => {
          sb.snapshots.delete(ref);
        },
        destroy: () => {
          sb.state = "destroyed";
          sandboxes.delete(sb.id);
        },
        exec: (cmd: string, execOpts: ExecOptions): DriverExec =>
          toDriverExec(
            `p${++sb.procCounter}`,
            runMemCommand(sb, cmd, execOpts)
          ),
        exposePort: (port: number): Preview => {
          const preview: Preview = { port, url: `http://127.0.0.1:${port}` };
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
        id: sb.id,
        killProcess: (processId: string): void => {
          sb.processes.delete(processId);
        },
        listPorts: (): Preview[] => [...sb.ports.values()],
        listProcesses: () =>
          [...sb.processes.entries()].map(([id, p]) => ({ cmd: p.cmd, id })),
        listSnapshots: (): SnapshotRef[] =>
          [...sb.snapshots.keys()].map((id) => ({
            id,
            provider: "memory",
            raw: sb,
          })),
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
        setTimeout: () => {
          /* memory sandboxes never expire */
        },
        snapshot: ({ name }: { name?: string }): SnapshotRef => {
          const id = `snap_${++sb.snapCounter}`;
          sb.snapshots.set(id, {
            dirs: new Set(sb.dirs),
            files: new Map(sb.files),
          });
          return {
            createdAt: new Date(),
            id,
            name,
            provider: "memory",
            raw: sb,
          };
        },
        spawn: (cmd: string, execOpts: ExecOptions): DriverProcess => {
          const id = `p${++sb.procCounter}`;
          sb.processes.set(id, { cmd });
          return { ...toDriverExec(id, runMemCommand(sb, cmd, execOpts)), id };
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
        upload: (path: string, data: FileBody): void => {
          if (typeof data === "string") {
            fsWrite(sb, path, new TextEncoder().encode(data));
          } else if (data instanceof Uint8Array) {
            fsWrite(sb, path, data);
          } else {
            throw new SandboxError(
              "Validation",
              "stream upload unsupported in memory"
            );
          }
        },
      };
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
      async *list() {
        for (const sb of sandboxes.values()) {
          yield info(sb);
        }
      },
      name: "memory",
    };
    return provider;
  }
}
