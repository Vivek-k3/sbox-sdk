import { defineConfig, defineDocs } from "fumadocs-mdx/config";

import { convertNpmCommand } from "./lib/convert-npm";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      themes: {
        dark: "vitesse-dark",
        light: "vitesse-light",
      },
    },
    remarkNpmOptions: {
      // Order: pnpm, bun, npm, yarn — the first entry is the default-selected tab.
      packageManagers: [
        {
          command: (cmd: string) => convertNpmCommand(cmd, "pnpm"),
          name: "pnpm",
        },
        {
          command: (cmd: string) => convertNpmCommand(cmd, "bun"),
          name: "bun",
        },
        { command: (cmd: string) => convertNpmCommand(cmd, "npm"), name: "npm" },
        {
          command: (cmd: string) => convertNpmCommand(cmd, "yarn"),
          name: "yarn",
        },
      ],
      persist: { id: "package-manager" },
    },
  },
});
