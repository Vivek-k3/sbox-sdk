import type { LiveConfig } from "../live/types.js";
import { freestyle } from "./index.js";

export const live: LiveConfig = {
  conformance: {
    template: {
      source: {
        context: { "hello.txt": "hi" },
        // Emulated build: Freestyle boots VM snapshots, so FROM must name an
        // Ubuntu/BusyBox base or a snapshot.
        dockerfile:
          "FROM ubuntu:24.04\nRUN mkdir -p /app\nCOPY hello.txt /app/hello.txt\n",
      },
    },
  },
  env: ["FREESTYLE_API_KEY"],
  make: () =>
    freestyle({
      apiKey: process.env.FREESTYLE_API_KEY!,
      ...(process.env.FREESTYLE_BASE_URL
        ? { baseUrl: process.env.FREESTYLE_BASE_URL }
        : {}),
    }),
  name: "freestyle",
};
