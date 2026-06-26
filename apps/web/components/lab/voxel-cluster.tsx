"use client";

import { motion } from "motion/react";

import { useSpin } from "@/components/lab/use-spin";

const UNIT = 44;
const GAP = 8;
const STEP = UNIT + GAP;
const HALF = UNIT / 2;
const FACES = [
  "rotateY(0deg)",
  "rotateY(90deg)",
  "rotateY(180deg)",
  "rotateY(270deg)",
  "rotateX(90deg)",
  "rotateX(-90deg)",
];
const AXIS = [-1, 0, 1];
const VOXELS = AXIS.flatMap((x) =>
  AXIS.flatMap((y) => AXIS.map((z) => ({ id: `v${x}${y}${z}`, x, y, z })))
);

const MiniCube = ({ x, y, z }: { x: number; y: number; z: number }) => (
  <div
    className="absolute inset-0 m-auto [transform-style:preserve-3d]"
    style={{
      height: UNIT,
      transform: `translate3d(${x * STEP}px, ${y * STEP}px, ${z * STEP}px)`,
      width: UNIT,
    }}
  >
    {FACES.map((t) => (
      <div
        className="absolute inset-0 rounded-[3px] border border-native/40 bg-native/[0.06]"
        key={t}
        style={{ transform: `${t} translateZ(${HALF}px)` }}
      />
    ))}
  </div>
);

export const VoxelCluster = () => {
  const { rotateX, rotateY, bind } = useSpin();

  return (
    <div
      className="grid h-[320px] w-full cursor-grab touch-none select-none place-items-center [perspective:1200px] active:cursor-grabbing"
      {...bind}
    >
      <motion.div
        className="relative size-px [transform-style:preserve-3d]"
        style={{ rotateX, rotateY }}
      >
        {VOXELS.map((v) => (
          <MiniCube key={v.id} x={v.x} y={v.y} z={v.z} />
        ))}
      </motion.div>
    </div>
  );
};
