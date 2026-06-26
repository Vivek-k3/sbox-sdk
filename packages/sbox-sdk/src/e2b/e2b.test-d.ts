import { expectTypeOf } from "vitest";

import { createSandboxClient } from "../index.js";
import type { CodeAPI, NetworkAPI, SnapshotsAPI } from "../internal/types.js";
import { memory } from "../memory/index.js";
import { e2b } from "./index.js";

// Type-level proof that capability gating is reflected in the public types:
// supported sub-APIs are present, unsupported ones are typed `undefined`.
export async function _typeChecks(): Promise<void> {
  const e2bClient = createSandboxClient({ provider: e2b({ apiKey: "x" }) });
  const sb = await e2bClient.create();

  // E2B supports the code interpreter + snapshots -> sub-APIs are present.
  expectTypeOf(sb.code).toEqualTypeOf<CodeAPI>();
  expectTypeOf(sb.snapshots).toEqualTypeOf<SnapshotsAPI>();
  // E2B has no egress control -> network is typed `undefined`.
  expectTypeOf(sb.network).toEqualTypeOf<undefined>();

  const memClient = createSandboxClient({ provider: memory() });
  const msb = await memClient.create();
  // Memory has no code interpreter -> calling it would be a compile error.
  expectTypeOf(msb.code).toEqualTypeOf<undefined>();
  expectTypeOf(msb.network).toEqualTypeOf<undefined>();
  // Memory exposes ports (emulated) + snapshots (native).
  expectTypeOf(msb.snapshots).toEqualTypeOf<SnapshotsAPI>();
  expectTypeOf(msb.network).not.toEqualTypeOf<NetworkAPI>();
}
