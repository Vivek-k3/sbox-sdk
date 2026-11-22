import type { SVGProps } from "react";

// Authored glyph (not a brand mark) for Superserve: a microVM chip with a play mark. `currentColor`, matching the
// other provider icons.
export const SuperserveIcon = (props: SVGProps<SVGSVGElement>) => (
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
    <rect height="16" rx="3" width="16" x="4" y="4" />
    <path d="m10 9 5 3-5 3V9Z" />
  </svg>
);
