import { z } from "zod";

/**
 * Zod schemas for the session API surface (PLAN_PHASE5 Step 2).
 *
 *  - `StartSessionSchema`: `{ quizId }` — starts (or rejoins) a session.
 *  - `AnswerSchema`: `{ questionId, selectedIndex? , selectedIndices? }` —
 *    EXACTLY ONE of the two answer fields must be present (QT-1: multi-select
 *    questions answer with a 1–5 element index set). The upper bound on the
 *    indices is deliberately NOT enforced against the question here: the
 *    route does not fetch questions (no misleading "clean 400" pre-check),
 *    and the RPC validates each index against THIS question's option count
 *    and maps `invalid_selected_index` / `invalid_selected_indices` → 400.
 *    Zod only guarantees non-negative int4-ceiling ints.
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
  })
  .superRefine((a, ctx) => {
    const hasScalar = a.selectedIndex !== undefined;
    const hasSet = a.selectedIndices !== undefined;
    if (hasScalar === hasSet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasScalar ? "selectedIndices" : "selectedIndex"],
        message:
          "Provide exactly one of selectedIndex (single-answer) or selectedIndices (multi-select).",
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
