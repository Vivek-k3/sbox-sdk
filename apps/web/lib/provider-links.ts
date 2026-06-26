/**
 * Official website / docs / source links per adapter, shown on each adapter
 * page via `<ProviderLinks>`. The in-memory provider has no external home.
 */

export interface ProviderLink {
  label: string;
  href: string;
}

export const PROVIDER_LINKS: Record<string, ProviderLink[]> = {
  e2b: [
    { label: "Website", href: "https://e2b.dev" },
    { label: "Docs", href: "https://e2b.dev/docs" },
    { label: "GitHub", href: "https://github.com/e2b-dev/E2B" },
  ],
  vercel: [
    { label: "Website", href: "https://vercel.com" },
    { label: "Docs", href: "https://vercel.com/docs/vercel-sandbox" },
  ],
  cloudflare: [
    { label: "Website", href: "https://www.cloudflare.com" },
    { label: "Docs", href: "https://developers.cloudflare.com/containers/" },
    { label: "GitHub", href: "https://github.com/cloudflare/sandbox-sdk" },
  ],
  daytona: [
    { label: "Website", href: "https://www.daytona.io" },
    { label: "Docs", href: "https://www.daytona.io/docs" },
    { label: "GitHub", href: "https://github.com/daytonaio/daytona" },
  ],
  modal: [
    { label: "Website", href: "https://modal.com" },
    { label: "Docs", href: "https://modal.com/docs" },
  ],
  fly: [
    { label: "Website", href: "https://fly.io" },
    { label: "Docs", href: "https://fly.io/docs/machines/" },
    { label: "Machines API", href: "https://fly.io/docs/machines/api/" },
  ],
  "aws-lambda": [
    { label: "Website", href: "https://aws.amazon.com/lambda/lambda-microvms/" },
    {
      label: "Docs",
      href: "https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html",
    },
  ],
};
