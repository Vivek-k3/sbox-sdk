"use client";

import { motion } from "motion/react";

import { useParallax } from "@/components/lab/use-parallax";

const COLS = 9;
const ROWS = 9;
const GAP = 26;
const CENTER = (COLS - 1) / 2;
const DOTS = Array.from({ length: COLS * ROWS }, (_, i) => {
  const cx = i % COLS;
  const cy = Math.floor(i / COLS);
  return {
    delay: Math.hypot(cx - CENTER, cy - CENTER) * 0.16,
    id: `g${i}`,
    x: (cx - CENTER) * GAP,
    y: (cy - CENTER) * GAP,
  };
});

export const GridWave = () => {
  const { rotateX, rotateY, bind } = useParallax(8);

  return (
    <div
      className="grid h-[330px] w-full place-items-center [perspective:900px]"
      {...bind}
    >
      <div className="[transform:rotateX(56deg)] [transform-style:preserve-3d]">
        <motion.div
          className="relative size-px [transform-style:preserve-3d]"
          style={{ rotateX, rotateY }}
        >
          {DOTS.map((d) => (
            <div
              className="absolute inset-0 m-auto size-1.5"
              key={d.id}
              style={{ transform: `translate3d(${d.x}px, ${d.y}px, 0)` }}
            >
              <div
                className="size-full rounded-full bg-native/80 motion-safe:animate-[wave_3s_ease-in-out_infinite]"
                style={{ animationDelay: `${d.delay}s` }}
              />
            </div>
          ))}
        </motion.div>
      </div>
    </div>
  );
};
