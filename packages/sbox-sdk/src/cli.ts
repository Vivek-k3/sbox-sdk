#!/usr/bin/env node
/**
 * `sbox` CLI — diagnostics + smoke runner. Full commands (caps / doctor / exec /
 * list) land in M9; this stub keeps the published `bin` wired and lazy-imports
 * providers so the CLI never bundles every SDK.
 */
const [cmd] = process.argv.slice(2);

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  process.stdout.write(
    [
      "sbox-sdk CLI",
      "",
      "Usage:",
      "  sbox caps <provider>     print a provider's capability matrix",
      "  sbox doctor --provider <id>   validate setup",
      "  sbox exec <provider> -- <cmd> run one command in a fresh sandbox",
      "  sbox list <provider>     list sandboxes",
      "",
      "(commands are implemented in milestone M9)",
      "",
    ].join("\n")
  );
  process.exit(0);
}

process.stderr.write(`sbox: command '${cmd}' is not implemented yet\n`);
process.exit(1);
