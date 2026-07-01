import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import {
  Bricolage_Grotesque,
  Geist,
  Geist_Mono,
  Martian_Mono,
} from "next/font/google";
import type { ReactNode } from "react";

import "./globals.css";
import { cn } from "@/lib/utils";

const geistSans = Geist({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

// Display: an engineered-humanist grotesque, used big and tight for headlines.
const display = Bricolage_Grotesque({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["500", "600", "700"],
});

// Data: the instrument-panel label voice — wide, mono, uppercase, tiny.
const dataMono = Martian_Mono({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-data",
  weight: ["500", "600"],
});

const title =
  "sbox SDK — one API for E2B, Vercel, Cloudflare & every agent sandbox";
const description =
  "A unified TypeScript SDK for agent sandbox providers. One namespaced API, capability gating, a single error taxonomy, and a typed escape hatch to the native client.";

export const metadata: Metadata = {
  description,
  metadataBase: new URL("https://sbox-sdk.vercel.app"),
  title: { default: title, template: "%s · sbox SDK" },
};

const RootLayout = ({ children }: { children: ReactNode }) => (
  <html
    lang="en"
    suppressHydrationWarning
    className={cn(
      "scroll-smooth touch-manipulation font-sans antialiased",
      geistSans.variable,
      geistMono.variable,
      display.variable,
      dataMono.variable
    )}
  >
    <body className="flex min-h-full flex-col">
      <RootProvider search={{ options: { api: "/search" } }}>
        {children}
      </RootProvider>
    </body>
  </html>
);

export default RootLayout;
