import type { LiveConfig } from "../live/types.js";
import { e2b } from "./index.js";

/**
 * Live conformance against E2B Cloud (or a self-hosted domain). Needs
 * `E2B_API_KEY`; `E2B_DOMAIN` is optional. Sandboxes are created with private
 * traffic so the private-preview check runs. The template check does a real
 * (small) build in your team; it stays private and is reused by cache key.
 */
export const live: LiveConfig = {
  conformance: {
    expectedCaps: {
      fork: "native",
      privatePreview: "native",
      pty: "native",
      templateBuild: "native",
    },
    template: {
      source: {
        context: { "hello.txt": "hi from sbox" },
        dockerfile:
          "FROM e2bdev/base:latest\nCOPY hello.txt /home/user/hello.txt\n",
      },
    },
  },
  env: ["E2B_API_KEY"],
  make: () =>
    e2b({
      allowPublicTraffic: false,
      apiKey: process.env.E2B_API_KEY,
      domain: process.env.E2B_DOMAIN || undefined,
    }),
  name: "e2b",
};
