import type { LiveConfig } from "../live/types.js";
import { tensorlake } from "./index.js";

export const live: LiveConfig = {
  conformance: {
    template: {
      source: {
        context: { "hello.txt": "from template" },
        dockerfile: "FROM ubuntu:24.04\nCOPY hello.txt /opt/sbox/hello.txt\n",
      },
    },
    workdir: "/tmp",
  },
  env: ["TENSORLAKE_API_KEY"],
  make: () =>
    tensorlake({
      apiKey: process.env.TENSORLAKE_API_KEY!,
      ...(process.env.TENSORLAKE_API_URL
        ? { apiUrl: process.env.TENSORLAKE_API_URL }
        : {}),
      ...(process.env.TENSORLAKE_PROJECT_ID
        ? { projectId: process.env.TENSORLAKE_PROJECT_ID }
        : {}),
    }),
  name: "tensorlake",
};
