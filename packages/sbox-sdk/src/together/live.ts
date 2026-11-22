import type { LiveConfig } from "../live/types.js";
import { together } from "./index.js";

/**
 * Live conformance against Together Sandbox. Every sandbox boots from a
 * snapshot, so the suite needs a base: set `TOGETHER_SNAPSHOT` (alias or id),
 * otherwise the conformance template below is built first and used.
 */
export const live: LiveConfig = {
  conformance: {
    ...(process.env.TOGETHER_SNAPSHOT
      ? { spec: { template: process.env.TOGETHER_SNAPSHOT } }
      : {
          spec: {
            template: {
              source: { dockerfile: "FROM debian:bookworm-slim\n" },
            },
          },
        }),
    template: {
      source: {
        context: { "hello.txt": "hi" },
        dockerfile:
          "FROM debian:bookworm-slim\nCOPY hello.txt /app/hello.txt\n",
      },
    },
  },
  env: ["TOGETHER_API_KEY"],
  make: () =>
    together({
      apiKey: process.env.TOGETHER_API_KEY!,
      ...(process.env.TOGETHER_BASE_URL
        ? { baseUrl: process.env.TOGETHER_BASE_URL }
        : {}),
    }),
  name: "together",
};
