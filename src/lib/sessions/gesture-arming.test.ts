import { describe, it, expect } from "vitest";
import {
  TYPE_HAS_FINGER_INPUT,
  typeHasFingerInput,
  isAnswerPadArmed,
  isPalmNextAllowed,
} from "@/lib/sessions/gesture-arming";

/**
 * U-65 — the gesture-arming matrix (audit-4 M4).
 *
 * These four invariants were the exact regressions the v4.9 plan's R3/R6
 * clauses were written against, and had ZERO tests (the existing
 * hold-confirm/hand-loss suites cover only the pre-existing gesture logic):
 *
 *   1. `short_text` is NOT in the finger-input allow-list.
 *   2. The `armed` predicate is false for `short_text` in EVERY phase/answered
 *      combination — a short_text question can never arm the AnswerPad.
 *   3. The palm-next gate applies only to types WITH finger input, so a
 *      0-option short_text keeps palm-next while a 5-option MCQ does not.
 *   4. The allow-list shape is deliberate: an unknown/future type is disarmed.
 */

describe("U-65 — gesture arming matrix (R6/B6-7/B7-5)", () => {
  it("U-65-1 the finger-input allow-list is exactly mcq/true_false/multi_select", () => {
    expect([...TYPE_HAS_FINGER_INPUT].sort()).toEqual([
      "mcq",
      "multi_select",
      "true_false",
    ]);
    expect(typeHasFingerInput("short_text")).toBe(false);
  });

  it("U-65-2 an UNKNOWN/future type is disarmed by default (allow-list, not deny-list)", () => {
    expect(typeHasFingerInput("ordering")).toBe(false);
    expect(typeHasFingerInput("")).toBe(false);
    expect(typeHasFingerInput("MCQ")).toBe(false); // case-sensitive by design
  });

  it("U-65-3 short_text never arms the AnswerPad, in any phase or answered state", () => {
    for (const phase of ["question", "locked", "submitted", "gate"]) {
      for (const answered of [true, false]) {
        expect(
          isAnswerPadArmed({ phase, answered, type: "short_text" }),
          `short_text must not arm in phase=${phase} answered=${answered}`,
        ).toBe(false);
      }
    }
  });

  it("U-65-4 a scalar/multi type arms ONLY in the question phase and before an answer", () => {
    expect(isAnswerPadArmed({ phase: "question", answered: false, type: "mcq" })).toBe(true);
    expect(isAnswerPadArmed({ phase: "question", answered: true, type: "mcq" })).toBe(false);
    expect(isAnswerPadArmed({ phase: "locked", answered: false, type: "mcq" })).toBe(false);
    expect(isAnswerPadArmed({ phase: "question", answered: false, type: "multi_select" })).toBe(true);
    expect(isAnswerPadArmed({ phase: "question", answered: false, type: "true_false" })).toBe(true);
  });

  it("U-65-5 palm-next ignores the optionCount term for a type with NO finger input", () => {
    // B6-7/B7-5: short_text has 0 options; the gate must NOT deny palm-next.
    expect(isPalmNextAllowed({ hasFingerInput: false, optionCount: 0, maxAnswerFingers: 5 })).toBe(true);
    expect(isPalmNextAllowed({ hasFingerInput: false, optionCount: 4, maxAnswerFingers: 5 })).toBe(true);
  });

  it("U-65-6 palm-next keeps the optionCount term when finger input IS in play", () => {
    // A 5-option MCQ: finger 5 could be a valid answer — palm-next must not fire.
    expect(isPalmNextAllowed({ hasFingerInput: true, optionCount: 5, maxAnswerFingers: 5 })).toBe(false);
    expect(isPalmNextAllowed({ hasFingerInput: true, optionCount: 4, maxAnswerFingers: 5 })).toBe(true);
    expect(isPalmNextAllowed({ hasFingerInput: true, optionCount: 0, maxAnswerFingers: 5 })).toBe(true);
  });
});
