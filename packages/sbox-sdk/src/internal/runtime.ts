/**
 * Tiny runtime probe so the (fetch-only) core can adapt without importing any
 * `node:` module. Providers that genuinely need Node APIs do their own checks.
 */
export type Runtime = "node" | "bun" | "deno" | "workerd" | "unknown";

export function detectRuntime(): Runtime {
  const g = globalThis as Record<string, unknown>;
  if (g.Deno) {
    return "deno";
  }
  if (g.Bun) {
    return "bun";
  }
  if (
    typeof navigator !== "undefined" &&
    navigator.userAgent === "Cloudflare-Workers"
  ) {
    return "workerd";
  }
  const proc = g.process as { versions?: { node?: string } } | undefined;
  if (proc?.versions?.node) {
    return "node";
  }
  return "unknown";
}

export function hasFetch(): boolean {
  return typeof globalThis.fetch === "function";
}
