import type { LiveConfig } from "../live/types.js";
import { daytona } from "./index.js";

export const live: LiveConfig = {
  conformance: {
    template: {
      source: {
        context: { "hello.txt": "hi" },
        dockerfile:
          "FROM debian:bookworm-slim\nCOPY hello.txt /app/hello.txt\n",
      },
    },
  },
  env: ["DAYTONA_API_KEY"],
  make: () =>
    daytona({
      apiKey: process.env.DAYTONA_API_KEY,
      target: process.env.DAYTONA_TARGET,
    }),
  name: "daytona",
};
