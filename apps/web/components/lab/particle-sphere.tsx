"use client";

import { motion } from "motion/react";

import { useSpin } from "@/components/lab/use-spin";

const COUNT = 90;
const R = 130;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const DOTS = Array.from({ length: COUNT }, (_, i) => {
  const y = 1 - (i / (COUNT - 1)) * 2;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = i * GOLDEN;
  return {
    id: `ps${i}`,
    x: Math.cos(theta) * radius * R,
    y: y * R,
    z: Math.sin(theta) * radius * R,
  };
});

export const ParticleSphere = () => {
  const { rotateX, rotateY, bind } = useSpin();

  return (
    <div
      className="grid h-[320px] w-full cursor-grab touch-none select-none place-items-center [perspective:1000px] active:cursor-grabbing"
      {...bind}
    >
      <div className="pointer-events-none absolute size-44 rounded-full bg-native/15 blur-3xl" />
      <motion.div
        className="relative size-px [transform-style:preserve-3d]"
        style={{ rotateX, rotateY }}
      >
        {DOTS.map((d) => (
          <div
            className="absolute inset-0 m-auto size-1.5 rounded-full bg-native"
            key={d.id}
            style={{ transform: `translate3d(${d.x}px, ${d.y}px, ${d.z}px)` }}
          />
        ))}
      </motion.div>
    </div>
  );
};
