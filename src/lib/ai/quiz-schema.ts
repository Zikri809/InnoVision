import { z } from "zod";

/**
 * AI quiz generation contract (PLAN §2 AiQuizSchema) + shared constants.
 *
 * Deliberate rules (locked in PLAN §0/§2; QT-1 multi-select added):
 *  - `mcq` (2–5 options), `true_false` (exactly 2 options) — the
 *    gesture-friendly types (1–5 fingers; 1 = true, 2 = false) — and
 *    `multi_select` (QT-1: 1..options.length correct indices; answered by
 *    tap+confirm, gesture answering disabled on these questions).
 *  - `correct_index` / `correct_indices` must reference existing options
 *    (strictly one-of by type — mirroring QuestionInputSchema).
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
    type: z.enum(["mcq", "true_false", "multi_select"]),
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
    correct_index: z.number().int().min(0).optional(),
    // QT-1: the multi answer key — 1..options.length canonical indices,
    // sorted+distinct (mirror of QuestionInputSchema.correctIndices).
    correct_indices: z
      .array(z.number().int().min(0))
      .min(1)
      .max(5)
      .optional(),
    // Models frequently emit `explanation: null` — accept both absent and null.
    explanation: z
      .string()
      .trim()
      .max(2000, "Explanation must be at most 2000 characters.")
      .optional()
      .nullable(),
  })
  // Gesture constraint: true_false must have exactly 2 options; the answer
  // key must be strictly one-of by type and point at existing options.
  .superRefine((q, ctx) => {
    if (q.type === "true_false" && q.options.length !== 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "True/False questions must have exactly 2 options.",
      });
    }
    if (q.type === "multi_select") {
      // Gesture amendment: palm-commit reserves five fingers — multi
      // questions cap at 4 options (mirrors MULTI_SELECT_OPTIONS_MAX /
      // questions_multi_option_cap).
      if (q.options.length > 4) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options"],
          message: "Multi-select questions support at most 4 options.",
        });
      }
      if (q.correct_index !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["correct_index"],
          message: "Multi-select questions use correct_indices.",
        });
      }
      if (q.correct_indices === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["correct_indices"],
          message: "Multi-select questions need at least one correct answer.",
        });
      } else {
        if (q.correct_indices.some((i) => i >= q.options.length)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["correct_indices"],
            message: "The correct answers must reference existing options.",
          });
        }
        for (let k = 1; k < q.correct_indices.length; k += 1) {
          if (q.correct_indices[k] <= q.correct_indices[k - 1]) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["correct_indices"],
              message: "The correct answers must be distinct.",
            });
            break;
          }
        }
      }
    } else {
      if (q.correct_indices !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["correct_indices"],
          message: "correct_indices is only valid for multi-select questions.",
        });
      }
      if (q.correct_index === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["correct_index"],
          message: "The correct answer must reference an existing option.",
        });
      } else if (q.correct_index >= q.options.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["correct_index"],
          message: "The correct answer must reference an existing option.",
        });
      }
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
  .refine(
    (q) =>
      q.questions.every(
        (x) =>
          x.type === "multi_select"
            ? x.correct_indices !== undefined &&
              x.correct_indices.every((i) => i < x.options.length)
            : x.correct_index !== undefined && x.correct_index < x.options.length,
      ),
    {
      message: "Every correct answer must reference an existing option.",
    },
  );

export type AiQuiz = z.infer<typeof AiQuizSchema>;

export type AiQuestion = AiQuiz["questions"][number];

/** DB-shaped question row payload for replace_quiz_questions. Multi rows
 * (QT-1) carry `correct_indices` and NULL the scalar; single-answer types
 * are the reverse (`correct_indices` stays undefined so JSON.stringify
 * drops it before the RPC sees it). */
export type ReplaceQuestionRow = {
  type: "mcq" | "true_false" | "multi_select";
  prompt: string;
  options: string[];
  correct_index: number | null;
  correct_indices?: number[] | null;
  explanation: string | null;
};

/** Discriminated normalize result: scalar input keeps the historical
 * key shape (no `correct_indices` key — the quiz-schema test pins it with
 * toEqual, where an explicit `null` would fail but `undefined` passes). */
export type NormalizedOptions =
  | { options: string[]; correct_index: number; correct_indices?: undefined }
  | { options: string[]; correct_index?: undefined; correct_indices: number[] };

/**
 * Normalize AI-produced options before insert: trim, dedupe case-insensitively,
 * and REMAP the answer key to the deduped array. `correct` is the scalar index
 * for mcq/true_false or the canonical index SET for multi_select (QT-1) — the
 * remapped set is sorted+distinct before return. Returns null when any correct
 * option no longer exists after dedup (caller should retry).
 */
export function normalizeOptions(
  options: string[],
  correct: number | number[],
): NormalizedOptions | null {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of options) {
    const trimmed = raw.trim();
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  // After dedup, find each ORIGINAL correct text (by the caller's index/indices)
  // and remap to its new position. If any disappeared, the answer is ambiguous.
  if (typeof correct === "number") {
    const correctText = (options[correct] ?? "").trim().toLowerCase();
    const newIndex = normalized.findIndex((o) => o.toLowerCase() === correctText);
    if (newIndex === -1) return null;
    return { options: normalized, correct_index: newIndex };
  }
  const remapped: number[] = [];
  for (const idx of correct) {
    const correctText = (options[idx] ?? "").trim().toLowerCase();
    const newIndex = normalized.findIndex((o) => o.toLowerCase() === correctText);
    if (newIndex === -1) return null;
    if (!remapped.includes(newIndex)) remapped.push(newIndex);
  }
  remapped.sort((a, b) => a - b);
  return { options: normalized, correct_indices: remapped };
}

/** Convert a validated AiQuiz into DB rows (normalized options). */
export function aiQuizToRows(quiz: AiQuiz): ReplaceQuestionRow[] {
  const rows: ReplaceQuestionRow[] = [];
  for (const q of quiz.questions) {
    if (q.type === "multi_select") {
      // Validation guarantees the set exists for multi rows.
      const set = q.correct_indices as number[];
      const normalized = normalizeOptions(q.options, set);
      if (!normalized || normalized.correct_indices === undefined) {
        // Unreachable for validated input — fall back to the raw values.
        rows.push({
          type: q.type,
          prompt: q.prompt,
          options: q.options,
          correct_index: null,
          correct_indices: set,
          explanation: q.explanation ?? null,
        });
        continue;
      }
      rows.push({
        type: q.type,
        prompt: q.prompt,
        options: normalized.options,
        correct_index: null,
        correct_indices: normalized.correct_indices,
        explanation: q.explanation ?? null,
      });
      continue;
    }
    // Validation guarantees the scalar exists for single-answer rows.
    const scalar = q.correct_index as number;
    const normalized = normalizeOptions(q.options, scalar);
    if (!normalized || normalized.correct_index === undefined) {
      rows.push({
        type: q.type,
        prompt: q.prompt,
        options: q.options,
        correct_index: scalar,
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
