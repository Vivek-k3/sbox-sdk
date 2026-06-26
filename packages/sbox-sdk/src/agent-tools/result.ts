/**
 * The normalized result every tool returns. `text` is always the model-facing
 * rendering; `output` is the optional structured value. Each framework adapter
 * serializes ONE of these into its own tool-result shape (AI SDK value,
 * Anthropic `tool_result` block, OpenAI string, Mastra output object).
 */

export interface ToolResultContent {
  type: "text" | "image";
  /** present when type === "text" */
  text?: string;
  /** base64-encoded payload, present when type === "image" */
  data?: string;
  /** e.g. "image/png", present when type === "image" */
  mediaType?: string;
}

export interface ToolResult<O = unknown> {
  /** false signals a tool-level failure (non-zero exit, denied, provider error). */
  ok: boolean;
  /** Always present — what the model reads. */
  text: string;
  /** Structured, machine-readable result (when the tool produces one). */
  output?: O;
  /** Mirrors `ok === false`; surfaced as `is_error` by adapters that support it. */
  isError?: boolean;
  /** Optional rich blocks for adapters that accept them (e.g. Anthropic images). */
  content?: ToolResultContent[];
}

/** A successful result. */
export function ok<O>(text: string, output?: O): ToolResult<O> {
  return { ok: true, output, text };
}

/** A tool-level failure — never thrown, always returned so the agent can react. */
export function err(text: string): ToolResult<never> {
  return { isError: true, ok: false, text };
}
