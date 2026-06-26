import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";

import "./globals.css";
import { cn } from "@/lib/utils";

const geistSans = Geist({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

const title =
  "sbox SDK — one API for E2B, Vercel, Cloudflare & every agent sandbox";
const description =
  "A unified TypeScript SDK for agent sandbox providers. One namespaced API, capability gating, a single error taxonomy, and a typed escape hatch to the native client.";

export const metadata: Metadata = {
  description,
  metadataBase: new URL("https://sbox-sdk.dev"),
  title: { default: title, template: "%s · sbox SDK" },
};

const RootLayout = ({ children }: { children: ReactNode }) => (
  <html
    lang="en"
    suppressHydrationWarning
    className={cn(
      "scroll-smooth touch-manipulation font-sans antialiased",
      geistSans.variable,
      geistMono.variable
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
