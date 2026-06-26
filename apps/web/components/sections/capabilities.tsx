import { FileText, Network, Camera, TerminalSquare } from "lucide-react";

const FEATURES = [
  {
    body: "E2B-aligned namespaces — sandbox.commands, .files, .code, .ports, .snapshots, .network. Learn one shape, use it everywhere.",
    icon: TerminalSquare,
    title: "Namespaced sub-APIs",
  },
  {
    body: "The exit code is data, not an exception. await for a buffered result, or for-await the same handle to stream output live.",
    icon: FileText,
    title: "exec never throws on non-zero exit",
  },
  {
    body: "Each provider declares a static capability table. Unsupported sub-APIs are typed undefined — a compile error — and throw before any network call.",
    icon: Network,
    title: "Capability gating",
  },
  {
    body: "Every provider normalizes to one SandboxError taxonomy. Need a provider-only feature? raw() drops you to the native client, fully typed.",
    icon: Camera,
    title: "One error taxonomy + escape hatch",
  },
];

export const Capabilities = () => (
  <section>
    <div className="mx-auto max-w-6xl px-6 py-24">
      <p className="font-mono text-xs text-muted-foreground">Why sbox SDK</p>
      <h2 className="mt-3 max-w-[26ch] text-4xl font-medium tracking-tight text-balance text-foreground sm:text-5xl">
        One surface. Every sandbox. No lock-in.
      </h2>
      <div className="mt-14 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
        {FEATURES.map(({ icon: Icon, title, body }) => (
          <div key={title} className="bg-background p-8">
            <Icon className="size-5 text-foreground" />
            <h3 className="mt-4 text-lg font-medium tracking-tight text-foreground">
              {title}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {body}
            </p>
          </div>
        ))}
      </div>
    </div>
  </section>
);
