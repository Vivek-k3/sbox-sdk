"use client";

import { motion } from "motion/react";

import { useSpin } from "@/components/lab/use-spin";

const SIZE = 200;
const HALF = SIZE / 2;
const FACES = [
  "rotateY(0deg)",
  "rotateY(90deg)",
  "rotateY(180deg)",
  "rotateY(270deg)",
  "rotateX(90deg)",
  "rotateX(-90deg)",
];

export const ContainmentCube = () => {
  const { rotateX, rotateY, bind } = useSpin();

  return (
    <div
      className="grid h-[300px] w-full cursor-grab touch-none select-none place-items-center [perspective:1000px] active:cursor-grabbing"
      {...bind}
    >
      <div className="relative" style={{ height: SIZE, width: SIZE }}>
        <div className="absolute inset-0 m-auto size-20 animate-pulse rounded-full bg-native/35 blur-2xl" />
        <motion.div
          className="absolute inset-0 [transform-style:preserve-3d]"
          style={{ rotateX, rotateY }}
        >
          {FACES.map((t) => (
            <div
              className="absolute inset-0 rounded-lg border border-native/40 bg-native/[0.05]"
              key={t}
              style={{ transform: `${t} translateZ(${HALF}px)` }}
            />
          ))}
          <div className="absolute inset-0 m-auto size-12 rounded-full bg-native/80 shadow-[0_0_40px_var(--native)]" />
        </motion.div>
      </div>
    </div>
  );
};
