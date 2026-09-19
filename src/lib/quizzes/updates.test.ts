import { describe, it, expect } from "vitest";
import { buildQuizUpdates, hasRetakeFields, hasNonWindowFields } from "./updates";

describe("buildQuizUpdates (U-M7..U-M13)", () => {
  it("U-M7 forces time_limit_sec to null when switching to practice mode", () => {
    const res = buildQuizUpdates({ mode: "practice" }, "assessment");
    expect(res).toEqual({ mode: "practice", time_limit_sec: null });
  });

  it("U-M8 forces time_limit_sec to null when mode is practice even if timeLimitSec supplied", () => {
    const res = buildQuizUpdates({ mode: "practice", timeLimitSec: 1800 }, "assessment");
    expect(res).toEqual({ mode: "practice", time_limit_sec: null });
  });

  it("U-M9 wipes time_limit_sec when mode is omitted but current quiz is practice", () => {
    const res = buildQuizUpdates({ timeLimitSec: 1800 }, "practice");
    expect(res).toEqual({ time_limit_sec: null });
  });

  it("U-M10 preserves timeLimitSec when mode is assessment", () => {
    const res = buildQuizUpdates({ mode: "assessment", timeLimitSec: 1800 }, "practice");
    expect(res).toEqual({ mode: "assessment", time_limit_sec: 1800 });
  });

  it("U-M11 allows setting untimed assessment (timeLimitSec: null)", () => {
    const res = buildQuizUpdates({ mode: "assessment", timeLimitSec: null }, "practice");
    expect(res).toEqual({ mode: "assessment", time_limit_sec: null });
  });

  it("U-M12 keeps mode and timeLimitSec untouched on title-only PATCH", () => {
    const res = buildQuizUpdates({ title: "Updated Title" }, "assessment");
    expect(res).toEqual({ title: "Updated Title" });
    expect(res.mode).toBeUndefined();
    expect(res.time_limit_sec).toBeUndefined();
  });

  it("U-M13 returns an immutable object unaffected by subsequent caller mutations", () => {
    const input = { title: "Original", mode: "assessment" as const, timeLimitSec: 600 };
    const updates = buildQuizUpdates(input, "assessment");
    input.title = "Mutated";
    expect(updates.title).toBe("Original");
  });

  it("U-M13b strips extraneous injected properties from update object (prototype pollution & mass assignment defense)", () => {
    const untrustedInput = {
      title: "Safe Title",
      mode: "assessment" as const,
      timeLimitSec: 300,
      status: "live",
      created_by: "00000000-0000-4000-8000-000000000099",
      source_file_url: "https://evil.com/malicious.pdf",
    };

    const updates = buildQuizUpdates(untrustedInput, "practice");
    expect(updates).toEqual({
      title: "Safe Title",
      mode: "assessment",
      time_limit_sec: 300,
    });
    expect((updates as Record<string, unknown>).status).toBeUndefined();
    expect((updates as Record<string, unknown>).created_by).toBeUndefined();
    expect((updates as Record<string, unknown>).source_file_url).toBeUndefined();
  });

  // ── QC-4: retake config (0032 lockstep) ────────────────────────────
  it("U-M14 maps allowRetake/maxAttempts to snake_case columns (QC-4)", () => {
    const res = buildQuizUpdates({ allowRetake: true, maxAttempts: 2 }, "assessment");
    expect(res).toEqual({ allow_retake: true, max_attempts: 2 });
  });

  it("U-M15 retake fields pass through even for practice (inert — RPC reads them on the assessment path only)", () => {
    const res = buildQuizUpdates({ allowRetake: true, maxAttempts: 3 }, "practice");
    expect(res).toEqual({
      allow_retake: true,
      max_attempts: 3,
      time_limit_sec: null,
    });
  });

  it("U-M16 retake fields are omitted when not in the payload (default-config invisibility)", () => {
    const res = buildQuizUpdates({ title: "Only Title" }, "assessment");
    expect(res.allow_retake).toBeUndefined();
    expect(res.max_attempts).toBeUndefined();
  });

  it("U-M17 hasRetakeFields detects each field independently", () => {
    expect(hasRetakeFields({ allowRetake: false })).toBe(true);
    expect(hasRetakeFields({ maxAttempts: 2 })).toBe(true);
    expect(hasRetakeFields({ title: "x" })).toBe(false);
    expect(hasRetakeFields({})).toBe(false);
  });

  // ── audit-3 C-F5: nullable fields reset to the column default ──────
  it("U-M18 an explicit null resets allowRetake/maxAttempts to their column defaults", () => {
    const res = buildQuizUpdates({ allowRetake: null, maxAttempts: null }, "assessment");
    expect(res).toEqual({ allow_retake: false, max_attempts: 1 });
  });

  it("U-M19 a null-only PATCH still produces a non-empty update (no misleading 404)", () => {
    const res = buildQuizUpdates({ maxAttempts: null }, "assessment");
    expect(Object.keys(res).length).toBeGreaterThan(0);
    expect(res).toEqual({ max_attempts: 1 });
  });

  it("U-M20 an explicit null resets shuffleQuestions to false", () => {
    const res = buildQuizUpdates({ shuffleQuestions: null }, "assessment");
    expect(res).toEqual({ shuffle_questions: false });
  });
});

/**
 * v4.9 — the gesture kill switch (U-61).
 *
 * `gestures_enabled` is DRAFT-FROZEN exactly like `shuffle_questions`: the
 * route's `hasNonWindowFields` check turns a live PATCH into a 409 before the
 * DB trigger has to reject it, so this predicate IS the enforcement point for
 * every API caller. The default is `true` (not `false` like shuffle) because
 * gestures have been ON for every quiz since the feature shipped — defaulting
 * them off would silently strip the modality from every newly created quiz.
 */
describe("U-61 — gesturesEnabled plumbing", () => {
  it("U-61-1 maps gesturesEnabled to the gestures_enabled column", () => {
    expect(buildQuizUpdates({ gesturesEnabled: false }, "assessment")).toEqual({
      gestures_enabled: false,
    });
  });

  it("U-61-2 an explicit null resets to the column default TRUE (not false)", () => {
    // The divergence from shuffleQuestions is deliberate and load-bearing:
    // `?? true` preserves current behaviour for a legacy row.
    expect(buildQuizUpdates({ gesturesEnabled: null }, "assessment")).toEqual({
      gestures_enabled: true,
    });
  });

  it("U-61-3 hasNonWindowFields counts gesturesEnabled as a FROZEN field", () => {
    expect(hasNonWindowFields({ gesturesEnabled: false })).toBe(true);
    expect(hasNonWindowFields({ gesturesEnabled: true })).toBe(true);
    // n13: `undefined` is the OMIT sentinel, `null` is an explicit reset to
    // the column default — both are PRESENT keys and both are draft-frozen
    // (the predicate tests `!== undefined`, not truthiness).
    expect(hasNonWindowFields({ gesturesEnabled: null })).toBe(true);
    // A window-only patch must NOT be treated as frozen (live management).
    expect(hasNonWindowFields({ opensAt: "2026-01-01T00:00:00Z" })).toBe(false);
    expect(hasNonWindowFields({ allowRetake: true })).toBe(false);
  });

  it("U-61-4 omitting gesturesEnabled leaves the column untouched", () => {
    expect(buildQuizUpdates({ title: "New title" }, "assessment")).toEqual({
      title: "New title",
    });
  });

  it("U-61-5 a gestures-only patch touches only gestures_enabled on an assessment", () => {
    // Assessment, because a PRACTICE patch legitimately also emits
    // `time_limit_sec: null` (the pre-existing untimed-practice invariant,
    // U-M7) — that would mask what this assertion is checking.
    expect(buildQuizUpdates({ gesturesEnabled: false }, "assessment")).toEqual({
      gestures_enabled: false,
    });
  });
});
