import { defineConfig, defineDocs } from "fumadocs-mdx/config";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

// fumadocs' built-in `remarkNpm` doesn't export its npm->manager converter, so
// we reimplement the small subset our install snippets use (plain `npm install
// <pkgs>`, plus npx). This lets us control the tab order + default selection.
type Manager = "pnpm" | "yarn" | "bun";

const convertNpm = (command: string, to: Manager): string =>
  command
    .split("\n")
    .map((rawLine) => {
      const line = rawLine.trim();
      if (line.length === 0) {
        return rawLine;
      }

      if (line.startsWith("npx ")) {
        const rest = line.slice(4);
        if (to === "pnpm") {
          return `pnpm dlx ${rest}`;
        }
        if (to === "yarn") {
          return `yarn dlx ${rest}`;
        }
        return `bunx ${rest}`;
      }

      const match = line.match(/^npm (?:install|i)\b(.*)$/u);
      if (!match) {
        return rawLine;
      }

      let rest = match[1].trim();
      const dev = /(?:^|\s)(?:-D|--save-dev)(?:\s|$)/u.test(rest);
      rest = rest.replaceAll(/(?:^|\s)(?:-D|--save-dev)(?:\s|$)/gu, " ").trim();

      const verb = rest.length > 0 ? "add" : "install";
      let out = `${to} ${verb}`;
      if (rest.length > 0) {
        out += ` ${rest}`;
      }
      if (dev && rest.length > 0) {
        out += to === "yarn" ? " --dev" : " -D";
      }
      return out;
    })
    .join("\n");

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
        { command: (cmd: string) => convertNpm(cmd, "pnpm"), name: "pnpm" },
        { command: (cmd: string) => convertNpm(cmd, "bun"), name: "bun" },
        { command: (cmd: string) => cmd, name: "npm" },
        { command: (cmd: string) => convertNpm(cmd, "yarn"), name: "yarn" },
      ],
      persist: { id: "package-manager" },
    },
  },
});
