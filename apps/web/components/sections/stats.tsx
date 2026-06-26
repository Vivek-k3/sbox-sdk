import { CAPABILITY_KEYS, PROVIDERS } from "@/lib/capabilities";

const STATS = [
  { label: "providers, one API", value: `${PROVIDERS.length}` },
  { label: "capabilities, typed", value: `${CAPABILITY_KEYS.length}` },
  { label: "line to swap", value: "1" },
  { label: "open source", value: "MIT" },
];

export const Stats = () => (
  <section className="border-t border-border">
    <div className="mx-auto grid max-w-6xl grid-cols-2 gap-px overflow-hidden border-x border-border bg-border sm:grid-cols-4">
      {STATS.map((stat) => (
        <div className="bg-background px-6 py-12 text-center" key={stat.label}>
          <p className="font-display text-5xl font-semibold tracking-tight text-foreground sm:text-6xl">
            {stat.value}
          </p>
          <p className="mt-2 font-data text-[10px] tracking-[0.16em] text-dim uppercase">
            {stat.label}
          </p>
        </div>
      ))}
    </div>
  </section>
);
