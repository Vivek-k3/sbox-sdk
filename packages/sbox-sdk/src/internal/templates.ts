/**
 * Template helpers shared by the core and adapters:
 * - `templateCacheKey()`  content hash used to skip rebuilds
 * - `loadTemplateContext()` normalize a build context into path -> bytes
 * - `tarContext()`        build an uncompressed ustar archive (docker, REST builders)
 * - `parseDockerfile()`   split a Dockerfile into instructions (for builder-chain APIs)
 *
 * Everything is web-standard except reading a context *directory*, which
 * lazy-imports `node:fs` only when a string path is given.
 */
import { SandboxError } from "./errors.js";
import type {
  FileBody,
  TemplateContext,
  TemplateRef,
  TemplateSpec,
} from "./types.js";

const encoder = new TextEncoder();

async function bodyToBytes(body: FileBody): Promise<Uint8Array> {
  if (typeof body === "string") {
    return encoder.encode(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/** Directories never sent as build context. */
const IGNORED_DIRS = new Set([".git", "node_modules", ".DS_Store"]);

/**
 * Normalize a context into a sorted `relativePath -> bytes` map. A string is a
 * local directory (Node/Bun/Deno with node compat); `.dockerignore` lines that
 * are plain names or `dir/` prefixes are honored.
 */
export async function loadTemplateContext(
  context: TemplateContext | undefined
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  if (context === undefined) {
    return out;
  }
  if (typeof context !== "string") {
    for (const key of Object.keys(context).toSorted()) {
      out.set(key.replace(/^\.?\/+/, ""), await bodyToBytes(context[key]!));
    }
    return out;
  }
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.resolve(context);
  let ignore: string[] = [];
  try {
    ignore = (await fs.readFile(path.join(root, ".dockerignore"), "utf-8"))
      .split("\n")
      .map((l) => l.trim().replace(/^\.\//, "").replace(/\/$/, ""))
      .filter((l) => l && !l.startsWith("#") && !l.includes("*"));
  } catch {
    // no .dockerignore
  }
  const isIgnored = (rel: string): boolean =>
    ignore.some((p) => rel === p || rel.startsWith(`${p}/`));
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (IGNORED_DIRS.has(e.name)) {
        continue;
      }
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (isIgnored(rel)) {
        continue;
      }
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        out.set(rel, new Uint8Array(await fs.readFile(abs)));
      }
    }
  };
  try {
    await walk(root);
  } catch (error) {
    throw new SandboxError(
      "Validation",
      `cannot read template context '${context}'`,
      { cause: error }
    );
  }
  return out;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    data as Uint8Array<ArrayBuffer>
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Deterministic content hash of everything that affects the built image:
 * source (Dockerfile text + every context file, or image ref, or snapshot id)
 * plus env/workdir/user/start/ready commands and resources. Hex, 64 chars.
 */
export async function templateCacheKey(spec: TemplateSpec): Promise<string> {
  const { source } = spec;
  const parts: Uint8Array[] = [];
  const push = (s: string): void => {
    parts.push(encoder.encode(`${s}\u0000`));
  };
  push("sbox-template-v1");
  if ("dockerfile" in source && source.dockerfile !== undefined) {
    push(`dockerfile:${source.dockerfile}`);
    const ctx = await loadTemplateContext(source.context);
    for (const [rel, bytes] of ctx) {
      push(`file:${rel}:${bytes.length}`);
      parts.push(bytes);
    }
  } else if ("image" in source && source.image !== undefined) {
    push(`image:${source.image}`);
  } else if ("snapshot" in source && source.snapshot !== undefined) {
    push(`snapshot:${source.snapshot}`);
  } else {
    throw new SandboxError(
      "Validation",
      "template source needs one of dockerfile | image | snapshot"
    );
  }
  push(
    JSON.stringify({
      env: sortedEntries(spec.env),
      ready: spec.readyCmd ?? null,
      resources: sortedEntries(spec.resources as Record<string, unknown>),
      start: spec.startCmd ?? null,
      user: spec.user ?? null,
      workdir: spec.workdir ?? null,
    })
  );
  let total = 0;
  for (const p of parts) {
    total += p.length;
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    all.set(p, off);
    off += p.length;
  }
  return sha256Hex(all);
}

function sortedEntries(
  o: Record<string, unknown> | undefined
): [string, unknown][] {
  return o ? Object.entries(o).toSorted(([a], [b]) => (a < b ? -1 : 1)) : [];
}

/** Default alias for a template built from `cacheKey`. */
export function defaultTemplateName(cacheKey: string): string {
  return `sbox-${cacheKey.slice(0, 16)}`;
}

export function templateRefId(ref: TemplateRef | string): string {
  return typeof ref === "string" ? ref : ref.id;
}

// ---------------------------------------------------------------------------
// tar (ustar, uncompressed)
// ---------------------------------------------------------------------------

function writeOctal(buf: Uint8Array, off: number, len: number, n: number) {
  const s = n.toString(8).padStart(len - 1, "0");
  buf.set(encoder.encode(s), off);
  buf[off + len - 1] = 0;
}

/**
 * Pack files into an uncompressed POSIX ustar archive. Paths longer than 100
 * bytes use the 155-byte prefix field; longer still throws.
 */
export function tarContext(files: Map<string, Uint8Array>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [rel, data] of files) {
    const header = new Uint8Array(512);
    let name = rel;
    let prefix = "";
    if (encoder.encode(name).length > 100) {
      const cut = rel.lastIndexOf("/", 155);
      prefix = rel.slice(0, cut);
      name = rel.slice(cut + 1);
      if (cut <= 0 || encoder.encode(name).length > 100) {
        throw new SandboxError("Validation", `path too long for tar: ${rel}`);
      }
    }
    header.set(encoder.encode(name), 0);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, data.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156); // checksum placeholder (spaces)
    header[156] = 0x30; // '0' regular file
    header.set(encoder.encode("ustar\u000000"), 257);
    header.set(encoder.encode(prefix), 345);
    let sum = 0;
    for (const b of header) {
      sum += b;
    }
    writeOctal(header, 148, 7, sum);
    header[155] = 0x20;
    blocks.push(header, data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) {
      blocks.push(new Uint8Array(pad));
    }
  }
  blocks.push(new Uint8Array(1024));
  let total = 0;
  for (const b of blocks) {
    total += b.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dockerfile parsing (for providers with builder-chain APIs)
// ---------------------------------------------------------------------------

export interface DockerInstruction {
  /** Upper-cased instruction, e.g. "FROM", "RUN". */
  op: string;
  /** Raw argument text (continuations joined). */
  args: string;
  /** The original instruction line(s), suitable for re-emitting. */
  raw: string;
}

/**
 * Split a Dockerfile into instructions. Handles `\` continuations, comments and
 * blank lines. Parser directives and heredocs are passed through verbatim in
 * `raw` but not interpreted.
 */
export function parseDockerfile(text: string): DockerInstruction[] {
  const out: DockerInstruction[] = [];
  let buf = "";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!buf && (trimmed === "" || trimmed.startsWith("#"))) {
      continue;
    }
    if (trimmed.endsWith("\\")) {
      buf += `${trimmed.slice(0, -1)} `;
      continue;
    }
    buf += trimmed;
    const m = /^(\w+)\s*(.*)$/s.exec(buf);
    if (m) {
      out.push({ args: m[2]!.trim(), op: m[1]!.toUpperCase(), raw: buf });
    }
    buf = "";
  }
  return out;
}
