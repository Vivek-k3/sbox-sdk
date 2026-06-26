"use client";

import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react";
import type { MotionStyle } from "motion/react";
import type { PointerEvent, ReactNode } from "react";

export const TiltCard = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) => {
  const reduce = useReducedMotion();
  const px = useMotionValue(0);
  const py = useMotionValue(0);
  const rotateX = useSpring(useTransform(py, [-0.5, 0.5], [7, -7]), {
    damping: 18,
    stiffness: 220,
  });
  const rotateY = useSpring(useTransform(px, [-0.5, 0.5], [-7, 7]), {
    damping: 18,
    stiffness: 220,
  });

  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    px.set((event.clientX - rect.left) / rect.width - 0.5);
    py.set((event.clientY - rect.top) / rect.height - 0.5);
  };
  const reset = () => {
    px.set(0);
    py.set(0);
  };

  const tiltStyle: MotionStyle = reduce
    ? {}
    : { rotateX, rotateY, transformStyle: "preserve-3d" };

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, rotateX: reduce ? 0 : 12, y: 26 }}
      onPointerLeave={reduce ? undefined : reset}
      onPointerMove={reduce ? undefined : onMove}
      style={tiltStyle}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      viewport={{ margin: "-80px", once: true }}
      whileInView={{ opacity: 1, rotateX: 0, y: 0 }}
    >
      {children}
    </motion.div>
  );
};
