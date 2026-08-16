import { describe, it, expect, beforeEach, vi } from "vitest";
import { rateLimit, _resetRateLimiter } from "@/lib/classes/rate-limit";

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
