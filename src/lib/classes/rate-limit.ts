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

type Bucket = { timestamps: number[]; windowMs: number };

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

// audit-3 R2-TOP-F4: at the cap, EVERY new key re-swept all 10k buckets, and
// while every entry was still inside its own window the sweep deleted nothing
// — so a flood paid the full O(10k) scan per request and gained no headroom.
// Rate-limit the sweep itself; a bucket cannot go stale faster than the
// shortest window, so a sub-second floor is pure win.
const SWEEP_MIN_INTERVAL_MS = 1_000;
let lastSweepAt = 0;

// Harness-only opt-out (playwright.config.ts webServer env): the e2e suite
// bursts far past every per-route budget from one IP/process. No e2e spec
// asserts a 429 — limits are proven by route-level vitest tests that seed
// buckets directly (_seedRateLimit) in their own process — so disabling here
// is test-only and inert in production (flag unset).
//
// audit-2 M-03: the flag deadens EVERY throttle with no signal if it ever
// reaches a production runtime (leaked env or a promoted harness-built
// artifact). The kill-switch now announces itself loudly when it fires in a
// production process — mirroring hardening-gate.ts's warn posture — so the
// condition is visible in prod logs instead of silently deadening the
// join/invite/AI-cost guards. CI/deploy checks should additionally assert
// the flag is absent from the prod image (see audit-2 M-14 for the same
// posture on the seam flags).
const RATE_LIMIT_DISABLED = process.env.E2E_RATE_LIMIT_DISABLED === "1";
const IS_PROD_RUNTIME = process.env.NODE_ENV === "production";
if (RATE_LIMIT_DISABLED && IS_PROD_RUNTIME && process.env.NEXT_PHASE !== "phase-production-build") {
  console.warn(
    "⚠️ E2E_RATE_LIMIT_DISABLED=1 is active in a PRODUCTION runtime — " +
      "every rate limit in this process is DISABLED (audit-2 M-03). " +
      "This must only ever be the e2e harness; if you see this in a real " +
      "deployment, remove the flag and redeploy.",
  );
}

/**
 * Enforce the bucket-map bound: sweep stale entries (at most once per
 * SWEEP_MIN_INTERVAL_MS) and, if still at the cap, evict the least-recently
 * USED bucket. Shared by `rateLimit` and `recordRateLimitHit` so the module's
 * memory bound holds for EVERY writer — a writer that skips this (audit-3
 * adversarial review, High) lets a caller mint unbounded permanent buckets and
 * defeats the cap for every other limiter in the process.
 */
function enforceBucketCap(now: number): void {
  if (buckets.size < MAX_BUCKETS) return;
  if (now - lastSweepAt >= SWEEP_MIN_INTERVAL_MS) {
    lastSweepAt = now;
    // Each bucket is pruned by ITS OWN windowMs — using the incoming request's
    // window would silently reset other routes' limits mid-flood (a 60s bucket
    // swept with a small window loses recent hits at the exact moment the
    // backstop is needed).
    for (const [k, b] of buckets) {
      b.timestamps = b.timestamps.filter((t) => now - t < b.windowMs);
      if (b.timestamps.length === 0) buckets.delete(k);
    }
  }
  if (buckets.size >= MAX_BUCKETS) {
    // audit-3 A-F3/B-F8: evict the least-recently-USED bucket. The map's
    // iteration order is insertion order, so this is only true because every
    // hit re-inserts its key (Map.set on an existing key preserves position,
    // hence the delete-then-set in the callers). Before that refresh the code
    // evicted the oldest-CREATED bucket while the comment claimed
    // oldest-accessed — and the oldest-created bucket is exactly the
    // long-lived per-account victim of a targeted brute force, so a flood of
    // fresh keys evicted the victim's counter and reset their budget.
    const oldest = buckets.keys().next().value as string | undefined;
    if (oldest !== undefined) buckets.delete(oldest);
  }
}

/** Prune + record a hit for `key`; returns true if within limit, false if exceeded. */
export function rateLimit(
  key: string,
  opts: { limit: number; windowMs: number },
): boolean {
  if (RATE_LIMIT_DISABLED) return true;
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket) {
    enforceBucketCap(now);
    bucket = { timestamps: [], windowMs: opts.windowMs };
    buckets.set(key, bucket);
  } else {
    // Refresh recency: delete + set moves the key to the end of the iteration
    // order, which is what makes the eviction above a genuine LRU.
    buckets.delete(key);
    buckets.set(key, bucket);
  }

  // Drop entries outside THIS bucket's window.
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < bucket.windowMs);

  if (bucket.timestamps.length >= opts.limit) {
    return false;
  }

  bucket.timestamps.push(now);
  return true;
}

/** Test-only: clear all buckets (used by unit tests). */
export function _resetRateLimiter(): void {
  buckets.clear();
  lastSweepAt = 0;
}

/**
 * Record a hit unconditionally and return the number of hits now inside the
 * window. Unlike `rateLimit` this never rejects and never stops recording, so
 * it can back a DETECTION counter that must keep counting past its threshold
 * (audit-3 A-F4: the per-account login counter is a signal, not a gate).
 *
 * audit-3 adversarial review: this MUST keep the module's bucket bound.
 * `enforceBucketCap` was initially only in `rateLimit`, but this function's
 * only caller keys on the RAW login-form email — a `"use server"` action is
 * directly POSTable, so an attacker could mint unbounded permanent buckets
 * (one per arbitrary email string) and, by pushing the map far past the cap,
 * degrade the eviction path for every other limiter in the process.
 */
export function recordRateLimitHit(key: string, opts: { windowMs: number }): number {
  if (RATE_LIMIT_DISABLED) return 0;
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    enforceBucketCap(now);
    bucket = { timestamps: [], windowMs: opts.windowMs };
  } else {
    buckets.delete(key);
  }
  buckets.set(key, bucket);
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < bucket.windowMs);
  bucket.timestamps.push(now);
  return bucket.timestamps.length;
}

/**
 * Clear one key's budget. Used by the login path (audit-3 A-F4): a per-account
 * brute-force budget that only ever counts FAILURES locks a legitimate account
 * out indefinitely while an attacker keeps it saturated, so a successful
 * authentication must reset the counter.
 */
export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

/**
 * Test-only: pre-seed a bucket with `count` hits so a test can force a 429
 * without waiting out a window. Used by route-handler tests (I-A7).
 */
export function _seedRateLimit(key: string, count: number): void {
  // Respect the module's bucket invariant like every other writer, so a test
  // that seeds many distinct keys cannot push the map past MAX_BUCKETS and
  // invalidate the bound other tests rely on (adversarial review).
  enforceBucketCap(Date.now());
  const now = Date.now();
  buckets.set(key, { timestamps: Array.from({ length: count }, () => now), windowMs: 60_000 });
}
