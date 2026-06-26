import { source } from "@/lib/source";

export const revalidate = false;

// Canonical site (matches metadataBase in app/layout.tsx).
const SITE = "https://sbox-sdk.dev";

const SECTION_TITLES: Record<string, string> = {
  adapters: "Adapters",
  ai: "AI agent tools",
  api: "API reference",
  general: "General",
  plugins: "Plugins",
};
const SECTION_ORDER = ["general", "adapters", "plugins", "ai", "api"];

export const GET = () => {
  const groups = new Map<string, string[]>();

  for (const page of source.getPages()) {
    const section = page.url.split("/").find(Boolean) ?? "general";
    const desc = page.data.description ? `: ${page.data.description}` : "";
    const line = `- [${page.data.title}](${SITE}/llms.mdx${page.url})${desc}`;
    const list = groups.get(section) ?? [];
    list.push(line);
    groups.set(section, list);
  }

  const sections = [...groups.keys()].toSorted((a, b) => {
    const ia = SECTION_ORDER.indexOf(a);
    const ib = SECTION_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const body = [
    "# sbox SDK",
    "",
    "> One unified TypeScript SDK for agent sandbox providers (E2B, Vercel, Cloudflare, and a built-in in-memory provider). One namespaced API, capability gating, a single error taxonomy, a typed escape hatch, and a plugin system that exposes sandbox tools to AI agent frameworks.",
    "",
    ...sections.flatMap((section) => [
      `## ${SECTION_TITLES[section] ?? section}`,
      "",
      ...(groups.get(section) ?? []),
      "",
    ]),
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
