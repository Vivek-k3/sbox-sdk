import type { SVGProps } from "react";

// Authored glyph (not a brand mark) for local container engine (Docker / OrbStack / Podman): stacked containers. `currentColor`, matching the
// other provider icons.
export const DockerIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    aria-hidden="true"
    fill="none"
    height="1em"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="1.7"
    viewBox="0 0 24 24"
    width="1em"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <rect height="4" rx="0.5" width="4" x="4" y="10" />
    <rect height="4" rx="0.5" width="4" x="9" y="10" />
    <rect height="4" rx="0.5" width="4" x="14" y="10" />
    <rect height="4" rx="0.5" width="4" x="9" y="5" />
    <path d="M2 15c1 4 4.5 6 9 6 6 0 9.5-3.5 11-9" />
  </svg>
);
