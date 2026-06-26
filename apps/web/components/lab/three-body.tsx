"use client";

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";

import { useSpin } from "@/components/lab/use-spin";

// ── Tweakables ──────────────────────────────────────────────────────────────
// Change BODIES to add or remove bodies. Equal masses orbit each other in true
// 3D space (a softened, angular-momentum-balanced gravitational cluster).
const BODIES = 3;

const G = 1;
const DT = 0.003;
const SUBSTEPS = 7;
const SCALE = 104;
const TRAIL = 46;
const EPS = 0.04;
const ESCAPE = 3.8;
const OMEGA = 0.9;
const BASE_TILT = 22;
const COLORS = ["var(--native)", "var(--emulated)", "var(--foreground)"];

// A shaded radial gradient turns each flat disc into a lit sphere.
const sphereBg = (c: string) =>
  `radial-gradient(circle at 33% 28%, color-mix(in oklab, ${c} 35%, #fff), ${c} 46%, color-mix(in oklab, ${c} 62%, #000))`;

interface Body {
  p: number[];
  v: number[];
  m: number;
}

const frac = (x: number) => x - Math.floor(x);

// N equal masses spread over a jittered sphere, set spinning about a tilted
// axis so the cluster carries angular momentum in all three dimensions.
const makeSystem = (n: number): Body[] => {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const bodies: Body[] = [];
  for (let i = 0; i < n; i += 1) {
    const y = n === 1 ? 0 : 1 - ((i + 0.5) / n) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const th = i * golden;
    const rr = 0.7 + 0.5 * frac(Math.sin(i * 9.73 + 1.3));
    bodies.push({
      m: 1,
      p: [Math.cos(th) * ring * rr, y * rr, Math.sin(th) * ring * rr],
      v: [0, 0, 0],
    });
  }
  // v = OMEGA * axis × r — a rigid spin about a tilted axis.
  const ax = 0.26;
  const ay = 0.93;
  const az = 0.4;
  for (const b of bodies) {
    const [rx, ry, rz] = b.p;
    b.v = [
      OMEGA * (ay * rz - az * ry),
      OMEGA * (az * rx - ax * rz),
      OMEGA * (ax * ry - ay * rx),
    ];
  }
  // Zero the centre of mass position and velocity so it stays put.
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let vx = 0;
  let vy = 0;
  let vz = 0;
  for (const b of bodies) {
    cx += b.p[0];
    cy += b.p[1];
    cz += b.p[2];
    vx += b.v[0];
    vy += b.v[1];
    vz += b.v[2];
  }
  const inv = 1 / Math.max(n, 1);
  for (const b of bodies) {
    b.p[0] -= cx * inv;
    b.p[1] -= cy * inv;
    b.p[2] -= cz * inv;
    b.v[0] -= vx * inv;
    b.v[1] -= vy * inv;
    b.v[2] -= vz * inv;
  }
  return bodies;
};

const SYSTEM = makeSystem(BODIES);
const N = SYSTEM.length;
const TRAIL_IDS = Array.from({ length: TRAIL }, (_, t) => `p${t}`);
const META = SYSTEM.map((b, i) => ({
  color: COLORS[i % COLORS.length],
  dia: Math.max(7, Math.round(Math.cbrt(b.m) * 15)),
  id: `b${i}`,
}));

const seed = () => ({
  pos: SYSTEM.map((b) => [...b.p]),
  vel: SYSTEM.map((b) => [...b.v]),
});

export const ThreeBody = () => {
  const reduce = useReducedMotion();
  const { rotateX, rotateY, bind } = useSpin(0.0022);
  const bodyRefs = useRef<(HTMLDivElement | null)[]>([]);
  const trailRefs = useRef<(HTMLDivElement | null)[][]>(SYSTEM.map(() => []));

  useEffect(() => {
    let { pos, vel } = seed();
    const mass = SYSTEM.map((b) => b.m);
    const trails: number[][][] = SYSTEM.map(() => []);
    let raf = 0;

    const acc = (p: number[][]) => {
      const a = Array.from({ length: N }, () => [0, 0, 0]);
      for (let i = 0; i < N; i += 1) {
        for (let j = 0; j < N; j += 1) {
          if (i !== j) {
            const dx = p[j][0] - p[i][0];
            const dy = p[j][1] - p[i][1];
            const dz = p[j][2] - p[i][2];
            const r2 = dx * dx + dy * dy + dz * dz + EPS;
            const inv = (G * mass[j]) / (r2 * Math.sqrt(r2));
            a[i][0] += dx * inv;
            a[i][1] += dy * inv;
            a[i][2] += dz * inv;
          }
        }
      }
      return a;
    };

    const step = () => {
      let a = acc(pos);
      for (let i = 0; i < N; i += 1) {
        for (let k = 0; k < 3; k += 1) {
          vel[i][k] += (a[i][k] * DT) / 2;
          pos[i][k] += vel[i][k] * DT;
        }
      }
      a = acc(pos);
      for (let i = 0; i < N; i += 1) {
        for (let k = 0; k < 3; k += 1) {
          vel[i][k] += (a[i][k] * DT) / 2;
        }
      }
    };

    const render = () => {
      const rx = rotateX.get();
      const ry = rotateY.get();
      // Counter-rotate each body so it always faces the camera (billboard) —
      // a shaded disc then reads as a sphere from any angle.
      const billboard = `rotateY(${-ry}deg) rotateX(${-(rx + BASE_TILT)}deg)`;
      for (let i = 0; i < N; i += 1) {
        const body = bodyRefs.current[i];
        if (body) {
          body.style.transform = `translate3d(${pos[i][0] * SCALE}px, ${pos[i][1] * SCALE}px, ${pos[i][2] * SCALE}px) ${billboard}`;
        }
        const hist = trails[i];
        hist.push([pos[i][0], pos[i][1], pos[i][2]]);
        if (hist.length > TRAIL) {
          hist.shift();
        }
        const refs = trailRefs.current[i];
        for (let t = 0; t < TRAIL; t += 1) {
          const dot = refs[t];
          if (dot) {
            const h = hist[hist.length - 1 - t];
            if (h) {
              dot.style.transform = `translate3d(${h[0] * SCALE}px, ${h[1] * SCALE}px, ${h[2] * SCALE}px)`;
              dot.style.opacity = `${(1 - t / TRAIL) * 0.45}`;
            } else {
              dot.style.opacity = "0";
            }
          }
        }
      }
    };

    const loop = () => {
      for (let s = 0; s < SUBSTEPS; s += 1) {
        step();
      }
      const escaped = pos.some((p) => Math.hypot(p[0], p[1], p[2]) > ESCAPE);
      if (escaped) {
        const fresh = seed();
        ({ pos } = fresh);
        ({ vel } = fresh);
        for (const h of trails) {
          h.length = 0;
        }
      }
      render();
      raf = requestAnimationFrame(loop);
    };

    if (reduce) {
      for (let s = 0; s < 320; s += 1) {
        step();
      }
      render();
    } else {
      loop();
    }

    return () => cancelAnimationFrame(raf);
  }, [reduce, rotateX, rotateY]);

  return (
    <div
      className="grid h-[340px] w-full cursor-grab touch-none select-none place-items-center [perspective:1100px] active:cursor-grabbing"
      {...bind}
    >
      <div className="pointer-events-none absolute size-48 rounded-full bg-native/12 blur-3xl" />
      <div className="[transform:rotateX(22deg)] [transform-style:preserve-3d]">
        <motion.div
          className="relative size-px [transform-style:preserve-3d]"
          style={{ rotateX, rotateY }}
        >
          {META.map((meta, i) => (
            <div key={meta.id}>
              {TRAIL_IDS.map((tid, t) => (
                <div
                  className="absolute inset-0 m-auto size-1 rounded-full"
                  key={tid}
                  ref={(el) => {
                    trailRefs.current[i][t] = el;
                  }}
                  style={{ background: meta.color, opacity: 0 }}
                />
              ))}
              <div
                className="absolute inset-0 m-auto rounded-full"
                ref={(el) => {
                  bodyRefs.current[i] = el;
                }}
                style={{
                  background: sphereBg(meta.color),
                  boxShadow: `0 0 ${Math.round(meta.dia * 1.1)}px ${meta.color}`,
                  height: meta.dia,
                  width: meta.dia,
                }}
              />
            </div>
          ))}
        </motion.div>
      </div>
    </div>
  );
};
