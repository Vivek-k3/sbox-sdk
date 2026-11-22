import type { LiveConfig } from "../live/types.js";
import { fly } from "./index.js";

/**
 * Live run: needs an existing Fly app (`fly apps create <name>`) with a public
 * IP for the preview checks (`fly ips allocate-v6 -a <name>`).
 */
export const live: LiveConfig = {
  conformance: {
    spec: { region: process.env.FLY_REGION },
  },
  env: ["FLY_API_TOKEN", "FLY_APP_NAME"],
  make: () =>
    fly({
      apiToken: process.env.FLY_API_TOKEN!,
      appName: process.env.FLY_APP_NAME!,
      region: process.env.FLY_REGION,
    }),
  name: "fly",
};
