// fumadocs' built-in `remarkNpm` doesn't export its npm->manager converter, so
// we reimplement the small subset our install snippets use (plain `npm install
// <pkgs>`, plus npx). Shared by docs tabs and the landing-page install command.
export type PackageManager = "bun" | "pnpm" | "npm" | "yarn";

type ConvertibleManager = Exclude<PackageManager, "npm">;

const convertNpm = (command: string, to: ConvertibleManager): string =>
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

export const convertNpmCommand = (
  command: string,
  to: PackageManager
): string => (to === "npm" ? command : convertNpm(command, to));
