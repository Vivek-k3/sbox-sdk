"use client";

import { Check, Copy } from "lucide-react";
import posthog from "posthog-js";
import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { convertNpmCommand } from "@/lib/convert-npm";
import type { PackageManager } from "@/lib/convert-npm";
import { cn } from "@/lib/utils";

const NPM_COMMAND = "npm install sbox-sdk";
const DEFAULT_MANAGER: PackageManager = "pnpm";
const PACKAGE_MANAGERS: PackageManager[] = ["bun", "pnpm", "npm", "yarn"];
// Agent skill install (see /general/skills).
const AGENT_COMMAND = "npx skills add vivek-k3/sbox-sdk";

type Mode = "humans" | "agents";

const PILL =
  "group inline-flex h-12 items-center gap-3 rounded-full border border-border bg-card px-5 font-mono text-sm text-foreground transition-colors hover:bg-accent";
const COPY_BTN =
  "text-muted-foreground outline-none transition-colors group-hover:text-foreground focus-visible:text-foreground";

/**
 * Homepage install widget with a "For humans / For agents" toggle.
 *  - humans: package install (with a package-manager picker on copy)
 *  - agents: the agent-skill install command (direct copy)
 */
export const InstallToggle = ({ className }: { className?: string }) => {
  const [mode, setMode] = useState<Mode>("humans");
  const [copiedManager, setCopiedManager] = useState<PackageManager | null>(
    null
  );
  const [copiedAgent, setCopiedAgent] = useState(false);

  const humanCommand = convertNpmCommand(NPM_COMMAND, DEFAULT_MANAGER);

  const copyHuman = async (manager: PackageManager) => {
    try {
      await navigator.clipboard.writeText(
        convertNpmCommand(NPM_COMMAND, manager)
      );
      setCopiedManager(manager);
      setTimeout(() => setCopiedManager(null), 1800);
      posthog.capture("install_command_copied", {
        package_manager: manager,
        section: "hero",
      });
    } catch {
      // clipboard unavailable — ignore
    }
  };

  const copyAgent = async () => {
    try {
      await navigator.clipboard.writeText(AGENT_COMMAND);
      setCopiedAgent(true);
      setTimeout(() => setCopiedAgent(false), 1800);
      posthog.capture("agent_install_command_copied", { section: "hero" });
    } catch {
      // clipboard unavailable — ignore
    }
  };

  const tab = (value: Mode, label: string) => (
    <button
      className={cn(
        "transition-colors outline-none focus-visible:text-foreground",
        mode === value
          ? "font-medium text-foreground"
          : "text-muted-foreground hover:text-foreground"
      )}
      onClick={() => {
        setMode(value);
        posthog.capture("install_mode_toggled", { mode: value });
      }}
      type="button"
    >
      {label}
    </button>
  );

  return (
    <div className={cn("flex flex-col items-center gap-4", className)}>
      <div className="flex items-center gap-3 text-sm">
        {tab("humans", "For humans")}
        <span aria-hidden className="h-4 w-px bg-border" />
        {tab("agents", "For agents")}
      </div>

      {mode === "humans" ? (
        <div className={PILL}>
          <span aria-hidden className="text-muted-foreground/60">
            $
          </span>
          <span>{humanCommand}</span>
          <span aria-hidden className="h-4 w-px bg-border" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label={
                  copiedManager
                    ? "Copied install command"
                    : "Copy install command"
                }
                className={COPY_BTN}
                type="button"
              >
                {copiedManager ? (
                  <Check className="size-4" />
                ) : (
                  <Copy className="size-4" />
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuGroup>
                {PACKAGE_MANAGERS.map((manager) => (
                  <DropdownMenuItem
                    key={manager}
                    onSelect={() => copyHuman(manager)}
                  >
                    {copiedManager === manager ? <Check /> : null}
                    {manager}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : (
        <div className={PILL}>
          <span aria-hidden className="text-muted-foreground/60">
            $
          </span>
          <span>{AGENT_COMMAND}</span>
          <span aria-hidden className="h-4 w-px bg-border" />
          <button
            aria-label={
              copiedAgent ? "Copied install command" : "Copy install command"
            }
            className={COPY_BTN}
            onClick={copyAgent}
            type="button"
          >
            {copiedAgent ? (
              <Check className="size-4" />
            ) : (
              <Copy className="size-4" />
            )}
          </button>
        </div>
      )}
    </div>
  );
};
