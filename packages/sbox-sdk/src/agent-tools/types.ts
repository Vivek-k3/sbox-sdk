/**
 * The provider- AND framework-agnostic tool model. A `ToolSpec` is the single
 * source of truth for one sandbox tool; every framework adapter is a pure
 * projection `ToolSpec -> that framework's tool object`, and the (future) MCP
 * server + Agent Skills read from the very same specs.
 */
import type { z } from "zod";

import type { Sandbox } from "../internal/types.js";
import type { ToolResult } from "./result.js";

/** The fixed set of canonical sandbox tools. */
export type ToolName =
  | "sbox_exec"
  | "sbox_run_code"
  | "sbox_fs_read"
  | "sbox_fs_write"
  | "sbox_fs_list"
  | "sbox_fs_remove"
  | "sbox_expose_port"
  | "sbox_snapshot"
  | "sbox_lifecycle"
  | "sbox_set_egress";

/** Drives the default approval posture (see SandboxPolicy). */
export type Risk = "safe" | "mutating" | "destructive";

/** MCP-aligned behavioral hints, reused verbatim by the future MCP server. */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** Threaded into every tool execution and policy rule. `sandbox` is optional:
 *  a spec's `execute` closes over its own sandbox, so it is only needed by
 *  policy rules that introspect the sandbox (absent when adapters are handed a
 *  pre-built `ToolSpec[]` rather than a live sandbox). */
export interface ToolRunContext {
  readonly sandbox?: Sandbox;
  readonly signal?: AbortSignal;
}

/**
 * One canonical tool. Homogeneous (input typed `unknown`) so the registry can
 * hold `ToolSpec[]`; `execute` validates its input against `inputSchema` before
 * running, so adapters may forward framework-parsed args as-is.
 */
export interface ToolSpec {
  readonly name: ToolName;
  /** Short human label (not shown to the model). */
  readonly title: string;
  /** Model-facing description — written for an agent, not a human reader. */
  readonly description: string;
  /** Zod is the lingua franca: AI SDK / Mastra / OpenAI / LangChain take it
   *  directly; the Anthropic adapter converts it to JSON Schema. */
  readonly inputSchema: z.ZodType;
  /** Optional structured-output schema (consumed by e.g. Mastra). */
  readonly outputSchema?: z.ZodType;
  /** Declared (base) risk; refine per-input via `riskFor`. */
  readonly risk: Risk;
  readonly annotations: ToolAnnotations;
  /** Per-input risk refinement for multi-verb tools (lifecycle, snapshot). */
  riskFor?(input: unknown): Risk;
  /** Runs the operation. MUST resolve a ToolResult — never throw for tool-level
   *  failure (return `err(...)`); may throw only on truly unexpected errors. */
  execute(input: unknown, ctx: ToolRunContext): Promise<ToolResult>;
}

/** Options accepted by `createSandboxTools` and every `toXTools` adapter. */
export interface ToolSetOptions {
  /** Approval policy (also carries `forbid`). */
  policy?: import("./policy.js").SandboxPolicy;
  /** Allow-list: when set, only these tools are produced. */
  only?: ToolName[];
  /** Removed entirely from the produced set (merged with `policy.forbid`). */
  forbid?: ToolName[];
}

/**
 * A framework "provider" for the `ai()` plugin: knows how to turn a sandbox into
 * one agent framework's tool objects. Returned by the framework subpaths
 * (`aiSdk()`, `mastra()`, `openaiAgents()`, `anthropic()`, `langchain()`) and
 * passed to `ai({ framework })`. `TTools` is the framework's tool shape, so
 * `sandbox.tools` stays correctly typed.
 */
export interface FrameworkAdapter<TTools = unknown> {
  /** Stable id, e.g. "ai-sdk" or "openai". */
  readonly name: string;
  /** Project the sandbox's (capability-gated, policy-aware) tools. */
  build(sandbox: Sandbox, opts: ToolSetOptions): TTools;
}
