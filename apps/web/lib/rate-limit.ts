/**
 * Fair-use rate limiting for the anonymous Ask AI endpoint.
 *
 * The docs assistant has no user accounts, so an open `/api/chat` route is a
 * cost/abuse vector. We throttle per client IP (a cookie "session" is trivially
 * reset, an IP is the honest fair-use key). When Upstash Redis is configured
 * (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`) it is used — the only
 * option that stays correct across Vercel's many short-lived serverless
 * instances. Otherwise we fall back to a best-effort in-memory sliding window,
 * which is enough locally and for a single warm instance.
 *
 * Tune the limit with `AI_RATELIMIT_MAX` (requests) and
 * `AI_RATELIMIT_WINDOW_SECONDS` (window); defaults to 10 requests / 60s per IP.
 */

const MAX = Number(process.env.AI_RATELIMIT_MAX ?? 10);
const WINDOW_SECONDS = Number(process.env.AI_RATELIMIT_WINDOW_SECONDS ?? 60);
const WINDOW_MS = WINDOW_SECONDS * 1000;

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  /** Epoch milliseconds at which the window resets. */
  reset: number;
}

/** Best identifier we have for an anonymous client: the forwarded IP. */
export const getClientId = (req: Request): string => {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }
  return req.headers.get("x-real-ip") ?? "unknown";
};

// --- In-memory fallback (best-effort, per instance) ---------------------------

const buckets = new Map<string, number[]>();

const inMemoryLimit = (id: string): RateLimitResult => {
  const now = Date.now();
  const recent = (buckets.get(id) ?? []).filter((t) => now - t < WINDOW_MS);

  if (recent.length >= MAX) {
    return {
      limit: MAX,
      remaining: 0,
      reset: recent[0] + WINDOW_MS,
      success: false,
    };
  }

  recent.push(now);
  buckets.set(id, recent);

  // Opportunistically drop fully-expired buckets so the map can't grow forever.
  if (buckets.size > 10_000) {
    for (const [key, times] of buckets) {
      if (times.every((t) => now - t >= WINDOW_MS)) {
        buckets.delete(key);
      }
    }
  }

  return {
    limit: MAX,
    remaining: MAX - recent.length,
    reset: now + WINDOW_MS,
    success: true,
  };
};

// --- Upstash (lazy, optional) -------------------------------------------------

interface Limiter {
  limit: (id: string) => Promise<{
    success: boolean;
    limit: number;
    remaining: number;
    reset: number;
  }>;
}

let upstash: Limiter | null | undefined;

const getUpstash = async (): Promise<Limiter | null> => {
  if (upstash !== undefined) {
    return upstash;
  }

  if (
    !(
      process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    )
  ) {
    upstash = null;
    return upstash;
  }

  try {
    const [{ Ratelimit }, { Redis }] = await Promise.all([
      import("@upstash/ratelimit"),
      import("@upstash/redis"),
    ]);
    upstash = new Ratelimit({
      analytics: false,
      limiter: Ratelimit.slidingWindow(MAX, `${WINDOW_SECONDS} s`),
      prefix: "sbox-ai",
      redis: Redis.fromEnv(),
    });
  } catch {
    // Package missing or Redis misconfigured — degrade to in-memory.
    upstash = null;
  }

  return upstash;
};

/** Consume one unit of the caller's budget and report whether it was allowed. */
export const rateLimit = async (id: string): Promise<RateLimitResult> => {
  const limiter = await getUpstash();
  if (limiter) {
    const result = await limiter.limit(id);
    return {
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
      success: result.success,
    };
  }
  return inMemoryLimit(id);
};
