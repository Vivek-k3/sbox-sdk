"use client";

import { motion } from "motion/react";

import { useSpin } from "@/components/lab/use-spin";

const ORBITS = [
  {
    carrier: "motion-safe:animate-[spin-z_6s_linear_infinite]",
    id: "o1",
    size: 230,
    tilt: "rotateX(74deg) rotateY(0deg)",
  },
  {
    carrier: "motion-safe:animate-[spin-z_4.4s_linear_infinite]",
    id: "o2",
    size: 168,
    tilt: "rotateX(68deg) rotateY(62deg)",
  },
  {
    carrier: "motion-safe:animate-[spin-z_3.3s_linear_infinite]",
    id: "o3",
    size: 118,
    tilt: "rotateX(70deg) rotateY(-58deg)",
  },
];

export const AtomOrbits = () => {
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
        {ORBITS.map((o) => (
          <div
            className="absolute inset-0 m-auto [transform-style:preserve-3d]"
            key={o.id}
            style={{ height: o.size, transform: o.tilt, width: o.size }}
          >
            <div className="absolute inset-0 rounded-full border border-native/35" />
            <div
              className={`absolute inset-0 m-auto size-px [transform-style:preserve-3d] ${o.carrier}`}
            >
              <div
                className="absolute top-0 left-0 size-2.5 rounded-full bg-native shadow-[0_0_14px_var(--native)]"
                style={{
                  transform: `translate(-50%, -50%) translateX(${o.size / 2}px)`,
                }}
              />
            </div>
          </div>
        ))}
        <div className="absolute inset-0 m-auto size-7 rounded-full bg-native/85 shadow-[0_0_34px_var(--native)]" />
      </motion.div>
    </div>
  );
};
