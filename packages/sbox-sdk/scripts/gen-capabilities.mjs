#!/usr/bin/env node
/**
 * Writes apps/web/lib/capabilities.generated.json from the BUILT adapters
 * (run `pnpm build` first). The docs site renders its capability matrix from
 * this file, so it can never drift from the SDK's real `*_CAPS` tables.
 *
 *   node scripts/gen-capabilities.mjs           # write
 *   node scripts/gen-capabilities.mjs --check   # exit 1 if out of date
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const here = import.meta.dirname;
const dist = join(here, "..", "dist");
const out = join(
  here,
  "..",
  "..",
  "..",
  "apps",
  "web",
  "lib",
  "capabilities.generated.json"
);

export const ADAPTERS = [
  "memory",
  "docker",
  "e2b",
  "daytona",
  "vercel",
  "modal",
  "tensorlake",
  "superserve",
  "sprites",
  "freestyle",
  "together",
  "blaxel",
  "beam",
  "railway",
  "northflank",
  "fly",
  "aws-lambda",
  "morph",
  "cloudflare",
  "codesandbox",
  "runloop",
];
const DEPRECATED = new Set(["cloudflare", "codesandbox", "runloop"]);

// Silence one-time deprecation warnings from factories.
const { warn } = console;
console.warn = () => {
  // deliberately silenced while reading capability tables
};
const result = {};
for (const id of ADAPTERS) {
  const mod = await import(join(dist, id, "index.js"));
  const factory = Object.values(mod).find(
    (v) => typeof v === "function" && v.length <= 1 && !/^[A-Z]/u.test(v.name)
  );
  let provider;
  for (const opts of [{}, { apiKey: "x", binding: {}, token: "x" }]) {
    try {
      provider = (mod[id === "aws-lambda" ? "awsLambda" : id] ?? factory)(opts);
      break;
    } catch {
      // try the next option shape
    }
  }
  if (!provider) {
    throw new Error(`cannot instantiate ${id} to read its capabilities`);
  }
  result[id] = {
    caps: Object.fromEntries(Object.entries(provider.capabilities).toSorted()),
    deprecated: DEPRECATED.has(id),
    flags: {
      previewBrowserAuth: provider.flags.previewBrowserAuth ?? false,
      previewModel: provider.flags.previewModel,
      templateSources: provider.flags.templateSources ?? [],
    },
    name: provider.name,
  };
}
console.warn = warn;

const json = `${JSON.stringify(result, null, 2)}\n`;
if (process.argv.includes("--check")) {
  // Compare parsed content: the repo formatter may reflow the JSON file.
  const current = await readFile(out, "utf-8").catch(() => "{}");
  if (JSON.stringify(JSON.parse(current)) !== JSON.stringify(result)) {
    console.error(
      "capabilities.generated.json is stale: run `pnpm gen:capabilities`"
    );
    process.exit(1);
  }
  console.log("capabilities.generated.json is up to date");
} else {
  await writeFile(out, json);
  console.log(`wrote ${out} (${ADAPTERS.length} adapters)`);
}
