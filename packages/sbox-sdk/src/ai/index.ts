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
import type { PluginSetupContext, SandboxPlugin } from "../internal/plugin.js";

export interface AIOptions<TTools> extends ToolSetOptions {
  /** The agent framework to target — `aiSdk()`, `openaiAgents()`, … */
  framework: FrameworkAdapter<TTools>;
}

/**
 * Merge per-sandbox overrides from `client.create(spec, options)` over the
 * plugin's client-wide defaults. Only `policy`, `only`, and `forbid` are honored
 * — never the framework. `policy` is shallow-merged so a single sandbox can
 * tighten its trust posture; `only`/`forbid` are replaced when provided. This is
 * what makes an untrusted sandbox's policy actually take effect rather than
 * silently inheriting the laxer client default.
 */
function resolveToolOptions(
  base: ToolSetOptions,
  createOptions: PluginSetupContext["createOptions"]
): ToolSetOptions {
  if (!createOptions) {
    return base;
  }
  const override = createOptions as Partial<ToolSetOptions>;
  const merged: ToolSetOptions = { ...base };
  if (override.policy) {
    merged.policy = { ...base.policy, ...override.policy };
  }
  if (override.only) {
    merged.only = override.only;
  }
  if (override.forbid) {
    merged.forbid = override.forbid;
  }
  return merged;
}

/**
 * The single AI-provider plugin. Shapes `sandbox.tools` for the given framework,
 * capability-gated to the provider and gated by the optional `policy`. Per-sandbox
 * overrides passed to `client.create(spec, options)` are merged over the defaults.
 */
export function ai<TTools>(
  opts: AIOptions<TTools>
): SandboxPlugin<{ tools: TTools }> {
  const { framework, ...toolOptions } = opts;
  return {
    extend: (sandbox, ctx) => ({
      tools: framework.build(
        sandbox,
        resolveToolOptions(toolOptions, ctx.createOptions)
      ),
    }),
    kind: "ai-provider",
    name: `ai:${framework.name}`,
  };
}
