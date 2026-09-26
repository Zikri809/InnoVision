import { z } from "zod";

/**
 * AI quiz generation contract (PLAN §2 AiQuizSchema) + shared constants.
 *
 * Deliberate rules (locked in PLAN §0/§2; QT-1 multi-select added;
 * gesture-off short_text added):
 *  - `mcq` (2–5 options), `true_false` (exactly 2 options) — the
 *    gesture-friendly types (1–5 fingers; 1 = true, 2 = false) — and
 *    `multi_select` (QT-1: 1..options.length correct indices; answered by
 *    tap+confirm, gesture answering disabled on these questions).
 *  - `short_text` (gesture-off only: 0 options, typed answer graded by the
 *    AI marker against `answer_key`, 1–500 chars mirroring
 *    questions_answer_key_shape). The model emits it ONLY when the caller
 *    opts in via `allowShortText` (auto-enabled for gesture-off quizzes);
 *    otherwise it is rejected with retry, exactly like multi_select.
 *  - `correct_index` / `correct_indices` / `answer_key` must be strictly
 *    one-of by type (mirroring QuestionInputSchema).
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
    type: z.enum(["mcq", "true_false", "multi_select", "short_text"]),
    prompt: z
      .string()
      .trim()
      .min(5, "Prompt must be at least 5 characters.")
      .max(2000, "Prompt must be at most 2000 characters."),
    // Per-element shape only — per-type cardinality lives in the arms below
    // (a schema-level min(2) would reject short_text's 0 options before any
    // superRefine runs; same restructure QuestionInputSchema did in B5-5).
    options: z.array(
      z
        .string()
        .trim()
        .min(1, "Options must not be empty.")
        .max(500, "Each option must be at most 500 characters."),
    ),
    correct_index: z.number().int().min(0).optional(),
    // QT-1: the multi answer key — 1..options.length canonical indices,
    // sorted+distinct (mirror of QuestionInputSchema.correctIndices).
    correct_indices: z
      .array(z.number().int().min(0))
      .min(1)
      .max(5)
      .optional(),
    // Gesture-off short-text rubric: the model answer the AI marker grades
    // against (1..500 mirrors questions_answer_key_shape, 0052).
    answer_key: z
      .string()
      .trim()
      .max(500, "The answer key must be at most 500 characters.")
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
  // Per-type cardinality mirrors the DB CHECK (0052); the messages preserve
  // the pre-short_text schema-level bounds verbatim.
  .superRefine((q, ctx) => {
    // ── short_text (gesture-off) ────────────────────────────────────
    // ZERO options, a required rubric, none of the index keys. First:
    // every arm below assumes an option list to index into.
    if (q.type === "short_text") {
      if (q.options.length !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options"],
          message: "Short-text questions have no options.",
        });
      }
      if (q.correct_index !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["correct_index"],
          message: "Short-text questions are graded against an answer key, not an option index.",
        });
      }
      if (q.correct_indices !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["correct_indices"],
          message: "Short-text questions are graded against an answer key, not option indices.",
        });
      }
      if (q.answer_key === undefined || q.answer_key.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["answer_key"],
          message: "An answer key is required for short-text questions.",
        });
      }
      return;
    }

    // No other type may carry a rubric.
    if (q.answer_key !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["answer_key"],
        message: "answer_key is only valid for short-text questions.",
      });
    }

    if (q.type === "mcq" && (q.options.length < 2 || q.options.length > 5)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message:
          q.options.length < 2
            ? "A question needs at least 2 options."
            : "A question can have at most 5 options.",
      });
    }
    if (q.type === "true_false" && q.options.length !== 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "True/False questions must have exactly 2 options.",
      });
    }
    if (q.type === "multi_select" && q.options.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "A question needs at least 2 options.",
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

/**
 * The raw schema the AI is asked to produce (also validates model output).
 *
 * audit-3 F-F7 — TITLE CONTRACT: `title` is validated here (1–200 chars, the
 * same bound as the quizzes DB CHECK) but is deliberately NOT written back to
 * the quiz row. A quiz is always created with a lecturer-chosen title
 * (`quizzes.title` is NOT NULL, 0004:37), so there is no "absent title" case
 * the generated value could honestly fill — the pre-existing title always
 * wins, and the RPC's `coalesce(p_title, title)` (0040/0041) is a no-op by
 * construction. The generated title remains load-bearing as a FAILURE gate:
 * a missing/over-long title fails AiQuizSchema and triggers the retry/422
 * path (pinned by ai-routes.test.ts:86-87). Callers must not "fix" this by
 * applying the AI title — that would silently rename lecturer quizzes.
 */
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
          x.type === "short_text"
            ? x.answer_key !== undefined && x.answer_key.length > 0
            : x.type === "multi_select"
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
 * drops it before the RPC sees it). Short-text rows carry NO option keys at
 * all — just the `answer_key` rubric (`answer_key` stays undefined on every
 * other type for the same drop-the-key reason). */
export type ReplaceQuestionRow = {
  type: "mcq" | "true_false" | "multi_select" | "short_text";
  prompt: string;
  options: string[];
  correct_index: number | null;
  correct_indices?: number[] | null;
  answer_key?: string | null;
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
    if (q.type === "short_text") {
      // Validation guarantees the rubric exists for short-text rows.
      // Options stay the EMPTY array (the 0052 DB convention, not NULL).
      rows.push({
        type: q.type,
        prompt: q.prompt,
        options: [],
        correct_index: null,
        answer_key: q.answer_key as string,
        explanation: q.explanation ?? null,
      });
      continue;
    }
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
