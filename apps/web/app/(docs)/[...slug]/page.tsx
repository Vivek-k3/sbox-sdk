import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/page";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageActions } from "@/components/page-actions";
import { getLLMText } from "@/lib/get-llm-text";
import { PROVIDER_ICONS } from "@/lib/icons";
import { source } from "@/lib/source";
import { getMDXComponents } from "@/mdx-components";

const protocol = process.env.NODE_ENV === "production" ? "https" : "http";
const origin = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "localhost:3000";
const baseUrl = `${protocol}://${origin}`;

const githubContentBase =
  "https://github.com/sbox-sdk/sbox-sdk/blob/main/apps/web/content/docs";

interface PageProps {
  params: Promise<{ slug: string[] }>;
}

const Page = async ({ params }: PageProps) => {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) {
    notFound();
  }

  const MDX = page.data.body;
  const markdown = await getLLMText(page);
  const markdownUrl = `${page.url}.md`;

  const iconId = typeof page.data.icon === "string" ? page.data.icon : undefined;
  const TitleIcon = iconId ? PROVIDER_ICONS[iconId] : undefined;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle className="flex items-center gap-2.5 font-semibold tracking-tight">
        {TitleIcon ? (
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/30">
            <TitleIcon className="size-5 text-foreground" />
          </span>
        ) : null}
        {page.data.title}
      </DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <PageActions
        githubUrl={`${githubContentBase}/${page.path}`}
        markdown={markdown}
        markdownAbsoluteUrl={`${baseUrl}${markdownUrl}`}
        markdownUrl={markdownUrl}
      />
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
};

export default Page;

export const generateStaticParams = () => source.generateParams();

export const generateMetadata = async ({
  params,
}: PageProps): Promise<Metadata> => {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) {
    notFound();
  }

  return {
    description: page.data.description,
    title: page.data.title,
  };
};
