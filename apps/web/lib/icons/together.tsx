import type { SVGProps } from "react";

// Authored glyph (not a brand mark) for Together Sandbox: two overlapping boxes. `currentColor`, matching the
// other provider icons.
export const TogetherIcon = (props: SVGProps<SVGSVGElement>) => (
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
    <rect height="11" rx="2" width="11" x="3" y="3" />
    <rect height="11" rx="2" width="11" x="10" y="10" />
  </svg>
);
