/**
 * Streaming markdown renderer for the Ask AI chat.
 *
 * The assistant streams raw markdown token-by-token, so we re-process it on
 * every update: remark -> rehype -> React via `hast-util-to-jsx-runtime`, with
 * fenced code blocks handed to Fumadocs' `DynamicCodeBlock` for syntax
 * highlighting and the rest wired to the default MDX components so the answer
 * matches the surrounding docs. A tiny `rehypeWrapWords` plugin wraps words in
 * fade-in spans for a smooth streaming feel, and results are memoised per text
 * so re-renders during a stream stay cheap.
 */
import { DynamicCodeBlock } from "fumadocs-ui/components/dynamic-codeblock";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { ElementContent, Root, RootContent } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Children, Suspense, use, useDeferredValue } from "react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import { visit } from "unist-util-visit";

interface Processor {
  process: (content: string) => Promise<ReactNode>;
}

const rehypeWrapWords = () => (tree: Root) => {
  visit(tree, ["text", "element"], (node, index, parent) => {
    if (node.type === "element" && node.tagName === "pre") {
      return "skip";
    }
    if (node.type !== "text" || !parent || index === undefined) {
      return;
    }

    const words = node.value.split(/(?=\s)/u);
    const newNodes: ElementContent[] = words.flatMap((word) => {
      if (word.length === 0) {
        return [];
      }

      return {
        children: [{ type: "text", value: word }],
        properties: { class: "animate-fd-fade-in" },
        tagName: "span",
        type: "element",
      };
    });

    Object.assign(node, {
      children: newNodes,
      properties: {},
      tagName: "span",
      type: "element",
    } satisfies RootContent);
    return "skip";
  });
};

const Pre = (props: ComponentProps<"pre">) => {
  const code = Children.only(props.children) as ReactElement;
  const codeProps = code.props as ComponentProps<"code">;
  const content = codeProps.children;
  if (typeof content !== "string") {
    return null;
  }

  let lang =
    codeProps.className
      ?.split(" ")
      .find((v) => v.startsWith("language-"))
      ?.slice("language-".length) ?? "text";

  if (lang === "mdx") {
    lang = "md";
  }

  return <DynamicCodeBlock code={content.trimEnd()} lang={lang} />;
};

const createProcessor = (): Processor => {
  const processor = remark()
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeWrapWords);

  return {
    process: async (content) => {
      const nodes = processor.parse({ value: content });
      const hast = await processor.run(nodes);

      return toJsxRuntime(hast, {
        Fragment,
        components: {
          ...defaultMdxComponents,
          img: undefined,
          pre: Pre,
        },
        development: false,
        jsx,
        jsxs,
      });
    },
  };
};

const processor = createProcessor();
const cache = new Map<string, Promise<ReactNode>>();

const Renderer = ({ text }: { text: string }) => {
  const result = cache.get(text) ?? processor.process(text);
  cache.set(text, result);

  return use(result);
};

export const Markdown = ({ text }: { text: string }) => {
  const deferredText = useDeferredValue(text);

  return (
    <Suspense fallback={<p className="invisible">{text}</p>}>
      <Renderer text={deferredText} />
    </Suspense>
  );
};
