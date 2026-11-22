import type { LiveConfig } from "../live/types.js";
import { runloop } from "./index.js";

export const live: LiveConfig = {
  env: ["RUNLOOP_API_KEY"],
  make: () => runloop({ apiKey: process.env.RUNLOOP_API_KEY }),
  name: "runloop",
};
