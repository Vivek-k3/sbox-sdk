/**
 * `sbox-sdk/mastra` — Mastra adapter. Projects the provider-neutral sandbox tool
 * registry into Mastra's `createTool()` shape, keyed by tool id so the result
 * drops into `new Agent({ tools })` or `new Mastra({ tools })`.
 *
 * Mastra is built on the AI SDK and also accepts AI SDK tools directly, so the
 * `vercelAI()` plugin's output works in a Mastra agent too; this native adapter
 * additionally gives Mastra-native registration (and a path to `outputSchema` /
 * `suspend()`-based HITL in a follow-up).
 *
 * Approval is enforced inside `execute` via the shared `enforcePolicy` (same as
 * every other adapter): `"deny"` short-circuits, `"ask"` awaits
 * `policy.onApprovalRequest` when configured. Native Mastra `suspend()` HITL is
 * a planned enhancement.
 *
 * Peer dependency: `@mastra/core` (optional).
 */
import { createTool } from "@mastra/core/tools";
import type { Tool } from "@mastra/core/tools";

import { enforcePolicy } from "../agent-tools/policy.js";
import { createSandboxTools } from "../agent-tools/registry.js";
import type {
  FrameworkAdapter,
  ToolRunContext,
  ToolSetOptions,
  ToolSpec,
} from "../agent-tools/types.js";
import type { Sandbox } from "../internal/types.js";

export type MastraToolOptions = ToolSetOptions;

/** Every spec erases its input schema to `unknown`, so the concrete `Tool`
 *  instances share `Tool<unknown, …>` and assign cleanly into this record. */
export type MastraToolSet = Record<string, ReturnType<typeof createTool>>;

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
 * Build Mastra tools from a live sandbox (capability-gated) or a pre-built
 * `ToolSpec[]`. Register the result on an Agent or the Mastra instance.
 */
export function toMastraTools(
  source: Sandbox | ToolSpec[],
  opts: MastraToolOptions = {}
): MastraToolSet {
  const { specs, sandbox } = resolve(source, opts);
  const { policy } = opts;
  const tools: MastraToolSet = {};
  for (const spec of specs) {
    tools[spec.name] = createTool({
      description: spec.description,
      execute: async (inputData): Promise<string> => {
        const ctx: ToolRunContext = { sandbox };
        const denied = await enforcePolicy(spec, inputData, ctx, policy);
        if (denied !== null) {
          return denied;
        }
        const result = await spec.execute(inputData, ctx);
        return result.text;
      },
      id: spec.name,
      inputSchema: spec.inputSchema as Tool["inputSchema"],
    });
  }
  return tools;
}

/**
 * The Mastra framework adapter for the `ai()` plugin:
 *
 * ```ts
 * import { ai } from "sbox-sdk/ai";
 * import { mastra } from "sbox-sdk/mastra";
 *
 * const client = createSandboxClient({ provider: e2b(), plugins: [ai({ framework: mastra() })] });
 * const sandbox = await client.create();
 * const agent = new Agent({ name: "coder", model, tools: sandbox.tools });
 * ```
 */
export function mastra(): FrameworkAdapter<MastraToolSet> {
  return {
    build: (sandbox, opts) => toMastraTools(sandbox, opts),
    name: "mastra",
  };
}
