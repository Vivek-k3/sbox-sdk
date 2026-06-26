import type { SVGProps } from "react";

// Blaxel's brand mark. Blaxel publishes no monochrome vector logo, so the
// official square logo is embedded as a raster asset (served from
// /public/providers/blaxel.png) inside an SVG so it slots into the icon registry.
export const BlaxelIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    aria-hidden="true"
    height="1em"
    viewBox="0 0 24 24"
    width="1em"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <image
      height="24"
      href="/providers/blaxel.png"
      preserveAspectRatio="xMidYMid meet"
      style={{ clipPath: "inset(0 round 5px)" }}
      width="24"
    />
  </svg>
);
