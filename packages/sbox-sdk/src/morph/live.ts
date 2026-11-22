import type { LiveConfig } from "../live/types.js";
import { morph } from "./index.js";

export const live: LiveConfig = {
  conformance: {
    template: {
      source: {
        dockerfile:
          "FROM morphvm-minimal\nRUN mkdir -p /opt/sbox && echo ok > /opt/sbox/marker\n",
      },
    },
  },
  env: ["MORPH_API_KEY"],
  make: () => morph({ apiKey: process.env.MORPH_API_KEY }),
  name: "morph",
};
