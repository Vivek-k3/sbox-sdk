"use client";

import { ArrowRight } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { ThreeBody } from "@/components/sections/three-body";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const KONAMI = [
  "arrowup",
  "arrowup",
  "arrowdown",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "arrowleft",
  "arrowright",
  "b",
  "a",
];

const frac = (x: number) => x - Math.floor(x);
const STARS = Array.from({ length: 22 }, (_, i) => ({
  delay: frac(Math.sin(i * 3.7)) * 4,
  id: `s${i}`,
  size: 1 + Math.round(frac(Math.sin(i * 5.1)) * 1.5),
  x: frac(Math.sin(i * 12.9 + 1)) * 100,
  y: frac(Math.sin(i * 78.2 + 2)) * 100,
}));

export const NotFoundView = () => {
  const path = usePathname();
  const reduce = useReducedMotion();
  const [egg, setEgg] = useState(false);
  const seq = useRef<string[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      seq.current = [...seq.current, e.key.toLowerCase()].slice(-KONAMI.length);
      if (
        seq.current.length === KONAMI.length &&
        KONAMI.every((k, i) => k === seq.current[i])
      ) {
        setEgg(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    // Full-screen overlay so it covers any surrounding layout chrome (the docs
    // catch-all renders not-found inside DocsLayout, which we want to hide).
    <div className="fixed inset-0 z-[100] overflow-y-auto bg-background">
      <main className="relative flex min-h-full flex-col items-center justify-center overflow-hidden px-6 py-20 text-center">
        <div className="pointer-events-none absolute inset-0">
          <div className="cube-glow absolute top-1/3 left-1/2 size-[36rem] -translate-x-1/2 -translate-y-1/2 opacity-50 blur-2xl" />
          {STARS.map((s) => (
            <span
              className="absolute rounded-full bg-foreground/20 motion-safe:animate-pulse"
              key={s.id}
              style={{
                animationDelay: `${s.delay}s`,
                height: s.size,
                left: `${s.x}%`,
                top: `${s.y}%`,
                width: s.size,
              }}
            />
          ))}
        </div>

        <Link
          className="absolute top-6 left-6 inline-flex items-center gap-2 font-display font-semibold text-foreground text-sm"
          href="/"
        >
          <span className="size-1.5 rounded-full bg-native" />
          sbox
        </Link>

        <p className="inline-flex items-center gap-2 font-data text-[10px] text-dim uppercase tracking-[0.22em]">
          <span className="size-1.5 rounded-full bg-emulated" />
          Error · NotFound
        </p>

        <h1 className="mt-5 font-display text-7xl font-semibold tracking-tight sm:text-8xl">
          <span className="brand-gradient">404</span>
        </h1>

        <p className="mt-5 max-w-[46ch] text-pretty text-muted-foreground sm:text-lg">
          This route never spun up. The page you&rsquo;re looking for
          isn&rsquo;t in the sandbox — it may have been moved, destroyed, or
          never created.
        </p>

        {/* The on-brand part: render the 404 as the SDK's own error. */}
        <div className="relative mt-9 min-h-[150px] w-full max-w-md">
          <AnimatePresence mode="wait">
            {egg ? (
              <motion.div
                animate={{ opacity: 1, scale: 1 }}
                className="panel-bezel overflow-hidden rounded-xl"
                exit={{ opacity: 0, scale: 0.98 }}
                initial={{ opacity: reduce ? 1 : 0, scale: reduce ? 1 : 0.98 }}
                key="egg"
                transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="flex items-center gap-1.5 border-border border-b px-3 py-2 font-data text-[10px] text-native uppercase tracking-[0.18em]">
                  <span className="size-1.5 rounded-full bg-native" />
                  escape hatch unlocked
                </div>
                <ThreeBody />
                <p className="px-4 pb-3 font-mono text-dim text-xs">
                  you found it — the three-body problem. drag to play.
                </p>
              </motion.div>
            ) : (
              <motion.div
                animate={{ opacity: 1, y: 0 }}
                className="panel-bezel overflow-hidden rounded-xl text-left"
                exit={{ opacity: 0, y: -8 }}
                initial={{ opacity: reduce ? 1 : 0, y: reduce ? 0 : 8 }}
                key="err"
                transition={{ duration: 0.3 }}
              >
                <div className="flex items-center gap-1.5 border-border border-b px-3 py-2 font-data text-[10px] text-dim uppercase tracking-[0.18em]">
                  <span className="size-1.5 rounded-full bg-emulated" />
                  stderr
                </div>
                <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed">
                  <code>
                    <span className="text-dim">await </span>
                    sandbox.files.read(
                    <span className="text-native">"{path}"</span>){"\n"}
                    <span className="text-emulated">✗ SandboxError</span>
                    <span className="text-muted-foreground">: NotFound</span>
                    {"\n"}
                    <span className="text-dim">
                      {'  code: "NotFound" · retryable: false'}
                    </span>
                  </code>
                </pre>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link className={cn(buttonVariants({ size: "lg" }))} href="/">
            Back to home
          </Link>
          <Link
            className={cn(buttonVariants({ size: "lg", variant: "ghost" }))}
            href="/general/overview"
          >
            Browse the docs
            <ArrowRight className="size-4" />
          </Link>
        </div>

        <p className="mt-10 font-mono text-[11px] text-dim/70">
          psst — there&rsquo;s an escape hatch on this page.{" "}
          <span aria-hidden>↑ ↑ ↓ ↓ ← → ← → B A</span>
        </p>
      </main>
    </div>
  );
};
