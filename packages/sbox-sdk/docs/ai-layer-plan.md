# sbox-sdk AI Layer — Implementation Plan

**Scope of this plan:** the agent-tooling layer, with first-class adapters for **Vercel AI SDK, Mastra, OpenAI Agents SDK, Anthropic, and LangChain (TS)**.

**Status:** research complete; design corrected against the real core API. **Phases 0, 1, 1.5 AND all of Phase 2 (5 adapters) implemented and green.** Remaining: Phase 3 (cross-adapter conformance suite) + Phase 4 (examples/docs).

**Implemented** (`packages/sbox-sdk/src/`):

- `agent-tools/{result,types,policy,registry,index}.ts` — `ToolResult`, `ToolSpec`/`ToolName`/`Risk`, `SandboxPolicy`+`decide()`+`enforcePolicy()`, the 10 capability-gated tools, `createSandboxTools()`. Subpath `sbox-sdk/agent-tools`.
- `internal/plugin.ts` — `SandboxPlugin`/`MergePlugins` + the 3 touch points in `types.ts`/`sandbox.ts`/`client.ts` (client-level plugins, `kind`-guard, `extend`/`onCreate`/`onDestroy`, per-`create` `createOptions`).
- 5 adapters, each `toXTools()` + plugin factory + tests, all verified against the **installed** SDK version:
  - `ai-sdk` → `vercelAI()` (map) · `mastra` → `mastra()` (map) · `openai` → `openaiAgents()` (array, native `needsApproval`) · `anthropic` → `anthropic()` (BetaRunnableTool array) · `langchain` → `langchain()` (array).
- **Tests: 48 passed / 2 skipped (12 files)**; `tsc` typecheck + declaration emit clean for all 6 new subpaths.
- Optional peers + dev deps: `zod` (`^3.25 || ^4`), `ai` (`^5 || ^6`), `@mastra/core` (`^1`), `@openai/agents` (`>=0.12`), `@anthropic-ai/sdk` (`>=0.40`), `@langchain/core` (`>=0.3`).

---

## 0. The thesis — write the sandbox tools once, project into every framework

Every framework has the _same_ idea of a tool (name + description + input schema + an `execute` fn) wearing a slightly different costume. The trap is to hand-author 5× the same ~10 tools. We don't.

```
                       ┌────────────────────────────────────────┐
   live Sandbox  ──▶   │  agent-tools  (framework-agnostic)      │
                       │  • 10 canonical ToolSpec builders       │
                       │  • capability gating (sandbox.can(cap)) │
                       │  • SandboxPolicy / approval decisions    │
                       │  • ToolResult normalization              │
                       │     createSandboxTools(sandbox) → Spec[] │
                       └───────────────┬────────────────────────┘
                                       │ pure projection (no logic, just shape)
        ┌───────────────┬─────────────┼──────────────┬────────────────┐
        ▼               ▼             ▼              ▼                ▼
   sbox-sdk/ai-sdk  /mastra      /openai        /anthropic      /langchain
   tool()-map     createTool()  tool()-array   betaZodTool[] / tool()-array
                                                raw input_schema[]
```

A new framework later = one new ~80-line file. The 10 tools, their schemas, their capability gates, and their approval semantics are authored **once** in `agent-tools`.

### Two layers of API

1. **Low-level projection functions** (`toAISDKTools(sandbox)`, …) — explicit, tree-shakable, composable. Always available.
2. **High-level plugin system** (the headline DX) — you pass an _AI-provider plugin_ to the client, and the sandbox grows a correctly-typed `sandbox.tools` you hand straight to the agent. The plugin you choose **decides the shape** of `sandbox.tools`; you never import a projection function.

```ts
import { createSandboxClient } from "sbox-sdk";
import { e2b } from "sbox-sdk/e2b";
import { vercelAI } from "sbox-sdk/ai-sdk"; // <- the AI-provider plugin
import { generateText } from "ai";

const client = createSandboxClient({
  provider: e2b({ apiKey }),
  plugins: [vercelAI({ policy: { defaults: { destructive: "ask" } } })],
});

const sandbox = await client.create({ template: "node" });

// sandbox.tools is typed Record<string, AISDKTool>, ALREADY capability-filtered
// for whatever E2B supports. Swap e2b()->vercel() and the toolset re-shapes itself.
const res = await generateText({ model, prompt, tools: sandbox.tools });
```

The plugin layer is built **on top of** the projection functions — same registry, same core, zero duplicated logic. See §1.5.

---

## 1. Shared foundation (`sbox-sdk/agent-tools`) — built first, everything else projects from it

This subpath has **no framework dependency**. It depends only on the core SDK + `zod`.

### 1.1 Types (`src/agent-tools/types.ts`)

```ts
import type { z } from "zod";
import type { Sandbox } from "../internal/types.js";
import type { CapabilityName } from "../internal/capabilities.js";

export type ToolName =
  | "sbox_exec"
  | "sbox_run_code"
  | "sbox_fs_read"
  | "sbox_fs_write"
  | "sbox_fs_list"
  | "sbox_fs_remove"
  | "sbox_expose_port"
  | "sbox_snapshot"
  | "sbox_lifecycle"
  | "sbox_set_egress";

export type Risk = "safe" | "mutating" | "destructive";

/** MCP-aligned hints, reused verbatim by the future MCP server. */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** Provider- AND framework-agnostic. The single source of truth. */
export interface ToolSpec<I = unknown, O = unknown> {
  name: ToolName;
  title: string;
  description: string; // written FOR an agent, not a human reader
  inputSchema: z.ZodType<I>; // zod is the lingua franca (all 5 take zod)
  outputSchema?: z.ZodType<O>; // Mastra outputSchema + structured returns
  risk: Risk;
  annotations: ToolAnnotations;
  /** Capability gate; spec is dropped when the sandbox can't satisfy it. */
  requires?: CapabilityName | { anyOf: CapabilityName[] };
  /** Closes over the live sandbox at build time. NEVER throws on tool failure. */
  execute(input: I, ctx: ToolRunContext): Promise<ToolResult<O>>;
}

export interface ToolRunContext {
  sandbox: Sandbox;
  signal?: AbortSignal;
  /** Set by the framework adapter so execute() can short-circuit on deny. */
  approved?: boolean;
}
```

### 1.2 Result (`src/agent-tools/result.ts`)

One normalized result that every adapter serializes from. `text` is always present (model-facing); `output` is the typed structured value.

```ts
export interface ToolResult<O = unknown> {
  ok: boolean;
  text: string; // what the model reads
  output?: O; // structured, validated against outputSchema
  isError?: boolean;
  /** optional rich content for adapters that support it (Anthropic images, etc.) */
  content?: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mediaType: string }
  >;
}

export const ok = <O>(text: string, output?: O): ToolResult<O> => ({
  ok: true,
  text,
  output,
});
export const err = (text: string): ToolResult => ({
  ok: false,
  isError: true,
  text,
});
```

Why a normalized result: OpenAI serializes non-string returns to JSON; Anthropic wants `tool_result` blocks (and `is_error`); AI SDK takes any JSON-serializable value; Mastra validates against `outputSchema`. One shape → five serializers, no per-tool special-casing.

### 1.3 Schema helpers (`src/agent-tools/schema.ts`)

The strict-mode minefield: OpenAI Agents auto-enables `strict` for zod params, and Anthropic/OpenAI strict require **every** property in `required`, `additionalProperties:false`, and optionals expressed as `["type","null"]` unions. So:

```ts
import { z } from "zod";
// Author every input schema with strictObject + .nullable() (NOT .optional()) for optionals.
export const strictObject = <T extends z.ZodRawShape>(shape: T) =>
  z.strictObject(shape); // additionalProperties:false
// For Anthropic raw input_schema we convert with zod's native JSON-schema emitter.
export const toJsonSchema = (s: z.ZodType) => z.toJSONSchema(s); // zod v4
```

### 1.4 Policy / approval (`src/agent-tools/policy.ts`)

The single approval model that every adapter maps into its native HITL.

```ts
export type Decision = "allow" | "ask" | "deny";

export interface SandboxPolicy {
  /** default: { safe:"allow", mutating:"allow", destructive:"ask" } */
  defaults?: Partial<Record<Risk, Decision>>;
  /** Per-tool override, can inspect the actual input. */
  rules?: Partial<
    Record<ToolName, (input: unknown, ctx: ToolRunContext) => Decision>
  >;
  /** Hard removal — tool never appears in the projected set. */
  forbid?: ToolName[];
  /** Used by adapters with NO native HITL (Anthropic, LangChain-without-graph). */
  onApprovalRequest?: (req: ApprovalRequest) => Promise<boolean>;
  audit?: (rec: AuditRecord) => void;
}

export function decide(
  spec: ToolSpec,
  input: unknown,
  policy: SandboxPolicy,
  ctx: ToolRunContext
): Decision;
```

### 1.5 Registry + resolver (`src/agent-tools/registry.ts`, `index.ts`)

```ts
export function createSandboxTools(
  sandbox: Sandbox,
  opts?: {
    policy?: SandboxPolicy;
    only?: ToolName[]; // allow-list
    // forbid lives on the policy
  }
): ToolSpec[];
```

`createSandboxTools`:

1. Instantiates the 10 spec builders, closing over `sandbox`.
2. **Drops** any spec whose `requires` is not satisfied by `sandbox.can(cap)` (so e.g. `sbox_run_code` simply isn't there on a provider without `codeInterpreter`).
3. Applies `only` / `policy.forbid`.
4. Returns the neutral `ToolSpec[]` — the input to every adapter.

### 1.6 The 10 canonical tools (mapped to the REAL core API)

| Tool               | Core call                                        | Gate (`requires`)                                              | Risk                                      | Notes                                    |
| ------------------ | ------------------------------------------------ | -------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| `sbox_exec`        | `sandbox.commands.run(cmd, opts)`                | — (always)                                                     | mutating                                  | buffers ExecResult; `openWorldHint`      |
| `sbox_run_code`    | `sandbox.code.runCode(code, {language})`         | `codeInterpreter`                                              | mutating                                  | stateful kernel via optional `contextId` |
| `sbox_fs_read`     | `sandbox.files.read(path)`                       | — (always)                                                     | **safe**                                  | `readOnlyHint:true`                      |
| `sbox_fs_write`    | `sandbox.files.write(path, data)`                | — (always)                                                     | mutating                                  |                                          |
| `sbox_fs_list`     | `sandbox.files.list(path)`                       | — (always)                                                     | **safe**                                  | `readOnlyHint:true`                      |
| `sbox_fs_remove`   | `sandbox.files.remove(path,{recursive})`         | — (always)                                                     | **destructive**                           | default `ask`                            |
| `sbox_expose_port` | `sandbox.ports.expose(port)`                     | `exposePort`                                                   | mutating                                  | `openWorldHint:true`                     |
| `sbox_snapshot`    | `sandbox.snapshots.{create,restore,list,delete}` | `snapshot`                                                     | per-verb (restore/delete = destructive)   | `action` enum arg; **NOT** `fork`        |
| `sbox_lifecycle`   | `getInfo/setTimeout/stop/pause/resume/destroy`   | per-verb (`stop`/`pause`/`setTimeout` gated; `getInfo` always) | per-verb (`destroy`/`stop` = destructive) | `action` enum arg                        |
| `sbox_set_egress`  | `sandbox.network.setEgressPolicy(p)`             | `egressControl`                                                | mutating                                  |                                          |

**Deliberately excluded:** `snapshots.fork(count)` returns `Sandbox[]` — not serializable to a model, so it is not a tool. Same for `ports.fetch` (returns a `Response`) and `commands.spawn`/stream handles in v1.

> Lifecycle and snapshot fold multiple verbs into one tool via an `action` enum to keep the tool count ≈10 (tool-count governance — too many tools degrades model selection). Per-verb capability + risk is enforced inside `execute`.

---

## 1.5 Plugin system & `sandbox.tools` (the headline DX)

A **plugin** is a small object that augments every sandbox the client builds. An **AI-provider plugin** is one _kind_ of plugin — it contributes a framework-shaped `tools` property. The plugin ecosystem is open: middleware, lifecycle, and MCP plugins are future kinds using the same interface.

### 1.5.1 Plugin interface (`src/internal/plugin.ts`)

```ts
import type { Sandbox } from "./types.js";

/** `Ext` = the typed properties this plugin grafts onto the sandbox. */
export interface SandboxPlugin<Ext extends object = {}> {
  readonly name: string;
  /** Discriminant. The client enforces AT MOST ONE `"ai-provider"` plugin. */
  readonly kind?: "ai-provider" | "middleware" | "lifecycle" | "mcp";
  /** Pure, synchronous projection. Runs inside buildSandbox; result is merged
   *  onto the sandbox object. The AI-provider plugins use this to add `tools`. */
  extend?(sandbox: Sandbox): Ext;
  /** Async side-effects (await-ed by the client): seed files, start a server… */
  onCreate?(sandbox: Sandbox & Ext): void | Promise<void>;
  /** Run before destroy(): flush audit logs, stop servers… */
  onDestroy?(sandbox: Sandbox): void | Promise<void>;
  // (future) wrap?: DriverMiddleware — intercept commands/files calls.
}
```

`extend` is **synchronous** by design so `buildSandbox` stays sync (it's called from `create`, `connect`, **and** `fork` — sync keeps all three paths and forked children identical). Tool projection is pure mapping, so sync costs nothing. Anything async goes in `onCreate`.

### 1.5.2 Type inference — the plugin chooses the type of `sandbox.tools`

```ts
type PluginExt<P> = P extends SandboxPlugin<infer E> ? E : {};
type MergePlugins<Ps extends readonly SandboxPlugin[]> = UnionToIntersection<
  PluginExt<Ps[number]>
>;

export function createSandboxClient<
  Caps extends CapabilityMap,
  Raw,
  const Ps extends readonly SandboxPlugin[] = [], // `const` keeps the literal tuple
>(
  options: ClientOptions<Caps, Raw> & {
    provider: SandboxProvider<Caps, Raw>;
    plugins?: Ps;
  }
): SandboxClient<Caps, Raw, MergePlugins<Ps>>;
```

`client.create()` / `connect()` then return `Sandbox<Caps, Raw> & MergePlugins<Ps>`. With `plugins: [vercelAI()]`, `sandbox.tools` is `Record<string, AISDKTool>`; with no AI-provider plugin, `sandbox.tools` simply **doesn't exist on the type** (no runtime cost, no `any`).

> **One AI-provider per client — enforced.** An agent runs in exactly one framework (`sandbox.tools` is handed to one `generateText(...)` / `new Agent({tools})` call), so a single shape is semantically correct, not just simpler. AI-provider plugins carry `kind:"ai-provider"`; the client **throws** on a second one with a message pointing to the standalone fns. Need N shapes of the same tools (libraries, benchmarks)? Use `toOpenAITools(sandbox)` / `toAISDKTools(sandbox)` directly — the neutral registry is always reachable via `createSandboxTools(sandbox)`. Other plugin _kinds_ (middleware, lifecycle, mcp) stack freely.

### 1.5.3a Client-level framework, per-`create` policy

The **framework** never varies within an app, so the AI-provider plugin lives only on the client. The thing that _does_ vary per sandbox is **trust posture** — the defining use case of a sandbox SDK is running untrusted code, so the same app wants a permissive policy for a trusted internal box and a strict one for a box running user code. Therefore:

```ts
const client = createSandboxClient({
  provider: e2b(),
  plugins: [vercelAI({ policy: trustedDefaults })], // framework + DEFAULT policy
});

// untrusted workload — tighten approval for THIS sandbox only:
const box = await client.create(spec, {
  policy: { defaults: { mutating: "ask", destructive: "deny" } },
});
box.tools; // identical AI-SDK shape, stricter gating
```

`create(spec, overrides?)` gains an optional second arg that overrides **only** `policy` / `only` / `forbid` — never the framework. Tools resolve the effective policy at **execute-time** (create-override ?? plugin-default), so no extra plugin wiring is needed: just thread the override through the existing `base` → `buildSandbox` path onto the sandbox, and the tool closures read it live.

### 1.5.3 Core integration (3 tiny, surgical touch points)

| File                                                                      | Change                                                                                                                                                                           |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `internal/types.ts`                                                       | `Sandbox<Caps, Raw, Ext = {}>` gains a 3rd defaulted param (`& Ext`); `ClientOptions` gains `plugins?`; `SandboxClient` carries `Ext`. Default `{}` ⇒ 100 % backward-compatible. |
| `internal/sandbox.ts` (`buildSandbox`, after the object literal at ~L356) | `for (const p of base.plugins ?? []) Object.assign(sandbox, p.extend?.(sandbox));` then wrap `destroy` to run `onDestroy` hooks first. `base` gains `plugins`.                   |
| `internal/client.ts` (`create`/`connect`, L111/124)                       | thread `plugins` into `base`; after `buildSandbox(...)`, `for (const p of plugins) await p.onCreate?.(sb)`.                                                                      |

`extend` closes over the same `sandbox` object it is grafted onto — `commands`/`files`/etc. already exist when it runs, so the tools' `execute` can call them. No chicken-and-egg.

### 1.5.4 The AI-provider plugin (one per framework, from its own subpath)

Each framework subpath exports **both** the low-level projection fn _and_ a plugin factory wrapping it:

```ts
// sbox-sdk/ai-sdk
export function vercelAI(
  opts?: AiToolOptions
): SandboxPlugin<{ tools: Record<string, AISDKTool> }> {
  return {
    name: "sbox:ai-sdk",
    extend: (s) => ({ tools: toAISDKTools(s, opts) }),
  };
}
```

| Subpath              | Plugin factory        | `sandbox.tools` type                                            |
| -------------------- | --------------------- | --------------------------------------------------------------- |
| `sbox-sdk/ai-sdk`    | `vercelAI(opts?)`     | `Record<string, AISDKTool>`                                     |
| `sbox-sdk/mastra`    | `mastra(opts?)`       | `Record<string, MastraTool>`                                    |
| `sbox-sdk/openai`    | `openaiAgents(opts?)` | `Tool[]`                                                        |
| `sbox-sdk/anthropic` | `anthropic(opts?)`    | `{ tools: AnthropicTool[]; handle(b): … }` or beta `BetaTool[]` |
| `sbox-sdk/langchain` | `langchain(opts?)`    | `StructuredTool[]`                                              |

`opts` is `{ policy?: SandboxPolicy; only?: ToolName[]; … }` — the same options the standalone fn takes. The plugin is the _only_ thing the app imports per framework; everything else is shared.

### 1.5.5 Why this is the right shape

- **The shape follows the provider AND the framework.** `sandbox.tools` is capability-filtered (E2B vs Vercel expose different tools) _and_ framework-typed (AI SDK map vs OpenAI array) — both resolved automatically.
- **Swap-one-import survives.** Change `e2b()`→`vercel()` and `sandbox.tools` re-shapes to the new capability set with zero code change — the SDK's core promise, now extended to agent tooling.
- **Open ecosystem.** AI-provider is just the first plugin kind. `wrap` middleware (audit/redaction/metrics), an `mcp()` plugin (expose the sandbox over MCP via `onCreate`), and lifecycle plugins all reuse `SandboxPlugin` with no further core changes.

---

## 2. Per-framework adapters (each is a thin, verified projection)

Every adapter exports two things from its subpath: (a) the **standalone projection** `to<Framework>Tools(sandboxOrSpecs, opts?)` — accepts a live `Sandbox` _or_ a pre-built `ToolSpec[]`; and (b) the **plugin factory** (§1.5.4) that wraps it. Internally each just maps `ToolSpec → that framework's tool object`.

### 2.1 `sbox-sdk/ai-sdk` — Vercel AI SDK ✅ · peer `ai` (^5 || ^6)

**Implemented** in `src/ai-sdk/index.ts`: `toAISDKTools(source, opts)`, the `vercelAI()` plugin, and `toolApproval()`. 7 tests green; typechecked against `ai@5.0.206`.

```ts
import { tool } from "ai";
export function toAISDKTools(
  source: Sandbox | ToolSpec[],
  opts?
): Record<string, Tool> {
  // resolve specs (createSandboxTools(sandbox) or pre-built ToolSpec[])
  return Object.fromEntries(
    specs.map((spec) => [
      spec.name,
      tool({
        description: spec.description,
        inputSchema: spec.inputSchema, // zod is a StandardSchema -> native
        execute: async (input, options) => {
          // policy enforced here (see below)
          const denied = await gate(
            spec,
            input,
            { sandbox, signal: options.abortSignal },
            policy
          );
          return denied ?? (await spec.execute(input, ctx)).text;
        },
      }),
    ])
  );
}
```

- **Output:** a **map** keyed by tool name → drop straight into `generateText({ tools })`.
- ⚠️ **Reality check (verified, not from docs):** the `needsApproval` tool field shown in the AI SDK cookbook is **not in stable `ai@5.0.206`** (`@ai-sdk/provider-utils@3.0.27` has no such field — it's on `main`/v7). So the adapter enforces approval **inside `execute`**: `"deny"` returns a message the model reads; `"ask"` awaits `policy.onApprovalRequest` when configured (else proceeds — HITL is opt-in). This is portable across all `ai` versions.
- **v7 forward-compat:** `toolApproval(source, opts)` returns the call-site `{ [toolName]: (input) => 'user-approval' | undefined }` map for `generateText({ tools, toolApproval })` once v7 lands.
- Returns `result.text` to the model.

### 2.2 `sbox-sdk/mastra` — Mastra ✅ · peer `@mastra/core` (^1, **not** 0.10.x)

**Implemented** in `src/mastra/index.ts`: `toMastraTools(source, opts)` + the `mastra()` plugin. 4 tests green; typechecked against `@mastra/core@1.46.0`.

```ts
import { createTool, type Tool } from "@mastra/core/tools";
export function toMastraTools(
  source,
  opts?
): Record<string, ReturnType<typeof createTool>> {
  return Object.fromEntries(
    specs.map((spec) => [
      spec.name,
      createTool({
        id: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema as Tool["inputSchema"], // zod is a StandardSchema
        execute: async (inputData) => {
          // (inputData, context) — modern API
          const denied = await enforcePolicy(
            spec,
            inputData,
            { sandbox },
            policy
          );
          return denied ?? (await spec.execute(inputData, { sandbox })).text;
        },
      }),
    ])
  );
}
```

- **Output:** map for `new Agent({ tools })` / `new Mastra({ tools })`. `createTool(...).execute` is the raw function (the class just stores it), so it's directly unit-testable with no Mastra runtime.
- ⚠️ **Reality check (verified):** `@mastra/core@0.10.x` pulls **`ai@4` + requires `zod@3`** — a hard conflict with our `zod@4`/`ai@5`. **`@mastra/core@1.46.0`** declares peer `zod: "^3.25 || ^4"` and resolves against `ai@5`/`zod@4` cleanly. So the peer is pinned **`^1.0.0`**, not `^0.10`. (This also retires the zod-version open decision — see §7.) The old `{ context }`-wrapped input is gone; modern execute is `(inputData, context)`.
- **Approval:** shared `enforcePolicy` (deny short-circuits, ask→`onApprovalRequest`), consistent with every adapter. **Native `suspend()`/`resumeSchema` HITL is a planned enhancement** (needs a running agent to verify/test, so deferred from v1).
- **Note:** Mastra also accepts AI SDK tools directly, so `vercelAI()` output works in a Mastra agent too; the native adapter is preferred for Mastra-native registration.

### 2.3 `sbox-sdk/openai` — OpenAI Agents SDK ✅ · peer `@openai/agents` (>=0.12)

**Implemented** in `src/openai/index.ts`: `toOpenAITools(source, opts)` + the `openaiAgents()` plugin. 4 tests green; typechecked against `@openai/agents@0.12.0` (peer `zod ^4`).

```ts
import { tool, type Tool } from "@openai/agents";
export function toOpenAITools(source, opts?): Tool[] {
  return specs.map((spec) => tool({
    name: spec.name,
    description: spec.description,
    parameters: spec.inputSchema as never,            // zod passed directly; see below
    strict: true,
    needsApproval: async (_rc, input) => decide(spec, input, ctx, policy) === "ask",
    execute: async (input) =>
      decide(...) === "deny" ? denyMsg : (await spec.execute(input, ctx)).text,
  }));
}
```

- **Output:** an **array** for `new Agent({ tools })`.
- ✅ **Native HITL (verified present):** unlike the AI SDK, `@openai/agents@0.12` **does** have `needsApproval?: boolean | ToolApprovalFunction`. The adapter wires `"ask"` → `needsApproval` returning `true`, which raises a `tool_approval_requested` interruption on the `RunResult` (host resolves via `result.state.approve()/reject()` + re-run). `"deny"` is enforced inside `execute`.
- ✅ **Strict schema (verified by probe):** passing our zod `z.object` with `strict:true`, the SDK auto-converts optional fields to `anyOf:[T,null]` **and** lists them in `required` with `additionalProperties:false` — i.e. it produces an OpenAI-strict-valid schema for us. No manual `.nullable()` authoring needed.
- ⚠️ **Type cast:** the SDK's `ZodObjectLike` param type is modeled on zod 3 (wants `.passthrough()` etc.), so our erased zod-4 `z.ZodType` needs a one-line `as never` type-only cast. Runtime is unaffected (the `invoke` round-trip test passes).

### 2.4 `sbox-sdk/anthropic` — Anthropic SDK ✅ · peer `@anthropic-ai/sdk` (>=0.40, tested 0.69)

**Implemented** in `src/anthropic/index.ts`: `toAnthropicTools(source, opts)` + the `anthropic()` plugin. 4 tests green.

```ts
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
export function toAnthropicTools(source, opts?): BetaRunnableTool[] {
  return specs.map((spec) =>
    betaZodTool({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema, // zod passed directly — no cast
      run: async (args) => {
        const denied = await enforcePolicy(spec, args, { sandbox }, policy);
        return denied ?? (await spec.execute(args, { sandbox })).text;
      },
    })
  );
}
```

- ✅ **One array serves both paths (verified):** `BetaRunnableTool = BetaToolUnion & { run, parse }` — i.e. it IS a tool definition _plus_ a runner. So the single returned array works for the **auto-loop** (`anthropic.beta.messages.toolRunner({ tools })`) AND the **manual loop** (`anthropic.beta.messages.create({ tools })`, then `tool.run(tool.parse(block.input))`). No separate manual function needed; the two-flavor plan collapsed to one.
- **Schema:** `betaZodTool` takes our zod `inputSchema` natively (no `ZodObjectLike` friction, unlike OpenAI).
- **Approval:** no native HITL → shared `enforcePolicy` inside `run` (deny / ask→`onApprovalRequest`), returns a string Claude reads. (`ToolError` for `is_error` is an available refinement.)
- Subpath `anthropic`; reserved `/claude` can become an alias re-export later.

### 2.5 `sbox-sdk/langchain` — LangChain (TS) ✅ · peer `@langchain/core` (>=0.3, tested 0.3.80)

**Implemented** in `src/langchain/index.ts`: `toLangChainTools(source, opts)` + the `langchain()` plugin. 4 tests green.

```ts
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
export function toLangChainTools(source, opts?): StructuredToolInterface[] {
  return specs.map((spec) =>
    tool(
      async (input) => {
        const denied = await enforcePolicy(spec, input, { sandbox }, policy);
        return denied ?? (await spec.execute(input, { sandbox })).text;
      },
      {
        name: spec.name,
        description: spec.description,
        schema: spec.inputSchema,
      }
    )
  );
}
```

- **Output:** an array of `StructuredToolInterface` for any LangChain agent / LangGraph `ToolNode`. Invoke via `tool.invoke(args)`.
- ✅ **Schema (verified):** `@langchain/core@0.3.80` `tool()` has explicit **ZodObjectV4** overloads, so our zod `schema` is accepted with **no cast** (cleanest of the five).
- **Approval:** shared `enforcePolicy` inside the tool fn. Graph-native `interrupt()` HITL is a documented follow-up (kept out of v1 so the only peer is `@langchain/core`, no `@langchain/langgraph`).

### 2.5 `sbox-sdk/langchain` — LangChain (TS) · peer `@langchain/core`

```ts
import { tool } from "@langchain/core/tools";
export function toLangChainTools(s, opts?): StructuredTool[] {
  return specs.map(spec => tool(
    async (args, config) => {
      const decision = decide(spec, args, policy, ctx);
      if (decision === "ask") {
        if (opts?.hitl === "interrupt") return interrupt({ tool: spec.name, args }); // LangGraph
        if (!(await policy.onApprovalRequest?.(...))) return err(`Denied`).text;       // plain
      }
      return (await spec.execute(args, ctx)).text;
    },
    { name: spec.name, description: spec.description, schema: spec.inputSchema },
  ));
}
```

- **Output:** an **array** of `StructuredTool` for any LangChain agent / LangGraph `ToolNode`.
- **Approval:** `opts.hitl: "interrupt" | "callback"`. `interrupt()` integrates with LangGraph checkpoints; `callback` uses `policy.onApprovalRequest` for non-graph usage.
- Import from `@langchain/core/tools` (stable) — re-exported by `langchain`.

---

## 3. Approval — one policy, five native mechanisms

`SandboxPolicy` is authored once; each adapter translates a `Decision` into the host framework's idiom:

| Decision | AI SDK                    | OpenAI Agents                          | Mastra      | Anthropic                  | LangChain                 |
| -------- | ------------------------- | -------------------------------------- | ----------- | -------------------------- | ------------------------- |
| `allow`  | execute                   | execute                                | execute     | execute                    | execute                   |
| `ask`    | `needsApproval`→UI stream | `needsApproval`→RunResult interruption | `suspend()` | `onApprovalRequest()` gate | `interrupt()` or callback |
| `deny`   | tool omitted              | tool omitted                           | omitted     | omitted                    | omitted                   |

**Default posture:** `{ safe: "allow", mutating: "allow", destructive: "ask" }` — so `sbox_fs_remove`, `sbox_lifecycle:destroy/stop`, and `sbox_snapshot:restore/delete` prompt by default; reads/exec/writes run free. Override per-tool via `policy.rules`.

---

## 4. Packaging

New subpath exports in `package.json` (mirrors the existing adapter pattern; all framework deps optional):

```jsonc
"./agent-tools": { "types": "./dist/agent-tools/index.d.ts", "import": "./dist/agent-tools/index.js" },
"./ai-sdk":      { "types": "./dist/ai-sdk/index.d.ts",      "import": "./dist/ai-sdk/index.js" },
"./mastra":      { "types": "./dist/mastra/index.d.ts",      "import": "./dist/mastra/index.js" },
"./openai":      { "types": "./dist/openai/index.d.ts",      "import": "./dist/openai/index.js" },
"./anthropic":   { "types": "./dist/anthropic/index.d.ts",   "import": "./dist/anthropic/index.js" },
"./langchain":   { "types": "./dist/langchain/index.d.ts",   "import": "./dist/langchain/index.js" }
```

```jsonc
// peerDependencies (all optional via peerDependenciesMeta)
"ai": "*", "@mastra/core": "*", "@openai/agents": "*",
"@anthropic-ai/sdk": "*", "@langchain/core": "*",
// hard dep (the lingua franca):
// dependencies: { "zod": "^3.25 || ^4" }
```

`zod` is the one new **runtime dependency** of `agent-tools`. All five frameworks accept zod; Anthropic raw mode converts via `z.toJSONSchema`.

### File layout

```
src/
  agent-tools/   index.ts  types.ts  result.ts  schema.ts  policy.ts  registry.ts  agent-tools.test.ts
  ai-sdk/        index.ts  ai-sdk.test.ts
  mastra/        index.ts  mastra.test.ts
  openai/        index.ts  openai.test.ts
  anthropic/     index.ts  anthropic.test.ts
  langchain/     index.ts  langchain.test.ts
```

---

## 5. Build sequence

1. **Phase 0 — foundation ✅:** `agent-tools/{result,types,policy}.ts`. No framework deps. (Strict-mode/JSON-schema helpers deferred to the adapters that need them.)
2. **Phase 1 — registry ✅:** the 10 `ToolSpec` builders + `createSandboxTools` + capability gating. Tested against `memory()` — gated `sbox_run_code`/`sbox_set_egress` correctly absent.
3. **Phase 1.5 — plugin core ✅:** `internal/plugin.ts` (`SandboxPlugin`, `MergePlugins`) + the 3 touch points (§1.5.3). Backward-compatible (default `Ext = object`); existing suite stayed green. Inline test plugin proves `extend` shapes `sandbox.tools`, lifecycle hooks fire, and the dup-`ai-provider` guard throws.
4. **Phase 2 — adapters ✅ (all five):** ① `ai-sdk` ✅ ② `mastra` ✅ ③ `openai` ✅ ④ `anthropic` ✅ ⑤ `langchain` ✅. Each subpath ships the standalone `toXTools` **and** its plugin factory + tests; each peer dep installed as a devDependency for tests only. Shared `enforcePolicy` (in `agent-tools/policy.ts`) is reused by callback-HITL adapters; OpenAI uses its native `needsApproval`.
5. **Phase 3 — adapter-conformance suite:** a shared table-driven test asserting every adapter, for the same sandbox, emits one tool per resolved spec, names/descriptions match, schemas validate sample inputs, approval wiring fires, capability-gated tools are absent when unsupported, **and the plugin path yields the same toolset as the standalone fn**.
6. **Phase 4 — DX:** per-adapter README snippet (both the plugin and standalone usage) + a runnable example per framework. Wire the docs site.

(Out of scope here, queued behind: the MCP server projecting the same registry, Agent Skills `SKILL.md` files, and code-mode tool collapsing — all consume the _same_ `agent-tools` registry, which is exactly why we build it first.)

---

## 6. Decisions baked in (state, override if you disagree)

- **Plugin system is the headline DX**, layered over the standalone projection fns (both ship; neither is deprecated).
- **Plugins attach at the client** (`createSandboxClient({ plugins })`) — applies to every sandbox incl. forks. `extend` is sync; `onCreate`/`onDestroy` are async.
- **Framework = client-level; policy = client-default + per-`create` override.** `create(spec, { policy?, only?, forbid? })` retunes trust posture per sandbox without changing the framework.
- **One AI-provider plugin per client, `kind`-guarded** → one `sandbox.tools` shape; client throws on a second. Multi-shape ⇒ standalone `toXTools(sandbox)`; neutral registry via `createSandboxTools(sandbox)`.
- **`agent-tools` is a public subpath**, not internal — enables the future MCP server, custom frameworks, and direct registry use.
- **Default approval = destructive-asks**, everything else allows.
- **zod** as the schema lingua franca (peer/runtime `^3.25 || ^4`).
- **Anthropic ships both** `toolRunner` (auto) and manual `{tools, handle()}` paths.
- **`fork`/`ports.fetch`/raw stream handles are not tools** (non-serializable).

## 7. Genuinely open (worth your call before/after Phase 2)

- ~~**zod major version**~~ **RESOLVED & confirmed across all 5:** peer `^3.25 || ^4`; we install zod 4. All five frameworks resolve against zod 4 — `ai@5`, `@mastra/core@1.46`, `@openai/agents@0.12` (peer `zod ^4`), `@anthropic-ai/sdk@0.69`, `@langchain/core@0.3.80` (explicit ZodObjectV4 overloads). The only casualty was `@mastra/core@0.10.x` (zod 3 / ai 4) — avoided by pinning Mastra `^1`.
- **Streaming exec as a tool** — v1 buffers `commands.run`. Expose a streaming variant later or keep buffered-only?
- **`run_code` statefulness** — expose `contextId` as a tool arg (multi-call kernel state) in v1, or single-shot?
