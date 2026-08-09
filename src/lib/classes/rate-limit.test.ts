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
});
