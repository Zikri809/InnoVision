/**
 * Minimal in-memory sliding-window rate limiter.
 *
 * Addresses the join-code / invite-code brute-force oracle (security audit
 * finding). This is a per-process limiter — adequate for a single Vercel
 * serverless instance at demo scale; it intentionally does NOT claim to be a
 * distributed lock (no Redis at MVP scale, per PLAN §0).
 *
 * The bucket map is capped and swept so unbounded key growth (attacker-rotated
 * emails/uids) can't leak memory. On a `limit` hit we REJECT (fail closed for
 * the request in question), which is the intended behavior for an anti-abuse
 * gate.
 */

type Bucket = { timestamps: number[] };

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

/** Prune + record a hit for `key`; returns true if within limit, false if exceeded. */
export function rateLimit(
  key: string,
  opts: { limit: number; windowMs: number },
): boolean {
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket) {
    if (buckets.size >= MAX_BUCKETS) {
      // Sweep stale buckets to stay under the cap.
      for (const [k, b] of buckets) {
        b.timestamps = b.timestamps.filter((t) => now - t < opts.windowMs);
        if (b.timestamps.length === 0) buckets.delete(k);
      }
      // If still at cap after sweeping, evict the oldest-accessed bucket.
      if (buckets.size >= MAX_BUCKETS) {
        const oldest = buckets.keys().next().value as string | undefined;
        if (oldest !== undefined) buckets.delete(oldest);
      }
    }
    bucket = { timestamps: [] };
    buckets.set(key, bucket);
  }

  // Drop entries outside the window.
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < opts.windowMs);

  if (bucket.timestamps.length >= opts.limit) {
    return false;
  }

  bucket.timestamps.push(now);
  return true;
}

/** Test-only: clear all buckets (used by unit tests). */
export function _resetRateLimiter(): void {
  buckets.clear();
}
