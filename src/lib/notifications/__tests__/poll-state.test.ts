import { describe, expect, it } from "vitest";
import {
  HEALTHY_POLL_MS,
  UNHEALTHY_POLL_MS,
  effectivePollMs,
  nextHealth,
  pollIntervalMs,
  type ChannelHealth,
} from "../poll-state";

describe("poll state machine (U2)", () => {
  it("subscribed → 60s, unhealthy → 20s", () => {
    expect(pollIntervalMs("subscribed")).toBe(HEALTHY_POLL_MS);
    expect(pollIntervalMs("unhealthy")).toBe(UNHEALTHY_POLL_MS);
  });

  it("any error/closed event degrades to unhealthy", () => {
    const states: ChannelHealth[] = ["subscribed", "unhealthy"];
    for (const s of states) {
      expect(nextHealth(s, "channel_error")).toBe("unhealthy");
      expect(nextHealth(s, "channel_closed")).toBe("unhealthy");
    }
  });

  it("only a SUBSCRIBED status restores the healthy cadence", () => {
    expect(nextHealth("unhealthy", "subscribed")).toBe("subscribed");
  });

  // audit-3 H-F3: a resume from a hidden gap tears the channel down, so a
  // previously-"subscribed" health is stale and must fast-poll until SUBSCRIBED
  // re-confirms. An already-unhealthy resume stays unhealthy (idempotent).
  it("resume downgrades a stale healthy state to the fast cadence", () => {
    expect(nextHealth("subscribed", "resumed")).toBe("unhealthy");
    expect(nextHealth("unhealthy", "resumed")).toBe("unhealthy");
  });

  it("resume → SUBSCRIBED restores the healthy cadence", () => {
    expect(nextHealth(nextHealth("subscribed", "resumed"), "subscribed")).toBe(
      "subscribed",
    );
  });

  it("effectivePollMs falls back to cadence when no window seam (node env)", () => {
    // In the vitest node environment there is no `window`, so the test-seam
    // override path is inert and the plain cadence applies.
    expect(effectivePollMs("subscribed")).toBe(HEALTHY_POLL_MS);
    expect(effectivePollMs("unhealthy")).toBe(UNHEALTHY_POLL_MS);
  });
});
