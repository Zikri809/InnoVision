import { z } from "zod";

/**
 * Zod schemas for the manual-builder API surface (PLAN_PHASE3 §Step 2).
 *
 * These are shared by:
 *  - route handlers (request-body validation at the boundary),
 *  - the builder UI (client-side pre-validation),
 *  - Phase 4 (AI generation) which will reuse the same question shape
 *    (PLAN §2 `AiQuizSchema` is a superset of `QuestionInputSchema`).
 *
 * Deliberate rules (locked in PLAN_PHASE3 §2; QT-1 multi-select added):
 *  - `mcq`: 2–5 distinct, trimmed options.
 *  - `true_false`: exactly 2 options (1 finger = true, 2 = false).
 *  - `multi_select` (QT-1): 2–4 distinct options (gesture amendment —
 *    palm-commit reserves five fingers); the answer key is
 *    `correctIndices` — 1..options.length indices, each < options.length,
 *    sorted ascending + distinct (mirrors the questions_correct_indices_guard
 *    trigger, 0037). `correctIndex` must be ABSENT for multi and
 *    `correctIndices` ABSENT otherwise (strictly symmetric so no mapping
 *    site silently drops a field).
 *  - `correctIndex` must be < options.length (a selected answer must exist).
 *  - lengths mirror the DB CHECK constraints (title ≤ 200, prompt ≤ 2000,
 *    option ≤ 500, explanation ≤ 2000).
 */

export const OPTION_MIN = 1;
export const OPTION_MAX = 500;
export const PROMPT_MAX = 2000;
export const TITLE_MAX = 200;
export const EXPLANATION_MAX = 2000;
export const MCQ_OPTIONS_MIN = 2;
export const MCQ_OPTIONS_MAX = 5;
export const TRUE_FALSE_OPTIONS = 2;
/**
 * QT-1 gesture amendment: multi-select questions cap at FOUR options —
 * five fingers is reserved for palm-commit, so a fifth option pose cannot
 * exist. Mirrors the questions_multi_option_cap DB CHECK (0037).
 */
export const MULTI_SELECT_OPTIONS_MAX = 4;

// Invisible/bidi control characters that could visually reorder or hide text
// (bidi marks/embeds/isolates, zero-width chars, soft hyphen, word joiner).
const BIDI_CONTROL_REGEX =
  /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD]/g;

/**
 * Strip bidi-override / zero-width characters from user-typed titles.
 * Quiz titles are rendered to entire class rosters (and, once shared,
 * beyond), so they get the same homoglyph-spoofing defense as student
 * practice-quiz titles.
 */
export function stripBidiControls(value: string): string {
  return value.replace(BIDI_CONTROL_REGEX, "");
}

/**
 * Time-limit bounds. null = untimed; 1..7200 = timed; 0 is invalid in
 * both Zod and the DB. Must stay in lockstep with the DB CHECK in
 * supabase/migrations/0004_quizzes.sql:40.
 */
export const TIME_LIMIT_MIN_SEC = 1;
export const TIME_LIMIT_MAX_SEC = 7200; // 2 hours (120 minutes)

/** A single question as sent from the client (camelCase on the wire). */
export const QuestionInputSchema = z
  .object({
    type: z.enum(["mcq", "true_false", "multi_select"]),
    prompt: z
      .string()
      .trim()
      .min(1, "Prompt is required.")
      .max(PROMPT_MAX, `Prompt must be at most ${PROMPT_MAX} characters.`),
    options: z
      .array(
        z
          .string()
          .trim()
          .min(OPTION_MIN, "Options must not be empty.")
          .max(OPTION_MAX, `Options must be at most ${OPTION_MAX} characters.`),
      )
      .min(MCQ_OPTIONS_MIN, "A question needs at least 2 options.")
      .max(MCQ_OPTIONS_MAX, "A question can have at most 5 options."),
    correctIndex: z
      .number()
      .int()
      .min(0, "Select a correct answer.")
      .max(2_147_483_647)
      .optional(),
    // QT-1 multi-select answer key. Element ceiling = PG int4 (the column is
    // int[]); cardinality mirrors the answer-set cap in AnswerSchema.
    correctIndices: z
      .array(
        z
          .number()
          .int()
          .min(0, "Correct answers must reference existing options.")
          .max(2_147_483_647),
      )
      .min(1, "Select at least one correct answer.")
      .max(MCQ_OPTIONS_MAX, `A question can have at most ${MCQ_OPTIONS_MAX} correct answers.`)
      .optional(),
    explanation: z
      .string()
      .trim()
      .max(EXPLANATION_MAX, `Explanation must be at most ${EXPLANATION_MAX} characters.`)
      .optional()
      .nullable(),
  })
  .superRefine((q, ctx) => {
    if (q.type === "multi_select") {
      if (q.options.length > MULTI_SELECT_OPTIONS_MAX) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options"],
          message: `Multi-select questions support at most ${MULTI_SELECT_OPTIONS_MAX} options.`,
        });
      }
      if (q.correctIndex !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["correctIndex"],
          message:
            "Multi-select questions use correctIndices; send correctIndex only for single-answer types.",
        });
      }
      if (q.correctIndices === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["correctIndices"],
          message: "Select at least one correct answer.",
        });
      } else {
        if (q.correctIndices.some((i) => i >= q.options.length)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["correctIndices"],
            message: "The correct answers must reference existing options.",
          });
        }
        for (let k = 1; k < q.correctIndices.length; k += 1) {
          if (q.correctIndices[k] <= q.correctIndices[k - 1]) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["correctIndices"],
              message: "The correct answers must be distinct.",
            });
            break;
          }
        }
      }
    } else {
      if (q.correctIndices !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["correctIndices"],
          message:
            "correctIndices is only valid for multi-select questions.",
        });
      }
      if (q.correctIndex === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["correctIndex"],
          message: "Select a correct answer.",
        });
      } else if (q.correctIndex >= q.options.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["correctIndex"],
          message: "The correct answer must reference an existing option.",
        });
      }
    }
    if (q.type === "true_false" && q.options.length !== TRUE_FALSE_OPTIONS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "True/False questions must have exactly 2 options.",
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

export type QuestionInput = z.infer<typeof QuestionInputSchema>;

/**
 * Strict single-answer variant for the STUDENT-authored quiz routes (v1
 * scope: multi-select is lecturer-quiz only — the student_quiz_questions
 * table carries a CHECK rejecting the type, so the boundary rejects it
 * here with a clean 400 instead of an unmapped DB error).
 */
export const StudentQuestionInputSchema = QuestionInputSchema.superRefine((q, ctx) => {
  if (q.type === "multi_select") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["type"],
      message: "Multi-select questions are not supported on student quizzes.",
    });
  }
});

/**
 * Availability-window bounds for a quiz. Both endpoints are optional
 * (null = unbounded); when both are set, closes_at must be strictly after
 * opens_at. Must stay in lockstep with the DB CHECK in
 * supabase/migrations/0030_quiz_lifecycle_windows.sql.
 *
 * Max horizon (7 days) mirrors the practical exam-scheduling horizon and
 * keeps the datetime-local wire format bounded.
 */
export const WINDOW_MIN_GAP_SEC = 60;
export const WINDOW_MAX_HORIZON_SEC = 14 * 24 * 3600;

/**
 * Retake config bounds (QC-4). max_attempts 1..3 mirrors the DB CHECK in
 * supabase/migrations/0032_retake_policy.sql. Both fields are live-quiz
 * management (outside the DB edit-freeze) like the windows above.
 */
export const MAX_ATTEMPTS_MIN = 1;
export const MAX_ATTEMPTS_MAX = 3;

/** Shared quiz fields (no defaults — see UpdateQuizSchema note). */
const QuizFieldsSchema = z.object({
  title: z
    .string()
    .transform(stripBidiControls)
    .pipe(
      z
        .string()
        .trim()
        .min(1, "Title is required.")
        .max(TITLE_MAX, `Title must be at most ${TITLE_MAX} characters.`),
    ),
  mode: z.enum(["practice", "assessment"]),
  timeLimitSec: z
    .number({ message: "Time limit must be a number of seconds." })
    .int("Time limit must be a whole number of seconds.")
    .min(TIME_LIMIT_MIN_SEC, "Time limit must be at least 1 second.")
    .max(TIME_LIMIT_MAX_SEC, "Time limit must be at most 2 hours (120 minutes).")
    .nullable()
    .optional(),
  opensAt: z
    .string()
    .datetime({ offset: true, message: "opensAt must be an ISO 8601 timestamp." })
    .nullable()
    .optional(),
  closesAt: z
    .string()
    .datetime({ offset: true, message: "closesAt must be an ISO 8601 timestamp." })
    .nullable()
    .optional(),
  allowRetake: z.boolean().nullable().optional(),
  maxAttempts: z
    .number({ message: "Max attempts must be a whole number." })
    .int("Max attempts must be a whole number.")
    .min(MAX_ATTEMPTS_MIN, `Max attempts must be at least ${MAX_ATTEMPTS_MIN}.`)
    .max(MAX_ATTEMPTS_MAX, `Max attempts must be at most ${MAX_ATTEMPTS_MAX}.`)
    .nullable()
    .optional(),
  /**
   * QT-3 per-student shuffling (migration 0034). DRAFT-ONLY setting (the DB
   * edit-freeze blocks flips on live/closed quizzes). Nullable+optional like
   * allowRetake — a required boolean here would 400 every existing create
   * payload that omits it.
   */
  shuffleQuestions: z.boolean().nullable().optional(),
});

/**
 * Shared cross-field window rules (order + min gap + horizon). Mirrors the DB
 * CHECK in supabase/migrations/0030_quiz_lifecycle_windows.sql so a bad pair
 * fails at the boundary with a readable message instead of a 500.
 */
function refineWindowRules(
  q: { opensAt?: string | null; closesAt?: string | null },
  ctx: z.RefinementCtx,
): void {
  const opensAt = q.opensAt ?? null;
  const closesAt = q.closesAt ?? null;
  if (opensAt !== null && closesAt !== null) {
    const opens = new Date(opensAt).getTime();
    const closes = new Date(closesAt).getTime();
    if (!(closes > opens)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["closesAt"],
        message: "The closing time must be after the opening time.",
      });
    } else if (closes - opens < WINDOW_MIN_GAP_SEC * 1000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["closesAt"],
        message: "The quiz window must stay open for at least a minute.",
      });
    }
  }
  if (closesAt !== null) {
    const closes = new Date(closesAt).getTime();
    if (closes > Date.now() + WINDOW_MAX_HORIZON_SEC * 1000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["closesAt"],
        message: "The closing time is too far in the future (max 14 days).",
      });
    }
  }
}

/** Create-quiz payload. `mode` defaults to practice; time limit optional. */
export const CreateQuizSchema = QuizFieldsSchema.extend({
  mode: z.enum(["practice", "assessment"]).default("practice"),
}).superRefine(refineWindowRules);

export type CreateQuizInput = z.infer<typeof CreateQuizSchema>;

/**
 * Update-quiz payload — any subset of the create fields.
 *
 * IMPORTANT: built from `QuizFieldsSchema` (NOT `CreateQuizSchema.partial()`),
 * because Zod applies `.default()` BEFORE `.partial()` unwraps. Deriving the
 * update schema from the create schema would inject `mode: "practice"` into
 * every PATCH — silently downgrading an assessment quiz whenever a lecturer
 * edits only the title/time limit. `.partial()` on the default-free base keeps
 * every field optional with NO implicit values.
 */
export const UpdateQuizSchema = QuizFieldsSchema.partial().superRefine(refineWindowRules);

export type UpdateQuizInput = z.infer<typeof UpdateQuizSchema>;

/** Reveal-settings payload: the assessment auto-reveal toggle. */
export const RevealSettingsSchema = z.object({
  autoRevealOnComplete: z.boolean(),
});

export type RevealSettingsInput = z.infer<typeof RevealSettingsSchema>;

/** Reorder payload: the exact ordered set of question ids (draft only). */
export const ReorderSchema = z.object({
  questionIds: z
    .array(z.string().uuid("Each question id must be a valid UUID."), {
      message: "Each question id must be a valid UUID.",
    })
    // Mirrors the student surface's cap: the RPC rejects foreign ids, but an
    // unbounded UUID array should fail HERE, not after a full parse + round trip.
    .min(1, "Reorder must include at least one question.")
    .max(200, "Reorder payload exceeds the question limit."),
});

export type ReorderInput = z.infer<typeof ReorderSchema>;
