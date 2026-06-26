import { PROVIDERS } from "@/lib/capabilities";

const NAMES = PROVIDERS.map((p) => p.name);

export const ProviderMarquee = () => (
  <section className="border-t border-border py-10">
    <p className="text-center font-data text-[10px] tracking-[0.22em] text-dim uppercase">
      Runs on the sandboxes you already use
    </p>
    <div className="mt-6 overflow-x-clip [mask-image:linear-gradient(to_right,transparent,#000_12%,#000_88%,transparent)]">
      <div className="marquee-track flex w-max animate-[marquee_28s_linear_infinite] items-center gap-4">
        {[...NAMES, ...NAMES].map((name, i) => (
          <span
            className="shrink-0 rounded-full border border-border bg-card px-5 py-2 font-mono text-sm text-muted-foreground"
            key={`${name}-${i}`}
          >
            {name}
          </span>
        ))}
      </div>
    </div>
  </section>
);
