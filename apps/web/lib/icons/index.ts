/**
 * Adapter logos as `currentColor` SVG components. Brand marks are sourced from
 * simple-icons (Vercel, Cloudflare, AWS, Fly, Modal) and daytona.io (Daytona);
 * E2B and the in-memory provider use authored glyphs (no public brand SVG).
 *
 * `PROVIDER_ICONS` is keyed by the same provider ids as `@/lib/capabilities`.
 */
import type { ComponentType, SVGProps } from "react";

import { AwsLambdaIcon } from "./aws-lambda";
import { CloudflareIcon } from "./cloudflare";
import { DaytonaIcon } from "./daytona";
import { E2bIcon } from "./e2b";
import { FlyIcon } from "./fly";
import { MemoryIcon } from "./memory";
import { ModalIcon } from "./modal";
import { VercelIcon } from "./vercel";

export {
  AwsLambdaIcon,
  CloudflareIcon,
  DaytonaIcon,
  E2bIcon,
  FlyIcon,
  MemoryIcon,
  ModalIcon,
  VercelIcon,
};

export type ProviderIcon = ComponentType<SVGProps<SVGSVGElement>>;

export const PROVIDER_ICONS: Record<string, ProviderIcon> = {
  "aws-lambda": AwsLambdaIcon,
  cloudflare: CloudflareIcon,
  daytona: DaytonaIcon,
  e2b: E2bIcon,
  fly: FlyIcon,
  memory: MemoryIcon,
  modal: ModalIcon,
  vercel: VercelIcon,
};
