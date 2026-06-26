"use client";

import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react";
import type { PointerEvent } from "react";

export const GlassMonolith = () => {
  const reduce = useReducedMotion();
  const mx = useMotionValue(0);
  const rotateY = useSpring(useTransform(mx, [-0.5, 0.5], [-24, 24]), {
    damping: 16,
    stiffness: 120,
  });

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    mx.set((e.clientX - r.left) / r.width - 0.5);
  };
  const reset = () => mx.set(0);

  return (
    <div
      className="relative grid h-[320px] w-full place-items-center [perspective:1100px]"
      onPointerLeave={reduce ? undefined : reset}
      onPointerMove={reduce ? undefined : onMove}
    >
      <div className="pointer-events-none absolute size-56 rounded-full bg-native/25 blur-3xl" />
      <div className="motion-safe:animate-[drift_6s_ease-in-out_infinite]">
        <motion.div
          className="relative h-64 w-44 overflow-hidden rounded-2xl border border-native/40 bg-native/[0.06] backdrop-blur-sm [transform-style:preserve-3d]"
          style={reduce ? undefined : { rotateX: -4, rotateY }}
        >
          <div className="monolith-grid absolute inset-0 opacity-40" />
          <div className="scanline-bar absolute inset-x-0 top-0 h-10 motion-safe:animate-[scanline_2.6s_linear_infinite]" />
          <div className="absolute inset-0 grid place-items-center">
            <div className="size-10 rounded-lg border border-native/60 bg-native/20" />
          </div>
        </motion.div>
      </div>
    </div>
  );
};
