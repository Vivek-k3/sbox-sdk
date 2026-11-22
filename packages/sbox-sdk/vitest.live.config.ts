import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/live/live.test.ts"],
    testTimeout: 15 * 60_000,
    // Providers run sequentially to stay inside free-tier concurrency limits.
    fileParallelism: false,
  },
});
