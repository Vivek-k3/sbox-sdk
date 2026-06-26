"use client";

import { motion } from "motion/react";

import { useSpin } from "@/components/lab/use-spin";

const COUNT = 7;
const SHARDS = Array.from({ length: COUNT }, (_, i) => ({
  id: `sh${i}`,
  transform: `translate(-50%, -50%) rotateY(${i * (360 / COUNT)}deg) translateZ(118px) rotateX(${((i % 3) - 1) * 22}deg)`,
}));

export const OrbitingShards = () => {
  const { rotateX, rotateY, bind } = useSpin();

  return (
    <div
      className="grid h-[300px] w-full cursor-grab touch-none select-none place-items-center [perspective:1000px] active:cursor-grabbing"
      {...bind}
    >
      <div className="pointer-events-none absolute size-40 rounded-full bg-native/30 blur-2xl" />
      <motion.div
        className="relative size-px [transform-style:preserve-3d]"
        style={{ rotateX, rotateY }}
      >
        <div className="absolute inset-0 m-auto size-7 rounded-full bg-native/80 shadow-[0_0_36px_var(--native)]" />
        {SHARDS.map((s) => (
          <div
            className="absolute top-0 left-0 h-20 w-1.5 rounded-full bg-native/60 shadow-[0_0_14px_var(--native)] [backface-visibility:hidden]"
            key={s.id}
            style={{ transform: s.transform }}
          />
        ))}
      </motion.div>
    </div>
  );
};
