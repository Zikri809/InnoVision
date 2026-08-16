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
 * Deliberate rules (locked in PLAN_PHASE3 §2):
 *  - `mcq`: 2–5 distinct, trimmed options.
 *  - `true_false`: exactly 2 options (1 finger = true, 2 = false).
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

/** A single question as sent from the client (camelCase on the wire). */
export const QuestionInputSchema = z
  .object({
    type: z.enum(["mcq", "true_false"]),
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
    correctIndex: z.number().int().min(0, "Select a correct answer."),
    explanation: z
      .string()
      .trim()
      .max(EXPLANATION_MAX, `Explanation must be at most ${EXPLANATION_MAX} characters.`)
      .optional()
      .nullable(),
  })
  .superRefine((q, ctx) => {
    if (q.correctIndex >= q.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["correctIndex"],
        message: "The correct answer must reference an existing option.",
      });
    }
    if (q.type === "true_false" && q.options.length !== TRUE_FALSE_OPTIONS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "True/False questions must have exactly 2 options.",
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

export type QuestionInput = z.infer<typeof QuestionInputSchema>;

/** Shared quiz fields (no defaults — see UpdateQuizSchema note). */
const QuizFieldsSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Title is required.")
    .max(TITLE_MAX, `Title must be at most ${TITLE_MAX} characters.`),
  mode: z.enum(["practice", "assessment"]),
  timeLimitSec: z
    .number()
    .int("Time limit must be a whole number of seconds.")
    .min(1, "Time limit must be at least 1 second.")
    .max(72 * 3600, "Time limit must be at most 72 hours.")
    .nullable()
    .optional(),
});

/** Create-quiz payload. `mode` defaults to practice; time limit optional. */
export const CreateQuizSchema = QuizFieldsSchema.extend({
  mode: z.enum(["practice", "assessment"]).default("practice"),
});

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
export const UpdateQuizSchema = QuizFieldsSchema.partial();

export type UpdateQuizInput = z.infer<typeof UpdateQuizSchema>;

/** Reveal-settings payload: the assessment auto-reveal toggle. */
export const RevealSettingsSchema = z.object({
  autoRevealOnComplete: z.boolean(),
});

export type RevealSettingsInput = z.infer<typeof RevealSettingsSchema>;

/** Reorder payload: the exact ordered set of question ids (draft only). */
export const ReorderSchema = z.object({
  questionIds: z
    .array(z.string().uuid("Each question id must be a valid UUID."), "Each question id must be a valid UUID.")
    .min(1, "Reorder must include at least one question."),
});

export type ReorderInput = z.infer<typeof ReorderSchema>;
