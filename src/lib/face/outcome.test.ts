import { describe, it, expect } from "vitest";
import { resolveVerifyOutcome, faceStatusFromCheckResult } from "./outcome";
import type { FaceCheckResult } from "./types";

/**
 * Outcome mapping + error branches (PLAN_PHASE7 §2 / outcome.test.ts):
 *  - sessionStatus → FaceStatus mappings
 *  - error branches incl. not_enrolled / consent_required / nonce_mismatch
 *  - exempt short-circuit shape: a sessionStatus:'paused' with distance:null
 *    maps to 'paused', never 'ready'/'exempt' (status authoritative).
 */
function result(partial: Partial<FaceCheckResult>): FaceCheckResult {
  return {
    matched: true,
    distance: 0.1,
    sessionStatus: "active",
    nextNonce: "nonce-1",
    faceFailStreak: 0,
    ...partial,
  };
}

describe("faceStatusFromCheckResult", () => {
  it("active + matched → ready", () => {
    expect(faceStatusFromCheckResult(result({ matched: true }))).toBe("ready");
  });

  it("active + unmatched → paused", () => {
    expect(faceStatusFromCheckResult(result({ matched: false, distance: 0.9 }))).toBe("paused");
  });

  it("active + distance:null (exempt short-circuit) → ready", () => {
    // An ACTIVE session with distance:null maps to ready (the status is
    // authoritative; the exempt marker just means "no distance computed").
    expect(
      faceStatusFromCheckResult(result({ matched: true, distance: null, sessionStatus: "active" })),
    ).toBe("ready");
  });

  it("payload with BOTH error and matched → error wins (error switch, not success)", () => {
    const out = resolveVerifyOutcome({ error: "not_enrolled", matched: true });
    expect(out).toEqual({ next: "gate", surfaceError: "not_enrolled" });
  });

  it("flagged → flagged", () => {
    expect(faceStatusFromCheckResult(result({ sessionStatus: "flagged" }))).toBe("flagged");
  });
});

describe("resolveVerifyOutcome", () => {
  it("success payload → next status + retryNonce", () => {
    const out = resolveVerifyOutcome(result({ matched: true, nextNonce: "abc" }));
    expect(out).toEqual({ next: "ready", retryNonce: "abc" });
  });

  it("nonce_mismatch → surfaceError, stays ready", () => {
    const out = resolveVerifyOutcome({ error: "nonce_mismatch" });
    expect(out).toEqual({ next: "ready", surfaceError: "nonce_mismatch" });
  });

  it("not_enrolled → explicit gate state (not an undefined branch)", () => {
    const out = resolveVerifyOutcome({ error: "not_enrolled" });
    expect(out).toEqual({ next: "gate", surfaceError: "not_enrolled" });
  });

  it("consent_required → explicit gate state", () => {
    const out = resolveVerifyOutcome({ error: "consent_required" });
    expect(out).toEqual({ next: "gate", surfaceError: "consent_required" });
  });

  it("session_not_active → unavailable + surfaceEnd", () => {
    const out = resolveVerifyOutcome({ error: "session_not_active" });
    expect(out).toEqual({ next: "unavailable", surfaceEnd: true });
  });

  it("quiz_not_live → unavailable + surfaceEnd", () => {
    const out = resolveVerifyOutcome({ error: "quiz_not_live" });
    expect(out).toEqual({ next: "unavailable", surfaceEnd: true });
  });

  it("flagged → flagged", () => {
    const out = resolveVerifyOutcome({ error: "flagged" });
    expect(out).toEqual({ next: "flagged", surfaceError: "flagged" });
  });

  it("duplicate_detected → explicit gate state (CompreFace enrollment hold)", () => {
    const out = resolveVerifyOutcome({ error: "duplicate_detected" });
    expect(out).toEqual({ next: "gate", surfaceError: "duplicate_detected" });
  });

  it("compreface_unavailable → unavailable (fail-open, no hard block)", () => {
    const out = resolveVerifyOutcome({ error: "compreface_unavailable" });
    expect(out).toEqual({ next: "unavailable", surfaceError: "compreface_unavailable" });
  });

  it("unknown / null → unavailable (fail-closed — never a silent ready-pass)", () => {
    // An unrecognized error / unparsed body (429/413/401/404, stripped 200)
    // must NOT mark the student verified. Fail-open `unavailable` (honest
    // passthrough, lecturer-visible) is the safe landing.
    expect(resolveVerifyOutcome(null)).toEqual({ next: "unavailable", surfaceError: "unexpected" });
    expect(resolveVerifyOutcome({ error: "weird" })).toEqual({
      next: "unavailable",
      surfaceError: "unexpected",
    });
    expect(resolveVerifyOutcome(undefined)).toEqual({ next: "unavailable", surfaceError: "unexpected" });
  });
});
