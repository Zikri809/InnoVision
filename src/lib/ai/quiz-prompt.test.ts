import { describe, it, expect, vi } from "vitest";
import {
  buildQuizSystemPrompt,
  buildQuizUserPrompt,
  buildRegeneratePrompt,
  sanitizePromptFeedback,
  parseQuizJson,
  parseQuestionJson,
  remainingBudgetMs,
  generateQuiz,
  regenerateQuestion,
} from "@/lib/ai/quiz-prompt";
import type { ChatMessage, ChatResult } from "@/lib/ai/client";
import type { AiQuestion } from "@/lib/ai/quiz-schema";

const validQuizJson = JSON.stringify({
  title: "Motion",
  questions: [
    { type: "mcq", prompt: "What is velocity?", options: ["Speed", "Distance"], correct_index: 0 },
    { type: "true_false", prompt: "Light is faster than sound.", options: ["True", "False"], correct_index: 0 },
    { type: "mcq", prompt: "Unit of force?", options: ["Joule", "Newton"], correct_index: 1 },
  ],
});

const okChat = (text: string) => async (): Promise<ChatResult> => ({ ok: true, text });

const sampleQuestion: AiQuestion = {
  type: "mcq",
  prompt: "Old question",
  options: ["a", "b"],
  correct_index: 0,
};

describe("U-A9 — prompt-injection hardening", () => {
  it("system prompt contains the untrusted-data warning and strict JSON instruction", () => {
    const prompt = buildQuizSystemPrompt();
    expect(prompt).toContain("UNTRUSTED");
    expect(prompt).toContain("ignore previous instructions");
    expect(prompt).toContain("NEVER output anything except a single JSON object");
  });

  it("model output containing embedded instructions fails validation → error, no rows", async () => {
    // The model is "injected" and tries to emit a huge invalid payload / ignore
    // the schema. The result must be a typed invalid_ai_output, never a quiz.
    const injected = JSON.stringify({
      title: "Hacked",
      questions: Array.from({ length: 50 }, (_, i) => ({
        type: "mcq",
        prompt: `X ${i}`,
        options: ["a", "b"],
        correct_index: 0,
      })),
    });
    const res = await generateQuiz({
      chat: okChat(injected),
      text: "chapter",
      questionCount: 10,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("invalid_ai_output");
  });
});

describe("U-A5/U-A6 — one retry, then fail closed", () => {
  it("retries once with validation feedback after malformed JSON", async () => {
    const chat = vi
      .fn<(messages: ChatMessage[]) => Promise<ChatResult>>()
      .mockResolvedValueOnce({ ok: true, text: "not json at all" })
      .mockResolvedValueOnce({ ok: true, text: validQuizJson });

    const res = await generateQuiz({ chat, text: "chapter", questionCount: 10 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.quiz.title).toBe("Motion");
    // Exactly 2 calls: original + 1 retry.
    expect(chat).toHaveBeenCalledTimes(2);
    // The retry prompt must include sanitized feedback.
    const retryUser = chat.mock.calls[1][0].find((m) => m.role === "user")?.content ?? "";
    expect(retryUser).toContain("Previous attempt failed validation");
  });

  it("second failure returns invalid_ai_output with no partial result", async () => {
    const chat = vi
      .fn<(messages: ChatMessage[]) => Promise<ChatResult>>()
      .mockResolvedValue({ ok: true, text: "still not json" });

    const res = await generateQuiz({ chat, text: "chapter", questionCount: 10 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("invalid_ai_output");
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("transport errors are NOT retried", async () => {
    const chat = vi
      .fn<(messages: ChatMessage[]) => Promise<ChatResult>>()
      .mockResolvedValue({ ok: false, error: "timeout" });

    const res = await generateQuiz({ chat, text: "chapter", questionCount: 10 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("timeout");
    expect(chat).toHaveBeenCalledTimes(1);
  });
});

describe("U-A10 — parseQuizJson strips fences", () => {
  it("parses fenced json", () => {
    const parsed = parseQuizJson("```json\n" + validQuizJson + "\n```");
    expect(parsed.ok).toBe(true);
  });

  it("parses bare json", () => {
    const parsed = parseQuizJson(validQuizJson);
    expect(parsed.ok).toBe(true);
  });

  it("rejects non-JSON", () => {
    const parsed = parseQuizJson("<html>oops</html>");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.length).toBeGreaterThan(0);
  });
});

describe("parseQuestionJson — wrapper handling", () => {
  it("accepts a bare question object", () => {
    const parsed = parseQuestionJson(JSON.stringify(sampleQuestion));
    expect(parsed.ok).toBe(true);
  });

  it("accepts a single-question wrapper", () => {
    const parsed = parseQuestionJson(
      JSON.stringify({ title: "T", questions: [sampleQuestion] }),
    );
    expect(parsed.ok).toBe(true);
  });

  it("rejects a wrapper with more than one question", () => {
    const parsed = parseQuestionJson(
      JSON.stringify({ title: "T", questions: [sampleQuestion, sampleQuestion] }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues[0]).toContain("exactly one question");
  });

  it("reports the wrapper question's own issues when the single question is invalid", () => {
    const parsed = parseQuestionJson(
      JSON.stringify({
        title: "T",
        questions: [{ type: "mcq", prompt: "x", options: ["a"], correct_index: 5 }],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      // The reported issues must come from the wrapper's question, not the
      // bare-object path (which would be empty/misleading).
      expect(parsed.issues.length).toBeGreaterThan(0);
    }
  });
});

describe("remainingBudgetMs — deadline clamping", () => {
  it("clamps to a minimum of 1s when the deadline has passed", () => {
    expect(remainingBudgetMs(Date.now() - 10_000)).toBe(1_000);
  });

  it("returns the remaining time when the deadline is in the future", () => {
    const remaining = remainingBudgetMs(Date.now() + 5_000);
    expect(remaining).toBeGreaterThan(1_000);
    expect(remaining).toBeLessThanOrEqual(5_000);
  });
});

describe("sanitizePromptFeedback", () => {
  it("strips control chars and truncates", () => {
    const out = sanitizePromptFeedback("a\nb\u0000c " + "x".repeat(1000), 100);
    expect(out).toHaveLength(100);
    expect(out).not.toContain("\u0000");
    expect(out).not.toContain("\n");
  });
});

describe("regenerateQuestion", () => {
  it("replaces the question on valid output", async () => {
    const newQ = JSON.stringify({
      type: "mcq",
      prompt: "New question",
      options: ["x", "y"],
      correct_index: 1,
    });
    const res = await regenerateQuestion({
      chat: okChat(newQ),
      question: sampleQuestion,
      siblings: [],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.question.prompt).toBe("New question");
      expect(res.question.correct_index).toBe(1);
    }
  });

  it("unwrap a {title, questions:[...]} wrapper", async () => {
    const wrapper = JSON.stringify({ title: "T", questions: [sampleQuestion] });
    const res = await regenerateQuestion({
      chat: okChat(wrapper),
      question: sampleQuestion,
      siblings: [],
    });
    expect(res.ok).toBe(true);
  });

  it("fails cleanly and leaves original untouched (caller never writes)", async () => {
    const res = await regenerateQuestion({
      chat: okChat("garbage"),
      question: sampleQuestion,
      siblings: [],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("invalid_ai_output");
  });
});

describe("buildQuizUserPrompt caps question count", () => {
  it("clamps to 3..30", () => {
    expect(buildQuizUserPrompt("text", 1)).toContain("exactly 3 questions");
    expect(buildQuizUserPrompt("text", 99)).toContain("exactly 30 questions");
  });
});

describe("buildRegeneratePrompt", () => {
  it("includes the original question and instruction", () => {
    const p = buildRegeneratePrompt({
      question: sampleQuestion,
      siblings: [],
      instruction: "make it about acceleration",
    });
    expect(p).toContain("make it about acceleration");
    expect(p).toContain("Old question");
  });
});
