import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import type { SVGProps } from "react";

const Logo = (props: SVGProps<SVGSVGElement>) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <title>sbox SDK</title>
    <path
      d="M12 2 21 7v10l-9 5-9-5V7l9-5Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <path
      d="M3.5 7.2 12 12l8.5-4.8M12 12v9.5"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      opacity="0.55"
    />
  </svg>
);

export const baseOptions: BaseLayoutProps = {
  githubUrl: "https://github.com/vivek-k3/sbox-sdk",
  nav: {
    title: (
      <div className="flex items-center gap-1.5 whitespace-nowrap shrink-0">
        <Logo className="size-4" />
        <p className="font-medium">sbox SDK</p>
      </div>
    ),
  },
};
