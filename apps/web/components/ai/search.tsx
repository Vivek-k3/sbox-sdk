/**
 * The "Ask AI" chat UI — the client half of the docs assistant.
 *
 * A self-contained slide-in chat dock built on the Vercel AI SDK's `useChat`
 * and Fumadocs' notebook layout grid. Exposes three pieces the docs layout
 * composes: `AISearch` (context + `useChat` wired to `/api/chat`),
 * `AISearchTrigger` (the "Ask AI" button), and `AISearchPanel` (the dock).
 *
 * The panel matches the reference design: a "Chat" header with copy / clear /
 * collapse actions, per-answer "Used N sources" citations aggregated from the
 * `search` tool, an empty state with suggested questions, and a composer with a
 * live character counter. The model/provider lives entirely in
 * `app/api/chat/route.ts`; this file never talks to a provider directly.
 */
"use client";

import { useChat } from "@ai-sdk/react";
import type { UIMessage, UseChatHelpers } from "@ai-sdk/react";
import { Presence } from "@radix-ui/react-presence";
import { DefaultChatTransport } from "ai";
import type { Tool, UIToolInvocation } from "ai";
import { buttonVariants } from "fumadocs-ui/components/ui/button";
import {
  Bookmark,
  Check,
  ChevronRight,
  Copy,
  CornerDownLeft,
  RefreshCw,
  Square,
  Trash2,
} from "lucide-react";
import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ComponentProps, ReactNode, SyntheticEvent } from "react";

import type { SearchTool } from "@/app/api/chat/route";
import { cn } from "@/lib/utils";

import { Markdown } from "./markdown";

/** Max characters accepted by the composer (mirrors the "N / 1000" counter). */
const MAX_INPUT = 1000;

/** Starter prompts shown in the empty state. */
const SUGGESTIONS = [
  "How do I create a sandbox with sbox-sdk?",
  "How do I run a command and stream its output?",
  "How do I switch providers, e.g. E2B to Vercel?",
  "How do I read and write files in a sandbox?",
];

const Context = createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
  chat: UseChatHelpers<UIMessage>;
} | null>(null);

const useAISearchContext = () => {
  const ctx = use(Context);
  if (!ctx) {
    throw new Error("AISearch components must be used within <AISearch>.");
  }
  return ctx;
};

const useChatContext = () => useAISearchContext().chat;

const useHotKey = () => {
  const { open, setOpen } = useAISearchContext();

  const onKeyPress = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === "Escape" && open) {
      setOpen(false);
      e.preventDefault();
    }

    if (e.key === "i" && (e.metaKey || e.ctrlKey)) {
      setOpen(!open);
      e.preventDefault();
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", onKeyPress);
    return () => window.removeEventListener("keydown", onKeyPress);
  }, []);
};

/** Flatten every `search` tool call in a message into a deduped source list. */
const collectSources = (message: UIMessage) => {
  const seen = new Map<string, { url: string; title: string }>();

  for (const part of message.parts ?? []) {
    if (!part.type.startsWith("tool-")) {
      continue;
    }
    const toolName = part.type.slice("tool-".length);
    const call = part as UIToolInvocation<SearchTool>;
    if (toolName !== "search" || !call.output) {
      continue;
    }

    for (const doc of call.output) {
      if (!seen.has(doc.url)) {
        seen.set(doc.url, { title: doc.title, url: doc.url });
      }
    }
  }

  return [...seen.values()];
};

/** Is any `search` tool call on this message still awaiting its result? */
const isSearching = (message: UIMessage) =>
  (message.parts ?? []).some((part) => {
    if (!part.type.startsWith("tool-")) {
      return false;
    }
    const call = part as UIToolInvocation<Tool>;
    return (
      part.type === "tool-search" &&
      call.state !== "output-available" &&
      call.state !== "output-error"
    );
  });

/** Animated gradient-sweep text — the "thinking/searching" shimmer. */
const TextShimmer = ({ children }: { children: ReactNode }) => (
  <span className="ai-shimmer-text font-medium text-sm">{children}</span>
);

/**
 * Placeholder shown while the assistant is working but hasn't streamed any
 * visible text yet, so the panel never looks frozen. `label` reflects the
 * current phase ("Searching the docs" vs "Thinking").
 */
const Thinking = ({ label }: { label: string }) => (
  <div className="flex flex-col gap-3">
    <TextShimmer>{label}…</TextShimmer>
    <div aria-hidden="true" className="flex flex-col gap-2">
      <div className="ai-skeleton h-3 w-11/12 rounded-full" />
      <div className="ai-skeleton h-3 w-full rounded-full" />
      <div className="ai-skeleton h-3 w-2/3 rounded-full" />
    </div>
  </div>
);

const Sources = ({ message }: { message: UIMessage }) => {
  const [expanded, setExpanded] = useState(false);
  const sources = collectSources(message);

  if (sources.length === 0) {
    return null;
  }

  return (
    <div className="mb-3">
      <button
        className="flex items-center gap-2 text-fd-muted-foreground text-sm transition-colors hover:text-fd-foreground"
        onClick={() => setExpanded((v) => !v)}
        type="button"
      >
        <Bookmark className="size-4" />
        Used {sources.length} {sources.length === 1 ? "source" : "sources"}
        <ChevronRight
          className={cn(
            "size-3.5 transition-transform",
            expanded && "rotate-90"
          )}
        />
      </button>
      {expanded && (
        <ul className="mt-2 flex flex-col gap-1.5 ps-1">
          {sources.map((source) => (
            <li className="flex items-start gap-2 text-sm" key={source.url}>
              <span className="mt-2 size-1 shrink-0 rounded-full bg-fd-muted-foreground" />
              <a
                className="text-fd-foreground transition-colors hover:text-fd-primary"
                href={source.url}
              >
                {source.title}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const Message = ({ message }: { message: UIMessage }) => {
  if (message.role === "user") {
    const text = (message.parts ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");

    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-fd-secondary px-4 py-2.5 text-fd-secondary-foreground text-sm">
          {text}
        </div>
      </div>
    );
  }

  const markdown = (message.parts ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
  const hasText = markdown.trim().length > 0;

  return (
    <div>
      <Sources message={message} />
      {hasText ? (
        <div className="prose text-sm prose-a:underline">
          <Markdown text={markdown} />
        </div>
      ) : (
        <Thinking
          label={isSearching(message) ? "Searching the docs" : "Thinking"}
        />
      )}
    </div>
  );
};

const List = (props: Omit<ComponentProps<"div">, "dir">) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }
    const scrollToBottom = () => {
      const container = containerRef.current;
      if (!container) {
        return;
      }
      container.scrollTo({ behavior: "instant", top: container.scrollHeight });
    };

    const observer = new ResizeObserver(scrollToBottom);
    scrollToBottom();

    const element = containerRef.current.firstElementChild;
    if (element) {
      observer.observe(element);
    }

    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      {...props}
      className={cn(
        "fd-scroll-container flex min-w-0 flex-col overflow-y-auto",
        props.className
      )}
    >
      {props.children}
    </div>
  );
};

const EmptyState = () => {
  const { sendMessage } = useChatContext();

  return (
    <div className="flex flex-1 flex-col justify-end gap-3 p-3">
      <div className="flex flex-col items-start gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            className="text-start text-fd-foreground text-sm transition-colors hover:text-fd-primary"
            key={suggestion}
            onClick={() => sendMessage({ text: suggestion })}
            type="button"
          >
            {suggestion}
          </button>
        ))}
      </div>
      <p className="text-fd-muted-foreground text-xs">
        Tip: open and close chat with{" "}
        <kbd className="rounded border bg-fd-muted px-1 font-mono">⌘</kbd>{" "}
        <kbd className="rounded border bg-fd-muted px-1 font-mono">I</kbd>
      </p>
    </div>
  );
};

const Header = () => {
  const { setOpen, chat } = useAISearchContext();
  const [copied, setCopied] = useState(false);

  const copyConversation = async () => {
    const transcript = chat.messages
      .map((message) => {
        const text = (message.parts ?? [])
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
        return `## ${message.role}\n\n${text}`;
      })
      .join("\n\n");

    try {
      await navigator.clipboard.writeText(transcript);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard unavailable — ignore
    }
  };

  const iconButton = cn(
    buttonVariants({
      className: "text-fd-muted-foreground rounded-lg",
      color: "ghost",
      size: "icon-sm",
    })
  );

  return (
    <div className="flex items-center justify-between px-2 pb-2">
      <p className="font-semibold text-fd-foreground">Chat</p>
      <div className="flex items-center gap-0.5">
        <button
          aria-label="Copy conversation"
          className={iconButton}
          disabled={chat.messages.length === 0}
          onClick={copyConversation}
          type="button"
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </button>
        <button
          aria-label="Clear chat"
          className={iconButton}
          disabled={chat.messages.length === 0}
          onClick={() => chat.setMessages([])}
          type="button"
        >
          <Trash2 className="size-4" />
        </button>
        <button
          aria-label="Close chat"
          className={iconButton}
          onClick={() => setOpen(false)}
          type="button"
        >
          <ChevronRight className="size-5" />
        </button>
      </div>
    </div>
  );
};

const StorageKeyInput = "__ai_search_input";
const Composer = () => {
  const { status, sendMessage, stop, messages, regenerate } = useChatContext();
  const [input, setInput] = useState(
    () => localStorage.getItem(StorageKeyInput) ?? ""
  );
  const isLoading = status === "streaming" || status === "submitted";

  const submit = (e?: SyntheticEvent) => {
    e?.preventDefault();
    const message = input.trim();
    if (message.length === 0 || isLoading) {
      return;
    }
    void sendMessage({ text: message });
    setInput("");
    localStorage.removeItem(StorageKeyInput);
  };

  const canRetry = !isLoading && messages.at(-1)?.role === "assistant";

  return (
    <div className="flex flex-col gap-2">
      {canRetry && (
        <button
          className={cn(
            buttonVariants({
              className: "gap-1.5 self-start rounded-full",
              color: "secondary",
              size: "sm",
            })
          )}
          onClick={() => regenerate()}
          type="button"
        >
          <RefreshCw className="size-3.5" />
          Retry
        </button>
      )}
      <form
        className="rounded-2xl border bg-fd-secondary/50 shadow-sm focus-within:shadow-md"
        onSubmit={submit}
      >
        <textarea
          autoFocus
          className="max-h-40 min-h-16 w-full resize-none bg-transparent p-3 text-sm placeholder:text-fd-muted-foreground focus-visible:outline-none"
          id="nd-ai-input"
          maxLength={MAX_INPUT}
          onChange={(e) => {
            setInput(e.target.value);
            localStorage.setItem(StorageKeyInput, e.target.value);
          }}
          onKeyDown={(event) => {
            if (!event.shiftKey && event.key === "Enter") {
              submit(event);
            }
          }}
          placeholder="What would you like to know?"
          value={input}
        />
        <div className="flex items-center justify-between p-2 pt-0">
          <span className="text-fd-muted-foreground text-xs tabular-nums">
            {input.length} / {MAX_INPUT}
          </span>
          {isLoading ? (
            <button
              aria-label="Stop"
              className={cn(
                buttonVariants({
                  className: "rounded-lg",
                  color: "secondary",
                  size: "icon-sm",
                })
              )}
              onClick={stop}
              type="button"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              aria-label="Send"
              className={cn(
                buttonVariants({
                  className: "rounded-lg",
                  color: "primary",
                  size: "icon-sm",
                })
              )}
              disabled={input.trim().length === 0}
              type="submit"
            >
              <CornerDownLeft className="size-4" />
            </button>
          )}
        </div>
      </form>
    </div>
  );
};

export const AISearch = ({ children }: { children: ReactNode }) => {
  const [open, setOpen] = useState(false);
  const chat = useChat({
    id: "search",
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

  return (
    <Context value={useMemo(() => ({ chat, open, setOpen }), [chat, open])}>
      {children}
    </Context>
  );
};

export const AISearchTrigger = ({
  position = "default",
  className,
  ...props
}: ComponentProps<"button"> & { position?: "default" | "float" }) => {
  const { open, setOpen } = useAISearchContext();

  return (
    <button
      className={cn(
        position === "float" && [
          "fixed bottom-4 z-20 gap-2 inset-e-[calc(--spacing(4)+var(--removed-body-scroll-bar-size,0px))] shadow-lg transition-[translate,opacity]",
          open && "translate-y-10 opacity-0",
        ],
        className
      )}
      data-state={open ? "open" : "closed"}
      onClick={() => setOpen(!open)}
      type="button"
      {...props}
    >
      {props.children}
    </button>
  );
};

export const AISearchPanel = () => {
  const { open, setOpen, chat } = useAISearchContext();
  useHotKey();

  const messages = chat.messages.filter((message) => message.role !== "system");
  // `submitted` = request sent, response not started yet (no assistant message).
  const pending = chat.status === "submitted";

  return (
    <>
      <style>
        {`
        @keyframes ask-ai-open {
          from { translate: 100% 0; }
          to { translate: 0 0; }
        }
        @keyframes ask-ai-close {
          from { width: var(--ai-chat-width); }
          to { width: 0px; }
        }
        .ai-shimmer-text {
          background: linear-gradient(90deg, var(--color-fd-muted-foreground) 0%, var(--color-fd-muted-foreground) 35%, var(--color-fd-foreground) 50%, var(--color-fd-muted-foreground) 65%, var(--color-fd-muted-foreground) 100%);
          background-size: 200% 100%;
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          color: transparent;
          animation: ai-shimmer 1.4s linear infinite;
        }
        @keyframes ai-shimmer {
          from { background-position: 200% 0; }
          to { background-position: -200% 0; }
        }
        .ai-skeleton {
          position: relative;
          overflow: hidden;
          background-color: var(--color-fd-muted);
        }
        .ai-skeleton::after {
          content: "";
          position: absolute;
          inset: 0;
          transform: translateX(-100%);
          background: linear-gradient(90deg, transparent, color-mix(in oklab, var(--color-fd-foreground) 10%, transparent), transparent);
          animation: ai-skeleton 1.6s infinite;
        }
        @keyframes ai-skeleton {
          to { transform: translateX(100%); }
        }`}
      </style>
      <Presence present={open}>
        <button
          aria-label="Close AI chat"
          className="fixed inset-0 z-30 bg-fd-overlay backdrop-blur-xs data-[state=closed]:animate-fd-fade-out data-[state=open]:animate-fd-fade-in lg:hidden"
          data-state={open ? "open" : "closed"}
          onClick={() => setOpen(false)}
          tabIndex={-1}
          type="button"
        />
      </Presence>
      <Presence present={open}>
        <div
          className={cn(
            "z-30 overflow-hidden bg-fd-card text-fd-card-foreground [--ai-chat-width:420px] 2xl:[--ai-chat-width:480px]",
            "max-lg:fixed max-lg:inset-x-2 max-lg:inset-y-4 max-lg:rounded-2xl max-lg:border max-lg:shadow-xl",
            "lg:sticky lg:top-0 lg:ms-auto lg:h-dvh lg:border-s lg:in-[#nd-docs-layout]:[grid-area:toc] lg:in-[#nd-notebook-layout]:col-start-5 lg:in-[#nd-notebook-layout]:row-span-full",
            open
              ? "animate-fd-dialog-in lg:animate-[ask-ai-open_200ms]"
              : "animate-fd-dialog-out lg:animate-[ask-ai-close_200ms]"
          )}
        >
          <div className="flex size-full flex-col p-3 max-lg:max-h-[85dvh] lg:w-(--ai-chat-width)">
            <Header />
            {messages.length === 0 ? (
              <List className="flex-1">
                <EmptyState />
              </List>
            ) : (
              <List className="flex-1 py-2">
                <div className="flex flex-col gap-5 px-2">
                  {messages.map((message) => (
                    <Message key={message.id} message={message} />
                  ))}
                  {pending && <Thinking label="Thinking" />}
                </div>
              </List>
            )}
            {chat.error && (
              <div className="mb-2 rounded-lg border border-fd-border bg-fd-secondary px-3 py-2 text-fd-muted-foreground text-xs">
                {chat.error.message ||
                  "Something went wrong. Please try again."}
              </div>
            )}
            <Composer />
          </div>
        </div>
      </Presence>
    </>
  );
};
