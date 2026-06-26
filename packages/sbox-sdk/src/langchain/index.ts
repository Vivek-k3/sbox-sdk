/**
 * `sbox-sdk/langchain` — LangChain (TS) adapter. Projects the provider-neutral
 * sandbox tool registry into `@langchain/core` `tool()` objects, returned as an
 * array for any LangChain agent / LangGraph `ToolNode`.
 *
 * Approval: enforced inside the tool function via the shared `enforcePolicy`
 * (`"deny"` short-circuits; `"ask"` awaits `policy.onApprovalRequest`). For
 * graph-native human-in-the-loop, wrap the call in a LangGraph `interrupt()` —
 * a documented follow-up (kept out of v1 so the only peer is `@langchain/core`).
 *
 * Peer dependency: `@langchain/core` (optional).
 */
import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";

import { enforcePolicy } from "../agent-tools/policy.js";
import { createSandboxTools } from "../agent-tools/registry.js";
import type {
  FrameworkAdapter,
  ToolRunContext,
  ToolSetOptions,
  ToolSpec,
} from "../agent-tools/types.js";
import type { Sandbox } from "../internal/types.js";

export type LangChainToolOptions = ToolSetOptions;

/** Array of LangChain structured tools. */
export type LangChainToolSet = StructuredToolInterface[];

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
 * Build LangChain tools from a live sandbox (capability-gated) or a pre-built
 * `ToolSpec[]`. Pass the result to a LangChain agent or LangGraph `ToolNode`.
 */
export function toLangChainTools(
  source: Sandbox | ToolSpec[],
  opts: LangChainToolOptions = {}
): LangChainToolSet {
  const { specs, sandbox } = resolve(source, opts);
  const { policy } = opts;
  return specs.map((spec) => {
    const run = async (input: unknown): Promise<string> => {
      const ctx: ToolRunContext = { sandbox };
      const denied = await enforcePolicy(spec, input, ctx, policy);
      if (denied !== null) {
        return denied;
      }
      return (await spec.execute(input, ctx)).text;
    };
    return tool(run, {
      description: spec.description,
      name: spec.name,
      schema: spec.inputSchema,
    });
  });
}

/**
 * The LangChain framework adapter for the `ai()` plugin:
 *
 * ```ts
 * import { ai } from "sbox-sdk/ai";
 * import { langchain } from "sbox-sdk/langchain";
 *
 * const client = createSandboxClient({ provider: e2b(), plugins: [ai({ framework: langchain() })] });
 * const sandbox = await client.create();
 * const agent = createReactAgent({ llm, tools: sandbox.tools });
 * ```
 */
export function langchain(): FrameworkAdapter<LangChainToolSet> {
  return {
    build: (sandbox, opts) => toLangChainTools(sandbox, opts),
    name: "langchain",
  };
}
