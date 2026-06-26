"use client";

import { motion } from "motion/react";

import { useSpin } from "@/components/lab/use-spin";

const SIDES = 6;
const SIDE_W = 72;
const HEIGHT = 184;
const APOTHEM = Math.round(SIDE_W / 2 / Math.tan(Math.PI / SIDES));
const CAP_W = SIDE_W * 2;
const CAP_H = APOTHEM * 2;
const FACES = Array.from({ length: SIDES }, (_, i) => ({
  id: `cf${i}`,
  transform: `rotateY(${i * (360 / SIDES)}deg) translateZ(${APOTHEM}px)`,
}));

export const CrystalPrism = () => {
  const { rotateX, rotateY, bind } = useSpin();

  return (
    <div
      className="grid h-[340px] w-full cursor-grab touch-none select-none place-items-center [perspective:1100px] active:cursor-grabbing"
      {...bind}
    >
      <motion.div
        className="relative size-px [transform-style:preserve-3d]"
        style={{ rotateX, rotateY }}
      >
        {FACES.map((f) => (
          <div
            className="absolute top-0 left-0 rounded-sm border border-native/45 bg-native/[0.07]"
            key={f.id}
            style={{
              height: HEIGHT,
              transform: `translate(-50%, -50%) ${f.transform}`,
              width: SIDE_W,
            }}
          />
        ))}
        <div
          className="hex-clip absolute top-0 left-0 border border-native/45 bg-native/15"
          style={{
            height: CAP_H,
            transform: `translate(-50%, -50%) rotateX(90deg) translateZ(${HEIGHT / 2}px)`,
            width: CAP_W,
          }}
        />
        <div
          className="hex-clip absolute top-0 left-0 border border-native/45 bg-native/15"
          style={{
            height: CAP_H,
            transform: `translate(-50%, -50%) rotateX(-90deg) translateZ(${HEIGHT / 2}px)`,
            width: CAP_W,
          }}
        />
      </motion.div>
    </div>
  );
};
