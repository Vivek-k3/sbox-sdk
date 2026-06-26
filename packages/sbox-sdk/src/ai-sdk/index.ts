/**
 * `sbox-sdk/ai-sdk` — Vercel AI SDK adapter. Projects the provider-neutral
 * sandbox tool registry into the AI SDK's `tool()` shape, keyed by tool name so
 * the result drops straight into `generateText({ tools })` / `streamText`.
 *
 * Approval: stable `ai` v5 has no `needsApproval` field on a tool, so the
 * `SandboxPolicy` is enforced inside `execute` — `"deny"` short-circuits with a
 * message the model reads, and `"ask"` awaits `policy.onApprovalRequest` when
 * one is configured (otherwise it proceeds; HITL is opt-in). For AI SDK v7,
 * `toolApproval()` builds the call-site approval map instead.
 *
 * Peer dependency: `ai` (optional).
 */
import { tool } from "ai";
import type { Tool } from "ai";

import { decide, enforcePolicy } from "../agent-tools/policy.js";
import { createSandboxTools } from "../agent-tools/registry.js";
import type {
  FrameworkAdapter,
  ToolRunContext,
  ToolSetOptions,
  ToolSpec,
} from "../agent-tools/types.js";
import type { Sandbox } from "../internal/types.js";

export type AISDKToolOptions = ToolSetOptions;

/** The AI SDK tool map: `{ [toolName]: Tool }`. */
export type AISDKToolSet = Record<string, Tool>;

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
 * Build AI SDK tools from a live sandbox (capability-gated) or a pre-built
 * `ToolSpec[]`. Hand the result to `generateText({ tools })`.
 */
export function toAISDKTools(
  source: Sandbox | ToolSpec[],
  opts: AISDKToolOptions = {}
): AISDKToolSet {
  const { specs, sandbox } = resolve(source, opts);
  const { policy } = opts;
  const tools: AISDKToolSet = {};
  for (const spec of specs) {
    tools[spec.name] = tool({
      description: spec.description,
      execute: async (input, options): Promise<string> => {
        const ctx: ToolRunContext = { sandbox, signal: options.abortSignal };
        const denied = await enforcePolicy(spec, input, ctx, policy);
        if (denied !== null) {
          return denied;
        }
        const result = await spec.execute(input, ctx);
        return result.text;
      },
      inputSchema: spec.inputSchema,
    });
  }
  return tools;
}

/**
 * The Vercel AI SDK framework adapter for the `ai()` plugin:
 *
 * ```ts
 * import { ai } from "sbox-sdk/ai";
 * import { aiSdk } from "sbox-sdk/ai-sdk";
 *
 * const client = createSandboxClient({ provider: e2b(), plugins: [ai({ framework: aiSdk() })] });
 * const sandbox = await client.create();
 * await generateText({ model, prompt, tools: sandbox.tools });
 * ```
 */
export function aiSdk(): FrameworkAdapter<AISDKToolSet> {
  return {
    build: (sandbox, opts) => toAISDKTools(sandbox, opts),
    name: "ai-sdk",
  };
}

/**
 * AI SDK v7 forward-compat: build the call-site `toolApproval` map
 * (`generateText({ tools, toolApproval })`) from the same policy. Each entry
 * returns `"user-approval"` when the policy says "ask", else `undefined`.
 */
export function toolApproval(
  source: Sandbox | ToolSpec[],
  opts: AISDKToolOptions = {}
): Record<string, (input: unknown) => Promise<"user-approval" | undefined>> {
  const { specs, sandbox } = resolve(source, opts);
  const { policy } = opts;
  const map: Record<
    string,
    (input: unknown) => Promise<"user-approval" | undefined>
  > = {};
  for (const spec of specs) {
    map[spec.name] = async (input): Promise<"user-approval" | undefined> =>
      decide(spec, input, { sandbox }, policy) === "ask"
        ? "user-approval"
        : undefined;
  }
  return map;
}
