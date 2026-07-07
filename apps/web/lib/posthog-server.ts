import { PostHog } from "posthog-node";

let posthogClient: PostHog | null = null;

export const getPostHogClient = (): PostHog => {
  if (!posthogClient) {
    posthogClient = new PostHog(
      process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN ?? "",
      {
        flushAt: 1,
        flushInterval: 0,
        host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      }
    );
  }
  return posthogClient;
};
