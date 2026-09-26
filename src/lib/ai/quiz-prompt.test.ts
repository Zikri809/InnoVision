import { describe, it, expect, vi } from "vitest";
import {
  buildRegenerateSystemPrompt,
  buildQuizSystemPrompt,
  buildQuizUserPrompt,
  buildRegeneratePrompt,
  sanitizePromptFeedback,
  parseQuizJson,
  parseQuestionJson,
  auditSelfContained,
  remainingBudgetMs,
  generateQuiz,
  regenerateQuestion,
} from "@/lib/ai/quiz-prompt";
import { NO_CHAT_USAGE, type ChatMessage, type ChatResult } from "@/lib/ai/client";
import type { AiQuestion } from "@/lib/ai/quiz-schema";

const validQuizJson = JSON.stringify({
  title: "Motion",
  questions: [
    { type: "mcq", prompt: "What is velocity?", options: ["Speed", "Distance"], correct_index: 0 },
    { type: "true_false", prompt: "Light is faster than sound.", options: ["True", "False"], correct_index: 0 },
    { type: "mcq", prompt: "Unit of force?", options: ["Joule", "Newton"], correct_index: 1 },
  ],
});

const okChat = (text: string) => async (): Promise<ChatResult> => ({ ok: true, text, usage: NO_CHAT_USAGE });

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
      .mockResolvedValueOnce({ ok: true, text: "not json at all", usage: NO_CHAT_USAGE })
      .mockResolvedValueOnce({ ok: true, text: validQuizJson, usage: NO_CHAT_USAGE });

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
      .mockResolvedValue({ ok: true, text: "still not json", usage: NO_CHAT_USAGE });

    const res = await generateQuiz({ chat, text: "chapter", questionCount: 10 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("invalid_ai_output");
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("transport errors are NOT retried", async () => {
    const chat = vi
      .fn<(messages: ChatMessage[]) => Promise<ChatResult>>()
      .mockResolvedValue({ ok: false, error: "timeout", usage: NO_CHAT_USAGE });

    const res = await generateQuiz({ chat, text: "chapter", questionCount: 10 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("timeout");
    expect(chat).toHaveBeenCalledTimes(1);
  });
});

describe("system prompt — self-contained question rule", () => {
  it("quiz system prompt forbids source-referential prompts ('In Task 1…', figures)", () => {
    const prompt = buildQuizSystemPrompt();
    expect(prompt).toContain("SELF-CONTAINED QUESTIONS");
    expect(prompt).toContain("In Task 1");
    expect(prompt).toContain("figure");
  });

  it("quiz system prompt keeps the rule across format/multi-select variants", () => {
    for (const config of [
      { formatDistribution: "mcq_only" as const },
      { formatDistribution: "true_false_only" as const },
      { allowMultiSelect: true },
    ]) {
      expect(buildQuizSystemPrompt(config)).toContain("SELF-CONTAINED QUESTIONS");
    }
  });

  it("regenerate system prompt carries the same self-containment rule", () => {
    for (const type of ["mcq", "true_false", "multi_select"] as const) {
      expect(buildRegenerateSystemPrompt("en", type)).toContain("SELF-CONTAINED QUESTIONS");
    }
  });
});

describe("auditSelfContained — source-reference and deliberation gate", () => {
  // AiQuizSchema requires >=3 questions, so fixtures always carry three.
  const quizWith = (
    ...questions: Array<{ prompt: string; explanation?: string; options?: string[] }>
  ) =>
    JSON.stringify({
      title: "T",
      questions: [
        { type: "mcq", prompt: "Neutral filler one?", options: ["a", "b", "c", "d"], correct_index: 0 },
        ...questions.map((q) => ({
          type: "mcq" as const,
          prompt: q.prompt,
          options: q.options ?? ["a", "b", "c", "d"],
          correct_index: 0,
          ...(q.explanation ? { explanation: q.explanation } : {}),
        })),
        { type: "mcq", prompt: "Neutral filler two?", options: ["a", "b", "c", "d"], correct_index: 0 },
      ],
    });

  it("accepts self-contained questions (existing fixtures pass)", () => {
    const parsed = parseQuizJson(validQuizJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(auditSelfContained(parsed.quiz)).toEqual([]);
  });

  it("flags 'In Task N…' prompts (real GLM failure, 2026-09 paste)", () => {
    const parsed = parseQuizJson(
      quizWith({ prompt: "In Task 3, for i=3, what happens in the justDoit method?" }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const issues = auditSelfContained(parsed.quiz);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("Q2");
    expect(issues[0]).toContain("self-contained");
  });

  it("flags figure/passage/according-to references", () => {
    for (const prompt of [
      "From the figure above, what is the slope?",
      "According to the passage, why did the ship sink?",
      "In the lab sheet exercise 2, what is printed?",
    ]) {
      const parsed = parseQuizJson(quizWith({ prompt }));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(auditSelfContained(parsed.quiz).length).toBe(1);
    }
  });

  it("does NOT flag questions that merely use shared nouns (code/task words without reference)", () => {
    const parsed = parseQuizJson(
      quizWith(
        { prompt: "In Java, what does a try block do?" },
        { prompt: "Which method throws in this code: try { justDoit(); } catch (RuntimeException e) {}?" },
      ),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(auditSelfContained(parsed.quiz)).toEqual([]);
  });

  it("flags leaked deliberation ('wait … actually … let's correct') in prompt or explanation", () => {
    const parsed = parseQuizJson(
      quizWith({
        prompt: "If the user inputs 0, what is the final value of sum?",
        explanation: "sum becomes 10/10=1. Actually finally: if sum <=0 sum=100. Let's correct: sum = 1.",
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const issues = auditSelfContained(parsed.quiz);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("deliberation");
  });
});

describe("generateQuiz — self-containment retry integration", () => {
  const bad = JSON.stringify({
    title: "Java Quiz",
    questions: [
      { type: "mcq", prompt: "In Task 2, what is the final value of sum?", options: ["0", "1", "10", "100"], correct_index: 1 },
      { type: "mcq", prompt: "From the figure, what is the angle?", options: ["a", "b", "c", "d"], correct_index: 0 },
      { type: "mcq", prompt: "In the lab sheet, what prints for i=5?", options: ["5", "6", "7", "8"], correct_index: 0 },
    ],
  });
  const good = JSON.stringify({
    title: "Java Quiz",
    questions: [
      { type: "mcq", prompt: "In Java, what does `sum / 0` throw for int division?", options: ["ArithmeticException", "NullPointerException", "IOException", "Error"], correct_index: 0 },
      { type: "mcq", prompt: "What does a finally block guarantee in Java?", options: ["It always runs", "It never runs", "It runs only on error", "It runs only on success"], correct_index: 0 },
      { type: "true_false", prompt: "A try block must be followed by catch or finally.", options: ["True", "False"], correct_index: 0 },
    ],
  });

  it("retries when the first attempt references the source, accepts a clean second attempt", async () => {
    const calls: string[] = [];
    const chat = async (messages: ChatMessage[]): Promise<ChatResult> => {
      calls.push(messages[messages.length - 1].content);
      return { ok: true, text: calls.length === 1 ? bad : good, usage: NO_CHAT_USAGE };
    };
    const res = await generateQuiz({ chat, text: "chapter", questionCount: 3 });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
    // The retry feedback names the violation (sanitized, single line).
    expect(calls[1]).toContain("Previous attempt failed validation");
    expect(calls[1]).toContain("self-contained");
  });

  it("fails invalid_ai_output when BOTH attempts violate self-containment", async () => {
    const chat = async (): Promise<ChatResult> => ({ ok: true, text: bad, usage: NO_CHAT_USAGE });
    const res = await generateQuiz({ chat, text: "chapter", questionCount: 3 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("invalid_ai_output");
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

  // audit-3 F-F8: prose-wrapped JSON used to fail BOTH attempts (the fence
  // stripper only handled a full-wrap fence), burning two full-priced calls
  // before a 422. Salvage the embedded object instead.
  it("salvages JSON wrapped in prose with a fenced block", () => {
    const parsed = parseQuizJson(`Here is the quiz:\n\`\`\`json\n${validQuizJson}\n\`\`\`\nHope that helps!`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.quiz.title).toBe("Motion");
  });

  it("salvages a bare JSON object embedded in prose (no fence)", () => {
    const parsed = parseQuizJson(`Sure! ${validQuizJson} Let me know if you need changes.`);
    expect(parsed.ok).toBe(true);
  });

  it("ignores a stray parseable object that is not a valid quiz", () => {
    const parsed = parseQuizJson(`{"unrelated":true} then ${validQuizJson}`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.quiz.questions).toHaveLength(3);
  });

  it("still fails when no valid quiz object exists anywhere", () => {
    const parsed = parseQuizJson(`{"unrelated":true} and {"other":1}`);
    expect(parsed.ok).toBe(false);
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

  // audit-3 F-F1: an aborted caller signal must not spend a round trip — the
  // `cancelled` branch used to be unreachable because no signal was threaded.
  it("returns cancelled without calling the model when the signal is already aborted", async () => {
    const chat = vi.fn(okChat(JSON.stringify({ type: "mcq", prompt: "x", options: ["a", "b"], correct_index: 0 })));
    const res = await regenerateQuestion({
      chat,
      question: sampleQuestion,
      siblings: [],
      signal: AbortSignal.abort(),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("cancelled");
    expect(chat).not.toHaveBeenCalled();
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

describe("difficulty & format distribution prompt generation", () => {
  it("generates easy recall constraints", () => {
    const prompt = buildQuizSystemPrompt({ difficulty: "easy", formatDistribution: "mcq_only" });
    expect(prompt).toContain("EASY (Recall & Foundations)");
    expect(prompt).toContain("ONLY multiple-choice questions");
  });

  it("generates hard analysis constraints", () => {
    const prompt = buildQuizSystemPrompt({ difficulty: "hard", formatDistribution: "true_false_only" });
    expect(prompt).toContain("HARD (Analysis & Evaluation)");
    expect(prompt).toContain("ONLY True/False questions");
  });

  it("includes lecturer steering instructions in user prompt", () => {
    const userPrompt = buildQuizUserPrompt({
      text: "Chapter content",
      questionCount: 5,
      steeringPrompt: "Focus on memory management algorithms",
    });
    expect(userPrompt).toContain("=== LECTURER STEERING INSTRUCTIONS ===");
    expect(userPrompt).toContain("Focus on memory management algorithms");
    expect(userPrompt).toContain("=== SOURCE MATERIAL (UNTRUSTED DATA) ===");
    expect(userPrompt).toContain("exactly 5 questions");
  });

  it("escapes markdown code blocks inside source text", () => {
    const userPrompt = buildQuizUserPrompt({
      text: "Code example:\n```js\nconsole.log(1);\n```",
      questionCount: 5,
    });
    expect(userPrompt).not.toContain("```js");
    expect(userPrompt).toContain("'''js");
  });

  it("retries when formatDistribution is violated (e.g. true_false in mcq_only)", async () => {
    const chat = vi
      .fn<(messages: ChatMessage[]) => Promise<ChatResult>>()
      .mockResolvedValueOnce({
        ok: true,
        usage: NO_CHAT_USAGE,
        text: JSON.stringify({
          title: "Title",
          questions: [
            { type: "true_false", prompt: "TF 1", options: ["True", "False"], correct_index: 0 },
            { type: "mcq", prompt: "MCQ 1", options: ["A", "B"], correct_index: 0 },
            { type: "mcq", prompt: "MCQ 2", options: ["A", "B"], correct_index: 1 },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        usage: NO_CHAT_USAGE,
        text: JSON.stringify({
          title: "Title",
          questions: [
            { type: "mcq", prompt: "MCQ 1", options: ["A", "B"], correct_index: 0 },
            { type: "mcq", prompt: "MCQ 2", options: ["A", "B"], correct_index: 1 },
            { type: "mcq", prompt: "MCQ 3", options: ["A", "B"], correct_index: 0 },
          ],
        }),
      });

    const res = await generateQuiz({
      chat,
      text: "chapter text",
      questionCount: 3,
      formatDistribution: "mcq_only",
    });

    expect(res.ok).toBe(true);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("regenerateQuestion rejects type mismatch between original and regenerated question", async () => {
    const chat = vi
      .fn<(messages: ChatMessage[]) => Promise<ChatResult>>()
      .mockResolvedValue({
        ok: true,
        usage: NO_CHAT_USAGE,
        text: JSON.stringify({
          type: "true_false", // original was mcq
          prompt: "TF question",
          options: ["True", "False"],
          correct_index: 0,
        }),
      });

    const res = await regenerateQuestion({
      chat,
      question: sampleQuestion, // mcq
      siblings: [],
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("invalid_ai_output");
    expect(chat).toHaveBeenCalledTimes(2); // Retried once before failing
  });
});




describe("QT-1 — allowMultiSelect gating", () => {
  const multiJson = JSON.stringify({
    title: "Mixed quiz",
    questions: [
      { type: "mcq", prompt: "What is 2+2?", options: ["3", "4"], correct_index: 1 },
      { type: "true_false", prompt: "Sun is hot.", options: ["True", "False"], correct_index: 0 },
      {
        type: "multi_select",
        prompt: "Which are prime?",
        options: ["2", "3", "4", "5"],
        correct_indices: [0, 1, 3],
      },
    ],
  });

  it("U-QT1-P1 default prompt never mentions multi_select (byte-identical default)", () => {
    expect(buildQuizSystemPrompt()).not.toContain("multi_select");
    expect(buildQuizSystemPrompt({ formatDistribution: "mixed" })).not.toContain("multi_select");
  });

  it("U-QT1-P2 opt-in prompt advertises multi_select + correct_indices", () => {
    const prompt = buildQuizSystemPrompt({ allowMultiSelect: true });
    expect(prompt).toContain("multi_select");
    expect(prompt).toContain("correct_indices");
  });

  it("U-QT1-P3 default (flag off) rejects multi output via the retry loop", async () => {
    const res = await generateQuiz({
      chat: okChat(multiJson),
      text: "chapter",
      questionCount: 10,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("invalid_ai_output");
      expect(res.message).toContain("Multi-select");
    }
  });

  it("U-QT1-P4 opt-in (flag on) accepts the mixed quiz", async () => {
    const res = await generateQuiz({
      chat: okChat(multiJson),
      text: "chapter",
      questionCount: 10,
      allowMultiSelect: true,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.quiz.questions.some((q) => q.type === "multi_select")).toBe(true);
    }
  });

  it("U-QT1-P6 default prompt never mentions short_text (unrelated flag)", () => {
    expect(buildQuizSystemPrompt()).not.toContain("short_text");
    expect(buildQuizSystemPrompt({ allowMultiSelect: true })).not.toContain("short_text");
  });
});

describe("Gesture-off — allowShortText gating", () => {
  const shortJson = JSON.stringify({
    title: "Mixed quiz",
    questions: [
      { type: "mcq", prompt: "What is 2+2?", options: ["3", "4"], correct_index: 1 },
      { type: "true_false", prompt: "Sun is hot.", options: ["True", "False"], correct_index: 0 },
      {
        type: "short_text",
        prompt: "Why is the sky blue?",
        options: [],
        answer_key: "Rayleigh scattering by air molecules.",
      },
    ],
  });

  it("U-ST-P1 default prompt never mentions short_text (byte-identical default)", () => {
    expect(buildQuizSystemPrompt()).not.toContain("short_text");
    expect(buildQuizSystemPrompt()).not.toContain("answer_key");
    expect(buildQuizSystemPrompt({ formatDistribution: "mixed" })).not.toContain("short_text");
  });

  it("U-ST-P2 opt-in prompt advertises short_text + answer_key", () => {
    const prompt = buildQuizSystemPrompt({ allowShortText: true });
    expect(prompt).toContain("short_text");
    expect(prompt).toContain("answer_key");
  });

  it("U-ST-P3 default (flag off) rejects short output via the retry loop", async () => {
    const res = await generateQuiz({
      chat: okChat(shortJson),
      text: "chapter",
      questionCount: 10,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("invalid_ai_output");
      expect(res.message).toContain("Short-text");
    }
  });

  it("U-ST-P4 opt-in (flag on) accepts the mixed quiz", async () => {
    const res = await generateQuiz({
      chat: okChat(shortJson),
      text: "chapter",
      questionCount: 10,
      allowShortText: true,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.quiz.questions.some((q) => q.type === "short_text")).toBe(true);
    }
  });

  it("U-ST-P5 regenerate keeps the short type and its rubric key", async () => {
    const shortQuestion: AiQuestion = {
      type: "short_text",
      prompt: "Old short",
      options: [],
      answer_key: "Old rubric.",
    };
    const rewritten = JSON.stringify({
      type: "short_text",
      prompt: "New short",
      options: [],
      answer_key: "New rubric.",
    });
    const res = await regenerateQuestion({
      chat: okChat(rewritten),
      question: shortQuestion,
      siblings: [],
    });
    expect(res.ok).toBe(true);
    // The kept-type system prompt must have advertised answer_key.
    expect(buildRegenerateSystemPrompt("auto", "short_text")).toContain("answer_key");
    expect(buildRegenerateSystemPrompt("auto", "mcq")).not.toContain("answer_key");
  });

  it("U-QT1-P5 regenerate keeps the multi type and its set key", async () => {
    const multiQuestion: AiQuestion = {
      type: "multi_select",
      prompt: "Old multi",
      options: ["a", "b", "c"],
      correct_indices: [0, 2],
    };
    const rewritten = JSON.stringify({
      type: "multi_select",
      prompt: "New multi",
      options: ["a", "b", "c"],
      correct_indices: [1, 2],
    });
    const res = await regenerateQuestion({
      chat: okChat(rewritten),
      question: multiQuestion,
      siblings: [],
    });
    expect(res.ok).toBe(true);
    // The kept-type system prompt must have advertised correct_indices.
    expect(buildRegenerateSystemPrompt("auto", "multi_select")).toContain("correct_indices");
    expect(buildRegenerateSystemPrompt("auto", "mcq")).not.toContain("correct_indices");
  });
});

// ── Phase 1 mirror test: onEvent is purely observational ──────────────────
// The single most safety-critical property of the event refactor: passing
// onEvent leaves the prompt bytes and outcome IDENTICAL to the omitted path
// (the code comment in quiz-prompt.ts claims this is pinned HERE).
describe("U-AE1 — onEvent mirror (byte-identical default path)", () => {
  const okChatWithCapture = (content: string, captured: ChatMessage[][]) => async (messages: ChatMessage[]) => {
    captured.push(messages);
    return { ok: true, text: content, usage: NO_CHAT_USAGE } as ChatResult;
  };

  it("identical prompts + outcome with and without onEvent (success path)", async () => {
    const without: ChatMessage[][] = [];
    const withEv: ChatMessage[][] = [];
    const resA = await generateQuiz({ chat: okChatWithCapture(validQuizJson, without), text: "chapter", questionCount: 10 });
    const events: unknown[] = [];
    const resB = await generateQuiz({
      chat: okChatWithCapture(validQuizJson, withEv),
      text: "chapter",
      questionCount: 10,
      onEvent: (e) => events.push(e),
    });
    expect(resA).toEqual(resB);
    expect(without).toEqual(withEv);
    expect(events).toEqual([{ type: "attempt_start", attempt: 1 }]);
  });

  it("identical retry prompts + outcome with and without onEvent (retry path)", async () => {
    const chatA = vi.fn<(messages: ChatMessage[]) => Promise<ChatResult>>()
      .mockResolvedValueOnce({ ok: true, text: "not json", usage: NO_CHAT_USAGE })
      .mockResolvedValueOnce({ ok: true, text: validQuizJson, usage: NO_CHAT_USAGE });
    const chatB = vi.fn<(messages: ChatMessage[]) => Promise<ChatResult>>()
      .mockResolvedValueOnce({ ok: true, text: "not json", usage: NO_CHAT_USAGE })
      .mockResolvedValueOnce({ ok: true, text: validQuizJson, usage: NO_CHAT_USAGE });
    const events: unknown[] = [];
    // Freeze the clock: remainingBudgetMs derives the per-call timeout from
    // Date.now() at CALL time, so two back-to-back runs with a shared
    // deadline can differ by 1ms and fail the prompt mirror spuriously.
    vi.useFakeTimers();
    try {
    const deadline = Date.now() + 900_000;
    const resA = await generateQuiz({ chat: chatA, text: "chapter", questionCount: 10, deadlineMs: deadline });
    const resB = await generateQuiz({ chat: chatB, text: "chapter", questionCount: 10, deadlineMs: deadline, onEvent: (e) => events.push(e) });
    expect(resA).toEqual(resB);
    expect(chatA.mock.calls).toEqual(chatB.mock.calls);
    expect(events).toEqual([
      { type: "attempt_start", attempt: 1 },
      { type: "attempt_retry", issues: expect.any(String) },
      { type: "attempt_start", attempt: 2 },
    ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
