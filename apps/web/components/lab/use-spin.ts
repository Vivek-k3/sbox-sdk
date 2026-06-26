"use client";

import {
  useAnimationFrame,
  useMotionValue,
  useReducedMotion,
} from "motion/react";
import { useRef } from "react";
import type { PointerEvent } from "react";

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** Shared drag-to-rotate + idle auto-spin for the abstract 3D elements. */
export const useSpin = (autoSpeed = 0.006) => {
  const reduce = useReducedMotion();
  const rotateY = useMotionValue(-26);
  const rotateX = useMotionValue(-14);
  const dragging = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const vel = useRef(0);

  useAnimationFrame((_, delta) => {
    if (reduce || dragging.current) {
      return;
    }
    rotateY.set(rotateY.get() + delta * autoSpeed + vel.current);
    vel.current *= 0.94;
  });

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    last.current = { x: e.clientX, y: e.clientY };
    vel.current = 0;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) {
      return;
    }
    const dx = e.clientX - last.current.x;
    const dy = e.clientY - last.current.y;
    last.current = { x: e.clientX, y: e.clientY };
    rotateY.set(rotateY.get() + dx * 0.4);
    rotateX.set(clamp(rotateX.get() - dy * 0.3, -70, 70));
    vel.current = dx * 0.05;
  };
  const onPointerUp = () => {
    dragging.current = false;
  };

  return {
    bind: {
      onPointerDown: reduce ? undefined : onPointerDown,
      onPointerLeave: onPointerUp,
      onPointerMove: reduce ? undefined : onPointerMove,
      onPointerUp,
    },
    reduce,
    rotateX,
    rotateY,
  };
};
