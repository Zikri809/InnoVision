import { describe, it, expect } from "vitest";
import {
  QuestionInputSchema,
  CreateQuizSchema,
  UpdateQuizSchema,
  ReorderSchema,
} from "@/lib/quizzes/validation";

const validMcq = {
  type: "mcq",
  prompt: "What is 2 + 2?",
  options: ["1", "2", "3", "4"],
  correctIndex: 3,
  explanation: "2 + 2 = 4",
};

const validTrueFalse = {
  type: "true_false",
  prompt: "Water boils at 100°C at sea level.",
  options: ["True", "False"],
  correctIndex: 0,
};

describe("QuestionInputSchema (U-Q1..U-Q7)", () => {
  it("U-Q1 accepts a valid mcq question", () => {
    const parsed = QuestionInputSchema.parse(validMcq);
    expect(parsed.correctIndex).toBe(3);
    // trim applied; explanation retained
    expect(parsed.prompt).toBe("What is 2 + 2?");
  });

  it("U-Q2 accepts a valid true_false question", () => {
    const parsed = QuestionInputSchema.parse(validTrueFalse);
    expect(parsed.type).toBe("true_false");
    expect(parsed.options).toHaveLength(2);
  });

  it("U-Q3 rejects correctIndex >= options.length", () => {
    const result = QuestionInputSchema.safeParse({
      ...validMcq,
      correctIndex: 4,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("correctIndex"))).toBe(true);
    }
  });

  it("U-Q4 rejects true_false with 3 options", () => {
    const result = QuestionInputSchema.safeParse({
      ...validTrueFalse,
      options: ["True", "False", "Maybe"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("options"))).toBe(true);
    }
  });

  it("U-Q5 rejects duplicate options (case-insensitive)", () => {
    const result = QuestionInputSchema.safeParse({
      ...validMcq,
      options: ["Yes", "yes", "No"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("options"))).toBe(true);
    }
  });

  it("U-Q6 rejects empty/whitespace prompt", () => {
    const result = QuestionInputSchema.safeParse({ ...validMcq, prompt: "   " });
    expect(result.success).toBe(false);
  });

  it("U-Q7 rejects invalid type, >5 options, and empty options", () => {
    expect(QuestionInputSchema.safeParse({ ...validMcq, type: "essay" }).success).toBe(false);
    expect(
      QuestionInputSchema.safeParse({ ...validMcq, options: ["a", "b", "c", "d", "e", "f"] }).success,
    ).toBe(false);
    expect(QuestionInputSchema.safeParse({ ...validMcq, options: [] }).success).toBe(false);
    expect(QuestionInputSchema.safeParse({ ...validMcq, options: ["only"] }).success).toBe(false);
  });

  it("trims option strings and rejects empty-after-trim", () => {
    const ok = QuestionInputSchema.safeParse({
      ...validMcq,
      options: ["  Alpha ", "Beta", "Gamma", "Delta"],
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.options[0]).toBe("Alpha");

    const bad = QuestionInputSchema.safeParse({
      ...validMcq,
      options: ["Alpha", "  ", "Gamma", "Delta"],
    });
    expect(bad.success).toBe(false);
  });

  it("allows a null/absent explanation", () => {
    expect(QuestionInputSchema.safeParse({ ...validMcq, explanation: null }).success).toBe(true);
    const { explanation, ...withoutExplanation } = validMcq;
    void explanation;
    expect(QuestionInputSchema.safeParse(withoutExplanation).success).toBe(true);
  });
});

describe("CreateQuizSchema (U-M6)", () => {
  it("defaults mode to practice", () => {
    const parsed = CreateQuizSchema.parse({ title: "  My Quiz  " });
    expect(parsed.title).toBe("My Quiz");
    expect(parsed.mode).toBe("practice");
  });

  it("accepts assessment with a time limit", () => {
    const parsed = CreateQuizSchema.parse({
      title: "Exam",
      mode: "assessment",
      timeLimitSec: 600,
    });
    expect(parsed.mode).toBe("assessment");
    expect(parsed.timeLimitSec).toBe(600);
  });

  it("accepts null timeLimitSec (untimed)", () => {
    expect(CreateQuizSchema.safeParse({ title: "Q", timeLimitSec: null }).success).toBe(true);
  });

  it("U-M6 rejects empty title and out-of-range time limits (capped at 7200)", () => {
    expect(CreateQuizSchema.safeParse({ title: "   " }).success).toBe(false);
    expect(CreateQuizSchema.safeParse({ title: "Q", timeLimitSec: 0 }).success).toBe(false);
    expect(CreateQuizSchema.safeParse({ title: "Q", timeLimitSec: 7201 }).success).toBe(false);
    expect(CreateQuizSchema.safeParse({ title: "Q", timeLimitSec: 10.5 }).success).toBe(false);
  });
});

describe("UpdateQuizSchema (U-M1..U-M5)", () => {
  it("U-M1 accepts partial updates without injecting mode or timeLimitSec", () => {
    expect(UpdateQuizSchema.safeParse({ title: "Renamed" }).success).toBe(true);
    expect(UpdateQuizSchema.safeParse({ mode: "assessment" }).success).toBe(true);
    expect(UpdateQuizSchema.safeParse({}).success).toBe(true);
  });

  it("U-M2 accepts maximum boundary 7200 seconds", () => {
    const res = UpdateQuizSchema.safeParse({ mode: "assessment", timeLimitSec: 7200 });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.timeLimitSec).toBe(7200);
    }
  });

  it("U-M3 accepts minimum boundary 1 second", () => {
    const res = UpdateQuizSchema.safeParse({ mode: "assessment", timeLimitSec: 1 });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.timeLimitSec).toBe(1);
    }
  });

  it("U-M4 rejects timeLimitSec: 0, -1, 7201, 30.5, NaN", () => {
    expect(UpdateQuizSchema.safeParse({ timeLimitSec: 0 }).success).toBe(false);
    expect(UpdateQuizSchema.safeParse({ timeLimitSec: -1 }).success).toBe(false);
    expect(UpdateQuizSchema.safeParse({ timeLimitSec: 7201 }).success).toBe(false);
    expect(UpdateQuizSchema.safeParse({ timeLimitSec: 30.5 }).success).toBe(false);
    expect(UpdateQuizSchema.safeParse({ timeLimitSec: NaN }).success).toBe(false);
  });

  it("U-M5 rejects invalid partial fields (empty title, whitespace, >200 chars)", () => {
    expect(UpdateQuizSchema.safeParse({ title: "" }).success).toBe(false);
    expect(UpdateQuizSchema.safeParse({ title: "   " }).success).toBe(false);
    expect(UpdateQuizSchema.safeParse({ title: "a".repeat(201) }).success).toBe(false);
    expect(UpdateQuizSchema.safeParse({ mode: "essay" }).success).toBe(false);
  });

  it("H2 — does NOT inject mode on a partial update (no mode downgrade)", () => {
    // Regression: UpdateQuizSchema must not default mode to "practice" — a
    // title-only PATCH must not silently flip an assessment quiz to practice.
    const parsed = UpdateQuizSchema.safeParse({ title: "Renamed" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.mode).toBeUndefined();
      expect(parsed.data.title).toBe("Renamed");
    }

    const empty = UpdateQuizSchema.safeParse({});
    expect(empty.success).toBe(true);
    if (empty.success) {
      expect(Object.keys(empty.data).length).toBe(0);
    }

    const modeOnly = UpdateQuizSchema.safeParse({ mode: "assessment" });
    expect(modeOnly.success).toBe(true);
    if (modeOnly.success) {
      expect(modeOnly.data.mode).toBe("assessment");
      expect(modeOnly.data.title).toBeUndefined();
    }
  });

  it("handles title edge cases (trimming, boundary 200 chars, unicode & emojis)", () => {
    const trimmed = UpdateQuizSchema.safeParse({ title: "   Week 5 Quiz   " });
    expect(trimmed.success).toBe(true);
    if (trimmed.success) {
      expect(trimmed.data.title).toBe("Week 5 Quiz");
    }

    const exact200 = UpdateQuizSchema.safeParse({ title: "x".repeat(200) });
    expect(exact200.success).toBe(true);
    if (exact200.success) {
      expect(exact200.data.title).toHaveLength(200);
    }

    const unicodeTitle = UpdateQuizSchema.safeParse({ title: "🧬 Biology 101: Cell Division 🔬 (Midterm)" });
    expect(unicodeTitle.success).toBe(true);
    if (unicodeTitle.success) {
      expect(unicodeTitle.data.title).toBe("🧬 Biology 101: Cell Division 🔬 (Midterm)");
    }
  });
});

describe("ReorderSchema", () => {
  const uuid = "11111111-1111-4111-8111-111111111111";
  it("accepts an array of uuids", () => {
    expect(ReorderSchema.safeParse({ questionIds: [uuid] }).success).toBe(true);
  });

  it("rejects empty arrays and non-uuid entries", () => {
    expect(ReorderSchema.safeParse({ questionIds: [] }).success).toBe(false);
    expect(ReorderSchema.safeParse({ questionIds: ["not-a-uuid"] }).success).toBe(false);
  });

  it("M8 — surfaces a helpful message for non-uuid entries", () => {
    const result = ReorderSchema.safeParse({ questionIds: ["not-a-uuid"] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/valid UUID/i);
    }
  });
});
