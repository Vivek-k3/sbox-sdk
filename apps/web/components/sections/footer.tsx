import Link from "next/link";

const COLUMNS = [
  {
    heading: "Docs",
    links: [
      { href: "/general/overview", text: "Overview" },
      { href: "/general/installation", text: "Installation" },
      { href: "/general/usage", text: "Usage" },
      { href: "/general/capabilities", text: "Capabilities" },
    ],
  },
  {
    heading: "API",
    links: [
      { href: "/api/client", text: "Client" },
      { href: "/api/commands", text: "Commands" },
      { href: "/api/files", text: "Files" },
      { href: "/general/errors", text: "Errors" },
    ],
  },
  {
    heading: "Adapters",
    links: [
      { href: "/adapters/memory", text: "In-Memory" },
      { href: "/adapters/e2b", text: "E2B" },
      { href: "/adapters/vercel", text: "Vercel" },
      { href: "/adapters/cloudflare", text: "Cloudflare" },
      { href: "/adapters/daytona", text: "Daytona" },
      { href: "/adapters/modal", text: "Modal" },
      { href: "/adapters/fly", text: "Fly Machines" },
      { href: "/adapters/aws-lambda", text: "AWS Lambda MicroVMs" },
    ],
  },
];

export const Footer = () => (
  <footer className="border-t border-border">
    <div className="mx-auto max-w-6xl px-6 py-16">
      <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="flex items-center gap-2 font-display text-base font-semibold text-foreground">
            <span className="size-1.5 rounded-full bg-native" />
            sbox SDK
          </p>
          <p className="mt-3 max-w-[28ch] text-sm text-muted-foreground">
            One unified SDK for agent sandbox providers. Swap the adapter, keep
            your code.
          </p>
        </div>
        {COLUMNS.map((col) => (
          <div key={col.heading}>
            <p className="font-data text-[10px] tracking-[0.18em] text-dim uppercase">
              {col.heading}
            </p>
            <ul className="mt-3 space-y-2">
              {col.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {link.text}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="mt-12 font-mono text-xs text-muted-foreground">
        MIT licensed · sbox-sdk
      </p>
    </div>
  </footer>
);
