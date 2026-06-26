"use client";

import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react";
import type { PointerEvent } from "react";

const BOX = 220;
const HALF = BOX / 2;
const COUNT = 24;

const frac = (n: number) => n - Math.floor(n);
const rand = (i: number, s: number) => frac(Math.sin(i * 53.7 + s) * 137.13);

const DOTS = Array.from({ length: COUNT }, (_, i) => ({
  delay: rand(i, 5) * 4,
  dur: 3 + rand(i, 4) * 4,
  id: `d${i}`,
  x: (rand(i, 1) * 2 - 1) * HALF * 0.84,
  y: (rand(i, 2) * 2 - 1) * HALF * 0.84,
  z: (rand(i, 3) * 2 - 1) * HALF * 0.84,
}));

const FACES = [
  `rotateY(0deg) translateZ(${HALF}px)`,
  `rotateY(90deg) translateZ(${HALF}px)`,
  `rotateY(180deg) translateZ(${HALF}px)`,
  `rotateY(270deg) translateZ(${HALF}px)`,
  `rotateX(90deg) translateZ(${HALF}px)`,
  `rotateX(-90deg) translateZ(${HALF}px)`,
];

export const ParticleBox = () => {
  const reduce = useReducedMotion();
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const rotateX = useSpring(useTransform(my, [-0.5, 0.5], [16, -16]), {
    damping: 18,
    stiffness: 120,
  });
  const rotateY = useSpring(useTransform(mx, [-0.5, 0.5], [-16, 16]), {
    damping: 18,
    stiffness: 120,
  });

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    mx.set((e.clientX - r.left) / r.width - 0.5);
    my.set((e.clientY - r.top) / r.height - 0.5);
  };
  const reset = () => {
    mx.set(0);
    my.set(0);
  };

  return (
    <div
      className="grid h-[320px] w-full place-items-center [perspective:1000px]"
      onPointerLeave={reduce ? undefined : reset}
      onPointerMove={reduce ? undefined : onMove}
    >
      <motion.div
        className="relative [transform-style:preserve-3d]"
        style={
          reduce
            ? { height: BOX, width: BOX }
            : { height: BOX, rotateX, rotateY, width: BOX }
        }
      >
        {FACES.map((t) => (
          <div
            className="absolute inset-0 rounded-md border border-native/15"
            key={t}
            style={{ transform: t }}
          />
        ))}
        {DOTS.map((d) => (
          <div
            className="absolute inset-0 m-auto size-1.5"
            key={d.id}
            style={{ transform: `translate3d(${d.x}px, ${d.y}px, ${d.z}px)` }}
          >
            <div
              className="size-full rounded-full bg-native"
              style={
                reduce
                  ? undefined
                  : {
                      animation: `drift ${d.dur}s ease-in-out ${d.delay}s infinite`,
                    }
              }
            />
          </div>
        ))}
      </motion.div>
    </div>
  );
};
