"use client";

import { motion } from "motion/react";

import { useSpin } from "@/components/lab/use-spin";

const COUNT = 72;
const RB = 92;
const RS = 32;
const DOTS = Array.from({ length: COUNT }, (_, i) => {
  const t = i / COUNT;
  const u = t * Math.PI * 2 * 3;
  const v = t * Math.PI * 2 * 2;
  const ring = RB + RS * Math.cos(v);
  return {
    id: `tk${i}`,
    x: ring * Math.cos(u),
    y: RS * Math.sin(v),
    z: ring * Math.sin(u),
  };
});

export const ParticleTorus = () => {
  const { rotateX, rotateY, bind } = useSpin();

  return (
    <div
      className="grid h-[320px] w-full cursor-grab touch-none select-none place-items-center [perspective:1000px] active:cursor-grabbing"
      {...bind}
    >
      <motion.div
        className="relative size-px [transform-style:preserve-3d]"
        style={{ rotateX, rotateY }}
      >
        {DOTS.map((d) => (
          <div
            className="absolute inset-0 m-auto size-2 rounded-full bg-native shadow-[0_0_10px_var(--native)]"
            key={d.id}
            style={{ transform: `translate3d(${d.x}px, ${d.y}px, ${d.z}px)` }}
          />
        ))}
      </motion.div>
    </div>
  );
};
