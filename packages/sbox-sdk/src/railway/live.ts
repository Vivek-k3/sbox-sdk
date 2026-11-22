import type { LiveConfig } from "../live/types.js";
import { railway } from "./index.js";

/**
 * Runs with either a project token (`RAILWAY_TOKEN`, environment implied) or
 * an account/workspace token plus an environment
 * (`RAILWAY_API_TOKEN` + `RAILWAY_ENVIRONMENT_ID`). The SDK reads these itself.
 */
export const live: LiveConfig = {
  available: async () =>
    !!process.env.RAILWAY_TOKEN ||
    (!!process.env.RAILWAY_API_TOKEN && !!process.env.RAILWAY_ENVIRONMENT_ID),
  conformance: {
    // Preview domains are declared at create time and need PRIVATE networking.
    spec: { ports: [8080] },
  },
  env: [],
  make: () => railway({ networkIsolation: "PRIVATE" }),
  name: "railway",
};
