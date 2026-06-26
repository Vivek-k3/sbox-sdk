import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { InstallToggle } from "@/components/install-toggle";
import { SwapLine } from "@/components/sections/swap-line";
import { ThreeBody } from "@/components/sections/three-body";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const Hero = ({ latestVersion }: { latestVersion: string }) => (
  <section className="relative overflow-hidden">
    <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 pt-16 pb-20 sm:pt-24 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] lg:gap-8 lg:pt-28 lg:pb-28">
      <div className="text-center lg:text-left">
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 font-data text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
          <span className="size-1.5 animate-pulse rounded-full bg-native" />v
          {latestVersion} · open source
        </span>

        <h1 className="mx-auto mt-6 max-w-[15ch] font-display text-[2.75rem] leading-[1.02] font-semibold tracking-tight text-balance text-foreground lg:mx-0 lg:text-7xl">
          Write once. Run in{" "}
          <span className="brand-gradient">any sandbox.</span>
        </h1>

        <p className="mx-auto mt-6 max-w-[52ch] text-pretty text-muted-foreground lg:mx-0 lg:text-lg">
          sbox is the unified TypeScript SDK for every code sandbox. Point your
          agents at E2B, Vercel, Modal, or Cloudflare — and switch between them
          without rewriting a thing.
        </p>

        <div className="mt-9 flex flex-col items-center gap-5 lg:items-start">
          <InstallToggle className="items-center lg:items-start" />
          <Link
            className={cn(buttonVariants({ size: "lg", variant: "ghost" }))}
            href="/general/overview"
          >
            Read the docs
            <ArrowRight className="size-4" />
          </Link>
        </div>

        <div className="mt-8 flex justify-center lg:justify-start">
          <SwapLine />
        </div>
      </div>

      <div className="flex justify-center lg:justify-end">
        <ThreeBody />
      </div>
    </div>
  </section>
);
