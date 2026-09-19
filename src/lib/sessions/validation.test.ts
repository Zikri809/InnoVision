import { describe, it, expect } from "vitest";
import { StartSessionSchema, AnswerSchema, SubmitSchema } from "./validation";

const QUIZ_ID = "00000000-0000-4000-8000-00000000000c";
const QUESTION_ID = "00000000-0000-4000-8000-00000000000d";

describe("U-S1 — valid payloads pass", () => {
  it("StartSessionSchema accepts a valid quizId", () => {
    expect(StartSessionSchema.safeParse({ quizId: QUIZ_ID }).success).toBe(true);
  });

  it("AnswerSchema accepts a valid questionId + non-negative int selectedIndex", () => {
    expect(
      AnswerSchema.safeParse({ questionId: QUESTION_ID, selectedIndex: 0 }).success,
    ).toBe(true);
    expect(
      AnswerSchema.safeParse({ questionId: QUESTION_ID, selectedIndex: 4 }).success,
    ).toBe(true);
  });

  it("SubmitSchema accepts an empty object", () => {
    expect(SubmitSchema.safeParse({}).success).toBe(true);
  });
});

describe("U-S2 — non-UUID ids rejected", () => {
  it("rejects a non-UUID quizId", () => {
    expect(StartSessionSchema.safeParse({ quizId: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects a non-UUID questionId", () => {
    expect(
      AnswerSchema.safeParse({ questionId: "not-a-uuid", selectedIndex: 1 }).success,
    ).toBe(false);
  });

  it("rejects a missing quizId", () => {
    expect(StartSessionSchema.safeParse({}).success).toBe(false);
  });
});

describe("U-S3 — negative / non-integer selectedIndex rejected", () => {
  it("rejects a negative selectedIndex", () => {
    expect(
      AnswerSchema.safeParse({ questionId: QUESTION_ID, selectedIndex: -1 }).success,
    ).toBe(false);
  });

  it("rejects a non-integer selectedIndex", () => {
    expect(
      AnswerSchema.safeParse({ questionId: QUESTION_ID, selectedIndex: 1.5 }).success,
    ).toBe(false);
  });

  it("rejects a missing answer field (neither selectedIndex nor selectedIndices)", () => {
    expect(AnswerSchema.safeParse({ questionId: QUESTION_ID }).success).toBe(false);
  });
});

describe("U-QT1 — AnswerSchema one-of (multi-select)", () => {
  it("accepts a valid selectedIndices set", () => {
    expect(
      AnswerSchema.safeParse({ questionId: QUESTION_ID, selectedIndices: [0, 2] }).success,
    ).toBe(true);
  });

  it("rejects BOTH fields present (exactly-one rule)", () => {
    expect(
      AnswerSchema.safeParse({ questionId: QUESTION_ID, selectedIndex: 0, selectedIndices: [1] })
        .success,
    ).toBe(false);
  });

  it("rejects an empty set", () => {
    expect(
      AnswerSchema.safeParse({ questionId: QUESTION_ID, selectedIndices: [] }).success,
    ).toBe(false);
  });

  it("rejects a set larger than 5 (options cap)", () => {
    expect(
      AnswerSchema.safeParse({
        questionId: QUESTION_ID,
        selectedIndices: [0, 1, 2, 3, 4, 5],
      }).success,
    ).toBe(false);
  });

  it("rejects negative / non-integer / int4-overflow elements", () => {
    expect(
      AnswerSchema.safeParse({ questionId: QUESTION_ID, selectedIndices: [-1] }).success,
    ).toBe(false);
    expect(
      AnswerSchema.safeParse({ questionId: QUESTION_ID, selectedIndices: [1.5] }).success,
    ).toBe(false);
    expect(
      AnswerSchema.safeParse({ questionId: QUESTION_ID, selectedIndices: [2_147_483_648] })
        .success,
    ).toBe(false);
  });
});

describe("U-S4 — SubmitSchema boundary", () => {
  it("accepts {} (empty body tolerated)", () => {
    expect(SubmitSchema.safeParse({}).success).toBe(true);
  });

  it("rejects a non-object body", () => {
    expect(SubmitSchema.safeParse(null).success).toBe(false);
  });
});

/**
 * FC-8/R13 (PLAN_GESTURE_OFF_RICH_TYPES §7): the two new answer shapes.
 *
 * The shared schema cannot see the question's type, so it enforces SHAPE
 * EXCLUSIVITY ONLY — `answerText ⇒ short_text` and `skipped`'s per-mode rules
 * belong to the RPC, which reads the question row. These pin the boundary
 * rules the schema DOES own: exactly one of four fields, and the 1..500 trim
 * bound on the free-text answer.
 */
describe("U-SHORT — answerText + skipped shape exclusivity", () => {
  it("accepts a trimmed answerText alone", () => {
    const parsed = AnswerSchema.safeParse({ questionId: QUESTION_ID, answerText: "  sugar  " });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.answerText).toBe("sugar");
  });

  it("accepts skipped:true alone", () => {
    expect(
      AnswerSchema.safeParse({ questionId: QUESTION_ID, skipped: true }).success,
    ).toBe(true);
  });

  it("rejects an empty / whitespace-only answerText", () => {
    for (const answerText of ["", "   ", "\n\t"]) {
      expect(
        AnswerSchema.safeParse({ questionId: QUESTION_ID, answerText }).success,
      ).toBe(false);
    }
  });

  it("rejects an answerText over 500 characters", () => {
    expect(
      AnswerSchema.safeParse({ questionId: QUESTION_ID, answerText: "x".repeat(500) }).success,
    ).toBe(true);
    expect(
      AnswerSchema.safeParse({ questionId: QUESTION_ID, answerText: "x".repeat(501) }).success,
    ).toBe(false);
  });

  it("rejects answerText combined with any index field", () => {
    expect(
      AnswerSchema.safeParse({ questionId: QUESTION_ID, answerText: "t", selectedIndex: 0 })
        .success,
    ).toBe(false);
    expect(
      AnswerSchema.safeParse({ questionId: QUESTION_ID, answerText: "t", selectedIndices: [0] })
        .success,
    ).toBe(false);
  });

  it("rejects skipped combined with any answer payload", () => {
    expect(
      AnswerSchema.safeParse({ questionId: QUESTION_ID, skipped: true, selectedIndex: 0 })
        .success,
    ).toBe(false);
    expect(
      AnswerSchema.safeParse({ questionId: QUESTION_ID, skipped: true, answerText: "t" })
        .success,
    ).toBe(false);
  });

  it("rejects a missing answer field (all four absent)", () => {
    expect(AnswerSchema.safeParse({ questionId: QUESTION_ID }).success).toBe(false);
  });

  it("rejects a non-boolean skipped", () => {
    expect(
      AnswerSchema.safeParse({ questionId: QUESTION_ID, skipped: "yes" }).success,
    ).toBe(false);
  });
});
