import { z } from "zod";

/**
 * Zod schemas for the session API surface (PLAN_PHASE5 Step 2).
 *
 *  - `StartSessionSchema`: `{ quizId }` — starts (or rejoins) a session.
 *  - `AnswerSchema`: `{ questionId, selectedIndex? , selectedIndices?,
 *    answerText?, skipped? }` — EXACTLY ONE of the four answer fields must be
 *    present (QT-1: multi-select questions answer with a 1–5 element index
 *    set; short_text answers with `answerText`; `skipped` is the student's
 *    Skip action). The upper bound on the indices is deliberately NOT enforced
 *    against the question here: the route does not fetch questions (no
 *    misleading "clean 400" pre-check), and the RPC validates each index
 *    against THIS question's option count and maps `invalid_selected_index` /
 *    `invalid_selected_indices` → 400. Zod only guarantees non-negative
 *    int4-ceiling ints.
 *    This schema is shared by every question type and cannot see the
 *    question's type, so it enforces SHAPE EXCLUSIVITY ONLY — the
 *    `answerText ⇒ short_text` coupling is enforced by the RPC (which reads
 *    the row) and surfaces as `invalid_selected_index` / `invalid_answer_text`.
 *  - `SubmitSchema`: an empty body is tolerated (`{}`).
 */

export const StartSessionSchema = z.object({
  quizId: z.string().uuid("quizId must be a valid UUID."),
});

export type StartSessionInput = z.infer<typeof StartSessionSchema>;

export const AnswerSchema = z
  .object({
    questionId: z.string().uuid("questionId must be a valid UUID."),
    // Upper bound = PG int4 ceiling: the RPC arg is an `int` (or int[]
    // element), so a larger value would fail at PostgREST as a transport
    // error (503) instead of this clean 400. Per-option bounds stay with
    // the RPC (see module doc above).
    selectedIndex: z
      .number()
      .int("selectedIndex must be a whole number.")
      .min(0)
      .max(2_147_483_647)
      .optional(),
    // QT-1 multi-select: 1..5 canonical indices (DB CHECK cardinality 2..5
    // options caps a meaningful answer set at 5).
    selectedIndices: z
      .array(
        z
          .number()
          .int("selectedIndices must be whole numbers.")
          .min(0)
          .max(2_147_483_647),
      )
      .min(1, "Select at least one option.")
      .max(5, "A question has at most 5 options.")
      .optional(),
    // short_text (v4.9): the free-text answer the AI marker grades. The
    // 1..500 bound mirrors `session_answers.answer_text`'s CHECK (0052) and
    // the per-answer input cap that keeps one answer from monopolizing the
    // quiz's daily marking budget.
    answerText: z
      .string()
      .trim()
      .min(1, "Write an answer before submitting.")
      .max(500, "An answer must be at most 500 characters.")
      .optional(),
    // Skip (R13/S11): the student declined to answer. Carries NO answer
    // payload — the RPC grades it 0 and, in assessment, treats it as terminal
    // (first-answer-wins).
    skipped: z.boolean().optional(),
  })
  .superRefine((a, ctx) => {
    // Shape exclusivity only — the schema cannot see the question's type, so
    // `answerText ⇒ short_text` (and `skipped`'s per-mode rules) stay with the
    // RPC, which is the sole authority on the question row.
    const present = (
      [
        ["selectedIndex", a.selectedIndex],
        ["selectedIndices", a.selectedIndices],
        ["answerText", a.answerText],
        ["skipped", a.skipped],
      ] as const
    ).filter(([, v]) => v !== undefined);
    if (present.length !== 1) {
      // Issue path points at the FIRST field the caller sent (or at the
      // scalar field when none was sent), so the message reads as a fix to
      // the payload the client actually built.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [present[0]?.[0] ?? "selectedIndex"],
        message:
          "Provide exactly one of selectedIndex (single-answer), selectedIndices (multi-select), answerText (short-text), or skipped.",
      });
    }
  });

export type AnswerInput = z.infer<typeof AnswerSchema>;

/** Empty body is accepted; the RPC does the real work with no arguments. */
export const SubmitSchema = z.object({});

export type SubmitInput = z.infer<typeof SubmitSchema>;

// `SubmitSchema` exists to pin the empty-body contract (U-S4). The submit
// route deliberately does NOT parse a body — the RPC is the boundary — so this
// schema is test-only by design. Do not "wire it in" or delete it in confusion.
