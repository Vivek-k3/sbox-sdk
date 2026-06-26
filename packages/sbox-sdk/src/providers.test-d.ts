import { expectTypeOf } from "vitest";

import { awsLambda } from "./aws-lambda/index.js";
import { cloudflare } from "./cloudflare/index.js";
import { daytona } from "./daytona/index.js";
import { fly } from "./fly/index.js";
import { createSandboxClient } from "./index.js";
import type { CodeAPI, PortsAPI } from "./internal/types.js";
import { modal } from "./modal/index.js";
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
}
