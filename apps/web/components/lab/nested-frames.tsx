"use client";

import { motion } from "motion/react";

import { useSpin } from "@/components/lab/use-spin";

const faces = (half: number) => [
  `rotateY(0deg) translateZ(${half}px)`,
  `rotateY(90deg) translateZ(${half}px)`,
  `rotateY(180deg) translateZ(${half}px)`,
  `rotateY(270deg) translateZ(${half}px)`,
  `rotateX(90deg) translateZ(${half}px)`,
  `rotateX(-90deg) translateZ(${half}px)`,
];

const OUTER = 220;
const INNER = 116;

export const NestedFrames = () => {
  const { rotateX, rotateY, bind } = useSpin(0.004);

  return (
    <div
      className="grid h-[320px] w-full cursor-grab touch-none select-none place-items-center [perspective:1100px] active:cursor-grabbing"
      {...bind}
    >
      <motion.div
        className="relative [transform-style:preserve-3d]"
        style={{ height: OUTER, rotateX, rotateY, width: OUTER }}
      >
        {faces(OUTER / 2).map((t) => (
          <div
            className="absolute inset-0 rounded-md border border-native/20"
            key={t}
            style={{ transform: t }}
          />
        ))}

        <div
          className="absolute inset-0 m-auto [transform-style:preserve-3d] motion-safe:animate-[spin-y-rev_15s_linear_infinite]"
          style={{ height: INNER, width: INNER }}
        >
          {faces(INNER / 2).map((t) => (
            <div
              className="absolute inset-0 rounded-md border border-native/55 bg-native/[0.07]"
              key={t}
              style={{ transform: t }}
            />
          ))}
        </div>

        <div className="absolute inset-0 m-auto size-2.5 rounded-full bg-native shadow-[0_0_24px_var(--native)]" />
      </motion.div>
    </div>
  );
};
