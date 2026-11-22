/**
 * Preview normalization + browser helpers. Adapters return a plain `Preview`;
 * the core fills `wsUrl`/`auth` so every provider looks the same, and
 * `browserUrl()` turns a preview into something a browser (incl. a WebSocket)
 * can open directly.
 */
import { NotSupportedError } from "./errors.js";
import type { Preview, PreviewAuth } from "./types.js";

/** Fill `wsUrl` and `auth` defaults on an adapter-returned preview. */
export function normalizePreview(p: Preview): Preview {
  const auth: PreviewAuth =
    p.auth ??
    (p.token
      ? { headers: { Authorization: `Bearer ${p.token}` }, type: "header" }
      : { type: "public" });
  let wsUrl = p.wsUrl;
  if (!wsUrl) {
    try {
      const u = new URL(p.url);
      if (u.protocol === "https:" || u.protocol === "http:") {
        u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
        wsUrl = u.toString();
      }
    } catch {
      // not a URL; leave wsUrl unset
    }
  }
  return { ...p, auth, ...(wsUrl ? { wsUrl } : {}) };
}

export interface BrowserUrlOptions {
  /** "ws" returns the WebSocket URL. Default "http". */
  protocol?: "http" | "ws";
  /** Path (and query) to append, e.g. "/websockify". */
  path?: string;
}

/**
 * A URL a browser can open with no custom headers: query-token and signed-URL
 * previews get their auth baked in. Throws `NotSupportedError` for
 * header-only auth (a browser WebSocket cannot send headers).
 */
export function browserUrl(
  preview: Preview,
  opts: BrowserUrlOptions = {}
): string {
  const p = normalizePreview(preview);
  const base = opts.protocol === "ws" ? (p.wsUrl ?? p.url) : p.url;
  const u = new URL(base);
  if (opts.path) {
    const extra = new URL(opts.path, "http://x");
    u.pathname = `${u.pathname.replace(/\/$/, "")}${extra.pathname}`;
    for (const [k, v] of extra.searchParams) {
      u.searchParams.set(k, v);
    }
  }
  const auth = p.auth!;
  if (auth.type === "header") {
    throw new NotSupportedError(
      "preview",
      "browserUrl (this preview needs auth headers; browsers cannot send them on a WebSocket)"
    );
  }
  if (auth.type === "query") {
    u.searchParams.set(auth.param, auth.token);
  }
  return u.toString();
}
