/**
 * The single, framework-agnostic approval model. One `SandboxPolicy` is
 * authored once; each adapter translates a `Decision` into that framework's
 * native human-in-the-loop mechanism (AI SDK `needsApproval`, OpenAI
 * interruptions, Mastra `suspend()`, or an `onApprovalRequest` gate).
 */
import type { Risk, ToolName, ToolRunContext, ToolSpec } from "./types.js";

export type Decision = "allow" | "ask" | "deny";

export interface ApprovalRequest {
  readonly tool: ToolName;
  readonly title: string;
  readonly input: unknown;
  readonly risk: Risk;
  readonly sandboxId: string;
}

export interface AuditRecord {
  readonly tool: ToolName;
  readonly input: unknown;
  readonly risk: Risk;
  readonly decision: Decision;
  readonly sandboxId: string;
}

export interface SandboxPolicy {
  /** Per-risk default decision. Defaults to DEFAULT_DECISIONS below. */
  defaults?: Partial<Record<Risk, Decision>>;
  /** Per-tool override; may inspect the actual input. Wins over `defaults`. */
  rules?: Partial<
    Record<ToolName, (input: unknown, ctx: ToolRunContext) => Decision>
  >;
  /** Hard removal — tool never appears in the produced set. */
  forbid?: ToolName[];
  /** Used by adapters with no native HITL (Anthropic, LangChain without a graph). */
  onApprovalRequest?: (req: ApprovalRequest) => boolean | Promise<boolean>;
  /** Observe every decision (logging, metrics, audit trails). */
  audit?: (rec: AuditRecord) => void;
}

/** Sensible default: only destructive actions pause for approval. */
export const DEFAULT_DECISIONS: Readonly<Record<Risk, Decision>> = {
  destructive: "ask",
  mutating: "allow",
  safe: "allow",
};

/** Effective risk for a given input (refined for multi-verb tools). */
export function effectiveRisk(spec: ToolSpec, input: unknown): Risk {
  return spec.riskFor?.(input) ?? spec.risk;
}

/** Resolve the approval decision for one tool call. */
export function decide(
  spec: ToolSpec,
  input: unknown,
  ctx: ToolRunContext,
  policy?: SandboxPolicy
): Decision {
  if (policy?.forbid?.includes(spec.name)) {
    return "deny";
  }
  const rule = policy?.rules?.[spec.name];
  if (rule) {
    return rule(input, ctx);
  }
  const risk = effectiveRisk(spec, input);
  return policy?.defaults?.[risk] ?? DEFAULT_DECISIONS[risk];
}

/**
 * Shared approval gate used by adapters without native HITL (and as the portable
 * default everywhere). Returns `null` when the call may proceed, or a denial
 * message the model can read. `"ask"` awaits `onApprovalRequest` when configured;
 * otherwise it proceeds (human-in-the-loop is opt-in). Emits `audit` records.
 */
export async function enforcePolicy(
  spec: ToolSpec,
  input: unknown,
  ctx: ToolRunContext,
  policy?: SandboxPolicy
): Promise<string | null> {
  const risk = effectiveRisk(spec, input);
  const sandboxId = ctx.sandbox?.id ?? "";
  const audit = (decision: Decision): void =>
    policy?.audit?.({ decision, input, risk, sandboxId, tool: spec.name });

  const decision = decide(spec, input, ctx, policy);
  if (decision === "deny") {
    audit("deny");
    return `Denied by policy: ${spec.name} is not permitted.`;
  }
  if (decision === "ask" && policy?.onApprovalRequest) {
    const approved = await policy.onApprovalRequest({
      input,
      risk,
      sandboxId,
      title: spec.title,
      tool: spec.name,
    });
    audit(approved ? "allow" : "deny");
    return approved ? null : `Approval denied for ${spec.name}.`;
  }
  audit("allow");
  return null;
}
