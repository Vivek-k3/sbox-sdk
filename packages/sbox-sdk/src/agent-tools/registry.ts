/**
 * The 10 canonical sandbox tools, each mapped to the real core `Sandbox` API,
 * plus `createSandboxTools` — the resolver that gates them by the sandbox's
 * capabilities and applies `only` / `forbid`. This is the single source of
 * truth every framework adapter projects from.
 */
import { z } from "zod";

import type { Sandbox } from "../internal/types.js";
import { err, ok } from "./result.js";
import type { ToolResult } from "./result.js";
import type {
  Risk,
  ToolAnnotations,
  ToolName,
  ToolRunContext,
  ToolSetOptions,
  ToolSpec,
} from "./types.js";

// --------------------------------------------------------------------------
// annotation presets (MCP-aligned)
// --------------------------------------------------------------------------

const READ_ONLY: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
};
const MUTATING: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
  readOnlyHint: false,
};
const DESTRUCTIVE: ToolAnnotations = {
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
  readOnlyHint: false,
};
const EXEC: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
  readOnlyHint: false,
};

// --------------------------------------------------------------------------
// authoring helper — gives type-safe execute, returns a homogeneous ToolSpec
// --------------------------------------------------------------------------

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function defineTool<S extends z.ZodType>(def: {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: S;
  outputSchema?: z.ZodType;
  risk: Risk;
  annotations: ToolAnnotations;
  riskFor?: (input: z.infer<S>) => Risk;
  run: (input: z.infer<S>, ctx: ToolRunContext) => Promise<ToolResult>;
}): ToolSpec {
  const parse = (raw: unknown): z.infer<S> =>
    def.inputSchema.parse(raw) as z.infer<S>;
  const { riskFor } = def;
  return {
    annotations: def.annotations,
    description: def.description,
    async execute(raw: unknown, ctx: ToolRunContext): Promise<ToolResult> {
      let input: z.infer<S>;
      try {
        input = parse(raw);
      } catch (error) {
        return err(`invalid input for ${def.name}: ${errMsg(error)}`);
      }
      try {
        return await def.run(input, ctx);
      } catch (error) {
        return err(`${def.name} failed: ${errMsg(error)}`);
      }
    },
    inputSchema: def.inputSchema,
    name: def.name,
    outputSchema: def.outputSchema,
    risk: def.risk,
    riskFor: riskFor ? (raw: unknown): Risk => riskFor(parse(raw)) : undefined,
    title: def.title,
  };
}

// --------------------------------------------------------------------------
// the 10 tools — each builder closes over the live sandbox
// --------------------------------------------------------------------------

const buildExec = (sandbox: Sandbox): ToolSpec =>
  defineTool({
    annotations: EXEC,
    description:
      "Run a shell command in the sandbox and return its stdout, stderr, and exit code. Use for installing packages, running scripts, inspecting files, and general shell work.",
    inputSchema: z.object({
      command: z
        .string()
        .describe("The shell command to run, e.g. 'ls -la /app'"),
      cwd: z.string().optional().describe("Working directory for the command"),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Abort the command after this many milliseconds"),
    }),
    name: "sbox_exec",
    risk: "mutating",
    run: async ({ command, cwd, timeoutMs }, ctx) => {
      const res = await sandbox.commands.run(command, {
        cwd,
        signal: ctx.signal,
        timeoutMs,
      });
      const parts: string[] = [];
      if (res.stdout) {
        parts.push(res.stdout.replace(/\s+$/, ""));
      }
      if (res.stderr) {
        parts.push(`[stderr]\n${res.stderr.replace(/\s+$/, "")}`);
      }
      parts.push(`[exit ${res.exitCode}]`);
      return ok(parts.join("\n"), {
        exitCode: res.exitCode,
        stderr: res.stderr,
        stdout: res.stdout,
      });
    },
    title: "Run shell command",
  });

const buildRunCode = (sandbox: Sandbox): ToolSpec =>
  defineTool({
    annotations: MUTATING,
    description:
      "Execute a snippet of code in the sandbox's stateful interpreter (e.g. Python/Node) and return its output, rich results, and any error/traceback.",
    inputSchema: z.object({
      code: z.string().describe("The source code to execute"),
      language: z
        .string()
        .optional()
        .describe("Language id, e.g. 'python' or 'javascript'"),
    }),
    name: "sbox_run_code",
    risk: "mutating",
    run: async ({ code, language }) => {
      if (!sandbox.code) {
        return err("code interpreter is not available");
      }
      const ex = await sandbox.code.runCode(code, { language });
      if (ex.error) {
        return err(
          `${ex.error.name}: ${ex.error.value}${
            ex.error.traceback ? `\n${ex.error.traceback}` : ""
          }`
        );
      }
      const stdout = ex.logs.stdout.join("").replace(/\s+$/, "");
      const stderr = ex.logs.stderr.join("").replace(/\s+$/, "");
      const rich = ex.results
        .map((r) => r.text ?? "")
        .filter(Boolean)
        .join("\n");
      const text =
        [stdout, stderr, rich].filter(Boolean).join("\n") || "(no output)";
      return ok(text, ex);
    },
    title: "Run code in interpreter",
  });

const buildFsRead = (sandbox: Sandbox): ToolSpec =>
  defineTool({
    annotations: READ_ONLY,
    description:
      "Read and return the UTF-8 text contents of a file in the sandbox.",
    inputSchema: z.object({
      path: z
        .string()
        .describe("Absolute or relative path of the file to read"),
    }),
    name: "sbox_fs_read",
    risk: "safe",
    run: async ({ path }) => {
      const file = await sandbox.files.read(path);
      const content = await file.text();
      return ok(content, { content, path });
    },
    title: "Read file",
  });

const buildFsWrite = (sandbox: Sandbox): ToolSpec =>
  defineTool({
    annotations: MUTATING,
    description:
      "Create or overwrite a file in the sandbox with the given UTF-8 text content.",
    inputSchema: z.object({
      content: z.string().describe("The full text content to write"),
      path: z.string().describe("Path of the file to write"),
    }),
    name: "sbox_fs_write",
    risk: "mutating",
    run: async ({ path, content }) => {
      await sandbox.files.write(path, content);
      return ok(`Wrote ${content.length} bytes to ${path}`, {
        bytes: content.length,
        path,
      });
    },
    title: "Write file",
  });

const buildFsList = (sandbox: Sandbox): ToolSpec =>
  defineTool({
    annotations: READ_ONLY,
    description:
      "List the entries (files and directories) of a directory in the sandbox.",
    inputSchema: z.object({
      path: z.string().describe("Path of the directory to list"),
    }),
    name: "sbox_fs_list",
    risk: "safe",
    run: async ({ path }) => {
      const entries = await sandbox.files.list(path);
      const text =
        entries
          .map(
            (e) =>
              `${e.type === "dir" ? "d" : e.type === "symlink" ? "l" : "-"} ${e.name}`
          )
          .join("\n") || "(empty)";
      return ok(text, { entries });
    },
    title: "List directory",
  });

const buildFsRemove = (sandbox: Sandbox): ToolSpec =>
  defineTool({
    annotations: DESTRUCTIVE,
    description:
      "Delete a file or directory in the sandbox. Set recursive=true to remove a non-empty directory. This is destructive.",
    inputSchema: z.object({
      path: z.string().describe("Path to delete"),
      recursive: z
        .boolean()
        .optional()
        .describe("Remove directories and their contents recursively"),
    }),
    name: "sbox_fs_remove",
    risk: "destructive",
    run: async ({ path, recursive }) => {
      await sandbox.files.remove(path, { recursive });
      return ok(`Removed ${path}`, { path });
    },
    title: "Remove file or directory",
  });

const buildExposePort = (sandbox: Sandbox): ToolSpec =>
  defineTool({
    annotations: EXEC,
    description:
      "Expose a port running inside the sandbox and return a public preview URL the model (or user) can open.",
    inputSchema: z.object({
      port: z.number().int().positive().describe("The port number to expose"),
      private: z
        .boolean()
        .optional()
        .describe("If true, require an access token instead of being public"),
    }),
    name: "sbox_expose_port",
    risk: "mutating",
    run: async ({ port, private: isPrivate }) => {
      if (!sandbox.ports) {
        return err("port exposure is not available");
      }
      const preview = await sandbox.ports.expose(port, { private: isPrivate });
      return ok(`Exposed port ${port} at ${preview.url}`, preview);
    },
    title: "Expose port",
  });

const buildSnapshot = (sandbox: Sandbox): ToolSpec =>
  defineTool({
    annotations: MUTATING,
    description:
      "Create, restore, list, or delete sandbox snapshots. 'restore' overwrites the sandbox's current state; 'delete' removes a snapshot — both are destructive.",
    inputSchema: z.object({
      action: z.enum(["create", "restore", "list", "delete"]),
      name: z
        .string()
        .optional()
        .describe("Optional name when creating a snapshot"),
      ref: z
        .string()
        .optional()
        .describe("Snapshot id — required for 'restore' and 'delete'"),
    }),
    name: "sbox_snapshot",
    risk: "mutating",
    riskFor: ({ action }): Risk =>
      action === "restore" || action === "delete"
        ? "destructive"
        : action === "create"
          ? "mutating"
          : "safe",
    run: async ({ action, ref, name }) => {
      const snaps = sandbox.snapshots;
      if (!snaps) {
        return err("snapshots are not supported");
      }
      switch (action) {
        case "create": {
          const created = await snaps.create({ name });
          return ok(`Created snapshot ${created.id}`, created);
        }
        case "restore": {
          if (!ref) {
            return err("'ref' is required to restore a snapshot");
          }
          await snaps.restore(ref);
          return ok(`Restored snapshot ${ref}`);
        }
        case "list": {
          const list = await snaps.list();
          return ok(list.map((s) => s.id).join("\n") || "(no snapshots)", list);
        }
        case "delete": {
          if (!ref) {
            return err("'ref' is required to delete a snapshot");
          }
          await snaps.delete(ref);
          return ok(`Deleted snapshot ${ref}`);
        }
      }
    },
    title: "Manage snapshots",
  });

const buildLifecycle = (sandbox: Sandbox): ToolSpec =>
  defineTool({
    annotations: MUTATING,
    description:
      "Inspect or change the sandbox lifecycle: getInfo, setTimeout, stop, pause, resume, or destroy. 'stop' and 'destroy' tear the sandbox down and are destructive.",
    inputSchema: z.object({
      action: z.enum([
        "getInfo",
        "setTimeout",
        "stop",
        "pause",
        "resume",
        "destroy",
      ]),
      ttlMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("New time-to-live in ms — required for 'setTimeout'"),
    }),
    name: "sbox_lifecycle",
    risk: "mutating",
    riskFor: ({ action }): Risk =>
      action === "stop" || action === "destroy"
        ? "destructive"
        : action === "getInfo"
          ? "safe"
          : "mutating",
    run: async ({ action, ttlMs }) => {
      switch (action) {
        case "getInfo": {
          const info = await sandbox.getInfo();
          return ok(
            `state=${info.state} id=${info.id} provider=${info.provider}`,
            info
          );
        }
        case "setTimeout": {
          if (ttlMs === undefined || ttlMs === null) {
            return err("'ttlMs' is required for setTimeout");
          }
          await sandbox.setTimeout(ttlMs);
          return ok(`Timeout set to ${ttlMs}ms`);
        }
        case "stop": {
          await sandbox.stop();
          return ok("Sandbox stopped");
        }
        case "pause": {
          await sandbox.pause();
          return ok("Sandbox paused");
        }
        case "resume": {
          await sandbox.resume();
          return ok("Sandbox resumed");
        }
        case "destroy": {
          await sandbox.destroy();
          return ok("Sandbox destroyed");
        }
      }
    },
    title: "Sandbox lifecycle",
  });

const buildSetEgress = (sandbox: Sandbox): ToolSpec =>
  defineTool({
    annotations: MUTATING,
    description:
      "Set the sandbox's outbound network policy: allow all, block all, or allow only specific domains/CIDRs.",
    inputSchema: z.object({
      cidrs: z
        .array(z.string())
        .optional()
        .describe("Allowed CIDR ranges when mode is 'allow-list'"),
      domains: z
        .array(z.string())
        .optional()
        .describe("Allowed domains when mode is 'allow-list'"),
      mode: z.enum(["allow-all", "block-all", "allow-list"]),
    }),
    name: "sbox_set_egress",
    risk: "mutating",
    run: async ({ mode, domains, cidrs }) => {
      if (!sandbox.network) {
        return err("egress control is not supported");
      }
      await sandbox.network.setEgressPolicy({ cidrs, domains, mode });
      return ok(`Egress policy set to ${mode}`);
    },
    title: "Set egress policy",
  });

// --------------------------------------------------------------------------
// registry + resolver
// --------------------------------------------------------------------------

interface Entry {
  readonly name: ToolName;
  readonly gate: (sandbox: Sandbox) => boolean;
  readonly build: (sandbox: Sandbox) => ToolSpec;
}

const ENTRIES: readonly Entry[] = [
  { build: buildExec, gate: () => true, name: "sbox_exec" },
  {
    build: buildRunCode,
    gate: (s) => s.can("codeInterpreter"),
    name: "sbox_run_code",
  },
  { build: buildFsRead, gate: () => true, name: "sbox_fs_read" },
  { build: buildFsWrite, gate: () => true, name: "sbox_fs_write" },
  { build: buildFsList, gate: () => true, name: "sbox_fs_list" },
  { build: buildFsRemove, gate: () => true, name: "sbox_fs_remove" },
  {
    build: buildExposePort,
    gate: (s) => s.can("exposePort"),
    name: "sbox_expose_port",
  },
  {
    build: buildSnapshot,
    gate: (s) => s.can("snapshot"),
    name: "sbox_snapshot",
  },
  { build: buildLifecycle, gate: () => true, name: "sbox_lifecycle" },
  {
    build: buildSetEgress,
    gate: (s) => s.can("egressControl"),
    name: "sbox_set_egress",
  },
];

/**
 * Build the provider-neutral tool set for a sandbox: only the tools whose
 * capabilities the provider supports, minus `forbid`, intersected with `only`.
 * This `ToolSpec[]` is the input to every `toXTools` adapter.
 */
export function createSandboxTools(
  sandbox: Sandbox,
  opts: ToolSetOptions = {}
): ToolSpec[] {
  const only = opts.only ? new Set<ToolName>(opts.only) : undefined;
  const forbid = new Set<ToolName>([
    ...(opts.policy?.forbid ?? []),
    ...(opts.forbid ?? []),
  ]);
  return ENTRIES.filter(
    (e) => e.gate(sandbox) && (!only || only.has(e.name)) && !forbid.has(e.name)
  ).map((e) => e.build(sandbox));
}
