import { PROVIDER_LINKS } from "@/lib/provider-links";

/**
 * Renders an adapter's official website / docs / source links as outbound
 * chips. Usage in MDX: `<ProviderLinks provider="e2b" />`
 */
export const ProviderLinks = ({ provider }: { provider: string }) => {
  const links = PROVIDER_LINKS[provider];
  if (!links || links.length === 0) {
    return null;
  }

  return (
    <div className="not-prose my-6 flex flex-wrap gap-2">
      {links.map((link) => (
        <a
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-1.5 font-mono text-foreground text-xs no-underline transition-colors hover:bg-accent/60"
          href={link.href}
          key={link.href}
          rel="noreferrer"
          target="_blank"
        >
          {link.label}
          <svg
            aria-hidden="true"
            className="size-3 text-dim"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path d="M7 17 17 7" />
            <path d="M7 7h10v10" />
          </svg>
        </a>
      ))}
    </div>
  );
};
