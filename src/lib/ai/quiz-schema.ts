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
export const AI_EXTRACTED_TEXT_MAX = 15_000;
export const AI_INSTRUCTION_MAX = 500;

/** Max characters the AI model may emit per generation. */
export const AI_MAX_OUTPUT_TOKENS = 4000;

/** Wall-clock budget for a single AI chat round-trip (routes run ≤60s). */
export const AI_ROUND_TRIP_TIMEOUT_MS = 45_000;

/** A single AI question (shared by the quiz schema and single-question regen). */
export const AiQuestionSchema = z
  .object({
    type: z.enum(["mcq", "true_false"]),
    prompt: z.string().trim().min(5, "Prompt must be at least 5 characters."),
    options: z
      .array(z.string().trim().min(1, "Options must not be empty."))
      .min(2, "A question needs at least 2 options.")
      .max(5, "A question can have at most 5 options."),
    correct_index: z.number().int().min(0),
    // Models frequently emit `explanation: null` — accept both absent and null.
    explanation: z.string().trim().optional().nullable(),
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
    const distinct = new Set(q.options.map((o) => o.toLocaleLowerCase()));
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
    const key = trimmed.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  // After dedup, find the ORIGINAL correct text (by the caller's index) and
  // remap to its new position. If it disappeared, the answer is ambiguous.
  const correctText = (options[correctIndex] ?? "").trim().toLocaleLowerCase();
  const newIndex = normalized.findIndex((o) => o.toLocaleLowerCase() === correctText);
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
