import type { LiveConfig } from "../live/types.js";
import { beam } from "./index.js";

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
  env: ["BEAM_TOKEN", "BEAM_WORKSPACE_ID"],
  make: () =>
    beam({
      token: process.env.BEAM_TOKEN,
      workspaceId: process.env.BEAM_WORKSPACE_ID,
    }),
  name: "beam",
};
