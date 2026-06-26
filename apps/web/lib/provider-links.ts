/**
 * Official website / docs / source links per adapter, shown on each adapter
 * page via `<ProviderLinks>`. The in-memory provider has no external home.
 */

export interface ProviderLink {
  label: string;
  href: string;
}

export const PROVIDER_LINKS: Record<string, ProviderLink[]> = {
  "aws-lambda": [
    {
      href: "https://aws.amazon.com/lambda/lambda-microvms/",
      label: "Website",
    },
    {
      href: "https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html",
      label: "Docs",
    },
  ],
  beam: [
    { href: "https://www.beam.cloud", label: "Website" },
    { href: "https://docs.beam.cloud/v2/sandbox/overview", label: "Docs" },
    { href: "https://github.com/beam-cloud/beta9", label: "GitHub" },
  ],
  blaxel: [
    { href: "https://blaxel.ai", label: "Website" },
    { href: "https://docs.blaxel.ai", label: "Docs" },
    { href: "https://github.com/blaxel-ai/sdk-typescript", label: "GitHub" },
  ],
  cloudflare: [
    { href: "https://www.cloudflare.com", label: "Website" },
    { href: "https://developers.cloudflare.com/containers/", label: "Docs" },
    { href: "https://github.com/cloudflare/sandbox-sdk", label: "GitHub" },
  ],
  codesandbox: [
    { href: "https://codesandbox.io", label: "Website" },
    { href: "https://codesandbox.io/docs/sdk", label: "Docs" },
    { href: "https://github.com/codesandbox/codesandbox-sdk", label: "GitHub" },
  ],
  daytona: [
    { href: "https://www.daytona.io", label: "Website" },
    { href: "https://www.daytona.io/docs", label: "Docs" },
    { href: "https://github.com/daytonaio/daytona", label: "GitHub" },
  ],
  e2b: [
    { href: "https://e2b.dev", label: "Website" },
    { href: "https://e2b.dev/docs", label: "Docs" },
    { href: "https://github.com/e2b-dev/E2B", label: "GitHub" },
  ],
  fly: [
    { href: "https://fly.io", label: "Website" },
    { href: "https://fly.io/docs/machines/", label: "Docs" },
    { href: "https://fly.io/docs/machines/api/", label: "Machines API" },
  ],
  modal: [
    { href: "https://modal.com", label: "Website" },
    { href: "https://modal.com/docs", label: "Docs" },
  ],
  morph: [
    { href: "https://www.morph.so", label: "Website" },
    { href: "https://cloud.morph.so/docs", label: "Docs" },
    {
      href: "https://github.com/morph-labs/morph-typescript-sdk",
      label: "GitHub",
    },
  ],
  northflank: [
    { href: "https://northflank.com", label: "Website" },
    {
      href: "https://northflank.com/docs/v1/application/sandboxes/sandboxes-on-northflank",
      label: "Docs",
    },
    {
      href: "https://github.com/northflank/northflank-js-client",
      label: "GitHub",
    },
  ],
  railway: [
    { href: "https://railway.com", label: "Website" },
    { href: "https://docs.railway.com/sandboxes", label: "Docs" },
  ],
  runloop: [
    { href: "https://www.runloop.ai", label: "Website" },
    { href: "https://docs.runloop.ai", label: "Docs" },
    { href: "https://github.com/runloopai/api-client-ts", label: "GitHub" },
  ],
  vercel: [
    { href: "https://vercel.com", label: "Website" },
    { href: "https://vercel.com/docs/vercel-sandbox", label: "Docs" },
  ],
};
