/**
 * Type-level proof that each adapter's capability table drives the public
 * types: gated sub-APIs are the real interface when supported and `undefined`
 * (a compile error to call) when not. Uses the exported `*_CAPS` consts, so it
 * needs no credentials and catches accidental capability regressions.
 */
import { expectTypeOf } from "vitest";

import type { AWS_LAMBDA_CAPS } from "./aws-lambda/index.js";
import type { BEAM_CAPS } from "./beam/index.js";
import type { BLAXEL_CAPS } from "./blaxel/index.js";
import type { CLOUDFLARE_CAPS } from "./cloudflare/index.js";
import type { DAYTONA_CAPS } from "./daytona/index.js";
import type { DOCKER_CAPS } from "./docker/index.js";
import type { E2B_CAPS } from "./e2b/index.js";
import type { FREESTYLE_CAPS } from "./freestyle/index.js";
import type {
  CodeAPI,
  NetworkAPI,
  PortsAPI,
  PtyAPI,
  Sandbox,
  SandboxClient,
  SnapshotsAPI,
  SshAPI,
  TemplatesAPI,
  VolumesAPI,
} from "./internal/types.js";
import type { MemoryCaps } from "./memory/index.js";
import type { MODAL_CAPS } from "./modal/index.js";
import type { RAILWAY_CAPS } from "./railway/index.js";
import type { SPRITES_CAPS } from "./sprites/index.js";
import type { SUPERSERVE_CAPS } from "./superserve/index.js";
import type { TENSORLAKE_CAPS } from "./tensorlake/index.js";
import type { TOGETHER_CAPS } from "./together/index.js";
import type { VERCEL_CAPS } from "./vercel/index.js";

type SB<C> = C extends import("./internal/capabilities.js").CapabilityMap
  ? Sandbox<C>
  : never;
type Client<C> = C extends import("./internal/capabilities.js").CapabilityMap
  ? SandboxClient<C>
  : never;

export function _providerTypeChecks(): void {
  // Borat's targets: templates + PTY + previews
  expectTypeOf<
    Client<typeof DOCKER_CAPS>["templates"]
  >().toEqualTypeOf<TemplatesAPI>();
  expectTypeOf<SB<typeof DOCKER_CAPS>["pty"]>().toEqualTypeOf<PtyAPI>();
  expectTypeOf<SB<typeof DOCKER_CAPS>["ssh"]>().toEqualTypeOf<undefined>();

  expectTypeOf<
    Client<typeof E2B_CAPS>["templates"]
  >().toEqualTypeOf<TemplatesAPI>();
  expectTypeOf<
    Client<typeof E2B_CAPS>["volumes"]
  >().toEqualTypeOf<VolumesAPI>();
  expectTypeOf<SB<typeof E2B_CAPS>["code"]>().toEqualTypeOf<CodeAPI>();

  expectTypeOf<
    Client<typeof DAYTONA_CAPS>["templates"]
  >().toEqualTypeOf<TemplatesAPI>();
  expectTypeOf<
    SB<typeof DAYTONA_CAPS>["snapshots"]
  >().toEqualTypeOf<SnapshotsAPI>();
  expectTypeOf<SB<typeof DAYTONA_CAPS>["ssh"]>().toEqualTypeOf<SshAPI>();

  expectTypeOf<SB<typeof MODAL_CAPS>["code"]>().toEqualTypeOf<undefined>();
  expectTypeOf<SB<typeof MODAL_CAPS>["network"]>().toEqualTypeOf<NetworkAPI>();

  expectTypeOf<
    Client<typeof TENSORLAKE_CAPS>["templates"]
  >().toEqualTypeOf<TemplatesAPI>();
  expectTypeOf<SB<typeof TENSORLAKE_CAPS>["ssh"]>().toEqualTypeOf<undefined>();

  // Cloud adapters
  expectTypeOf<SB<typeof VERCEL_CAPS>["code"]>().toEqualTypeOf<undefined>();
  expectTypeOf<SB<typeof VERCEL_CAPS>["pty"]>().toEqualTypeOf<PtyAPI>();
  expectTypeOf<
    Client<typeof VERCEL_CAPS>["templates"]
  >().toEqualTypeOf<undefined>();

  expectTypeOf<SB<typeof CLOUDFLARE_CAPS>["code"]>().toEqualTypeOf<CodeAPI>();
  expectTypeOf<
    SB<typeof CLOUDFLARE_CAPS>["network"]
  >().toEqualTypeOf<NetworkAPI>();

  expectTypeOf<
    SB<typeof BLAXEL_CAPS>["snapshots"]
  >().toEqualTypeOf<SnapshotsAPI>();
  expectTypeOf<SB<typeof BEAM_CAPS>["code"]>().toEqualTypeOf<CodeAPI>();
  expectTypeOf<SB<typeof RAILWAY_CAPS>["ports"]>().toEqualTypeOf<PortsAPI>();
  expectTypeOf<
    Client<typeof RAILWAY_CAPS>["templates"]
  >().toEqualTypeOf<undefined>();
  expectTypeOf<SB<typeof AWS_LAMBDA_CAPS>["code"]>().toEqualTypeOf<undefined>();

  // New adapters
  expectTypeOf<SB<typeof FREESTYLE_CAPS>["ssh"]>().toEqualTypeOf<SshAPI>();
  expectTypeOf<SB<typeof SUPERSERVE_CAPS>["pty"]>().toEqualTypeOf<undefined>();
  expectTypeOf<SB<typeof SPRITES_CAPS>["pty"]>().toEqualTypeOf<PtyAPI>();
  expectTypeOf<SB<typeof TOGETHER_CAPS>["ports"]>().toEqualTypeOf<undefined>();

  // The in-memory reference implements everything except the code interpreter.
  expectTypeOf<SB<MemoryCaps>["code"]>().toEqualTypeOf<undefined>();
  expectTypeOf<SB<MemoryCaps>["pty"]>().toEqualTypeOf<PtyAPI>();
  expectTypeOf<Client<MemoryCaps>["templates"]>().toEqualTypeOf<TemplatesAPI>();
}
