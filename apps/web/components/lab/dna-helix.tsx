"use client";

import { motion } from "motion/react";

import { useSpin } from "@/components/lab/use-spin";

const N = 16;
const STEP = 34;
const RADIUS = 66;
const GAP = 17;

const NODES = Array.from({ length: N }, (_, i) => ({
  angle: i * STEP,
  id: `n${i}`,
  yOff: (i - (N - 1) / 2) * GAP,
}));

export const DnaHelix = () => {
  const { rotateX, rotateY, bind } = useSpin();

  return (
    <div
      className="grid h-[360px] w-full cursor-grab touch-none select-none place-items-center [perspective:1100px] active:cursor-grabbing"
      {...bind}
    >
      <motion.div
        className="relative size-px [transform-style:preserve-3d]"
        style={{ rotateX, rotateY }}
      >
        {NODES.map((n) => (
          <div key={n.id}>
            <div
              className="absolute top-0 left-0 h-px rounded-full bg-native/30"
              style={{
                transform: `translate(-50%, -50%) rotateY(${n.angle}deg) translateY(${n.yOff}px)`,
                width: RADIUS * 2,
              }}
            />
            <div
              className="absolute top-0 left-0 size-2 rounded-full bg-native shadow-[0_0_12px_var(--native)]"
              style={{
                transform: `translate(-50%, -50%) rotateY(${n.angle}deg) translateY(${n.yOff}px) translateX(${RADIUS}px)`,
              }}
            />
            <div
              className="absolute top-0 left-0 size-2 rounded-full bg-native/65 shadow-[0_0_12px_var(--native)]"
              style={{
                transform: `translate(-50%, -50%) rotateY(${n.angle}deg) translateY(${n.yOff}px) translateX(${-RADIUS}px)`,
              }}
            />
          </div>
        ))}
      </motion.div>
    </div>
  );
};
