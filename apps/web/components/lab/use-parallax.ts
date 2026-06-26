"use client";

import {
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react";
import type { PointerEvent } from "react";

/** Cursor-driven 3D parallax tilt for the non-dragged abstract elements. */
export const useParallax = (range = 16) => {
  const reduce = useReducedMotion();
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const rotateX = useSpring(useTransform(my, [-0.5, 0.5], [range, -range]), {
    damping: 18,
    stiffness: 120,
  });
  const rotateY = useSpring(useTransform(mx, [-0.5, 0.5], [-range, range]), {
    damping: 18,
    stiffness: 120,
  });

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    mx.set((e.clientX - r.left) / r.width - 0.5);
    my.set((e.clientY - r.top) / r.height - 0.5);
  };
  const onPointerLeave = () => {
    mx.set(0);
    my.set(0);
  };

  return {
    bind: {
      onPointerLeave: reduce ? undefined : onPointerLeave,
      onPointerMove: reduce ? undefined : onPointerMove,
    },
    reduce,
    rotateX,
    rotateY,
  };
};
