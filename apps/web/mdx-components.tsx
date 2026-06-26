import {
  createFileSystemGeneratorCache,
  createGenerator,
} from "fumadocs-typescript";
import { AutoTypeTable } from "fumadocs-typescript/ui";
import type { AutoTypeTableProps } from "fumadocs-typescript/ui";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

import { CapabilityMatrix } from "@/components/sections/capability-matrix";

const typeGenerator = createGenerator({
  cache: createFileSystemGeneratorCache(".next/fumadocs-typescript"),
});

export const getMDXComponents = (
  components?: MDXComponents
): MDXComponents => ({
  ...defaultMdxComponents,
  AutoTypeTable: (props: Partial<AutoTypeTableProps>) => (
    <AutoTypeTable {...props} generator={typeGenerator} />
  ),
  CapabilityMatrix,
  Tab,
  Tabs,
  ...components,
});

export const useMDXComponents = getMDXComponents;
