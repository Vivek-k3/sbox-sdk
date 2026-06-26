/**
 * `sbox-sdk/agent-tools` — the framework-agnostic agent-tooling core. Build a
 * provider-neutral tool set from any sandbox, then project it into a framework
 * with one of the adapter subpaths (`sbox-sdk/ai-sdk`, `/openai`, …) or feed it
 * to the (future) MCP server. Depends only on the core SDK + `zod`.
 */
export { createSandboxTools } from "./registry.js";

export type {
  ToolName,
  Risk,
  ToolAnnotations,
  ToolRunContext,
  ToolSpec,
  ToolSetOptions,
  FrameworkAdapter,
} from "./types.js";

export { ok, err } from "./result.js";
export type { ToolResult, ToolResultContent } from "./result.js";

export {
  decide,
  effectiveRisk,
  enforcePolicy,
  DEFAULT_DECISIONS,
} from "./policy.js";
export type {
  Decision,
  SandboxPolicy,
  ApprovalRequest,
  AuditRecord,
} from "./policy.js";
