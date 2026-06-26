import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { InstallCommand } from "@/components/install-command";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const Cta = () => (
  <section className="border-t border-border">
    <div className="mx-auto max-w-6xl px-6 py-24 text-center sm:py-32">
      <h2 className="mx-auto max-w-[18ch] font-display text-4xl leading-[1.05] font-semibold tracking-tight text-balance text-foreground sm:text-6xl">
        Start building in one line.
      </h2>
      <p className="mx-auto mt-5 max-w-[46ch] text-pretty text-muted-foreground sm:text-lg">
        Install the SDK, pick a provider, and ship. Switch providers whenever
        you want — your code stays exactly the same.
      </p>
      <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
        <InstallCommand />
        <Link
          className={cn(buttonVariants({ size: "lg" }))}
          href="/general/overview"
        >
          Read the docs
          <ArrowRight className="size-4" />
        </Link>
      </div>
    </div>
  </section>
);
