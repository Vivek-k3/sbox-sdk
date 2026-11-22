# sbox-sdk ![status: alpha](https://img.shields.io/badge/status-alpha-orange)

**One unified SDK for agent sandbox providers.** Write your code against a stable
`Sandbox` / `SandboxClient` interface. Swap the adapter import to change provider,
and the rest of your code stays the same.

> Status: **alpha** (`0.x`). 20 provider adapters plus a built-in in-memory
> provider. Every adapter passes the shared conformance suite offline against a
> fake of its real SDK. `docker` also passes it live; the cloud adapters need
> live verification with real accounts (see `pnpm test:live`).

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
const sandbox = await client.create({
  template: "base",
  lifecycle: { idleTimeoutMs: 10 * 60_000, onIdle: "pause" },
});

// exec: await for a buffered result (never throws on non-zero exit):
const res = await sandbox.commands.run("echo hi", { cwd: "/tmp" });
console.log(res.exitCode, res.stdout);

// ...or for-await the SAME handle to stream live:
for await (const ev of sandbox.commands.run(["python", "train.py"])) {
  if (ev.type === "stdout") process.stdout.write(ev.data);
}

// filesystem (web-standard bodies in, StoredFile out):
await sandbox.files.write("/tmp/data.json", JSON.stringify({ ok: true }));
const text = await (await sandbox.files.read("/tmp/data.json")).text();

await sandbox.destroy();
await client.dispose();
```

Zero config? `createSandboxClient()` defaults to a built-in in-memory provider,
which is useful for tests and local dev:

```ts
const sb = await createSandboxClient().create();
await sb.commands.run("echo works offline");
```

## Build a template from a Dockerfile

Templates build **in your own provider account** and are cached by content hash,
so the second `create()` boots instantly instead of rebuilding:

```ts
const sandbox = await client.create({
  template: { source: { dockerfile, context: "./desktop" } },
  resources: { vcpus: 2, memoryMB: 4096, shmMB: 1024 },
  onTemplateEvent: (e) => console.log(e),
});
```

## Previews a browser can open

```ts
import { browserUrl } from "sbox-sdk";

const vnc = await sandbox.ports!.expose(6080, { visibility: "private" });
const ws = browserUrl(vnc, { protocol: "ws", path: "/websockify" });
```

`browserUrl` bakes in query-token or signed-URL auth, and throws when a provider
only supports header auth. Check `client.capabilities.flags.previewBrowserAuth`.

## Swap providers, keep your code

```ts
import { daytona } from "sbox-sdk/daytona";
const client = createSandboxClient({
  provider: daytona({ apiKey: process.env.DAYTONA_API_KEY! }),
});
// every sandbox.commands / sandbox.files call site above is unchanged
```

Each provider declares a static **capability table**. Sub-APIs a provider can't
do (`code`, `ports`, `snapshots`, `network`, `pty`, `ssh`, `templates`, `volumes`)
are typed `undefined` (a compile error to call), and unsupported features throw
`NotSupportedError` before any network call.

## Providers

| Provider       | Import                 | Peer SDK                          | Templates  | Browser-safe private previews |
| -------------- | ---------------------- | --------------------------------- | ---------- | ----------------------------- |
| Docker (local) | `sbox-sdk/docker`      | _none (Engine API)_               | ✅         | n/a (localhost)               |
| E2B            | `sbox-sdk/e2b`         | `@e2b/code-interpreter`           | ✅         | ❌ (header token)             |
| Daytona        | `sbox-sdk/daytona`     | `@daytona/sdk`                    | ✅         | ✅                            |
| Vercel         | `sbox-sdk/vercel`      | `@vercel/sandbox`                 | ❌         | ❌ (public only)              |
| Modal          | `sbox-sdk/modal`       | `modal`                           | ✅         | ✅                            |
| Tensorlake     | `sbox-sdk/tensorlake`  | _none_ (`tensorlake` for builds)  | ✅         | ❌ (header token)             |
| Superserve     | `sbox-sdk/superserve`  | `@superserve/sdk`                 | ✅         | ✅                            |
| Fly Sprites    | `sbox-sdk/sprites`     | `@fly/sprites`                    | ❌         | ❌                            |
| Freestyle      | `sbox-sdk/freestyle`   | `freestyle`                       | ✅         | ❌                            |
| Together       | `sbox-sdk/together`    | `together-sandbox`                | ✅         | n/a                           |
| Blaxel         | `sbox-sdk/blaxel`      | `@blaxel/core`                    | ✅         | ✅                            |
| Beam           | `sbox-sdk/beam`        | `@beamcloud/beam-js`              | ✅         | n/a                           |
| Railway        | `sbox-sdk/railway`     | `railway`                         | ❌         | n/a                           |
| Northflank     | `sbox-sdk/northflank`  | `@northflank/js-client`           | ✅ (image) | ❌                            |
| Fly Machines   | `sbox-sdk/fly`         | _none (REST)_                     | ❌         | n/a                           |
| AWS Lambda     | `sbox-sdk/aws-lambda`  | `@aws-sdk/client-lambda-microvms` | ✅         | ❌                            |
| Morph ⚠️       | `sbox-sdk/morph`       | `morphcloud`                      | ✅         | ❌                            |
| Cloudflare ⛔  | `sbox-sdk/cloudflare`  | `@cloudflare/sandbox` ~0.12       | ❌         | n/a                           |
| CodeSandbox ⛔ | `sbox-sdk/codesandbox` | `@codesandbox/sdk`                | ❌         | ❌                            |
| Runloop ⛔     | `sbox-sdk/runloop`     | `@runloop/api-client`             | ❌         | n/a                           |

⚠️ maintenance-only (unmaintained upstream TS SDK) · ⛔ deprecated, removed in 0.2.
Full capability matrix: [sbox-sdk.vercel.app/general/capabilities](https://sbox-sdk.vercel.app/general/capabilities).

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

The package ships a `sbox` bin. Credentials come from the environment
(`E2B_API_KEY`, `DAYTONA_API_KEY`, …); `caps` and `doctor` run fully offline:

```bash
npx sbox caps daytona                        # print a provider's capability matrix
npx sbox doctor e2b                          # check node + the provider SDK
npx sbox verify e2b                          # check credentials without creating anything
npx sbox exec docker -- uname -a             # run one command in a fresh sandbox
npx sbox list e2b                            # list live sandboxes
npx sbox templates build daytona ./desktop   # build ./desktop/Dockerfile as a template
```

## License

[MIT](./LICENSE) © Vivek Kornepalli
