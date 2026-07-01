import { buttonVariants } from "fumadocs-ui/components/ui/button";
import { DocsLayout } from "fumadocs-ui/layouts/notebook";
import { MessageCircleIcon } from "lucide-react";
import type { ReactNode } from "react";

import { baseOptions } from "@/app/layout.config";
import {
  AISearch,
  AISearchPanel,
  AISearchTrigger,
} from "@/components/ai/search";
import { source } from "@/lib/source";
import { cn } from "@/lib/utils";

const Layout = ({ children }: { children: ReactNode }) => (
  <DocsLayout
    tree={source.pageTree}
    tabMode="navbar"
    sidebar={{ collapsible: false }}
    {...baseOptions}
    nav={{ ...baseOptions.nav, mode: "top" }}
  >
    <AISearch>
      <AISearchPanel />
      <AISearchTrigger
        position="float"
        className={cn(
          buttonVariants({
            className: "text-fd-muted-foreground rounded-2xl",
            color: "secondary",
          })
        )}
      >
        <MessageCircleIcon className="size-4.5" />
        Ask AI
      </AISearchTrigger>
    </AISearch>
    {children}
  </DocsLayout>
);

export default Layout;
