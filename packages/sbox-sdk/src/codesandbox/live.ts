import type { LiveConfig } from "../live/types.js";
import { codesandbox } from "./index.js";

export const live: LiveConfig = {
  conformance: {
    // CodeSandbox commands run in a PTY: stdout and stderr are one stream.
    skip: ["exec: stdout and stderr are separate"],
  },
  env: ["CSB_API_KEY"],
  make: () => codesandbox({ apiKey: process.env.CSB_API_KEY }),
  name: "codesandbox",
};
