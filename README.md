# sbox-sdk

**One unified SDK for agent sandbox providers.** Write your code against a stable
`Sandbox` / `SandboxClient` interface — swap the adapter import to change
provider, and the rest of your code stays the same.

> Status: **alpha** (`0.0.x`). The core, the in-memory provider, and 14 provider
> adapters ship today. E2B is the most battle-tested; newer adapters pass the
> shared conformance suite offline but are less proven against live APIs.

📚 **Docs:** [sbox-sdk.vercel.app](https://sbox-sdk.vercel.app)

## Install

```bash
npm install sbox-sdk
# then install the provider SDK you use (an optional peer dependency):
npm install @e2b/code-interpreter
```

## Quickstart

```ts
import { createSandboxClient } from "sbox-sdk";
import { e2b } from "sbox-sdk/e2b";

const client = createSandboxClient({
  provider: e2b({ apiKey: process.env.E2B_API_KEY! }),
});
const sandbox = await client.create({ template: "python-3.12", ttlMs: 60_000 });

// exec — await for a buffered result (never throws on non-zero exit):
const res = await sandbox.commands.run("echo hi", { cwd: "/app" });
console.log(res.exitCode, res.stdout);

// ...or for-await the SAME handle to stream live:
for await (const ev of sandbox.commands.run(["python", "train.py"])) {
  if (ev.type === "stdout") process.stdout.write(ev.data);
}

// filesystem (web-standard bodies in, StoredFile out):
await sandbox.files.write("/app/data.json", JSON.stringify({ ok: true }));
const text = await (await sandbox.files.read("/app/data.json")).text();

await sandbox.destroy();
await client.dispose();
```

Zero config? `createSandboxClient()` defaults to a built-in in-memory provider —
great for tests and local dev:

```ts
const sb = await createSandboxClient().create();
await sb.commands.run("echo works offline");
```

## Swap providers, keep your code

```ts
import { vercel } from "sbox-sdk/vercel";
const client = createSandboxClient({
  provider: vercel({ token, teamId, projectId }),
});
// every sandbox.commands / sandbox.files call site above is unchanged
```

Each provider declares a static **capability table**. Sub-APIs a provider can't
do are typed `undefined` (a compile error to call), and unsupported features
throw `NotSupportedError` before any network call.

## Providers

| Provider    | Import                 | Peer SDK                          |
| ----------- | ---------------------- | --------------------------------- |
| E2B         | `sbox-sdk/e2b`         | `@e2b/code-interpreter`           |
| Vercel      | `sbox-sdk/vercel`      | `@vercel/sandbox`                 |
| Cloudflare  | `sbox-sdk/cloudflare`  | `@cloudflare/sandbox`             |
| Daytona     | `sbox-sdk/daytona`     | `@daytonaio/sdk`                  |
| Modal       | `sbox-sdk/modal`       | `modal`                           |
| Fly         | `sbox-sdk/fly`         | _none (REST)_                     |
| AWS Lambda  | `sbox-sdk/aws-lambda`  | `@aws-sdk/client-lambda-microvms` |
| Northflank  | `sbox-sdk/northflank`  | `@northflank/js-client`           |
| Runloop     | `sbox-sdk/runloop`     | `@runloop/api-client`             |
| CodeSandbox | `sbox-sdk/codesandbox` | `@codesandbox/sdk`                |
| Morph       | `sbox-sdk/morph`       | `morphcloud`                      |
| Blaxel      | `sbox-sdk/blaxel`      | `@blaxel/core`                    |
| Beam        | `sbox-sdk/beam`        | `@beamcloud/beam-js`              |
| Railway     | `sbox-sdk/railway`     | `railway`                         |

The in-memory provider (`sbox-sdk/memory`, also the zero-config default) needs no peer.

## AI agent tools

Turn any sandbox into a framework-shaped tool set with a risk/approval policy:

```ts
import { ai } from "sbox-sdk/ai";
import { aiSdk } from "sbox-sdk/ai-sdk";

const client = createSandboxClient({
  provider: e2b(),
  plugins: [
    ai({ framework: aiSdk(), policy: { defaults: { destructive: "ask" } } }),
  ],
});
const sandbox = await client.create();
// sandbox.tools is typed for the Vercel AI SDK, capability-gated + policy-aware
```

Adapters ship for the Vercel AI SDK, Mastra, OpenAI Agents, Anthropic, and
LangChain. See the [AI docs](https://sbox-sdk.vercel.app/ai/overview).

## CLI

The package ships a `sbox` bin. `caps` and `doctor` run fully offline:

```bash
npx sbox caps e2b              # print a provider's capability matrix
npx sbox doctor e2b           # check node + whether the provider SDK is installed
npx sbox exec e2b -- echo hi  # run one command in a fresh sandbox
npx sbox list e2b             # list live sandboxes
```

## Monorepo layout

This is a pnpm + Turborepo monorepo (Node >= 20):

- `packages/sbox-sdk` — the SDK itself (core router, adapters, agent-tools, AI layer, CLI).
- `packages/config` — shared `tsconfig.base.json`.
- `apps/web` — the docs + marketing site ([sbox-sdk.vercel.app](https://sbox-sdk.vercel.app)).

## Development

```bash
pnpm install
pnpm build        # turbo build
pnpm test         # turbo test (SDK unit tests run fully offline)
pnpm types        # typecheck (tsgo)
pnpm check        # lint + format (ultracite = oxlint + oxfmt)
pnpm fix          # auto-fix lint + format
```

Releases are automated: every merge to `main` publishes the next patch of
`sbox-sdk` to npm. Put `#minor` or `#major` in the merge commit / PR title to
bump those instead.

## License

[MIT](./LICENSE) © Vivek Kornepalli
