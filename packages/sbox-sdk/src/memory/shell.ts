/**
 * A tiny POSIX-ish shell for the in-memory provider. Enough to run everything
 * the core and the conformance suite emit: `;` `&&` `||` `|` `{ }` groups,
 * `sh -c`, redirects (`>&2`, `2>&1`, `>`, `>>`, `<`), quoting, `$VAR`, and a
 * handful of builtins over the in-memory filesystem. `sleep` really waits and
 * honors the abort signal, so timeouts and kill behave like a real sandbox.
 */

export interface ShellFs {
  read(path: string): Uint8Array | null;
  write(path: string, data: Uint8Array): void;
  list(dir: string): { name: string; type: "file" | "dir" }[] | null;
  mkdir(path: string, recursive: boolean): string | null;
  remove(path: string, recursive: boolean, force: boolean): string | null;
  rename(from: string, to: string): string | null;
  stat(path: string): { type: "file" | "dir"; size: number } | null;
  isDir(path: string): boolean;
}

export interface ShellIo {
  cwd: string;
  env: Record<string, string>;
  stdin: Uint8Array;
  stdout: (data: Uint8Array) => void;
  stderr: (data: Uint8Array) => void;
  signal: AbortSignal;
}

class ExitSignal {
  readonly code: number;
  constructor(code: number) {
    this.code = code;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------

interface Part {
  text: string;
  quote: "'" | '"' | null;
}
type Tok = { kind: "word"; parts: Part[] } | { kind: "op"; op: string };

const OPS = [
  "&&",
  "||",
  ">>",
  "2>&1",
  "1>&2",
  ">&2",
  ";",
  "|",
  "{",
  "}",
  ">",
  "<",
  "\n",
  "&",
];

function matchOp(input: string, at: number): string | undefined {
  for (const o of OPS) {
    if (input.startsWith(o, at)) {
      return o;
    }
  }
  return undefined;
}

function lex(input: string): Tok[] {
  const toks: Tok[] = [];
  let parts: Part[] = [];
  let cur = "";
  let i = 0;
  const flushWord = () => {
    if (cur) {
      parts.push({ quote: null, text: cur });
      cur = "";
    }
    if (parts.length) {
      toks.push({ kind: "word", parts });
      parts = [];
    }
  };
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === "'") {
      if (cur) {
        parts.push({ quote: null, text: cur });
        cur = "";
      }
      const end = input.indexOf("'", i + 1);
      const stop = end === -1 ? input.length : end;
      parts.push({ quote: "'", text: input.slice(i + 1, stop) });
      i = stop + 1;
      continue;
    }
    if (ch === '"') {
      if (cur) {
        parts.push({ quote: null, text: cur });
        cur = "";
      }
      let j = i + 1;
      let text = "";
      while (j < input.length && input[j] !== '"') {
        if (
          input[j] === "\\" &&
          j + 1 < input.length &&
          '"\\$`'.includes(input[j + 1]!)
        ) {
          text += input[j + 1];
          j += 2;
        } else {
          text += input[j];
          j++;
        }
      }
      parts.push({ quote: '"', text });
      i = j + 1;
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      if (input[i + 1] === "\n") {
        i += 2;
        continue;
      }
      parts.push({ quote: null, text: cur });
      cur = "";
      parts.push({ quote: "'", text: input[i + 1]! });
      i += 2;
      continue;
    }
    if (ch === "#" && !cur && !parts.length) {
      while (i < input.length && input[i] !== "\n") {
        i++;
      }
      continue;
    }
    if (ch === " " || ch === "\t") {
      flushWord();
      i++;
      continue;
    }
    // `{`/`}` are only operators as standalone words.
    const op = matchOp(input, i);
    if (op && !((op === "{" || op === "}") && (cur || parts.length))) {
      if (
        (op === "{" || op === "}") &&
        i + 1 < input.length &&
        !/[\s;]/.test(input[i + 1]!)
      ) {
        cur += ch;
        i++;
        continue;
      }
      flushWord();
      toks.push({ kind: "op", op });
      i += op.length;
      continue;
    }
    cur += ch;
    i++;
  }
  flushWord();
  return toks;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

type Redirect =
  | { kind: "out-to-err" }
  | { kind: "err-to-out" }
  | { kind: "file"; target: Part[]; append: boolean }
  | { kind: "in"; target: Part[] };

type Cmd =
  | { kind: "simple"; words: Part[][]; redirects: Redirect[] }
  | { kind: "group"; body: List; redirects: Redirect[] };
type Pipeline = Cmd[];
interface List {
  pipelines: Pipeline[];
  joins: string[];
}

function parse(toks: Tok[]): List {
  let pos = 0;
  const peek = () => toks[pos];
  const isOp = (t: Tok | undefined, op: string) =>
    t?.kind === "op" && t.op === op;

  const parseList = (stop?: string): List => {
    const list: List = { joins: [], pipelines: [] };
    while (pos < toks.length) {
      while (isOp(peek(), "\n") || isOp(peek(), ";")) {
        pos++;
      }
      if (pos >= toks.length || (stop && isOp(peek(), stop))) {
        break;
      }
      list.pipelines.push(parsePipeline());
      const t = peek();
      if (t?.kind === "op" && ["&&", "||", ";", "\n", "&"].includes(t.op)) {
        list.joins.push(t.op === "\n" || t.op === "&" ? ";" : t.op);
        pos++;
      } else {
        list.joins.push(";");
      }
    }
    return list;
  };

  const parseRedirects = (redirects: Redirect[]) => {
    for (;;) {
      const t = peek();
      if (isOp(t, ">&2") || isOp(t, "1>&2")) {
        redirects.push({ kind: "out-to-err" });
        pos++;
      } else if (isOp(t, "2>&1")) {
        redirects.push({ kind: "err-to-out" });
        pos++;
      } else if (isOp(t, ">") || isOp(t, ">>")) {
        pos++;
        const target = peek();
        pos++;
        redirects.push({
          append: (t as { op: string }).op === ">>",
          kind: "file",
          target: target?.kind === "word" ? target.parts : [],
        });
      } else if (isOp(t, "<")) {
        pos++;
        const target = peek();
        pos++;
        redirects.push({
          kind: "in",
          target: target?.kind === "word" ? target.parts : [],
        });
      } else {
        return;
      }
    }
  };

  const parseCmd = (): Cmd => {
    if (isOp(peek(), "{")) {
      pos++;
      const body = parseList("}");
      if (isOp(peek(), "}")) {
        pos++;
      }
      const redirects: Redirect[] = [];
      parseRedirects(redirects);
      return { body, kind: "group", redirects };
    }
    const words: Part[][] = [];
    const redirects: Redirect[] = [];
    for (;;) {
      parseRedirects(redirects);
      const t = peek();
      if (t?.kind !== "word") {
        break;
      }
      words.push(t.parts);
      pos++;
    }
    return { kind: "simple", redirects, words };
  };

  const parsePipeline = (): Pipeline => {
    const cmds: Cmd[] = [parseCmd()];
    while (isOp(peek(), "|")) {
      pos++;
      cmds.push(parseCmd());
    }
    return cmds;
  };

  return parseList();
}

// ---------------------------------------------------------------------------
// interpreter
// ---------------------------------------------------------------------------

function expand(parts: Part[], env: Record<string, string>): string {
  return parts
    .map((p) =>
      p.quote === "'"
        ? p.text
        : p.text.replaceAll(
            /\$\{(\w+)\}|\$(\w+|\?)/g,
            (_m, a: string, b: string) => env[a ?? b] ?? ""
          )
    )
    .join("");
}

function resolve(cwd: string, p: string): string {
  const abs = p.startsWith("/") ? p : `${cwd}/${p}`;
  const out: string[] = [];
  for (const seg of abs.split("/")) {
    if (!seg || seg === ".") {
      continue;
    }
    if (seg === "..") {
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return `/${out.join("/")}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal.aborted) {
      rej(new ExitSignal(143));
      return;
    }
    const t = setTimeout(res, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        rej(new ExitSignal(143));
      },
      { once: true }
    );
  });
}

export class MiniShell {
  readonly #fs: ShellFs;
  constructor(fs: ShellFs) {
    this.#fs = fs;
  }

  /** Run a script. Resolves with the exit code; never throws for shell errors. */
  async run(script: string, io: ShellIo): Promise<number> {
    try {
      return await this.#list(parse(lex(script)), io);
    } catch (error) {
      if (error instanceof ExitSignal) {
        return error.code;
      }
      io.stderr(
        enc.encode(
          `sh: ${error instanceof Error ? error.message : String(error)}\n`
        )
      );
      return 2;
    }
  }

  async #list(list: List, io: ShellIo): Promise<number> {
    let status = 0;
    for (let i = 0; i < list.pipelines.length; i++) {
      const join = i === 0 ? ";" : list.joins[i - 1];
      if (join === "&&" && status !== 0) {
        continue;
      }
      if (join === "||" && status === 0) {
        continue;
      }
      status = await this.#pipeline(list.pipelines[i]!, io);
      io.env["?"] = String(status);
    }
    return status;
  }

  async #pipeline(cmds: Pipeline, io: ShellIo): Promise<number> {
    let stdin = io.stdin;
    let status = 0;
    for (let i = 0; i < cmds.length; i++) {
      const last = i === cmds.length - 1;
      const chunks: Uint8Array[] = [];
      const stageIo: ShellIo = last
        ? { ...io, stdin }
        : { ...io, stdin, stdout: (d) => chunks.push(d) };
      status = await this.#cmd(cmds[i]!, stageIo);
      if (!last) {
        stdin = concat(chunks);
      }
    }
    return status;
  }

  async #cmd(cmd: Cmd, io0: ShellIo): Promise<number> {
    if (io0.signal.aborted) {
      throw new ExitSignal(143);
    }
    const io = this.#applyRedirects(cmd.redirects, io0);
    if (cmd.kind === "group") {
      return this.#list(cmd.body, io);
    }
    const argv = cmd.words.map((w) => expand(w, io.env));
    return this.#builtin(argv, io);
  }

  #applyRedirects(redirects: Redirect[], io0: ShellIo): ShellIo {
    const io = { ...io0 };
    for (const r of redirects) {
      if (r.kind === "out-to-err") {
        io.stdout = io0.stderr;
      } else if (r.kind === "err-to-out") {
        io.stderr = io.stdout;
      } else if (r.kind === "file") {
        const path = resolve(io.cwd, expand(r.target, io.env));
        if (!r.append) {
          this.#fs.write(path, new Uint8Array());
        }
        io.stdout = (d) => {
          const prev = this.#fs.read(path) ?? new Uint8Array();
          this.#fs.write(path, concat([prev, d]));
        };
      } else {
        const path = resolve(io.cwd, expand(r.target, io.env));
        io.stdin = this.#fs.read(path) ?? new Uint8Array();
      }
    }
    return io;
  }

  async #builtin(argv: string[], io: ShellIo): Promise<number> {
    const [cmd, ...args] = argv;
    const out = (s: string) => io.stdout(enc.encode(s));
    const err = (s: string) => io.stderr(enc.encode(s));
    const operands = args.filter((a) => !a.startsWith("-") || a === "-");
    const flags = args.filter((a) => a.startsWith("-") && a !== "-").join("");
    const fs = this.#fs;

    // KEY=value prefix assignments
    if (cmd && /^[A-Za-z_]\w*=/.test(cmd)) {
      const eq = cmd.indexOf("=");
      const env = { ...io.env, [cmd.slice(0, eq)]: cmd.slice(eq + 1) };
      if (args.length === 0) {
        io.env[cmd.slice(0, eq)] = cmd.slice(eq + 1);
        return 0;
      }
      return this.#builtin(args, { ...io, env });
    }

    switch (cmd) {
      case undefined:
      case ":":
      case "true": {
        return 0;
      }
      case "false": {
        return 1;
      }
      case "exit": {
        throw new ExitSignal(Number(args[0] ?? io.env["?"] ?? 0) || 0);
      }
      case "pwd": {
        out(`${io.cwd}\n`);
        return 0;
      }
      case "cd": {
        const target = resolve(io.cwd, args[0] ?? io.env.HOME ?? "/");
        if (!fs.isDir(target)) {
          err(`cd: ${args[0]}: No such file or directory\n`);
          return 1;
        }
        io.cwd = target;
        return 0;
      }
      case "export": {
        for (const a of args) {
          const eq = a.indexOf("=");
          if (eq > 0) {
            io.env[a.slice(0, eq)] = a.slice(eq + 1);
          }
        }
        return 0;
      }
      case "echo": {
        let rest = args;
        let nl = true;
        if (rest[0] === "-n") {
          nl = false;
          rest = rest.slice(1);
        }
        out(rest.join(" ") + (nl ? "\n" : ""));
        return 0;
      }
      case "printf": {
        const fmt = args[0] ?? "";
        const values = args.slice(1);
        let vi = 0;
        const body = fmt
          .replaceAll(/%s/g, () => values[vi++] ?? "")
          .replaceAll(/\\n/g, "\n")
          .replaceAll(/\\t/g, "\t");
        out(body);
        return 0;
      }
      case "env": {
        out(
          `${Object.entries(io.env)
            .filter(([k]) => k !== "?")
            .map(([k, v]) => `${k}=${v}`)
            .join("\n")}\n`
        );
        return 0;
      }
      case "cat": {
        if (operands.length === 0 || operands[0] === "-") {
          io.stdout(io.stdin);
          return 0;
        }
        for (const f of operands) {
          const data = fs.read(resolve(io.cwd, f));
          if (!data) {
            err(`cat: ${f}: No such file or directory\n`);
            return 1;
          }
          io.stdout(data);
        }
        return 0;
      }
      case "base64": {
        const input = operands[0]
          ? fs.read(resolve(io.cwd, operands[0]))
          : io.stdin;
        if (!input) {
          return 1;
        }
        if (flags.includes("d")) {
          const bin = atob(dec.decode(input).replaceAll(/\s/g, ""));
          io.stdout(Uint8Array.from(bin, (c) => c.codePointAt(0) ?? 0));
        } else {
          let s = "";
          for (const b of input) {
            s += String.fromCodePoint(b);
          }
          out(`${btoa(s)}\n`);
        }
        return 0;
      }
      case "sleep": {
        await sleep(Number(args[0] ?? 0) * 1000, io.signal);
        return 0;
      }
      case "touch": {
        for (const f of operands) {
          const p = resolve(io.cwd, f);
          if (!fs.read(p)) {
            fs.write(p, new Uint8Array());
          }
        }
        return 0;
      }
      case "ls": {
        const target = operands[0] ?? ".";
        const entries = fs.list(resolve(io.cwd, target));
        if (!entries) {
          err(`ls: cannot access '${target}': No such file or directory\n`);
          return 2;
        }
        const names = entries.map((e) =>
          e.type === "dir" ? `${e.name}/` : e.name
        );
        out(names.length ? `${names.join("\n")}\n` : "");
        return 0;
      }
      case "mkdir": {
        for (const f of operands) {
          const e = fs.mkdir(resolve(io.cwd, f), flags.includes("p"));
          if (e) {
            err(`${e}\n`);
            return 1;
          }
        }
        return 0;
      }
      case "rm": {
        for (const f of operands) {
          const e = fs.remove(
            resolve(io.cwd, f),
            /[rR]/.test(flags),
            flags.includes("f")
          );
          if (e) {
            err(`${e}\n`);
            return 1;
          }
        }
        return 0;
      }
      case "mv": {
        if (operands.length < 2) {
          err("mv: missing operand\n");
          return 1;
        }
        const e = fs.rename(
          resolve(io.cwd, operands[0]!),
          resolve(io.cwd, operands[1]!)
        );
        if (e) {
          err(`${e}\n`);
          return 1;
        }
        return 0;
      }
      case "stat": {
        const target = args.at(-1) ?? "";
        const info = fs.stat(resolve(io.cwd, target));
        if (!info) {
          err(`stat: cannot statx '${target}': No such file or directory\n`);
          return 1;
        }
        out(
          `${info.type === "dir" ? "directory" : "regular file"}|${info.size}|0\n`
        );
        return 0;
      }
      case "sh":
      case "bash": {
        const ci = args.indexOf("-c");
        if (ci === -1) {
          return this.run(dec.decode(io.stdin), { ...io, env: { ...io.env } });
        }
        return this.run(args[ci + 1] ?? "", { ...io, env: { ...io.env } });
      }
      default: {
        err(`sh: ${cmd}: not found\n`);
        return 127;
      }
    }
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const c of chunks) {
    n += c.length;
  }
  const out = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
