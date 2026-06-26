import { Boxes, Layers, Sparkles } from "lucide-react";

import { TiltCard } from "@/components/sections/tilt-card";

const PROPS = [
  {
    body: "Swap providers with a one-line import change. The agent code you wrote on E2B runs untouched on Vercel, Modal, or Fly.",
    icon: Boxes,
    title: "No lock-in, ever",
  },
  {
    body: "Run commands, manage files, stream output, expose ports — the same way, everywhere. Learn it once, use it on any provider.",
    icon: Layers,
    title: "One API, every sandbox",
  },
  {
    body: "Turn any sandbox into typed tools your LLM can call, shaped for your framework, with an approval policy you control.",
    icon: Sparkles,
    title: "Built for agents",
  },
];

export const ValueProps = () => (
  <section className="border-t border-border">
    <div className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
      <p className="text-center font-data text-[10px] tracking-[0.22em] text-dim uppercase">
        Why sbox
      </p>
      <h2 className="mx-auto mt-3 max-w-[18ch] text-center font-display text-3xl leading-tight font-semibold tracking-tight text-balance text-foreground sm:text-5xl">
        The freedom to run anywhere.
      </h2>

      <div className="mt-14 grid gap-5 [perspective:1400px] md:grid-cols-3">
        {PROPS.map(({ icon: Icon, title, body }) => (
          <TiltCard
            className="group relative overflow-hidden rounded-2xl border border-border bg-card p-8"
            key={title}
          >
            <span className="inline-flex size-11 items-center justify-center rounded-xl border border-native/25 bg-native/10 text-native">
              <Icon className="size-5" />
            </span>
            <h3 className="mt-6 font-display text-xl font-semibold tracking-tight text-foreground">
              {title}
            </h3>
            <p className="mt-2.5 text-pretty text-muted-foreground">{body}</p>
          </TiltCard>
        ))}
      </div>
    </div>
  </section>
);
