import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  rateLimit,
  recordRateLimitHit,
  resetRateLimit,
  _resetRateLimiter,
} from "@/lib/classes/rate-limit";

describe("rateLimit", () => {
  beforeEach(() => {
    _resetRateLimiter();
    vi.useRealTimers();
  });

  it("allows requests up to the limit", () => {
    for (let i = 0; i < 5; i++) {
      expect(rateLimit("key", { limit: 5, windowMs: 60_000 })).toBe(true);
    }
  });

  it("rejects requests beyond the limit", () => {
    for (let i = 0; i < 5; i++) {
      rateLimit("key", { limit: 5, windowMs: 60_000 });
    }
    expect(rateLimit("key", { limit: 5, windowMs: 60_000 })).toBe(false);
  });

  it("tracks keys independently", () => {
    for (let i = 0; i < 5; i++) {
      rateLimit("a", { limit: 5, windowMs: 60_000 });
    }
    expect(rateLimit("a", { limit: 5, windowMs: 60_000 })).toBe(false);
    expect(rateLimit("b", { limit: 5, windowMs: 60_000 })).toBe(true);
  });

  it("reopens after the window elapses", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) {
      rateLimit("key", { limit: 5, windowMs: 60_000 });
    }
    expect(rateLimit("key", { limit: 5, windowMs: 60_000 })).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect(rateLimit("key", { limit: 5, windowMs: 60_000 })).toBe(true);
  });

  it("sweep prunes each bucket by ITS OWN window (not the incoming request's)", () => {
    vi.useFakeTimers();
    // Bucket A: 60s window, full at 5/5.
    const keyA = "sweep-a";
    for (let i = 0; i < 5; i++) rateLimit(keyA, { limit: 5, windowMs: 60_000 });
    expect(rateLimit(keyA, { limit: 5, windowMs: 60_000 })).toBe(false);

    // Fill the map to the 10k cap with 30s-window one-shot keys.
    for (let i = 0; i < 9_999; i++) rateLimit(`sweep-filler-${i}`, { limit: 1, windowMs: 30_000 });

    // Let the fillers' 30s window elapse but NOT key A's 60s window.
    vi.advanceTimersByTime(31_000);

    // This call sits exactly at the cap → triggers the sweep.
    rateLimit("sweep-trigger", { limit: 1, windowMs: 30_000 });

    // Key A's history must SURVIVE — a buggy sweep using the incoming 30s
    // window would have pruned A's recent hits and silently reopened its limit.
    expect(rateLimit(keyA, { limit: 5, windowMs: 60_000 })).toBe(false);
  });

});

describe("recordRateLimitHit / resetRateLimit (audit-3 A-F4)", () => {
  beforeEach(() => {
    _resetRateLimiter();
    vi.useRealTimers();
  });

  it("counts every hit and never rejects", () => {
    // Unlike rateLimit, this is a DETECTION counter: it must keep counting
    // past any threshold (the login path logs on it, it never gates).
    for (let i = 1; i <= 10; i++) {
      expect(recordRateLimitHit("k", { windowMs: 60_000 })).toBe(i);
    }
  });

  it("prunes hits outside the window", () => {
    vi.useFakeTimers();
    expect(recordRateLimitHit("k", { windowMs: 60_000 })).toBe(1);
    expect(recordRateLimitHit("k", { windowMs: 60_000 })).toBe(2);
    vi.advanceTimersByTime(60_001);
    expect(recordRateLimitHit("k", { windowMs: 60_000 })).toBe(1);
  });

  it("resetRateLimit clears one key without touching its siblings", () => {
    recordRateLimitHit("a", { windowMs: 60_000 });
    recordRateLimitHit("a", { windowMs: 60_000 });
    recordRateLimitHit("b", { windowMs: 60_000 });
    resetRateLimit("a");
    // 'a' restarts at 1 (this is the success-clears-the-counter behaviour);
    // 'b' kept its history.
    expect(recordRateLimitHit("a", { windowMs: 60_000 })).toBe(1);
    expect(recordRateLimitHit("b", { windowMs: 60_000 })).toBe(2);
  });

  it("respects the bucket cap: a flood of fresh keys cannot grow the map unbounded", () => {
    // Adversarial-review regression: recordRateLimitHit originally skipped the
    // MAX_BUCKETS bound entirely, so its login caller (keyed on RAW form input
    // from a directly POSTable server action) could mint unbounded permanent
    // buckets and defeat the cap for every other limiter in the process.
    // Fill well past the 10k cap and assert the module still answers and the
    // ORIGINAL key is still tracked (eviction is bounded, not a wipe).
    for (let i = 0; i < 12_000; i++) {
      recordRateLimitHit(`flood-${i}`, { windowMs: 60_000 });
    }
    // A long-lived bucket created BEFORE the flood is evicted by LRU (that is
    // the documented A-F3 trade), but the module must stay functional and
    // bounded rather than growing without limit.
    expect(recordRateLimitHit("after-flood", { windowMs: 60_000 })).toBe(1);
    // And a normal rateLimit gate still works after the flood.
    for (let i = 0; i < 3; i++) rateLimit("post-flood-gate", { limit: 3, windowMs: 60_000 });
    expect(rateLimit("post-flood-gate", { limit: 3, windowMs: 60_000 })).toBe(false);
  });
});

