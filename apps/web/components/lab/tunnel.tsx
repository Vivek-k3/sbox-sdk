"use client";

import { motion } from "motion/react";

import { useParallax } from "@/components/lab/use-parallax";

const COUNT = 14;
const DURATION = 4;
const RINGS = Array.from({ length: COUNT }, (_, i) => ({
  delay: -(i * (DURATION / COUNT)),
  id: `t${i}`,
  z: -700 + i * (900 / COUNT),
}));

export const Tunnel = () => {
  const { rotateX, rotateY, bind } = useParallax(10);

  return (
    <div
      className="grid h-[340px] w-full place-items-center overflow-hidden [perspective:600px]"
      {...bind}
    >
      <motion.div
        className="relative size-px [transform-style:preserve-3d]"
        style={{ rotateX, rotateY }}
      >
        {RINGS.map((r) => (
          <div
            className="absolute inset-0 m-auto size-48 rounded-3xl border-2 border-native/40 motion-safe:animate-[tunnel_4s_linear_infinite]"
            key={r.id}
            style={{
              animationDelay: `${r.delay}s`,
              transform: `translateZ(${r.z}px)`,
            }}
          />
        ))}
        <div className="absolute inset-0 m-auto size-3 rounded-full bg-native shadow-[0_0_30px_var(--native)]" />
      </motion.div>
    </div>
  );
};
