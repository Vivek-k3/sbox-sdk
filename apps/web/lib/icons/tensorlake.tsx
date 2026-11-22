import type { SVGProps } from "react";

// Authored glyph (not a brand mark) for Tensorlake: layered waves (a lake of tensors). `currentColor`, matching the
// other provider icons.
export const TensorlakeIcon = (props: SVGProps<SVGSVGElement>) => (
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
    <path d="M3 8c2.5-2 5.5-2 8 0s5.5 2 8 0" />
    <path d="M3 12.5c2.5-2 5.5-2 8 0s5.5 2 8 0" />
    <path d="M3 17c2.5-2 5.5-2 8 0s5.5 2 8 0" />
  </svg>
);
