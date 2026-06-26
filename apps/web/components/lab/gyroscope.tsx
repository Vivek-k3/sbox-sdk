"use client";

import { motion } from "motion/react";

import { useSpin } from "@/components/lab/use-spin";

const RINGS = [
  {
    id: "a",
    ring: "border-native/45 motion-safe:animate-[spin-y_8s_linear_infinite]",
    size: 220,
  },
  {
    id: "b",
    ring: "border-native/35 motion-safe:animate-[spin-x_11s_linear_infinite]",
    size: 166,
  },
  {
    id: "c",
    ring: "border-native/55 motion-safe:animate-[spin-z_7s_linear_infinite]",
    size: 112,
  },
];

export const Gyroscope = () => {
  const { rotateX, rotateY, bind } = useSpin(0.003);

  return (
    <div
      className="grid h-[320px] w-full cursor-grab touch-none select-none place-items-center [perspective:1100px] active:cursor-grabbing"
      {...bind}
    >
      <motion.div
        className="relative size-px [transform-style:preserve-3d]"
        style={{ rotateX, rotateY }}
      >
        {RINGS.map((r) => (
          <div
            className={`absolute inset-0 m-auto rounded-full border-2 ${r.ring}`}
            key={r.id}
            style={{ height: r.size, width: r.size }}
          />
        ))}
        <div className="absolute inset-0 m-auto size-5 rounded-full bg-native shadow-[0_0_30px_var(--native)]" />
      </motion.div>
    </div>
  );
};
