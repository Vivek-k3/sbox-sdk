import type { LiveConfig } from "../live/types.js";
import { cloudflare } from "./index.js";

/**
 * Cloudflare sandboxes only exist inside a Worker: the provider needs the
 * `env.Sandbox` Durable Object binding, which Node can't obtain. The live
 * suite therefore always skips here; run `runConformance(cloudflare({ binding:
 * env.Sandbox }), { live: true })` from a Worker (e.g. `wrangler dev`) instead.
 */
export const live: LiveConfig = {
  available: async () => false,
  env: [],
  make: () => cloudflare({ binding: undefined }),
  name: "cloudflare",
};
