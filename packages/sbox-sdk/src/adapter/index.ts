/**
 * `sbox-sdk/adapter` — the authoring kit for provider adapters. Implement
 * `SandboxProvider` and return it from a factory wrapped in `defineProvider`.
 * Everything an adapter needs (contract types, capability helpers, the error
 * taxonomy, and shell-emulation helpers) is re-exported from here.
 */
import type { CapabilityMap } from "../internal/capabilities.js";
import type { SandboxProvider } from "../internal/types.js";

/** Typed-identity wrapper so a provider factory infers its Caps/Raw/Opts. */
export function defineProvider<Caps extends CapabilityMap, Raw, Opts>(
  factory: (opts: Opts) => SandboxProvider<Caps, Raw>
): (opts: Opts) => SandboxProvider<Caps, Raw> {
  return factory;
}

// ---- contract + result/option types ----
export type {
  SandboxProvider,
  DriverHandle,
  DriverExec,
  DriverProcess,
  CallContext,
  MaybePromise,
  SandboxSpec,
  SandboxInfo,
  SandboxState,
  ResourceSpec,
  VolumeMount,
  SecretRef,
  ExecOptions,
  ExecResult,
  OutputEvent,
  ProcessInfo,
  FileBody,
  FileType,
  FileInfo,
  DirEntry,
  StoredFile,
  FsEvent,
  Preview,
  EgressPolicy,
  SshCredentials,
  KernelContext,
  RichResult,
  CodeExecution,
  SnapshotRef,
  ListFilter,
} from "../internal/types.js";

// ---- capability helpers + types ----
export {
  baseCapabilities,
  defaultFlags,
  freezeCapabilities,
  isCapable,
  assertCapability,
} from "../internal/capabilities.js";
export type {
  CapabilityMap,
  CapabilityLevel,
  CapabilityName,
  CapabilityFlags,
  Capabilities,
  PreviewModel,
} from "../internal/capabilities.js";

// ---- error taxonomy ----
export {
  SandboxError,
  NotSupportedError,
  ProviderNotFoundError,
  AllProvidersFailedError,
  isRetryableStatus,
  isRetryableError,
} from "../internal/errors.js";
export type {
  SandboxErrorCode,
  SandboxErrorInit,
  ProviderAttempt,
} from "../internal/errors.js";

// ---- shell-emulation helpers (for exec-over-transport adapters) ----
export {
  shellQuote,
  joinCmd,
  bakeCwdEnv,
  buildExecCommand,
  parseLsOutput,
  parseStatOutput,
  EXIT_MARKER,
} from "../internal/shell.js";
export type { BuiltExec } from "../internal/shell.js";

// ---- runtime probe ----
export { detectRuntime, hasFetch } from "../internal/runtime.js";
export type { Runtime } from "../internal/runtime.js";

// ---- stream bridge (push callbacks -> AsyncIterable<OutputEvent>) ----
export { AsyncQueue, numExit } from "../internal/stream.js";

// ---- encoding helpers (exec-over-text fs) ----
export { base64ToBytes, bytesToBase64 } from "../internal/encoding.js";
