/**
 * Small Dockerfile helpers for adapters whose builders are step lists rather
 * than Docker: flag splitting, exec-form to shell-form, `ENV` parsing, `ARG`
 * substitution and `COPY` source resolution against a loaded build context.
 *
 * Shared by adapters (superserve, freestyle, morph, ...) via `sbox-sdk/adapter`.
 */
import { NotSupportedError, SandboxError } from "./errors.js";
import { shellQuote } from "./shell.js";

/** Split a shell-ish string into words, honoring quotes and backslashes. */
export function splitShellWords(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < input.length) {
        cur += input[++i];
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < input.length) {
      cur += input[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) {
        out.push(cur);
      }
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) {
    out.push(cur);
  }
  return out;
}

/** Leading `--flag[=value]` options of an instruction, and the rest. */
export function splitFlags(args: string): {
  flags: Record<string, string | true>;
  rest: string;
} {
  const flags: Record<string, string | true> = {};
  let rest = args.trimStart();
  for (;;) {
    const m = /^--([\w-]+)(?:=(\S*))?\s*/.exec(rest);
    if (!m) {
      break;
    }
    flags[m[1]!] = m[2] ?? true;
    rest = rest.slice(m[0].length);
  }
  return { flags, rest: rest.trim() };
}

/** `["a", "b c"]` (exec form) to `'a' 'b c'`; shell form passes through. */
export function shellForm(args: string): string {
  const t = args.trim();
  if (t.startsWith("[")) {
    try {
      const arr: unknown = JSON.parse(t);
      if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) {
        return arr.map((x: string) => shellQuote(x)).join(" ");
      }
    } catch {
      // not JSON: treat as shell form
    }
  }
  return t;
}

/** Exec-form or shell-form arguments as a list of words. */
export function argList(args: string): string[] {
  const t = args.trim();
  if (t.startsWith("[")) {
    try {
      const arr: unknown = JSON.parse(t);
      if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) {
        return arr as string[];
      }
    } catch {
      // fall through
    }
  }
  return splitShellWords(t);
}

/** `ENV A=1 B="x y"` or legacy `ENV A some value`. */
export function parseEnvArgs(args: string): [string, string][] {
  const t = args.trim();
  const first = /^[A-Za-z_][A-Za-z0-9_]*/.exec(t)?.[0];
  if (first && t[first.length] !== "=") {
    return [[first, t.slice(first.length).trim()]];
  }
  const out: [string, string][] = [];
  for (const word of splitShellWords(t)) {
    const eq = word.indexOf("=");
    if (eq > 0) {
      out.push([word.slice(0, eq), word.slice(eq + 1)]);
    }
  }
  return out;
}

/** Replace `$NAME` / `${NAME}` for known build args. */
export function substituteArgs(
  text: string,
  vars: ReadonlyMap<string, string>
): string {
  if (vars.size === 0) {
    return text;
  }
  return text.replaceAll(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (all, a: string | undefined, b: string | undefined) => {
      const key = (a ?? b)!;
      return vars.has(key) ? vars.get(key)! : all;
    }
  );
}

/** Join and normalize (`.`/`..`/repeated slashes) into an absolute path. */
export function joinPath(dir: string, rel: string): string {
  const parts: string[] = [];
  for (const seg of `${dir}/${rel}`.split("/")) {
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

function baseName(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

function globToRegExp(glob: string): RegExp {
  const esc = glob.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(
    `^${esc.replaceAll("*", "[^/]*").replaceAll("?", "[^/]")}$`
  );
}

export interface ResolvedCopy {
  files: { path: string; data: Uint8Array }[];
  chown?: string;
  chmod?: string;
}

/**
 * Resolve a `COPY`/`ADD` instruction against the build context. Supports
 * files, directories (contents are copied), `.`, and simple `*`/`?` globs.
 * Multi-stage `--from`, remote URLs and `ADD` auto-extraction are refused.
 */
export function resolveCopy(
  op: string,
  args: string,
  context: ReadonlyMap<string, Uint8Array>,
  workdir: string,
  provider: string
): ResolvedCopy {
  const { flags, rest } = splitFlags(args);
  if (flags.from !== undefined) {
    throw new NotSupportedError(provider, `${op} --from (multi-stage builds)`);
  }
  const words = argList(rest);
  if (words.length < 2) {
    throw new SandboxError("Validation", `${op} needs a source and a dest`, {
      provider,
    });
  }
  const dest = words.at(-1)!;
  const sources = words.slice(0, -1);
  const destAbs = joinPath(dest.startsWith("/") ? "/" : workdir || "/", dest);
  let intoDir = dest.endsWith("/") || sources.length > 1;
  const picked: { rel: string; data: Uint8Array }[] = [];
  for (const raw of sources) {
    if (/^https?:\/\//.test(raw)) {
      throw new NotSupportedError(
        provider,
        `${op} from a URL (download it in a RUN step)`
      );
    }
    const src = raw.replace(/^\.\//, "").replace(/\/+$/, "");
    if (src === "" || src === ".") {
      intoDir = true;
      for (const [k, v] of context) {
        picked.push({ data: v, rel: k });
      }
      continue;
    }
    const exact = context.get(src);
    if (exact) {
      picked.push({ data: exact, rel: baseName(src) });
      continue;
    }
    const prefix = `${src}/`;
    const inDir = [...context].filter(([k]) => k.startsWith(prefix));
    if (inDir.length > 0) {
      intoDir = true;
      for (const [k, v] of inDir) {
        picked.push({ data: v, rel: k.slice(prefix.length) });
      }
      continue;
    }
    if (/[*?]/.test(src)) {
      const re = globToRegExp(src);
      const hits = [...context].filter(([k]) => re.test(k));
      if (hits.length > 0) {
        intoDir = true;
        for (const [k, v] of hits) {
          picked.push({ data: v, rel: baseName(k) });
        }
        continue;
      }
    }
    throw new SandboxError(
      "Validation",
      `${op} source '${raw}' is not in the build context`,
      { provider }
    );
  }
  return {
    files: picked.map((p) => ({
      data: p.data,
      path: intoDir ? joinPath(destAbs, p.rel) : destAbs,
    })),
    ...(typeof flags.chown === "string" ? { chown: flags.chown } : {}),
    ...(typeof flags.chmod === "string" ? { chmod: flags.chmod } : {}),
  };
}
