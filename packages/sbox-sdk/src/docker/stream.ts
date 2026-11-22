/**
 * Byte-level helpers for the Docker Engine API, all web-standard:
 * - `Demuxer`      splits the 8-byte-header stdout/stderr multiplexed stream
 *                  that non-TTY `exec/start` and `attach` return.
 * - `readTar()`    a small ustar/pax/GNU tar reader for `GET /archive`.
 * - `PidMarker`    strips the `\x1eSBOXPID:<n>\x1e` prefix our exec wrapper
 *                  prints so we learn the in-container pid of a command.
 */

export type StreamKind = "stdin" | "stdout" | "stderr";

export interface Frame {
  stream: StreamKind;
  data: Uint8Array;
}

const KINDS: Record<number, StreamKind> = {
  0: "stdin",
  1: "stdout",
  2: "stderr",
};

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) {
    return b;
  }
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Incremental demultiplexer for Docker's raw stream format: each frame is
 * `[kind, 0, 0, 0, size(uint32 BE)]` followed by `size` payload bytes. Frames
 * may be split across (or packed into) arbitrary transport chunks.
 */
export class Demuxer {
  #buf: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    this.#buf = concat(this.#buf, chunk);
    const frames: Frame[] = [];
    let off = 0;
    while (this.#buf.length - off >= 8) {
      const kind = KINDS[this.#buf[off]!] ?? "stdout";
      const size = new DataView(
        this.#buf.buffer,
        this.#buf.byteOffset + off + 4,
        4
      ).getUint32(0, false);
      if (this.#buf.length - off - 8 < size) {
        break;
      }
      frames.push({
        data: this.#buf.slice(off + 8, off + 8 + size),
        stream: kind,
      });
      off += 8 + size;
    }
    this.#buf = off === 0 ? this.#buf : this.#buf.slice(off);
    return frames;
  }

  /** Bytes left over that never formed a complete frame. */
  get pending(): number {
    return this.#buf.length;
  }
}

// ---------------------------------------------------------------------------
// tar reader
// ---------------------------------------------------------------------------

export type TarEntryType = "file" | "dir" | "symlink" | "hardlink" | "other";

export interface TarEntry {
  name: string;
  type: TarEntryType;
  size: number;
  mode: number;
  mtime?: Date;
  linkname?: string;
  data: Uint8Array;
}

const dec = new TextDecoder();

function cstr(buf: Uint8Array, off: number, len: number): string {
  let end = off;
  while (end < off + len && buf[end] !== 0) {
    end++;
  }
  return dec.decode(buf.subarray(off, end));
}

function octal(buf: Uint8Array, off: number, len: number): number {
  // GNU base-256 encoding for large values (high bit set on first byte).
  if (buf[off]! >= 0x80) {
    let n = buf[off]! - 0x80;
    for (let i = 1; i < len; i++) {
      n = n * 256 + buf[off + i]!;
    }
    return n;
  }
  const s = cstr(buf, off, len).trim();
  return s ? Number.parseInt(s, 8) : 0;
}

function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const text = dec.decode(data);
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(" ", i);
    if (sp === -1) {
      break;
    }
    const len = Number.parseInt(text.slice(i, sp), 10);
    if (!Number.isFinite(len) || len <= 0) {
      break;
    }
    const record = text.slice(sp + 1, i + len - 1); // drop trailing \n
    const eq = record.indexOf("=");
    if (eq !== -1) {
      out[record.slice(0, eq)] = record.slice(eq + 1);
    }
    i += len;
  }
  return out;
}

function typeOf(flag: number): TarEntryType {
  switch (flag) {
    case 0:
    case 0x30: // '0'
    case 0x37: {
      // '7' contiguous file
      return "file";
    }
    case 0x35: {
      return "dir";
    }
    case 0x32: {
      return "symlink";
    }
    case 0x31: {
      return "hardlink";
    }
    default: {
      return "other";
    }
  }
}

/**
 * Parse an uncompressed tar archive (ustar, pax `x`/`g` headers, GNU `L`/`K`
 * long names). Entries are returned in archive order with their payloads.
 */
export function readTar(archive: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let off = 0;
  let pax: Record<string, string> = {};
  let longName: string | undefined;
  let longLink: string | undefined;
  while (off + 512 <= archive.length) {
    const h = archive.subarray(off, off + 512);
    if (h.every((b) => b === 0)) {
      break;
    }
    const flag = h[156]!;
    const sizeField = octal(h, 124, 12);
    const size =
      pax.size === undefined ? sizeField : Number.parseInt(pax.size, 10);
    const dataStart = off + 512;
    const data = archive.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;

    if (flag === 0x78 /* x */) {
      Object.assign(pax, parsePax(data));
      continue;
    }
    if (flag === 0x67 /* g */) {
      continue;
    }
    if (flag === 0x4c /* L */) {
      longName = cstr(data, 0, data.length);
      continue;
    }
    if (flag === 0x4b /* K */) {
      longLink = cstr(data, 0, data.length);
      continue;
    }

    const magic = cstr(h, 257, 6);
    const prefix = magic.startsWith("ustar") ? cstr(h, 345, 155) : "";
    const baseName = cstr(h, 0, 100);
    const name =
      pax.path ?? longName ?? (prefix ? `${prefix}/${baseName}` : baseName);
    const linkname = pax.linkpath ?? longLink ?? cstr(h, 157, 100);
    const mtimeSec = pax.mtime ? Number(pax.mtime) : octal(h, 136, 12);
    entries.push({
      data: new Uint8Array(data),
      linkname: linkname || undefined,
      mode: octal(h, 100, 8),
      mtime: Number.isFinite(mtimeSec) ? new Date(mtimeSec * 1000) : undefined,
      name,
      size,
      type: typeOf(flag),
    });
    pax = {};
    longName = undefined;
    longLink = undefined;
  }
  return entries;
}

/**
 * Patch a ustar header in place (mtime seconds, uid, gid, mode) and recompute
 * its checksum. Used to give files written via `PUT /archive` a real mtime and
 * the container user's ownership.
 */
export function patchTarHeader(
  archive: Uint8Array,
  headerOffset: number,
  fields: { mtime?: number; uid?: number; gid?: number; mode?: number }
): void {
  const enc = new TextEncoder();
  const h = archive.subarray(headerOffset, headerOffset + 512);
  const put = (off: number, len: number, n: number): void => {
    h.set(
      enc.encode(
        Math.floor(n)
          .toString(8)
          .padStart(len - 1, "0")
      ),
      off
    );
    h[off + len - 1] = 0;
  };
  if (fields.mode !== undefined) {
    put(100, 8, fields.mode);
  }
  if (fields.uid !== undefined) {
    put(108, 8, fields.uid);
  }
  if (fields.gid !== undefined) {
    put(116, 8, fields.gid);
  }
  if (fields.mtime !== undefined) {
    put(136, 12, fields.mtime);
  }
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) {
    sum += b;
  }
  h.set(enc.encode(sum.toString(8).padStart(6, "0")), 148);
  h[154] = 0;
  h[155] = 0x20;
}

// ---------------------------------------------------------------------------
// pid marker
// ---------------------------------------------------------------------------

const RS = 0x1e;
const MARKER_HEAD = new TextEncoder().encode("\u001ESBOXPID:");
/** Longest marker we wait for before giving up: RS + "SBOXPID:" + 10 digits + RS. */
const MARKER_MAX = MARKER_HEAD.length + 11;

/**
 * Strips `\x1eSBOXPID:<digits>\x1e` from the very start of a byte stream. Feed
 * chunks in order; it returns the bytes to pass through. Anything that is not
 * the marker is passed through untouched.
 */
export class PidMarker {
  #buf: Uint8Array = new Uint8Array(0);
  #done = false;
  #onPid: (pid: string) => void;

  constructor(onPid: (pid: string) => void) {
    this.#onPid = onPid;
  }

  get done(): boolean {
    return this.#done;
  }

  push(chunk: Uint8Array): Uint8Array {
    if (this.#done) {
      return chunk;
    }
    const buf = concat(this.#buf, chunk);
    // Still a prefix of the marker head? keep buffering.
    const headLen = Math.min(buf.length, MARKER_HEAD.length);
    for (let i = 0; i < headLen; i++) {
      if (buf[i] !== MARKER_HEAD[i]) {
        return this.#give(buf);
      }
    }
    if (buf.length <= MARKER_HEAD.length) {
      this.#buf = buf;
      return new Uint8Array(0);
    }
    for (let i = MARKER_HEAD.length; i < buf.length; i++) {
      const b = buf[i]!;
      if (b === RS) {
        const pid = dec.decode(buf.subarray(MARKER_HEAD.length, i));
        this.#done = true;
        this.#buf = new Uint8Array(0);
        if (pid) {
          this.#onPid(pid);
        }
        return buf.slice(i + 1);
      }
      if (b < 0x30 || b > 0x39 || i >= MARKER_MAX) {
        return this.#give(buf);
      }
    }
    this.#buf = buf;
    return new Uint8Array(0);
  }

  /** Flush anything still buffered (stream ended mid-marker). */
  flush(): Uint8Array {
    const out = this.#buf;
    this.#buf = new Uint8Array(0);
    this.#done = true;
    return out;
  }

  #give(buf: Uint8Array): Uint8Array {
    this.#done = true;
    this.#buf = new Uint8Array(0);
    return buf;
  }
}
