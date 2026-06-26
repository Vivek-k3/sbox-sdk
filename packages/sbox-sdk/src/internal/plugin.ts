/**
 * The sandbox plugin system. A plugin augments every sandbox the client builds.
 * The headline kind is an *AI-provider* plugin (`kind: "ai-provider"`), which
 * contributes a framework-shaped `tools` property to `sandbox.tools` via
 * `extend`. The shape of `sandbox.tools` follows whichever AI-provider plugin
 * is installed — the app never imports a projection function.
 *
 * This module is intentionally free of any agent-tools dependency: the per-create
 * overrides reach a plugin as an opaque `createOptions` bag it interprets itself.
 */
import type { Sandbox } from "./types.js";

/** Standard "merge a union of object types into one intersection" helper. */
export type UnionToIntersection<U> = (
  U extends unknown ? (k: U) => void : never
) extends (k: infer I) => void
  ? I
  : never;

/** Passed to `extend`/`onCreate`. Carries the 2nd arg of `client.create`. */
export interface PluginSetupContext {
  /** Per-sandbox overrides from `client.create(spec, options)`; plugin-defined. */
  readonly createOptions?: Readonly<Record<string, unknown>>;
}

/**
 * A sandbox plugin. `Ext` is the typed set of properties it grafts onto the
 * sandbox object (e.g. `{ tools: Record<string, AISDKTool> }`).
 */
export interface SandboxPlugin<Ext extends object = object> {
  readonly name: string;
  /** Discriminant. The client enforces AT MOST ONE `"ai-provider"` plugin. */
  readonly kind?: "ai-provider" | "middleware" | "lifecycle" | "mcp";
  /** Pure, synchronous projection merged onto the sandbox (keeps build sync). */
  extend?(sandbox: Sandbox, ctx: PluginSetupContext): Ext;
  /** Async side-effects, awaited by the client after the sandbox is built. */
  onCreate?(
    sandbox: Sandbox & Ext,
    ctx: PluginSetupContext
  ): void | Promise<void>;
  /** Runs before the underlying destroy(); flush audit logs, stop servers, … */
  onDestroy?(sandbox: Sandbox): void | Promise<void>;
}

/** The contribution type of a single plugin. */
export type PluginExt<P> = P extends SandboxPlugin<infer E> ? E : object;

/** The merged contribution of a tuple of plugins (empty tuple -> `{}`). */
export type MergePlugins<Ps extends readonly SandboxPlugin[]> =
  Ps extends readonly [] ? object : UnionToIntersection<PluginExt<Ps[number]>>;
