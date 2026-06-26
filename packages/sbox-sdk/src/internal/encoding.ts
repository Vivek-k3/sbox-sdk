/**
 * Encoding helpers shared by adapters that move bytes over text channels
 * (exec + base64). Web-standard only (atob/btoa) so they work on Node, Bun,
 * Deno, and Workers. (For shell quoting, use `shellQuote` from the adapter kit.)
 */

export function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (const x of b) {
    s += String.fromCodePoint(x);
  }
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.codePointAt(i) ?? 0;
  }
  return out;
}
