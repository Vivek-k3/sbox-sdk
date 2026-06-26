import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { AtomOrbits } from "@/components/lab/atom-orbits";
import { ContainmentCube } from "@/components/lab/containment-cube";
import { CrystalPrism } from "@/components/lab/crystal-prism";
import { DnaHelix } from "@/components/lab/dna-helix";
import { ExplodedCube } from "@/components/lab/exploded-cube";
import { GlassMonolith } from "@/components/lab/glass-monolith";
import { GridWave } from "@/components/lab/grid-wave";
import { Gyroscope } from "@/components/lab/gyroscope";
import { LayeredPlanes } from "@/components/lab/layered-planes";
import { NestedFrames } from "@/components/lab/nested-frames";
import { OrbitingShards } from "@/components/lab/orbiting-shards";
import { ParticleBox } from "@/components/lab/particle-box";
import { ParticleSphere } from "@/components/lab/particle-sphere";
import { ParticleTorus } from "@/components/lab/particle-torus";
import { PulseRadar } from "@/components/lab/pulse-radar";
import { SpiralGalaxy } from "@/components/lab/spiral-galaxy";
import { ThemeToggle } from "@/components/lab/theme-toggle";
import { ThreeBody } from "@/components/lab/three-body";
import { Tunnel } from "@/components/lab/tunnel";
import { VoxelCluster } from "@/components/lab/voxel-cluster";

export const metadata: Metadata = {
  title: "3D element gallery",
};

const ITEMS: { title: string; note: string; element: ReactNode }[] = [
  {
    element: <ThreeBody />,
    note: "A real-time gravitational simulation — equal-mass bodies orbiting each other in true 3D space, rendered as shaded spheres with glowing trails. Drag to orbit the camera. (Set BODIES in the source to add more.)",
    title: "Three-body problem",
  },
  {
    element: <ContainmentCube />,
    note: "A glowing core sealed in a translucent box — the sandbox as one isolated unit. Drag to rotate.",
    title: "Containment cube",
  },
  {
    element: <NestedFrames />,
    note: "Layers of isolation around a core; the inner frame counter-rotates inside the outer. Drag to spin.",
    title: "Nested isolation frames",
  },
  {
    element: <ExplodedCube />,
    note: "Six faces that breathe apart and seal back around a core — a sandbox assembling itself. Drag to rotate.",
    title: "Exploded cube",
  },
  {
    element: <VoxelCluster />,
    note: "A dense 3×3×3 lattice of translucent cells — compute as a solid block. Drag to rotate.",
    title: "Voxel cluster",
  },
  {
    element: <CrystalPrism />,
    note: "A faceted hexagonal crystal — an abstract, contained monolith. Drag to rotate.",
    title: "Crystal prism",
  },
  {
    element: <LayeredPlanes />,
    note: "Translucent layers stacked in depth — the strata of a system. Move your cursor to separate them.",
    title: "Layered planes",
  },
  {
    element: <ParticleSphere />,
    note: "Points spread by the golden angle into an even sphere — a contained field of compute. Drag to rotate.",
    title: "Particle sphere",
  },
  {
    element: <ParticleBox />,
    note: "Ephemeral compute drifting inside an invisible boundary. Move your cursor to tilt the volume.",
    title: "Bounded particle field",
  },
  {
    element: <ParticleTorus />,
    note: "Particles sampled along a torus knot — a process looping on itself. Drag to rotate.",
    title: "Torus knot",
  },
  {
    element: <SpiralGalaxy />,
    note: "Points winding out along spiral arms on a slowly turning disc. Move your cursor to steer.",
    title: "Spiral disc",
  },
  {
    element: <GridWave />,
    note: "A dot grid rippling in a wave from the center — a living terrain. Move your cursor to tilt it.",
    title: "Wave terrain",
  },
  {
    element: <OrbitingShards />,
    note: "Energy held in orbit around a bright core. Drag to rotate the field.",
    title: "Orbiting shards",
  },
  {
    element: <Gyroscope />,
    note: "Three perpendicular rings spinning on different axes — an abstract nucleus. Drag to tilt.",
    title: "Gyroscope",
  },
  {
    element: <AtomOrbits />,
    note: "Electrons tracing tilted orbits around a core. Drag to tilt the whole atom.",
    title: "Atom orbits",
  },
  {
    element: <DnaHelix />,
    note: "Two strands and their rungs winding around a vertical axis — structured data. Drag to spin.",
    title: "Double helix",
  },
  {
    element: <Tunnel />,
    note: "Rings flying down the Z-axis — entering the sandbox. Move your cursor to steer the vanishing point.",
    title: "Ring tunnel",
  },
  {
    element: <PulseRadar />,
    note: "Concentric pulses sweeping out across a tilted grid — a probe pinging the environment.",
    title: "Radar pulse",
  },
  {
    element: <GlassMonolith />,
    note: "A live compute surface — a scanning grid over a contained core. Move your cursor to turn it.",
    title: "Compute slab",
  },
];

const Stage = ({
  index,
  title,
  note,
  children,
}: {
  index: string;
  title: string;
  note: string;
  children: ReactNode;
}) => (
  <section className="border-border border-t">
    <div className="mx-auto max-w-4xl px-6 py-16">
      <div className="flex items-baseline gap-3">
        <span className="font-data text-[10px] text-dim tracking-[0.2em]">
          {index}
        </span>
        <h2 className="font-display font-semibold text-2xl text-foreground tracking-tight">
          {title}
        </h2>
      </div>
      <p className="mt-1.5 max-w-[60ch] text-muted-foreground text-sm">
        {note}
      </p>
      <div className="mt-8 grid min-h-[360px] place-items-center rounded-2xl border border-border bg-[radial-gradient(circle_at_50%_30%,color-mix(in_oklab,var(--native)_8%,transparent),transparent_70%)] p-6 sm:p-10">
        {children}
      </div>
    </div>
  </section>
);

const LabPage = () => (
  <main className="min-h-screen bg-background pb-24">
    <header className="sticky top-0 z-20 flex items-center justify-between border-border border-b bg-background/85 px-6 py-4 backdrop-blur">
      <Link
        className="inline-flex items-center gap-2 font-mono text-muted-foreground text-sm transition-colors hover:text-foreground"
        href="/"
      >
        <ArrowLeft className="size-4" />
        Home
      </Link>
      <ThemeToggle />
    </header>

    <div className="mx-auto max-w-4xl px-6 pt-16 pb-4">
      <p className="font-data text-[10px] text-dim tracking-[0.22em] uppercase">
        Pick one
      </p>
      <h1 className="mt-3 font-display font-semibold text-4xl text-foreground tracking-tight sm:text-5xl">
        Sandbox, abstracted
      </h1>
      <p className="mt-4 max-w-[60ch] text-muted-foreground">
        Nineteen abstract 3D ideas for the hero — each an abstract take on an
        isolated sandbox, no provider logos attached. All pure CSS-3D,
        theme-aware, and reduced-motion safe. Drag, hover, and move your cursor,
        then tell me which one to ship.
      </p>
    </div>

    {ITEMS.map((item, i) => (
      <Stage
        index={String(i + 1).padStart(2, "0")}
        key={item.title}
        note={item.note}
        title={item.title}
      >
        {item.element}
      </Stage>
    ))}
  </main>
);

export default LabPage;
