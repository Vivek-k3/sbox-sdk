"use client";

import { motion } from "motion/react";

import { useParallax } from "@/components/lab/use-parallax";

const COUNT = 84;
const ARMS = 3;
const DOTS = Array.from({ length: COUNT }, (_, i) => {
  const t = i / COUNT;
  const r = 18 + t * 132;
  const angle = t * Math.PI * 4 + (i % ARMS) * ((Math.PI * 2) / ARMS);
  return {
    id: `gx${i}`,
    op: 0.3 + (1 - t) * 0.6,
    size: 1 + (1 - t) * 2.4,
    x: Math.cos(angle) * r,
    z: Math.sin(angle) * r,
  };
});

export const SpiralGalaxy = () => {
  const { rotateX, rotateY, bind } = useParallax(10);

  return (
    <div
      className="grid h-[330px] w-full place-items-center [perspective:1000px]"
      {...bind}
    >
      <motion.div
        className="relative size-px [transform-style:preserve-3d]"
        style={{ rotateX, rotateY }}
      >
        <div className="relative size-px [transform:rotateX(60deg)] [transform-style:preserve-3d]">
          <div className="relative size-px [transform-style:preserve-3d] motion-safe:animate-[spin-z_32s_linear_infinite]">
            <div className="absolute inset-0 m-auto size-3 rounded-full bg-native shadow-[0_0_30px_var(--native)]" />
            {DOTS.map((d) => (
              <div
                className="absolute inset-0 m-auto rounded-full bg-native"
                key={d.id}
                style={{
                  height: d.size,
                  opacity: d.op,
                  transform: `translate3d(${d.x}px, 0, ${d.z}px)`,
                  width: d.size,
                }}
              />
            ))}
          </div>
        </div>
      </motion.div>
    </div>
  );
};
