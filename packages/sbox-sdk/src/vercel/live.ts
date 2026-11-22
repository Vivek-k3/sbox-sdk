import type { LiveConfig } from "../live/types.js";
import { vercel } from "./index.js";

/**
 * Runs with an access token plus team and project ids
 * (`VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`), or with a
 * `VERCEL_OIDC_TOKEN` from `vercel env pull`, which the SDK reads itself.
 */
export const live: LiveConfig = {
  available: async () =>
    !!process.env.VERCEL_OIDC_TOKEN ||
    (!!process.env.VERCEL_TOKEN &&
      !!process.env.VERCEL_TEAM_ID &&
      !!process.env.VERCEL_PROJECT_ID),
  conformance: {
    expectedCaps: {
      codeInterpreter: "unsupported",
      templateBuild: "unsupported",
    },
  },
  env: [],
  make: () =>
    vercel({
      projectId: process.env.VERCEL_PROJECT_ID,
      teamId: process.env.VERCEL_TEAM_ID,
      token: process.env.VERCEL_TOKEN,
    }),
  name: "vercel",
};
