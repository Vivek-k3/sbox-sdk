---
name: sbox-sdk
description: >-
  Set up and use sbox-sdk, the unified TypeScript SDK for agent sandboxes (E2B,
  Daytona, Vercel, Modal, Tensorlake, Superserve, Fly Sprites, Freestyle,
  Together, Blaxel, Beam, Railway, Northflank, Fly, AWS Lambda MicroVMs, local
  Docker, and a built-in in-memory provider). Covers installing the SDK plus an
  adapter, creating a sandbox client, running shell commands, reading/writing
  files, executing code, building templates from a Dockerfile, exposing ports
  (incl. browser-safe private previews), PTY terminals, pause/resume, and giving an AI agent
  framework (Vercel AI SDK, OpenAI Agents, Mastra, Anthropic, LangChain) sandbox
  tools via the ai() plugin. Use when adding a code sandbox to a project, running
  untrusted or model-generated code in isolation, or letting an LLM agent run
  commands/files/code safely.
metadata:
  homepage: https://sbox-sdk.vercel.app
  repository: https://github.com/vivek-k3/sbox-sdk
---

# sbox-sdk

`sbox-sdk` is one TypeScript API over many sandbox providers. You pick a provider
by importing its adapter; the rest of your code stays identical when you swap
providers. The core is fetch-only and runs on Node 20+, Bun, Deno, and edge/Workers.

## When to use this

- Adding an ephemeral code **sandbox** to run untrusted or model-generated code.
- Giving an AI agent tools to run commands, read/write files, or execute code.
- Supporting (or switching between) multiple sandbox providers behind one API.

## Setup

1. Install the SDK and the optional **peer dependency** for the adapter you want.
   E2B is the reference adapter (richest features):

   ```bash
   npm install sbox-sdk @e2b/code-interpreter
   ```

   Other adapters and their peers: Daytona → `@daytona/sdk`, Vercel →
   `@vercel/sandbox`, Modal → `modal`, Superserve → `@superserve/sdk`, Fly Sprites →
   `@fly/sprites`, Freestyle → `freestyle`, Together → `together-sandbox`, Blaxel →
   `@blaxel/core`, Beam → `@beamcloud/beam-js`, Railway → `railway`. **No peer
   needed:** `sbox-sdk/docker` (local Docker/OrbStack/Podman), `sbox-sdk/tensorlake`
   (REST; `tensorlake` only for template builds), `sbox-sdk/fly`, and the
   **in-memory** provider (`sbox-sdk/memory`), which is the zero-config default
   for tests. Deprecated: `cloudflare`, `codesandbox` (use `together`), `runloop`.

2. Create a client and a sandbox. Each adapter is a subpath import:

   ```ts
   import { createSandboxClient } from "sbox-sdk";
   import { e2b } from "sbox-sdk/e2b";

   const client = createSandboxClient({
     provider: e2b({ apiKey: process.env.E2B_API_KEY! }),
   });

   const sandbox = await client.create({
     template: "node",
     lifecycle: { maxAgeMs: 60_000 },
   });
   ```

## Core API

- **Commands** — `sandbox.commands.run(cmd, opts?)` returns an `ExecHandle` that is
  BOTH awaitable (buffered `{ stdout, stderr, exitCode }`) AND async-iterable
  (live output events). It **never throws on a non-zero exit** — the exit code is
  data; it only rejects on transport/provider failures (normalized to `SandboxError`).

  ```ts
  const res = await sandbox.commands.run("node -v");
  console.log(res.stdout, res.exitCode);
  ```

- **Files** — `sandbox.files.{read,write,list,mkdir,remove,rename,stat,exists,upload,download,watch}`.
  `read()` returns a `StoredFile` with `.text()`, `.bytes()`, `.stream()`.

  ```ts
  await sandbox.files.write("/app/index.js", "console.log('hi')");
  const file = await sandbox.files.read("/app/index.js");
  console.log(await file.text());
  ```

- **Capability-gated namespaces** are typed `undefined` when the provider can't do
  them — guard with `?.` or `sandbox.can(capability)`:
  - `sandbox.code?.runCode(code, { language })` — stateful interpreter (e.g. E2B).
  - `sandbox.ports?.expose(port)` — returns a public preview `{ url }`.
  - `sandbox.snapshots?.{create,restore,list,delete}`.
  - `sandbox.network?.setEgressPolicy(policy)`.

  - `sandbox.pty?.create({ cols, rows })`: interactive terminal (async-iterable bytes, `write`, `resize`).
  - `sandbox.ssh?.create()`, `client.templates?`, `client.volumes?`.

- **Templates**: `client.templates?.build({ source: { dockerfile, context } })`, or pass
  the spec inline as `create({ template: { source: {...} } })`. Builds run in the
  user's own account and are cached by content hash, so a second create doesn't rebuild.
  Check `client.capabilities.flags.templateSources`.

- **Previews**: `ports.expose(port, { visibility: "private" })` returns `{ url, wsUrl, auth }`.
  `browserUrl(preview, { protocol: "ws" })` (from `sbox-sdk`) gives a URL a browser
  WebSocket can open; it throws for header-only auth. Check `flags.previewBrowserAuth`.

- **Lifecycle** lives on the sandbox: `getInfo()` (live state), `setTimeout(ttlMs)`, `pause()`,
  `resume()`, `stop()`, `destroy()`, `fork()`, `metrics()`. Set `create({ lifecycle:
{ idleTimeoutMs, maxAgeMs, onIdle, autoResume } })`. Reconnect after a restart with
  `client.connect(id, { resume: true })`, or use `client.getOrCreate({ name })`.
  `client.verify()` checks credentials without creating anything.

- **Escape hatch** — `sandbox.raw()` is the native provider client, typed per adapter.

## Rules and gotchas

- **Never assume a capability exists.** `sandbox.code` / `ports` / `snapshots` /
  `network` / `pty` / `ssh` and `client.templates` / `volumes` are `undefined` on
  providers that don't support them. Use `?.` or
  `if (sandbox.can("codeInterpreter")) { ... }`.
- **`commands.run` does not throw on non-zero exit** — check `exitCode`. Wrap only
  for `SandboxError` (transport/quota/timeout), which carries a `retryable` flag.
- **Install the adapter's peer dep**, or the lazy import throws
  `ERR_MODULE_NOT_FOUND` naming the missing package.
- **Always bound a sandbox's life** with `lifecycle` (on `create`) or `setTimeout`, and
  call `destroy()` (or `stop`/`pause`) when done, so sandboxes don't leak.
- Provider-specific features outside the unified surface live behind `sandbox.raw()`.

## Giving an AI agent sandbox tools

Use the `ai()` plugin to expose the sandbox as tools shaped for your agent
framework. Install the framework's peer dependency (e.g. `ai` for the Vercel AI
SDK), then pass the matching framework adapter:

```ts
import { createSandboxClient } from "sbox-sdk";
import { e2b } from "sbox-sdk/e2b";
import { ai } from "sbox-sdk/ai";
import { aiSdk } from "sbox-sdk/ai-sdk"; // or mastra(), openaiAgents(), anthropic(), langchain()
import { generateText } from "ai";

const client = createSandboxClient({
  provider: e2b({ apiKey: process.env.E2B_API_KEY! }),
  plugins: [ai({ framework: aiSdk() })],
});

const sandbox = await client.create({ template: "node" });

// `sandbox.tools` is shaped for the framework and capability-gated to the provider.
await generateText({ model, prompt, tools: sandbox.tools });
```

- Framework adapters: `aiSdk()` (Vercel AI SDK), `mastra()`, `openaiAgents()`,
  `anthropic()` (Claude), `langchain()` — imported from `sbox-sdk/<framework>`.
- One AI framework per client; the client throws if you pass two.
- Gate dangerous tools with a policy: `ai({ framework, policy: { defaults: { destructive: "ask" }, onApprovalRequest } })`.
  Destructive operations (delete, destroy) ask for approval by default.

## Reference documentation

The docs are at <https://sbox-sdk.vercel.app> and are available as plain markdown for LLMs:

- **Index for LLMs:** <https://sbox-sdk.vercel.app/llms.txt>
- **Any page as markdown:** append the path to `/llms.mdx`, e.g.
  <https://sbox-sdk.vercel.app/llms.mdx/general/usage>
- Key pages: `/general/usage`, `/general/capabilities`, `/api/sandbox`,
  `/adapters/e2b`, `/ai/overview`.

When you need exact signatures or provider capability tables, fetch the relevant
`/llms.mdx/...` page rather than guessing.
