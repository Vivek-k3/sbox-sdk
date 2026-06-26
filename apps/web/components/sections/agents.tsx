import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const FRAMEWORKS = [
  "Vercel AI SDK",
  "Mastra",
  "OpenAI Agents",
  "Anthropic",
  "LangChain",
];

export const Agents = () => (
  <section className="border-t border-border">
    <div className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
      <div className="mx-auto max-w-3xl text-center">
        <p className="font-data text-[10px] tracking-[0.22em] text-dim uppercase">
          For AI agents
        </p>
        <h2 className="mt-3 font-display text-3xl leading-tight font-semibold tracking-tight text-balance text-foreground sm:text-5xl">
          Give your agent <span className="brand-gradient">a computer.</span>
        </h2>
        <p className="mx-auto mt-5 max-w-[54ch] text-pretty text-muted-foreground sm:text-lg">
          sbox turns any sandbox into tools your model can call — run code, read
          and write files, expose ports — typed for your framework and gated by
          a policy you control.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5">
          {FRAMEWORKS.map((name) => (
            <span
              className="rounded-full border border-border bg-card px-4 py-1.5 font-mono text-sm text-muted-foreground"
              key={name}
            >
              {name}
            </span>
          ))}
        </div>

        <Link
          className={cn(
            buttonVariants({ size: "lg", variant: "ghost" }),
            "mt-8"
          )}
          href="/ai/overview"
        >
          Explore the agent layer
          <ArrowRight className="size-4" />
        </Link>
      </div>
    </div>
  </section>
);
