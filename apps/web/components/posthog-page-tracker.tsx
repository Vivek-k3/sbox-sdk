"use client";

import { usePathname } from "next/navigation";
import posthog from "posthog-js";
import { useEffect, useRef } from "react";

import { docsAdapterProvider, docsPageSection } from "@/lib/posthog-analytics";

/** Fires `docs_page_viewed` on client-side navigations. */
export const PosthogPageTracker = () => {
  const pathname = usePathname();
  const previousPath = useRef<string | null>(null);

  useEffect(() => {
    if (pathname === previousPath.current) {
      return;
    }
    previousPath.current = pathname;

    const section = docsPageSection(pathname);
    const provider = docsAdapterProvider(pathname);

    posthog.capture("docs_page_viewed", {
      is_adapter_page: section === "adapters",
      path: pathname,
      provider,
      section,
    });
  }, [pathname]);

  return null;
};
