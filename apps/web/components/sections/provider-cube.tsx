"use client";

import {
  motion,
  useAnimationFrame,
  useMotionValue,
  useReducedMotion,
  useScroll,
  useTransform,
} from "motion/react";
import { useRef } from "react";

const HALF = "calc(var(--cube-size) / 2)";

const FACES = [
  { name: "E2B", transform: `rotateY(0deg) translateZ(${HALF})` },
  { name: "Vercel", transform: `rotateY(90deg) translateZ(${HALF})` },
  { name: "Cloudflare", transform: `rotateY(180deg) translateZ(${HALF})` },
  { name: "Modal", transform: `rotateY(270deg) translateZ(${HALF})` },
  { name: "Fly", transform: `rotateX(90deg) translateZ(${HALF})` },
  { name: "Daytona", transform: `rotateX(-90deg) translateZ(${HALF})` },
];

export const ProviderCube = () => {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);

  const spin = useMotionValue(-32);
  const { scrollYProgress } = useScroll({
    offset: ["start end", "end start"],
    target: ref,
  });
  const scrollSpin = useTransform(scrollYProgress, [0, 1], [0, 230]);
  const rotateY = useTransform(() => spin.get() + scrollSpin.get());
  const rotateX = useTransform(scrollYProgress, [0, 1], [-28, -6]);

  useAnimationFrame((_, delta) => {
    if (!reduce) {
      spin.set(spin.get() + delta * 0.009);
    }
  });

  return (
    <div
      ref={ref}
      className="relative grid place-items-center [--cube-size:14rem] sm:[--cube-size:18rem]"
    >
      <div className="cube-glow pointer-events-none absolute size-[150%] rounded-full blur-2xl" />
      <div className="[perspective:1100px]">
        <motion.div
          className="relative size-[var(--cube-size)]"
          style={
            reduce
              ? {
                  transform: "rotateX(-24deg) rotateY(-34deg)",
                  transformStyle: "preserve-3d",
                }
              : { rotateX, rotateY, transformStyle: "preserve-3d" }
          }
        >
          {FACES.map((face) => (
            <div
              className="cube-face absolute inset-0 grid place-items-center rounded-2xl"
              key={face.name}
              style={{ transform: face.transform }}
            >
              <div className="text-center">
                <span className="mx-auto mb-3 block size-1.5 rounded-full bg-native" />
                <span className="font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                  {face.name}
                </span>
              </div>
            </div>
          ))}
        </motion.div>
      </div>
    </div>
  );
};
