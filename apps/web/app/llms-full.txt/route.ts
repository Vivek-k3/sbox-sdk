import { getLLMText } from "@/lib/get-llm-text";
import { source } from "@/lib/source";

export const revalidate = false;

// The entire documentation concatenated as one markdown file, for pasting into
// an LLM context window.
export const GET = async () => {
  const pages = source.getPages();
  const texts = await Promise.all(pages.map((page) => getLLMText(page)));

  return new Response(texts.join("\n\n---\n\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
