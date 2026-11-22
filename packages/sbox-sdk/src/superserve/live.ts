import type { LiveConfig } from "../live/types.js";
import { superserve } from "./index.js";

export const live: LiveConfig = {
  conformance: {
    template: {
      source: {
        context: { "hello.txt": "hi" },
        dockerfile:
          "FROM debian:bookworm-slim\nRUN mkdir -p /app\nCOPY hello.txt /app/hello.txt\n",
      },
    },
  },
  env: ["SUPERSERVE_API_KEY"],
  make: () =>
    superserve({
      apiKey: process.env.SUPERSERVE_API_KEY!,
      ...(process.env.SUPERSERVE_BASE_URL
        ? { baseUrl: process.env.SUPERSERVE_BASE_URL }
        : {}),
    }),
  name: "superserve",
};
