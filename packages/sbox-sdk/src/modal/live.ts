import type { LiveConfig } from "../live/types.js";
import { modal } from "./index.js";

export const live: LiveConfig = {
  conformance: {
    // Modal's default sandbox lifetime is 5 minutes; give the suite room.
    spec: { lifecycle: { maxAgeMs: 30 * 60_000 } },
    // Modal templates can't COPY local context (JS SDK limitation).
    template: {
      source: {
        dockerfile: "FROM debian:bookworm-slim\nRUN echo hi > /opt/hello.txt\n",
      },
    },
  },
  env: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"],
  make: () =>
    modal({
      appName: process.env.MODAL_APP_NAME ?? "sbox-sdk-live",
      environment: process.env.MODAL_ENVIRONMENT,
      tokenId: process.env.MODAL_TOKEN_ID,
      tokenSecret: process.env.MODAL_TOKEN_SECRET,
    }),
  name: "modal",
};
