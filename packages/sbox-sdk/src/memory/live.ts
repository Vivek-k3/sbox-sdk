import type { LiveConfig } from "../live/types.js";
import { memory } from "./index.js";

export const live: LiveConfig = {
  conformance: {
    template: {
      source: {
        context: { "hello.txt": "hi" },
        dockerfile: "FROM scratch\nCOPY hello.txt /app/hello.txt\n",
      },
    },
  },
  env: [],
  make: () => memory(),
  name: "memory",
};
