#!/usr/bin/env node
/**
 * `sbox` CLI — diagnostics + a one-shot runner for the unified sandbox SDK.
 *
 * Every command lazy-imports only the provider it touches (and the vendor SDK
 * only when a sandbox is actually created), so the published `bin` never bundles
 * all provider SDKs. `caps` and `doctor` are fully offline; `exec` and `list`
 * talk to the real provider using credentials from the environment.
 */
import { createRequire } from "node:module";

import type { CapabilityLevel } from "./internal/capabilities.js";
import type { SandboxProvider } from "./internal/types.js";

type ProviderFactory = (opts?: Record<string, unknown>) => SandboxProvider;

interface ProviderMeta {
  /** Exported capability-map const, e.g. `E2B_CAPS`. */
  caps: string;
  /** Exported provider-factory, e.g. `e2b`. */
  factory: string;
  /** Vendor peer SDK to install, or `null` when the adapter is REST-only. */
  pkg: string | null;
}

/** Registry of the network-backed adapters the CLI can drive by id. */
const PROVIDERS: Record<string, ProviderMeta> = {
  e2b: { caps: "E2B_CAPS", factory: "e2b", pkg: "@e2b/code-interpreter" },
  vercel: { caps: "VERCEL_CAPS", factory: "vercel", pkg: "@vercel/sandbox" },
  cloudflare: {
    caps: "CLOUDFLARE_CAPS",
    factory: "cloudflare",
    pkg: "@cloudflare/sandbox",
  },
  daytona: { caps: "DAYTONA_CAPS", factory: "daytona", pkg: "@daytonaio/sdk" },
  modal: { caps: "MODAL_CAPS", factory: "modal", pkg: "modal" },
  fly: { caps: "FLY_CAPS", factory: "fly", pkg: null },
  "aws-lambda": {
    caps: "AWS_LAMBDA_CAPS",
    factory: "awsLambda",
    pkg: "@aws-sdk/client-lambda-microvms",
  },
  northflank: {
    caps: "NORTHFLANK_CAPS",
    factory: "northflank",
    pkg: "@northflank/js-client",
  },
  runloop: {
    caps: "RUNLOOP_CAPS",
    factory: "runloop",
    pkg: "@runloop/api-client",
  },
  codesandbox: {
    caps: "CODESANDBOX_CAPS",
    factory: "codesandbox",
    pkg: "@codesandbox/sdk",
  },
  morph: { caps: "MORPH_CAPS", factory: "morph", pkg: "morphcloud" },
  blaxel: { caps: "BLAXEL_CAPS", factory: "blaxel", pkg: "@blaxel/core" },
  beam: { caps: "BEAM_CAPS", factory: "beam", pkg: "@beamcloud/beam-js" },
  railway: { caps: "RAILWAY_CAPS", factory: "railway", pkg: "railway" },
};

const LEVEL_SYMBOL: Record<CapabilityLevel, string> = {
  emulated: "◐",
  native: "●",
  unsupported: "○",
};

function write(s: string): void {
  process.stdout.write(`${s}\n`);
}

function writeErr(s: string): void {
  process.stderr.write(`${s}\n`);
}

function unknownProvider(id: string): number {
  writeErr(
    `sbox: unknown provider '${id}'. Known: ${Object.keys(PROVIDERS).join(", ")}`
  );
  return 1;
}

/** Import a built adapter module by id (cheap — vendor SDK stays lazy). */
async function importProvider(id: string): Promise<Record<string, unknown>> {
  return (await import(`./${id}/index.js`)) as Record<string, unknown>;
}

function printHelp(): void {
  write(
    [
      "sbox — one unified CLI for agent sandbox providers",
      "",
      "Usage:",
      "  sbox caps <provider>            print a provider's capability matrix",
      "  sbox doctor [<provider>]        validate node + provider SDK setup",
      "  sbox exec <provider> -- <cmd>   run one command in a fresh sandbox",
      "  sbox list <provider>            list a provider's live sandboxes",
      "",
      `Providers: ${Object.keys(PROVIDERS).join(", ")}`,
      "",
      "Credentials for exec/list are read from the environment (see each",
      "provider's docs). caps and doctor run fully offline.",
    ].join("\n")
  );
}

async function cmdCaps(id: string | undefined): Promise<number> {
  if (!id) {
    writeErr("sbox: caps needs a provider, e.g. `sbox caps e2b`");
    return 1;
  }
  const meta = PROVIDERS[id];
  if (!meta) {
    return unknownProvider(id);
  }
  const mod = await importProvider(id);
  const map = mod[meta.caps] as Record<string, CapabilityLevel> | undefined;
  if (!map) {
    writeErr(`sbox: '${id}' does not export ${meta.caps}`);
    return 1;
  }
  const names = Object.keys(map).toSorted();
  const width = Math.max(...names.map((n) => n.length));
  const counts: Record<CapabilityLevel, number> = {
    emulated: 0,
    native: 0,
    unsupported: 0,
  };
  write(`${id} capabilities\n`);
  for (const name of names) {
    const level = map[name];
    if (!level) {
      continue;
    }
    counts[level]++;
    write(`  ${LEVEL_SYMBOL[level]} ${name.padEnd(width)}  ${level}`);
  }
  write(
    `\n  ${counts.native} native · ${counts.emulated} emulated · ${counts.unsupported} unsupported`
  );
  return 0;
}

async function cmdDoctor(id: string | undefined): Promise<number> {
  let ok = true;
  write("sbox doctor\n");

  const major = Number(process.versions.node.split(".")[0]);
  const nodeOk = major >= 20;
  ok &&= nodeOk;
  write(
    `  ${nodeOk ? "✔" : "✖"} node ${process.versions.node}${
      nodeOk ? "" : " (requires >= 20)"
    }`
  );

  if (id) {
    const meta = PROVIDERS[id];
    if (!meta) {
      return unknownProvider(id);
    }
    if (meta.pkg) {
      const req = createRequire(import.meta.url);
      let installed = true;
      try {
        req.resolve(meta.pkg);
      } catch {
        installed = false;
      }
      ok &&= installed;
      write(
        installed
          ? `  ✔ provider SDK '${meta.pkg}' is installed`
          : `  ✖ provider SDK '${meta.pkg}' is missing — run: npm install ${meta.pkg}`
      );
    } else {
      write(`  ✔ ${id} needs no extra SDK (uses the platform REST API)`);
    }
  }

  write(`\n  ${ok ? "all checks passed" : "some checks failed"}`);
  return ok ? 0 : 1;
}

async function withProvider(
  id: string,
  fn: (provider: SandboxProvider) => Promise<number>
): Promise<number> {
  const meta = PROVIDERS[id];
  if (!meta) {
    return unknownProvider(id);
  }
  const mod = await importProvider(id);
  const factory = mod[meta.factory] as ProviderFactory | undefined;
  if (!factory) {
    writeErr(`sbox: '${id}' does not export ${meta.factory}`);
    return 1;
  }
  return await fn(factory({}));
}

async function cmdExec(
  id: string | undefined,
  command: string
): Promise<number> {
  if (!(id && command)) {
    writeErr("sbox: usage: sbox exec <provider> -- <cmd>");
    return 1;
  }
  const { createSandboxClient } = await import("./index.js");
  return await withProvider(id, async (provider) => {
    const client = createSandboxClient({ provider });
    try {
      const sandbox = await client.create();
      try {
        const res = await sandbox.commands.run(command);
        if (res.stdout) {
          process.stdout.write(res.stdout);
        }
        if (res.stderr) {
          process.stderr.write(res.stderr);
        }
        return res.exitCode ?? 0;
      } finally {
        await sandbox.destroy();
      }
    } finally {
      await client.dispose();
    }
  });
}

async function cmdList(id: string | undefined): Promise<number> {
  if (!id) {
    writeErr("sbox: list needs a provider, e.g. `sbox list e2b`");
    return 1;
  }
  const { createSandboxClient } = await import("./index.js");
  return await withProvider(id, async (provider) => {
    const client = createSandboxClient({ provider });
    try {
      let n = 0;
      for await (const info of client.list()) {
        n++;
        const state = info.state ? ` [${info.state}]` : "";
        write(`${info.id}${state}`);
      }
      if (n === 0) {
        write("(no sandboxes)");
      }
      return 0;
    } finally {
      await client.dispose();
    }
  });
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return 0;
  }

  switch (cmd) {
    case "caps":
      return await cmdCaps(rest[0]);
    case "doctor": {
      const flag = rest.indexOf("--provider");
      const id = flag === -1 ? rest[0] : rest[flag + 1];
      return await cmdDoctor(id);
    }
    case "exec": {
      const sep = rest.indexOf("--");
      const command = (sep === -1 ? rest.slice(1) : rest.slice(sep + 1)).join(
        " "
      );
      return await cmdExec(rest[0], command);
    }
    case "list":
      return await cmdList(rest[0]);
    default:
      writeErr(`sbox: unknown command '${cmd}'. Try \`sbox help\`.`);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    writeErr(`sbox: ${message}`);
    process.exit(1);
  });
