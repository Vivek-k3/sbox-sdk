"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

const COMMAND = "npm install sbox-sdk";

export const InstallCommand = ({ className }: { className?: string }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard unavailable — ignore
    }
  };

  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy install command"}
      onClick={handleCopy}
      className={cn(
        "group inline-flex h-11 items-center gap-3 rounded-lg border border-border bg-card px-4 font-mono text-sm text-foreground transition-colors hover:bg-accent",
        className
      )}
    >
      <span aria-hidden className="text-muted-foreground/60">
        $
      </span>
      <span>{COMMAND}</span>
      <span
        aria-hidden
        className="text-muted-foreground transition-colors group-hover:text-foreground"
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </span>
    </button>
  );
};
