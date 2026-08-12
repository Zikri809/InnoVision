import { describe, it, expect } from "vitest";
import {
  isWithinTimeLimit,
  computeScore,
  firstUnansweredIndex,
  remainingMs,
} from "./timer";

const HOUR = 60 * 60 * 1000;

describe("U-T1 — isWithinTimeLimit with grace", () => {
  const startedAt = 1_000_000;

  it("is true inside limit + grace", () => {
    expect(
      isWithinTimeLimit({ startedAt, timeLimitSec: 60, graceSec: 5, now: startedAt + 64_000 }),
    ).toBe(true);
  });

  it("is false past limit + grace", () => {
    expect(
      isWithinTimeLimit({ startedAt, timeLimitSec: 60, graceSec: 5, now: startedAt + 66_000 }),
    ).toBe(false);
  });
});

describe("U-T2 — untimed quiz is always within limit", () => {
  it("returns true regardless of elapsed time", () => {
    expect(
      isWithinTimeLimit({ startedAt: 1_000_000, timeLimitSec: null, graceSec: 5, now: 1_000_000 + 10 * HOUR }),
    ).toBe(true);
  });
});

describe("U-T3 — computeScore counts each correct answer once", () => {
  it("counts correct answers", () => {
    expect(
      computeScore([
        { is_correct: true },
        { is_correct: false },
        { is_correct: true },
      ]),
    ).toBe(2);
  });

  it("returns 0 for no answers / all wrong", () => {
    expect(computeScore([])).toBe(0);
    expect(computeScore([{ is_correct: false }, { is_correct: false }])).toBe(0);
  });
});

describe("U-T5 — boundary is inclusive (exactly limit + grace)", () => {
  const startedAt = 1_000_000;
  it("is within at exactly limit + grace", () => {
    expect(
      isWithinTimeLimit({ startedAt, timeLimitSec: 60, graceSec: 5, now: startedAt + 65_000 }),
    ).toBe(true);
  });
});

describe("U-T6 — firstUnansweredIndex + remainingMs", () => {
  const questions = [
    { id: "q1" },
    { id: "q2" },
    { id: "q3" },
  ];

  it("returns -1 when all questions are answered", () => {
    expect(firstUnansweredIndex(questions, ["q1", "q2", "q3"])).toBe(-1);
  });

  it("returns 0 when nothing is answered", () => {
    expect(firstUnansweredIndex(questions, [])).toBe(0);
  });

  it("resumes mid-list (q1 answered → index 1)", () => {
    expect(firstUnansweredIndex(questions, ["q1"])).toBe(1);
    expect(firstUnansweredIndex(questions, ["q1", "q3"])).toBe(1);
  });

  it("ignores ids that are not in the question set", () => {
    expect(firstUnansweredIndex(questions, ["not-a-question"])).toBe(0);
  });

  it("remainingMs is null for untimed quizzes", () => {
    expect(remainingMs({ startedAt: 1_000_000, timeLimitSec: null, serverNow: 1_000_000 })).toBeNull();
  });

  it("remainingMs is correct for timed quizzes", () => {
    const startedAt = 1_000_000;
    const serverNow = startedAt + 20_000;
    expect(remainingMs({ startedAt, timeLimitSec: 60, serverNow })).toBe(40_000);
  });

  it("remainingMs clamps naturally to negative past the limit (client stops at 0)", () => {
    const startedAt = 1_000_000;
    const serverNow = startedAt + 70_000;
    expect(remainingMs({ startedAt, timeLimitSec: 60, serverNow })).toBe(-10_000);
  });
});
