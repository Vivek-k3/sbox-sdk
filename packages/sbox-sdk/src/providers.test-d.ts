import { expectTypeOf } from "vitest";

import { awsLambda } from "./aws-lambda/index.js";
import { beam } from "./beam/index.js";
import { blaxel } from "./blaxel/index.js";
import { cloudflare } from "./cloudflare/index.js";
import { codesandbox } from "./codesandbox/index.js";
import { daytona } from "./daytona/index.js";
import { fly } from "./fly/index.js";
import { createSandboxClient } from "./index.js";
import type { CodeAPI, PortsAPI, SnapshotsAPI } from "./internal/types.js";
import { modal } from "./modal/index.js";
import { morph } from "./morph/index.js";
import { northflank } from "./northflank/index.js";
import { railway } from "./railway/index.js";
import { runloop } from "./runloop/index.js";
import { vercel } from "./vercel/index.js";

// Per-provider proof that capability gating is reflected in the public types.
export async function _providerTypeChecks(): Promise<void> {
  const cf = await createSandboxClient({
    provider: cloudflare({ binding: {} }),
  }).create();
  expectTypeOf(cf.code).toEqualTypeOf<CodeAPI>(); // Cloudflare has a code interpreter
  expectTypeOf(cf.network).toEqualTypeOf<undefined>(); // ...but no egress control

  const vc = await createSandboxClient({
    provider: vercel({ projectId: "y", teamId: "x", token: "t" }),
  }).create();
  expectTypeOf(vc.code).toEqualTypeOf<undefined>(); // Vercel: no code interpreter (compile error to call)
  expectTypeOf(vc.ports).toEqualTypeOf<PortsAPI>(); // ...but it exposes ports

  // Tier-2 ----------------------------------------------------------------
  const dy = await createSandboxClient({
    provider: daytona({ apiKey: "k" }),
  }).create();
  expectTypeOf(dy.code).toEqualTypeOf<CodeAPI>(); // Daytona has a code interpreter
  expectTypeOf(dy.snapshots).toEqualTypeOf<undefined>(); // ...snapshots gated off

  const md = await createSandboxClient({ provider: modal({}) }).create();
  expectTypeOf(md.code).toEqualTypeOf<undefined>(); // Modal: no code interpreter

  const fl = await createSandboxClient({
    provider: fly({ apiToken: "t", appName: "a" }),
  }).create();
  expectTypeOf(fl.code).toEqualTypeOf<undefined>();
  expectTypeOf(fl.ports).toEqualTypeOf<PortsAPI>();

  const aws = await createSandboxClient({
    provider: awsLambda({ imageIdentifier: "arn" }),
  }).create();
  expectTypeOf(aws.code).toEqualTypeOf<undefined>();
  expectTypeOf(aws.ports).toEqualTypeOf<PortsAPI>();

  // Tier-3 ----------------------------------------------------------------
  const nf = await createSandboxClient({
    provider: northflank({ token: "t", projectId: "p" }),
  }).create();
  expectTypeOf(nf.ports).toEqualTypeOf<PortsAPI>(); // public service ports
  expectTypeOf(nf.snapshots).toEqualTypeOf<undefined>(); // services platform: no snapshots
  expectTypeOf(nf.code).toEqualTypeOf<undefined>();

  const rl = await createSandboxClient({
    provider: runloop({ apiKey: "k" }),
  }).create();
  expectTypeOf(rl.snapshots).toEqualTypeOf<SnapshotsAPI>(); // snapshotDisk + fork
  expectTypeOf(rl.code).toEqualTypeOf<undefined>();

  const csb = await createSandboxClient({
    provider: codesandbox({ apiKey: "k" }),
  }).create();
  expectTypeOf(csb.ports).toEqualTypeOf<PortsAPI>();
  expectTypeOf(csb.code).toEqualTypeOf<undefined>(); // general VM, no kernel API

  const mp = await createSandboxClient({
    provider: morph({ apiKey: "k" }),
  }).create();
  expectTypeOf(mp.snapshots).toEqualTypeOf<SnapshotsAPI>(); // snapshot + branch
  expectTypeOf(mp.network).toEqualTypeOf<undefined>(); // no egress control

  // Tier-4 ----------------------------------------------------------------
  const bl = await createSandboxClient({
    provider: blaxel({ apiKey: "k" }),
  }).create();
  expectTypeOf(bl.ports).toEqualTypeOf<PortsAPI>(); // preview URLs
  expectTypeOf(bl.snapshots).toEqualTypeOf<undefined>();

  const bm = await createSandboxClient({ provider: beam({}) }).create();
  expectTypeOf(bm.snapshots).toEqualTypeOf<SnapshotsAPI>(); // snapshot + fork
  expectTypeOf(bm.code).toEqualTypeOf<undefined>();

  const rw = await createSandboxClient({
    provider: railway({}),
  }).create();
  expectTypeOf(rw.snapshots).toEqualTypeOf<SnapshotsAPI>(); // checkpoint + fork
  expectTypeOf(rw.ports).toEqualTypeOf<undefined>(); // network-isolated, no ports
}
