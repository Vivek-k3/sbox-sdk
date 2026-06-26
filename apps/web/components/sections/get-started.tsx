import Link from "next/link";

const SNIPPET = `import { createSandboxClient } from "sbox-sdk";
import { e2b } from "sbox-sdk/e2b";

const client = createSandboxClient({
  provider: e2b({ apiKey: process.env.E2B_API_KEY! }),
});

const sandbox = await client.create({ template: "python-3.12" });

// exec — buffered (never throws on a non-zero exit):
const res = await sandbox.commands.run("echo hi", { cwd: "/app" });
console.log(res.exitCode, res.stdout);

// ...or for-await the SAME handle to stream live:
for await (const ev of sandbox.commands.run(["python", "train.py"])) {
  if (ev.type === "stdout") process.stdout.write(ev.data);
}

// filesystem — web-standard bodies in, StoredFile out:
await sandbox.files.write("/app/data.json", JSON.stringify({ ok: true }));
const text = await (await sandbox.files.read("/app/data.json")).text();

await sandbox.destroy();`;

export const GetStarted = () => (
  <section>
    <div className="mx-auto max-w-6xl px-6 py-24">
      <p className="font-mono text-xs text-muted-foreground">Get started</p>
      <h2 className="mt-3 max-w-[28ch] text-4xl font-medium tracking-tight text-balance text-foreground sm:text-5xl">
        The exact same code. Any provider.
      </h2>
      <p className="mt-5 max-w-[60ch] text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
        Swap the adapter import to change provider — every{" "}
        <code className="font-mono text-sm">commands</code> and{" "}
        <code className="font-mono text-sm">files</code> call site stays
        identical.
      </p>
      <div className="mt-10 overflow-hidden rounded-xl border border-border bg-card">
        <pre className="overflow-x-auto p-6 font-mono text-[13px] leading-relaxed text-foreground">
          <code>{SNIPPET}</code>
        </pre>
      </div>
      <div className="mt-8 flex flex-wrap gap-4 font-mono text-sm">
        <Link
          href="/general/installation"
          className="text-foreground underline-offset-4 hover:underline"
        >
          Installation →
        </Link>
        <Link
          href="/api/client"
          className="text-foreground underline-offset-4 hover:underline"
        >
          API reference →
        </Link>
        <Link
          href="/general/capabilities"
          className="text-foreground underline-offset-4 hover:underline"
        >
          Capabilities →
        </Link>
      </div>
    </div>
  </section>
);
