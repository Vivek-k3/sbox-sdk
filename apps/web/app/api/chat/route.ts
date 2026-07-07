import { createOpenRouter } from "@openrouter/ai-sdk-provider";
/**
 * The "Ask AI" chat endpoint that powers the in-docs assistant.
 *
 * A single POST route wired to the Vercel AI SDK. It runs a small
 * retrieval-augmented loop: the model is given one `search` tool backed by an
 * in-memory FlexSearch index of every docs page's processed markdown, calls it
 * to ground its answer, and streams the reply back as a UI message stream that
 * `components/ai/search.tsx` renders.
 *
 * The model is served through OpenRouter (a unified, OpenAI-compatible gateway
 * to many providers) via `@openrouter/ai-sdk-provider`, so the default is a
 * free, tool-capable model and any OpenRouter model id can be swapped in with
 * the `OPENROUTER_MODEL` env var — the application code never changes.
 */
import { withTracing } from "@posthog/ai";
import { convertToModelMessages, stepCountIs, streamText, tool } from "ai";
import type { UIMessage } from "ai";
import { Document } from "flexsearch";
import type { DocumentData } from "flexsearch";
import { after } from "next/server";
import type { PostHog } from "posthog-node";
import { z } from "zod";

import { getPostHogDistinctIdFromRequest } from "@/lib/posthog-analytics";
import { getPostHogClient } from "@/lib/posthog-server";
import { getClientId, rateLimit } from "@/lib/rate-limit";
import { source } from "@/lib/source";

// Allow up to 30s of streaming on serverless platforms (e.g. Vercel).
export const maxDuration = 30;

/**
 * Model used when `OPENROUTER_MODEL` is unset. `openrouter/free` is OpenRouter's
 * free auto-router: it picks an available free, tool-capable model per request,
 * which sidesteps the per-model rate limits individual free models hit. Pin a
 * specific one via `OPENROUTER_MODEL` (e.g. `openai/gpt-oss-120b:free` or
 * `qwen/qwen3-coder:free`) — it must support function calling for `search`.
 * See the "free + tools" list at https://openrouter.ai/models?max_price=0.
 */
const DEFAULT_MODEL = "openrouter/free";

/** Cap per-result content so a handful of pages never blows the model's context. */
const MAX_CONTENT_CHARS = 4000;

interface DocsDocument extends DocumentData {
  url: string;
  title: string;
  description: string;
  content: string;
}

const createSearchServer = async () => {
  const index = new Document<DocsDocument>({
    document: {
      id: "url",
      index: ["title", "description", "content"],
      store: true,
    },
  });

  const docs = await Promise.all(
    source.getPages().map(async (page) => {
      if (!("getText" in page.data)) {
        return null;
      }

      return {
        content: await page.data.getText("processed"),
        description: page.data.description ?? "",
        title: page.data.title,
        url: page.url,
      } satisfies DocsDocument;
    })
  );

  for (const doc of docs) {
    if (doc) {
      index.add(doc);
    }
  }

  return index;
};

// Build the search index once per server instance, lazily awaited per request.
const searchServer = createSearchServer();

interface SearchToolContext {
  distinctId: string;
  posthog: PostHog;
  traceId: string;
}

const createSearchTool = ({
  distinctId,
  posthog,
  traceId,
}: SearchToolContext) =>
  tool({
    description:
      "Search the sbox-sdk documentation and return the most relevant pages as JSON. Always search before answering questions about the SDK.",
    execute: async ({ query, limit }) => {
      const startedAt = Date.now();
      const index = await searchServer;
      const results = await index.searchAsync(query, {
        enrich: true,
        limit,
        merge: true,
      });

      const docs = results
        .map((item) => item.doc)
        .filter((doc): doc is DocsDocument => doc !== null && doc !== undefined)
        .map((doc) => ({
          content: doc.content.slice(0, MAX_CONTENT_CHARS),
          description: doc.description,
          title: doc.title,
          url: doc.url,
        }));

      posthog.capture({
        distinctId,
        event: "ai_chat_search_executed",
        properties: {
          duration_ms: Date.now() - startedAt,
          query_length: query.length,
          result_count: docs.length,
          top_urls: docs.slice(0, 3).map((doc) => doc.url),
          trace_id: traceId,
        },
      });

      return docs;
    },
    inputSchema: z.object({
      limit: z.number().int().min(1).max(20).default(8),
      query: z.string().describe("A natural-language search query."),
    }),
  });

/** Exported so the chat UI can type each `search` tool invocation. */
export type SearchTool = ReturnType<typeof createSearchTool>;

/** System prompt — tweak to change the assistant's voice and grounding rules. */
const systemPrompt = [
  "You are the Ask AI assistant for the sbox-sdk documentation.",
  "sbox-sdk is one unified TypeScript SDK for agent sandbox providers (E2B, Vercel, Cloudflare, Daytona, Modal, Fly, and more): swap the adapter import, keep your code.",
  "Use the `search` tool to retrieve relevant documentation before answering — do not rely on prior knowledge of the SDK.",
  "Ground every answer in the returned results and cite the pages you used as markdown links with the document `url`.",
  "Prefer concise answers with fenced code examples. If the docs do not cover something, say so plainly instead of guessing.",
].join("\n");

export const POST = async (req: Request) => {
  const clientId = getClientId(req);
  const posthog = getPostHogClient();

  // Fair-use throttle first, so abuse never reaches the (paid) model call.
  const { success, limit, remaining, reset } = await rateLimit(clientId);
  if (!success) {
    const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
    const distinctId = getPostHogDistinctIdFromRequest(req, clientId);
    posthog.capture({
      distinctId,
      event: "ai_chat_rate_limit_hit",
      properties: { rate_limit: limit, retry_after_seconds: retryAfter },
    });
    return new Response(
      "You've reached the Ask AI usage limit. Please wait a moment and try again.",
      {
        headers: {
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(limit),
          "X-RateLimit-Remaining": String(remaining),
          "X-RateLimit-Reset": String(reset),
        },
        status: 429,
      }
    );
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return new Response("Missing OPENROUTER_API_KEY environment variable.", {
      status: 500,
    });
  }

  // Build the provider per request so the API key is read at request time
  // rather than captured at module load (when env may not yet be populated).
  const openrouter = createOpenRouter({ apiKey });
  const {
    messages,
    trace_id: clientTraceId,
  }: { messages: UIMessage[]; trace_id?: string } = await req.json();
  const modelId = process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;
  const traceId = clientTraceId ?? crypto.randomUUID();
  const distinctId = getPostHogDistinctIdFromRequest(req, clientId);

  posthog.capture({
    distinctId,
    event: "ai_chat_query_received",
    properties: {
      message_count: messages.length,
      model: modelId,
      trace_id: traceId,
    },
  });

  const result = streamText({
    messages: await convertToModelMessages(messages),
    model: withTracing(openrouter.chat(modelId), posthog, {
      posthogCaptureImmediate: true,
      posthogDistinctId: distinctId,
      posthogModelOverride: modelId,
      posthogProperties: {
        $ai_span_name: "docs_ask_ai",
        message_count: messages.length,
      },
      posthogProviderOverride: "openrouter",
      posthogTraceId: traceId,
    }),
    stopWhen: stepCountIs(5),
    system: systemPrompt,
    tools: { search: createSearchTool({ distinctId, posthog, traceId }) },
  });

  after(async () => {
    await posthog.flush();
  });

  return result.toUIMessageStreamResponse();
};
