import { describe, it, expect } from "vitest";
import {
  AiQuizSchema,
  normalizeOptions,
  aiQuizToRows,
  AI_QUESTIONS_MAX,
  AI_QUESTIONS_MIN,
  type AiQuiz,
} from "@/lib/ai/quiz-schema";

const validQuiz: AiQuiz = {
  title: "Chapter 1: Motion",
  questions: [
    {
      type: "mcq",
      prompt: "What is velocity?",
      options: ["Speed in a direction", "Total distance", "Time taken"],
      correct_index: 0,
      explanation: "Velocity includes direction.",
    },
    {
      type: "true_false",
      prompt: "Light travels faster than sound.",
      options: ["True", "False"],
      correct_index: 0,
    },
    {
      type: "mcq",
      prompt: "Which unit is force measured in?",
      options: ["Joule", "Newton", "Watt"],
      correct_index: 1,
    },
  ],
};

describe("U-A1 — valid AI JSON passes AiQuizSchema", () => {
  it("accepts a well-formed mcq + true_false quiz", () => {
    const res = AiQuizSchema.safeParse(validQuiz);
    expect(res.success).toBe(true);
  });
});

describe("U-A2 — correct_index >= options.length rejected", () => {
  it("rejects an out-of-range correct_index", () => {
    const bad = {
      ...validQuiz,
      questions: [
        { ...validQuiz.questions[0], correct_index: 3 }, // 3 options → index 3 invalid
      ],
    };
    const res = AiQuizSchema.safeParse(bad);
    expect(res.success).toBe(false);
  });
});

describe("U-A3 — options >5 or <2 rejected (gesture constraint)", () => {
  it("rejects 6 options", () => {
    const bad = {
      ...validQuiz,
      questions: [
        { ...validQuiz.questions[0], options: ["a", "b", "c", "d", "e", "f"] },
      ],
    };
    expect(AiQuizSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects 1 option", () => {
    const bad = {
      ...validQuiz,
      questions: [{ ...validQuiz.questions[0], options: ["only"] }],
    };
    expect(AiQuizSchema.safeParse(bad).success).toBe(false);
  });
});

describe("U-A4 — type not in mcq/true_false rejected", () => {
  it("rejects an unknown type", () => {
    const bad = {
      ...validQuiz,
      questions: [{ ...validQuiz.questions[0], type: "essay" }],
    };
    expect(AiQuizSchema.safeParse(bad).success).toBe(false);
  });
});

describe("U-A7 — question count bounds", () => {
  it("rejects 2 questions", () => {
    const bad = { ...validQuiz, questions: validQuiz.questions.slice(0, 2) };
    expect(AiQuizSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects 31 questions", () => {
    const one = validQuiz.questions[0];
    const questions = Array.from({ length: 31 }, (_, i) => ({
      ...one,
      prompt: `Question ${i}`,
    }));
    expect(AiQuizSchema.safeParse({ ...validQuiz, questions }).success).toBe(false);
  });

  it("accepts exactly AI_QUESTIONS_MIN and AI_QUESTIONS_MAX", () => {
    const one = validQuiz.questions[0];
    const mk = (n: number) =>
      AiQuizSchema.safeParse({
        ...validQuiz,
        questions: Array.from({ length: n }, (_, i) => ({
          ...one,
          prompt: `Question ${i}`,
        })),
      }).success;
    expect(mk(AI_QUESTIONS_MIN)).toBe(true);
    expect(mk(AI_QUESTIONS_MAX)).toBe(true);
  });
});

describe("U-A11 — schema refines (true_false=2, distinct options)", () => {
  it("rejects true_false with 3 options", () => {
    const bad = {
      ...validQuiz,
      questions: [
        { ...validQuiz.questions[1], options: ["True", "False", "Maybe"] },
      ],
    };
    expect(AiQuizSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects duplicate options (case-insensitive)", () => {
    const bad = {
      ...validQuiz,
      questions: [{ ...validQuiz.questions[0], options: ["Yes", "yes", "No"] }],
    };
    expect(AiQuizSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects empty/whitespace prompt shorter than 5 chars", () => {
    const bad = { ...validQuiz, questions: [{ ...validQuiz.questions[0], prompt: "Hi" }] };
    expect(AiQuizSchema.safeParse(bad).success).toBe(false);
  });
});

describe("U-A8 — normalizeOptions", () => {
  it("trims and dedupes case-insensitively, remapping correct_index", () => {
    const res = normalizeOptions(["  A  ", "a", "B", " c "], 1); // correct was "a" (index 1)
    expect(res).not.toBeNull();
    expect(res!.options).toEqual(["A", "B", "c"]);
    // Original correct text "a" → now at index 0.
    expect(res!.correct_index).toBe(0);
  });

  it("remaps correct_index when the correct option was a duplicate that deduped away", () => {
    // Correct option is the duplicate "a" (index 1). It dedupes into "A" at
    // index 0, so the answer must be remapped to 0 — not lost.
    const res = normalizeOptions(["A", "a", "b"], 1);
    expect(res).toEqual({ options: ["A", "b"], correct_index: 0 });
  });

  it("returns null when the correct option text is absent (out-of-range index)", () => {
    const res = normalizeOptions(["A", "B"], 5);
    expect(res).toBeNull();
  });

  it("keeps distinct options as-is with unchanged index", () => {
    const res = normalizeOptions(["Newton", "Joule", "Watt"], 0);
    expect(res).toEqual({ options: ["Newton", "Joule", "Watt"], correct_index: 0 });
  });
});

describe("aiQuizToRows — converts validated quiz to DB rows", () => {
  it("produces normalized rows with snake_case correct_index", () => {
    const rows = aiQuizToRows(validQuiz);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      type: "mcq",
      correct_index: 0,
      explanation: "Velocity includes direction.",
    });
    expect(rows[1]).toMatchObject({ type: "true_false", options: ["True", "False"] });
  });
});

describe("AiQuestionSchema length bounds", () => {
  it("rejects prompt exceeding 2000 characters", () => {
    const bad = {
      ...validQuiz,
      questions: [
        { ...validQuiz.questions[0], prompt: "A".repeat(2001) },
      ],
    };
    expect(AiQuizSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects option exceeding 500 characters", () => {
    const bad = {
      ...validQuiz,
      questions: [
        { ...validQuiz.questions[0], options: ["A".repeat(501), "B", "C"] },
      ],
    };
    expect(AiQuizSchema.safeParse(bad).success).toBe(false);
  });
});
