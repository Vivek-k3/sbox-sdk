/**
 * `sbox-sdk/anthropic` — Anthropic (Claude) adapter. Projects the
 * provider-neutral sandbox tool registry into the SDK's `betaZodTool()` shape.
 *
 * The returned `BetaRunnableTool[]` serves BOTH Claude tool-use paths, because a
 * `BetaRunnableTool` IS a tool definition (`BetaToolUnion`) plus a `run`/`parse`:
 *   • auto-loop  — `anthropic.beta.messages.toolRunner({ tools })`
 *   • manual loop — `anthropic.beta.messages.create({ tools })`, then on a
 *     `tool_use` block: `tool.run(tool.parse(block.input))` -> `tool_result`.
 *
 * Approval: Claude has no native HITL, so the shared `enforcePolicy` runs inside
 * `run` — `"deny"` short-circuits and `"ask"` awaits `policy.onApprovalRequest`
 * (when configured); both return a message Claude reads.
 *
 * Peer dependency: `@anthropic-ai/sdk` (optional).
 */
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";

import { enforcePolicy } from "../agent-tools/policy.js";
import { createSandboxTools } from "../agent-tools/registry.js";
import type {
  FrameworkAdapter,
  ToolRunContext,
  ToolSetOptions,
  ToolSpec,
} from "../agent-tools/types.js";
import type { Sandbox } from "../internal/types.js";

export type AnthropicToolOptions = ToolSetOptions;

/** Array of runnable Claude tools (also valid tool definitions for create()). */
export type AnthropicToolSet = ReturnType<typeof betaZodTool>[];

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
 * Build Claude tools from a live sandbox (capability-gated) or a pre-built
 * `ToolSpec[]`. Pass the result to `anthropic.beta.messages.toolRunner({ tools })`
 * or `anthropic.beta.messages.create({ tools })`.
 */
export function toAnthropicTools(
  source: Sandbox | ToolSpec[],
  opts: AnthropicToolOptions = {}
): AnthropicToolSet {
  const { specs, sandbox } = resolve(source, opts);
  const { policy } = opts;
  return specs.map((spec) =>
    betaZodTool({
      description: spec.description,
      inputSchema: spec.inputSchema,
      name: spec.name,
      run: async (args): Promise<string> => {
        const ctx: ToolRunContext = { sandbox };
        const denied = await enforcePolicy(spec, args, ctx, policy);
        if (denied !== null) {
          return denied;
        }
        return (await spec.execute(args, ctx)).text;
      },
    })
  );
}

/**
 * The Anthropic (Claude) framework adapter for the `ai()` plugin:
 *
 * ```ts
 * import { ai } from "sbox-sdk/ai";
 * import { anthropic } from "sbox-sdk/anthropic";
 *
 * const client = createSandboxClient({ provider: e2b(), plugins: [ai({ framework: anthropic() })] });
 * const sandbox = await client.create();
 * const msg = await claude.beta.messages.toolRunner({ model, messages, tools: sandbox.tools });
 * ```
 */
export function anthropic(): FrameworkAdapter<AnthropicToolSet> {
  return {
    build: (sandbox, opts) => toAnthropicTools(sandbox, opts),
    name: "anthropic",
  };
}
