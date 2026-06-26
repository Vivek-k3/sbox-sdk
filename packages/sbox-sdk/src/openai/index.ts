/**
 * `sbox-sdk/openai` — OpenAI Agents SDK adapter. Projects the provider-neutral
 * sandbox tool registry into `tool()` objects, returned as an **array** for
 * `new Agent({ tools })`.
 *
 * Approval: the OpenAI Agents SDK has native human-in-the-loop, so this adapter
 * wires the policy into `needsApproval` — `"ask"` → the agent surfaces a
 * `tool_approval_requested` interruption on the `RunResult` (the host resolves
 * it via `result.state.approve()/reject()` + re-run). `"deny"` is enforced
 * inside `execute` (returns a message the model reads).
 *
 * Schema: our zod schemas are passed directly with `strict: true`; the SDK
 * converts optional fields to nullable+required (OpenAI strict-mode valid).
 *
 * Peer dependency: `@openai/agents` (optional).
 */
import { tool } from "@openai/agents";
import type { Tool } from "@openai/agents";

import { decide } from "../agent-tools/policy.js";
import { createSandboxTools } from "../agent-tools/registry.js";
import type {
  FrameworkAdapter,
  ToolRunContext,
  ToolSetOptions,
  ToolSpec,
} from "../agent-tools/types.js";
import type { Sandbox } from "../internal/types.js";

export type OpenAIToolOptions = ToolSetOptions;

/** OpenAI Agents takes tools as an array. */
export type OpenAIToolSet = Tool[];

interface Resolved {
  specs: ToolSpec[];
  sandbox?: Sandbox;
}

function resolve(source: Sandbox | ToolSpec[], opts: ToolSetOptions): Resolved {
  return Array.isArray(source)
    ? { specs: source }
    : { sandbox: source, specs: createSandboxTools(source, opts) };
}

/**
 * Build OpenAI Agents tools from a live sandbox (capability-gated) or a
 * pre-built `ToolSpec[]`. Pass the result to `new Agent({ tools })`.
 */
export function toOpenAITools(
  source: Sandbox | ToolSpec[],
  opts: OpenAIToolOptions = {}
): OpenAIToolSet {
  const { specs, sandbox } = resolve(source, opts);
  const { policy } = opts;
  return specs.map((spec) => {
    const ctx: ToolRunContext = { sandbox };
    return tool({
      name: spec.name,
      description: spec.description,
      // `inputSchema` is erased to z.ZodType but is a z.object() at runtime, which
      // the SDK accepts and converts to a strict JSON schema (verified by the
      // round-trip test). The SDK's ZodObjectLike param type is modeled on zod 3,
      // so this type-only cast bridges the boundary; the runtime value is unchanged.
      parameters: spec.inputSchema as never,
      strict: true,
      // Native HITL: "ask" -> the SDK raises a tool-approval interruption.
      needsApproval: async (_runContext, input): Promise<boolean> =>
        decide(spec, input, ctx, policy) === "ask",
      execute: async (input): Promise<string> => {
        if (decide(spec, input, ctx, policy) === "deny") {
          return `Denied by policy: ${spec.name} is not permitted.`;
        }
        return (await spec.execute(input, ctx)).text;
      },
    });
  });
}

/**
 * The OpenAI Agents framework adapter for the `ai()` plugin:
 *
 * ```ts
 * import { ai } from "sbox-sdk/ai";
 * import { openaiAgents } from "sbox-sdk/openai";
 *
 * const client = createSandboxClient({ provider: e2b(), plugins: [ai({ framework: openaiAgents() })] });
 * const sandbox = await client.create();
 * const agent = new Agent({ name: "coder", tools: sandbox.tools });
 * ```
 */
export function openaiAgents(): FrameworkAdapter<OpenAIToolSet> {
  return {
    build: (sandbox, opts) => toOpenAITools(sandbox, opts),
    name: "openai",
  };
}
