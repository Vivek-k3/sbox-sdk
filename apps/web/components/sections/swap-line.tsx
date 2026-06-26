"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

const PROVIDERS = ["e2b", "vercel", "cloudflare", "modal", "fly", "daytona"];

export const SwapLine = () => {
  const reduce = useReducedMotion();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (reduce) {
      return;
    }
    const id = setInterval(
      () => setIndex((i) => (i + 1) % PROVIDERS.length),
      1900
    );
    return () => clearInterval(id);
  }, [reduce]);

  const provider = PROVIDERS[index];

  return (
    <div className="inline-flex items-center rounded-lg border border-border bg-card px-4 py-2.5 font-mono text-[13px] shadow-sm">
      <span className="text-muted-foreground">{"import { "}</span>
      <span className="relative inline-grid">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            animate={{ opacity: 1, y: 0 }}
            className="col-start-1 row-start-1 text-native"
            exit={{ opacity: 0, y: -8 }}
            initial={{ opacity: 0, y: 8 }}
            key={provider}
            transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
          >
            {provider}
          </motion.span>
        </AnimatePresence>
      </span>
      <span className="text-muted-foreground">{' } from "sbox-sdk/'}</span>
      <span className="relative inline-grid">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            animate={{ opacity: 1, y: 0 }}
            className="col-start-1 row-start-1 text-foreground"
            exit={{ opacity: 0, y: -8 }}
            initial={{ opacity: 0, y: 8 }}
            key={provider}
            transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
          >
            {provider}
          </motion.span>
        </AnimatePresence>
      </span>
      <span className="text-muted-foreground">{'"'}</span>
    </div>
  );
};
