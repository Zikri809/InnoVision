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

  it("rejects a missing selectedIndex", () => {
    expect(AnswerSchema.safeParse({ questionId: QUESTION_ID }).success).toBe(false);
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
