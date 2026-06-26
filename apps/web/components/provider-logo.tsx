import { PROVIDER_ICONS } from "@/lib/icons";

/**
 * Shows an adapter's logo in a framed tile. Used at the top of each adapter
 * docs page. Usage in MDX: `<ProviderLogo id="e2b" />`
 */
export const ProviderLogo = ({ id }: { id: string }) => {
  const Icon = PROVIDER_ICONS[id];
  if (!Icon) {
    return null;
  }

  return (
    <span className="not-prose mb-4 inline-flex size-12 items-center justify-center rounded-xl border border-border bg-muted/30">
      <Icon className="size-6 text-foreground" />
    </span>
  );
};
