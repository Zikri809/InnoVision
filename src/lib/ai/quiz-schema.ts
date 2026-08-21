import { z } from "zod";

/**
 * AI quiz generation contract (PLAN §2 AiQuizSchema) + shared constants.
 *
 * Deliberate rules (locked in PLAN §0/§2):
 *  - Only `mcq` (2–5 options) and `true_false` (exactly 2 options) — the
 *    gesture-friendly types (1–5 fingers; 1 = true, 2 = false).
 *  - `correct_index` must reference an existing option.
 *  - 3–30 questions per generation (gesture round + token budget).
 *  - `title` trimmed 1–200 (mirrors the quizzes DB CHECK).
 */

export const AI_QUESTIONS_MIN = 3;
export const AI_QUESTIONS_MAX = 30;
export const AI_TITLE_MIN = 1;
export const AI_TITLE_MAX = 200;
export const AI_INSTRUCTION_MAX = 500;

/** Max characters the AI model may emit per generation. 30-question quizzes
 * need ~8k+ output tokens; raised from 4000 (a Vercel-60s-budget cap) since
 * the app now runs locally on the lecturer's machine. */
export const AI_MAX_OUTPUT_TOKENS = 16_000;

/** Wall-clock budget for a single AI chat round-trip. Local-only tuning: the
 * 45s value was a serverless guard; keep a generous 10-minute ceiling so a
 * long 30-question generation can't be aborted mid-stream. */
export const AI_ROUND_TRIP_TIMEOUT_MS = 600_000;

/** Overall wall-clock budget for a whole AI route (parse + attempt + retry).
 * Shared by generate-quiz and regenerate-question so both routes bound the
 * upstream identically. Local-only tuning (see docs/COSTS.md §2.1). */
export const GENERATION_BUDGET_MS = 900_000;

/** A single AI question (shared by the quiz schema and single-question regen). */
export const AiQuestionSchema = z
  .object({
    type: z.enum(["mcq", "true_false"]),
    prompt: z
      .string()
      .trim()
      .min(5, "Prompt must be at least 5 characters.")
      .max(2000, "Prompt must be at most 2000 characters."),
    options: z
      .array(
        z
          .string()
          .trim()
          .min(1, "Options must not be empty.")
          .max(500, "Each option must be at most 500 characters."),
      )
      .min(2, "A question needs at least 2 options.")
      .max(5, "A question can have at most 5 options."),
    correct_index: z.number().int().min(0),
    // Models frequently emit `explanation: null` — accept both absent and null.
    explanation: z
      .string()
      .trim()
      .max(2000, "Explanation must be at most 2000 characters.")
      .optional()
      .nullable(),
  })
  // Gesture constraint: true_false must have exactly 2 options, and
  // correct_index must point at an existing option.
  .superRefine((q, ctx) => {
    if (q.type === "true_false" && q.options.length !== 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "True/False questions must have exactly 2 options.",
      });
    }
    if (q.correct_index >= q.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["correct_index"],
        message: "The correct answer must reference an existing option.",
      });
    }
    const distinct = new Set(q.options.map((o) => o.toLowerCase()));
    if (distinct.size !== q.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "Options must be distinct.",
      });
    }
  });

/** The raw schema the AI is asked to produce (also validates model output). */
export const AiQuizSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(AI_TITLE_MIN, "Title is required.")
      .max(AI_TITLE_MAX, `Title must be at most ${AI_TITLE_MAX} characters.`),
    questions: z
      .array(AiQuestionSchema)
      .min(AI_QUESTIONS_MIN, "A quiz needs at least 3 questions.")
      .max(AI_QUESTIONS_MAX, "A quiz can have at most 30 questions."),
  })
  .refine((q) => q.questions.every((x) => x.correct_index < x.options.length), {
    message: "Every correct answer must reference an existing option.",
  });

export type AiQuiz = z.infer<typeof AiQuizSchema>;

export type AiQuestion = AiQuiz["questions"][number];

/** DB-shaped question row payload for replace_quiz_questions. */
export type ReplaceQuestionRow = {
  type: "mcq" | "true_false";
  prompt: string;
  options: string[];
  correct_index: number;
  explanation: string | null;
};

/**
 * Normalize AI-produced options before insert: trim, dedupe case-insensitively,
 * and REMAP `correct_index` to the deduped array. Returns null when the option
 * that was marked correct no longer exists after dedup (caller should retry).
 */
export function normalizeOptions(
  options: string[],
  correctIndex: number,
): { options: string[]; correct_index: number } | null {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of options) {
    const trimmed = raw.trim();
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  // After dedup, find the ORIGINAL correct text (by the caller's index) and
  // remap to its new position. If it disappeared, the answer is ambiguous.
  const correctText = (options[correctIndex] ?? "").trim().toLowerCase();
  const newIndex = normalized.findIndex((o) => o.toLowerCase() === correctText);
  if (newIndex === -1) return null;
  return { options: normalized, correct_index: newIndex };
}

/** Convert a validated AiQuiz into DB rows (normalized options). */
export function aiQuizToRows(quiz: AiQuiz): ReplaceQuestionRow[] {
  const rows: ReplaceQuestionRow[] = [];
  for (const q of quiz.questions) {
    const normalized = normalizeOptions(q.options, q.correct_index);
    // Validation guarantees the correct option exists, so normalizeOptions
    // cannot return null here — fall back defensively to the raw values.
    if (!normalized) {
      rows.push({
        type: q.type,
        prompt: q.prompt,
        options: q.options,
        correct_index: q.correct_index,
        explanation: q.explanation ?? null,
      });
      continue;
    }
    rows.push({
      type: q.type,
      prompt: q.prompt,
      options: normalized.options,
      correct_index: normalized.correct_index,
      explanation: q.explanation ?? null,
    });
  }
  return rows;
}
