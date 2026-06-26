/**
 * `sbox-sdk/ai` — the umbrella AI-provider plugin. Pick a framework adapter from
 * its subpath (`aiSdk()`, `mastra()`, `openaiAgents()`, `anthropic()`,
 * `langchain()`) and pass it in; `ai()` grafts the framework-shaped tools onto
 * `sandbox.tools`. Core-only — no framework SDK is imported here, so this stays
 * dependency-free; the framework you import decides what gets bundled.
 *
 * ```ts
 * import { createSandboxClient } from "sbox-sdk";
 * import { e2b } from "sbox-sdk/e2b";
 * import { ai } from "sbox-sdk/ai";
 * import { aiSdk } from "sbox-sdk/ai-sdk";
 *
 * const client = createSandboxClient({
 *   provider: e2b(),
 *   plugins: [ai({ framework: aiSdk(), policy })],
 * });
 * const sandbox = await client.create();
 * await generateText({ model, prompt, tools: sandbox.tools });
 * ```
 */
import type { FrameworkAdapter, ToolSetOptions } from "../agent-tools/index.js";
import type { SandboxPlugin } from "../internal/plugin.js";

export interface AIOptions<TTools> extends ToolSetOptions {
  /** The agent framework to target — `aiSdk()`, `openaiAgents()`, … */
  framework: FrameworkAdapter<TTools>;
}

/**
 * The single AI-provider plugin. Shapes `sandbox.tools` for the given framework,
 * capability-gated to the provider and gated by the optional `policy`.
 */
export function ai<TTools>(
  opts: AIOptions<TTools>
): SandboxPlugin<{ tools: TTools }> {
  const { framework, ...toolOptions } = opts;
  return {
    extend: (sandbox) => ({ tools: framework.build(sandbox, toolOptions) }),
    kind: "ai-provider",
    name: `ai:${framework.name}`,
  };
}
