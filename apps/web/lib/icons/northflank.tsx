import type { SVGProps } from "react";

// Authored glyph (no public monochrome brand SVG): a hexagonal-prism ring,
// echoing Northflank's mark. Inherits `currentColor`.
export const NorthflankIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    aria-hidden="true"
    fill="currentColor"
    height="1em"
    viewBox="0 0 24 24"
    width="1em"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <path d="M12 1.7 20.66 6.7v10.6L12 22.3 3.34 17.3V6.7L12 1.7Zm0 2.31L5.34 7.85v8.3L12 19.99l6.66-3.84v-8.3L12 4.01Z" />
    <path d="M8.4 8.2h1.7l3.8 5.2V8.2h1.7v7.6h-1.7l-3.8-5.2v5.2H8.4V8.2Z" />
  </svg>
);
