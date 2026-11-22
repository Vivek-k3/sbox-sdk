import type { LiveConfig } from "../live/types.js";
import { northflank } from "./index.js";

const snapshots = process.env.NORTHFLANK_SNAPSHOTS === "1";

export const live: LiveConfig = {
  conformance: {
    skip: [
      // pause = scale to zero: the ephemeral disk is dropped by design.
      "lifecycle: pause/resume keeps files",
      // Container snapshots need a Kata-backed cluster; opt in with
      // NORTHFLANK_SNAPSHOTS=1.
      ...(snapshots
        ? []
        : ["snapshots: create returns a ref", "fork: clone sees parent files"]),
    ],
    template: { source: { image: "ubuntu:24.04" } },
  },
  env: ["NORTHFLANK_API_TOKEN", "NORTHFLANK_PROJECT_ID"],
  make: () =>
    northflank({
      deploymentPlan: process.env.NORTHFLANK_PLAN,
      projectId: process.env.NORTHFLANK_PROJECT_ID!,
      teamId: process.env.NORTHFLANK_TEAM_ID,
      token: process.env.NORTHFLANK_API_TOKEN!,
    }),
  name: "northflank",
};
