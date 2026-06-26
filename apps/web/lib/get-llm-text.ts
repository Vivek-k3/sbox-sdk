import type { source } from "@/lib/source";

export const getLLMText = async (page: (typeof source)["$inferPage"]) => {
  const content = await page.data.getText("processed");

  return `# ${page.data.title} (${page.url})

${page.data.description ?? ""}

${content}`;
};
