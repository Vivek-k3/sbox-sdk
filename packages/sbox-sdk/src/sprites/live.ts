import type { LiveConfig } from "../live/types.js";
import { sprites } from "./index.js";

export const live: LiveConfig = {
  conformance: {
    // Sprites run as the `sprite` user; /tmp is writable.
    workdir: "/tmp",
  },
  env: ["SPRITES_TOKEN"],
  make: () =>
    sprites({
      ...(process.env.SPRITES_BASE_URL
        ? { baseURL: process.env.SPRITES_BASE_URL }
        : {}),
      token: process.env.SPRITES_TOKEN!,
    }),
  name: "sprites",
};
