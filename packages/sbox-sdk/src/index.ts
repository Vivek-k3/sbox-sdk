/**
 * sbox-sdk — one unified SDK for agent sandbox providers.
 *
 * Pick a provider by importing its adapter from a subpath and passing it in:
 *
 * ```ts
 * import { createSandboxClient } from "sbox-sdk";
 * import { e2b } from "sbox-sdk/e2b";
 *
 * const client = createSandboxClient({ provider: e2b({ apiKey }) });
 * const sandbox = await client.create({ template: "python-3.12" });
 * const { stdout } = await sandbox.commands.run("echo hi");
 * ```
 */

export { createSandboxClient } from "./internal/client.js";

export {
  SandboxError,
  NotSupportedError,
  ProviderNotFoundError,
  AllProvidersFailedError,
  isRetryableError,
  isRetryableStatus,
} from "./internal/errors.js";
export type {
  SandboxErrorCode,
  SandboxErrorInit,
  ProviderAttempt,
} from "./internal/errors.js";

export type {
  CapabilityLevel,
  CapabilityMap,
  CapabilityName,
  CapabilityFlags,
  Capabilities,
  Gated,
  PreviewModel,
} from "./internal/capabilities.js";

export type * from "./internal/types.js";

export type {
  SandboxPlugin,
  PluginSetupContext,
  MergePlugins,
} from "./internal/plugin.js";
