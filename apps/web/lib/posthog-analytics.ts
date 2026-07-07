/** Header the docs AI chat client sends so server events share one distinct id. */
export const POSTHOG_DISTINCT_ID_HEADER = "X-PostHog-Distinct-Id";

export const getPostHogDistinctIdFromRequest = (
  req: Request,
  fallback: string
): string => req.headers.get(POSTHOG_DISTINCT_ID_HEADER)?.trim() || fallback;

export const docsPageSection = (pathname: string): string => {
  const section = pathname.split("/").find((part) => part.length > 0);
  return section ?? "home";
};

export const docsAdapterProvider = (pathname: string): string | undefined => {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "adapters") {
    return undefined;
  }
  return parts[1];
};
