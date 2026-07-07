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

export const InstallCommand = ({ className }: { className?: string }) => {
  const [copiedManager, setCopiedManager] = useState<PackageManager | null>(
    null
  );

  const displayCommand = convertNpmCommand(NPM_COMMAND, DEFAULT_MANAGER);

  const handleCopy = async (manager: PackageManager) => {
    try {
      await navigator.clipboard.writeText(
        convertNpmCommand(NPM_COMMAND, manager)
      );
      setCopiedManager(manager);
      setTimeout(() => setCopiedManager(null), 1800);
      posthog.capture("install_command_copied", {
        package_manager: manager,
        section: "cta",
      });
    } catch {
      // clipboard unavailable — ignore
    }
  };

  return (
    <div
      className={cn(
        "group inline-flex h-11 items-center gap-3 rounded-lg border border-border bg-card px-4 font-mono text-sm text-foreground transition-colors hover:bg-accent",
        className
      )}
    >
      <span aria-hidden className="text-muted-foreground/60">
        $
      </span>
      <span>{displayCommand}</span>
      <span aria-hidden className="h-4 w-px bg-border" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={
              copiedManager ? "Copied install command" : "Copy install command"
            }
            className="text-muted-foreground transition-colors outline-none group-hover:text-foreground focus-visible:text-foreground"
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
                onSelect={() => handleCopy(manager)}
              >
                {copiedManager === manager ? <Check /> : null}
                {manager}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
