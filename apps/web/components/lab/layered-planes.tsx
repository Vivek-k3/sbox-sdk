"use client";

import { motion } from "motion/react";

import { useParallax } from "@/components/lab/use-parallax";

const COUNT = 6;
const GAP = 32;
const SHEETS = Array.from({ length: COUNT }, (_, i) => ({
  id: `lp${i}`,
  z: (i - (COUNT - 1) / 2) * GAP,
}));

export const LayeredPlanes = () => {
  const { rotateX, rotateY, bind } = useParallax(20);

  return (
    <div
      className="grid h-[320px] w-full place-items-center [perspective:1000px]"
      {...bind}
    >
      <motion.div
        className="relative size-px [transform-style:preserve-3d]"
        style={{ rotateX, rotateY }}
      >
        {SHEETS.map((s) => (
          <div
            className="absolute inset-0 m-auto size-44 rounded-xl border border-native/35 bg-native/[0.04]"
            key={s.id}
            style={{ transform: `translateZ(${s.z}px)` }}
          />
        ))}
        <div className="absolute inset-0 m-auto size-12 rounded-lg border border-native/60 bg-native/15" />
      </motion.div>
    </div>
  );
};
