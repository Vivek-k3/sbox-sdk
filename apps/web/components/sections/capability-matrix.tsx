"use client";

import { Fragment, useState } from "react";

import { CAPABILITY_GROUPS, nativeCount, PROVIDERS } from "@/lib/capabilities";
import type { Level } from "@/lib/capabilities";
import { PROVIDER_ICONS } from "@/lib/icons";
import { cn } from "@/lib/utils";

interface Hover {
  cap: string;
  col: number;
  level: Level;
  provider: string;
}

const Indicator = ({ level }: { level: Level }) => {
  if (level === "native") {
    return <span aria-hidden className="size-2.5 rounded-full bg-native" />;
  }
  if (level === "emulated") {
    return (
      <span
        aria-hidden
        className="size-2.5 rounded-full border-[1.5px] border-emulated"
      />
    );
  }
  return <span aria-hidden className="h-px w-2.5 bg-foreground/20" />;
};

export const CapabilityMatrix = () => {
  const [hover, setHover] = useState<Hover | null>(null);

  return (
    <div className="not-prose my-6">
      <div className="flex h-6 items-center font-mono text-xs">
        {hover ? (
          <span className="text-muted-foreground">
            <span className="text-foreground">{hover.provider}</span>
            <span className="text-dim"> · </span>
            {hover.cap}
            <span className="text-dim"> — </span>
            <span
              className={cn(
                hover.level === "native" && "text-native",
                hover.level === "emulated" && "text-emulated",
                hover.level === "unsupported" && "text-dim"
              )}
            >
              {hover.level}
            </span>
          </span>
        ) : (
          <span className="text-dim">Hover a cell to inspect.</span>
        )}
      </div>

      <div className="mt-3 overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[44rem] border-collapse text-sm">
          <caption className="sr-only">
            Capability support by provider: native, emulated, or unsupported.
          </caption>
          <thead>
            <tr className="border-border border-b">
              <th
                className="sticky left-0 z-10 bg-background px-4 py-3 text-left font-data font-medium text-[10px] text-dim uppercase tracking-[0.16em]"
                scope="col"
              >
                Capability
              </th>
              {PROVIDERS.map((p, ci) => {
                const Icon = PROVIDER_ICONS[p.id];
                return (
                  <th
                    className={cn(
                      "px-2 py-3 text-center align-bottom transition-colors",
                      hover?.col === ci && "bg-accent/60"
                    )}
                    key={p.id}
                    scope="col"
                  >
                    {Icon ? (
                      <Icon className="mx-auto mb-1 size-4 text-foreground" />
                    ) : null}
                    <span className="block font-mono text-foreground text-xs">
                      {p.name}
                    </span>
                    <span className="mt-0.5 block font-data text-[9px] text-dim tracking-[0.1em]">
                      {nativeCount(p)}n
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {CAPABILITY_GROUPS.map((group) => (
              <Fragment key={group.group}>
                <tr>
                  <th
                    className="sticky left-0 bg-muted/40 px-4 py-1.5 text-left font-data text-[9px] text-dim uppercase tracking-[0.2em]"
                    colSpan={PROVIDERS.length + 1}
                    scope="colgroup"
                  >
                    {group.group}
                  </th>
                </tr>
                {group.caps.map((cap) => (
                  <tr
                    className="border-border/60 border-t transition-colors hover:bg-accent/40"
                    key={cap.key}
                  >
                    <th
                      className="sticky left-0 z-10 bg-background px-4 py-2 text-left font-mono font-normal text-muted-foreground text-xs whitespace-nowrap"
                      scope="row"
                    >
                      {cap.label}
                    </th>
                    {PROVIDERS.map((p, ci) => {
                      const level = p.caps[cap.key];
                      return (
                        <td
                          className={cn(
                            "px-2 py-2 transition-colors",
                            hover?.col === ci && "bg-accent/60"
                          )}
                          key={p.id}
                          onMouseEnter={() =>
                            setHover({
                              cap: cap.label,
                              col: ci,
                              level,
                              provider: p.name,
                            })
                          }
                          onMouseLeave={() => setHover(null)}
                          title={`${p.name} · ${cap.label} — ${level}`}
                        >
                          <span className="flex items-center justify-center">
                            <Indicator level={level} />
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-muted-foreground text-xs">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-native" /> native
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-full border-[1.5px] border-emulated" />{" "}
          emulated
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-px w-2.5 bg-foreground/20" /> unsupported
        </span>
      </div>
    </div>
  );
};
