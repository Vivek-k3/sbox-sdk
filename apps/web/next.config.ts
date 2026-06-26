import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const withMDX = createMDX();

const generalPages = [
  "overview",
  "installation",
  "usage",
  "capabilities",
  "templates",
  "errors",
  "escape-hatch",
  "retries",
] as const;

const nextConfig: NextConfig = {
  redirects: () => [
    { destination: "/general/overview", permanent: true, source: "/docs" },
    { destination: "/adapters/memory", permanent: false, source: "/adapters" },
    { destination: "/api/client", permanent: false, source: "/api" },
    ...generalPages.map((page) => ({
      destination: `/general/${page}`,
      permanent: true,
      source: `/${page}`,
    })),
  ],
  rewrites: () => [{ destination: "/llms.mdx/:path*", source: "/:path*.md" }],
};

export default withMDX(nextConfig);
