# sbox-sdk

One unified SDK for agent **sandbox** providers (E2B, Vercel Sandbox, Cloudflare Sandbox, and more). Write your code once; swap the adapter import to change provider — the rest of your code stays the same.

> Status: **alpha**. Tier-1 adapter shipping first is **E2B**; the in-memory provider is built in for tests/dev. Cloudflare and Vercel adapters are next.

## Install

```bash
npm install sbox-sdk
# then install the provider SDK you use (optional peer dependency):
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

Zero config? `createSandboxClient()` defaults to an in-memory provider — great for tests:

```ts
import { createSandboxClient } from "sbox-sdk";
const sb = await createSandboxClient().create();
await sb.commands.run("echo works offline");
```

## Swap providers, keep your code

```ts
import { vercel } from "sbox-sdk/vercel"; // when available
const client = createSandboxClient({
  provider: vercel({ token, teamId, projectId }),
});
// every sandbox.commands / sandbox.files call site above is unchanged
```

## Capability gating

Each provider declares a static capability table. Sub-APIs that a provider doesn't support are typed `undefined` — calling them is a **compile error**, and unsupported features throw `NotSupportedError` at runtime _before_ any network call.

```ts
// `sandbox.code` only exists on providers with a code interpreter (e.g. E2B):
if (sandbox.code) {
  const exec = await sandbox.code.runCode(
    "import matplotlib.pyplot as plt; plt.plot([1,2,3])"
  );
  for (const r of exec.results)
    if (r.mime["image/png"]) save(r.mime["image/png"]);
}

// runtime tri-state level (native | emulated | unsupported):
console.log(sandbox.capabilities.map.snapshot);

// dynamic providers: `can()` narrows at runtime + type level:
if (sandbox.can("snapshot")) await sandbox.snapshots.create({ name: "ckpt" });
```

## Errors

All providers normalize to one `SandboxError` taxonomy (`code`, `provider`, `retryable`, …). Key rules:

- `commands.run(...)` **never throws on a non-zero exit** — the exit code is data (`result.exitCode`).
- `files.exists()` returns `false` only on NotFound; auth/timeout errors throw.
- `NotSupportedError` is thrown synchronously, before any network call.

## Writing an adapter

Implement the `SandboxProvider` contract from `sbox-sdk/adapter` and run it through the shared conformance suite:

```ts
import { runConformance } from "sbox-sdk/conformance";
const report = await runConformance(myProvider());
expect(report.passed).toBe(true);
```

## License

MIT
