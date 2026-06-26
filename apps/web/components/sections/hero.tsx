"use client";

import { ArrowRight } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";

import { InstallCommand } from "@/components/install-command";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const EASE = [0.16, 1, 0.3, 1] as const;

const PROVIDERS = [
  "E2B",
  "Vercel Sandbox",
  "Cloudflare",
  "In-Memory",
  "Daytona",
  "Modal",
  "Fly",
  "Runloop",
];

interface HeroProps {
  adapterCount: number;
  latestVersion: string;
}

export const Hero = ({ adapterCount, latestVersion }: HeroProps) => (
  <section className="relative overflow-hidden">
    <div className="mx-auto flex max-w-5xl flex-col items-center px-6 pt-24 pb-16 text-center sm:pt-32 lg:pt-40">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, ease: EASE }}
      >
        <span className="inline-flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <span className="inline-block size-1.5 rounded-full bg-emerald-500" />
          v{latestVersion} · alpha
        </span>
      </motion.div>

      <motion.h1
        className="mt-8 max-w-[20ch] text-[2.5rem]/[1.05] font-medium tracking-tight text-balance text-foreground sm:text-7xl lg:text-8xl"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08, duration: 0.7, ease: EASE }}
      >
        Write once. Run in any sandbox.
      </motion.h1>

      <motion.p
        className="mt-7 max-w-[60ch] text-base leading-relaxed text-pretty text-muted-foreground sm:text-xl"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.18, duration: 0.6, ease: EASE }}
      >
        One unified SDK for agent sandbox providers — E2B, Vercel, Cloudflare,
        Daytona, Modal, Fly, AWS Lambda and more. The same{" "}
        <code className="font-mono text-sm text-foreground">commands</code>,{" "}
        <code className="font-mono text-sm text-foreground">files</code> and{" "}
        <code className="font-mono text-sm text-foreground">code</code> calls,
        whichever provider you swap in.
      </motion.p>

      <motion.div
        className="mt-10 flex flex-wrap items-center justify-center gap-3"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.26, duration: 0.6, ease: EASE }}
      >
        <InstallCommand />
        <Link
          href="/general/overview"
          className={cn(buttonVariants({ size: "lg", variant: "ghost" }))}
        >
          Read the docs
          <ArrowRight className="size-4" />
        </Link>
      </motion.div>
    </div>

    <motion.div
      className="relative mx-auto max-w-6xl px-6 pb-24"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.4, duration: 0.7, ease: EASE }}
    >
      <div className="overflow-x-clip py-2 [mask-image:linear-gradient(to_right,transparent,#000_10%,#000_90%,transparent)]">
        <div className="flex w-max animate-[marquee_30s_linear_infinite] items-center gap-4">
          {[...PROVIDERS, ...PROVIDERS].map((name, i) => (
            <span
              key={`${name}-${i}`}
              className="shrink-0 rounded-full border border-border bg-card px-4 py-1.5 font-mono text-sm text-muted-foreground"
            >
              {name}
            </span>
          ))}
        </div>
      </div>
      <p className="mt-8 text-center font-mono text-xs text-muted-foreground">
        {adapterCount} adapters shipping ·{" "}
        <Link
          href="/adapters/memory"
          className="text-foreground underline-offset-4 hover:underline"
        >
          see every adapter →
        </Link>
      </p>
    </motion.div>
  </section>
);
