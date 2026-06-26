"use client";

import { motion } from "motion/react";

import { useSpin } from "@/components/lab/use-spin";

const SIZE = 200;
const FACES = [
  { id: "front", orient: "rotateY(0deg)" },
  { id: "back", orient: "rotateY(180deg)" },
  { id: "right", orient: "rotateY(90deg)" },
  { id: "left", orient: "rotateY(270deg)" },
  { id: "top", orient: "rotateX(90deg)" },
  { id: "bottom", orient: "rotateX(-90deg)" },
];

export const ExplodedCube = () => {
  const { rotateX, rotateY, bind } = useSpin(0.005);

  return (
    <div
      className="grid h-[320px] w-full cursor-grab touch-none select-none place-items-center [perspective:1100px] active:cursor-grabbing"
      {...bind}
    >
      <motion.div
        className="relative [transform-style:preserve-3d]"
        style={{ height: SIZE, rotateX, rotateY, width: SIZE }}
      >
        {FACES.map((face, i) => (
          <div
            className="absolute inset-0 [transform-style:preserve-3d]"
            key={face.id}
            style={{ transform: face.orient }}
          >
            <div
              className="absolute inset-0 rounded-lg border border-native/45 bg-native/[0.06] motion-safe:animate-[explode_4.2s_ease-in-out_infinite]"
              style={{
                animationDelay: `${i * 0.12}s`,
                transform: "translateZ(100px)",
              }}
            />
          </div>
        ))}
        <div className="absolute inset-0 m-auto size-9 rounded-full bg-native/80 shadow-[0_0_34px_var(--native)]" />
      </motion.div>
    </div>
  );
};
