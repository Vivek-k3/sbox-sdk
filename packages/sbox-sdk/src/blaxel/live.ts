import type { LiveConfig } from "../live/types.js";
import { blaxel } from "./index.js";

export const live: LiveConfig = {
  conformance: {
    spec: process.env.BL_REGION ? { region: process.env.BL_REGION } : undefined,
    template: {
      source: {
        context: { "hello.txt": "hi" },
        dockerfile:
          "FROM debian:bookworm-slim\nCOPY hello.txt /app/hello.txt\n",
      },
    },
  },
  env: ["BL_API_KEY", "BL_WORKSPACE"],
  make: () =>
    blaxel({
      apiKey: process.env.BL_API_KEY,
      region: process.env.BL_REGION,
      workspace: process.env.BL_WORKSPACE,
    }),
  name: "blaxel",
};
