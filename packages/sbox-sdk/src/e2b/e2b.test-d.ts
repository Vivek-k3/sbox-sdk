import { expectTypeOf } from "vitest";

import { createSandboxClient } from "../index.js";
import type {
  CodeAPI,
  NetworkAPI,
  PortsAPI,
  PtyAPI,
  SnapshotsAPI,
  SshAPI,
  TemplatesAPI,
  VolumesAPI,
} from "../internal/types.js";
import { memory } from "../memory/index.js";
import { e2b } from "./index.js";

// Type-level proof that capability gating is reflected in the public types:
// supported sub-APIs are present, unsupported ones are typed `undefined`.
export async function _typeChecks(): Promise<void> {
  const e2bClient = createSandboxClient({ provider: e2b({ apiKey: "x" }) });
  const sb = await e2bClient.create();

  // E2B: code interpreter, snapshots, ports, egress, PTY -> present.
  expectTypeOf(sb.code).toEqualTypeOf<CodeAPI>();
  expectTypeOf(sb.snapshots).toEqualTypeOf<SnapshotsAPI>();
  expectTypeOf(sb.ports).toEqualTypeOf<PortsAPI>();
  expectTypeOf(sb.network).toEqualTypeOf<NetworkAPI>();
  expectTypeOf(sb.pty).toEqualTypeOf<PtyAPI>();
  // E2B has no SSH -> typed `undefined`.
  expectTypeOf(sb.ssh).toEqualTypeOf<undefined>();
  expectTypeOf(sb.ssh).not.toEqualTypeOf<SshAPI>();
  // Template builds + volumes live on the client.
  expectTypeOf(e2bClient.templates).toEqualTypeOf<TemplatesAPI>();
  expectTypeOf(e2bClient.volumes).toEqualTypeOf<VolumesAPI>();
  // Options: everything optional (falls back to E2B_API_KEY / E2B_DOMAIN).
  expectTypeOf(e2b).parameter(0).toEqualTypeOf<{
    apiKey?: string;
    domain?: string;
    allowPublicTraffic?: boolean;
    requestTimeoutMs?: number;
  }>();

  const memClient = createSandboxClient({ provider: memory() });
  const msb = await memClient.create();
  // Memory has no code interpreter -> calling it would be a compile error.
  expectTypeOf(msb.code).toEqualTypeOf<undefined>();
  // Memory exposes snapshots (native) and egress control (native).
  expectTypeOf(msb.snapshots).toEqualTypeOf<SnapshotsAPI>();
  expectTypeOf(msb.network).toEqualTypeOf<NetworkAPI>();
}
