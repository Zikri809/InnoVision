import { z } from "zod";

/**
 * Zod schemas for the session API surface (PLAN_PHASE5 Step 2).
 *
 *  - `StartSessionSchema`: `{ quizId }` — starts (or rejoins) a session.
 *  - `AnswerSchema`: `{ questionId, selectedIndex }` — the upper bound on
 *    `selectedIndex` is deliberately NOT enforced here: the route does not
 *    fetch questions (no misleading "clean 400" pre-check), and the RPC
 *    validates the index against the question's option count and maps
 *    `invalid_selected_index` → 400. Zod only guarantees a non-negative int.
 *  - `SubmitSchema`: an empty body is tolerated (`{}`).
 */

export const StartSessionSchema = z.object({
  quizId: z.string().uuid("quizId must be a valid UUID."),
});

export type StartSessionInput = z.infer<typeof StartSessionSchema>;

export const AnswerSchema = z.object({
  questionId: z.string().uuid("questionId must be a valid UUID."),
  selectedIndex: z.number().int("selectedIndex must be a whole number.").min(0),
});

export type AnswerInput = z.infer<typeof AnswerSchema>;

/** Empty body is accepted; the RPC does the real work with no arguments. */
export const SubmitSchema = z.object({});

export type SubmitInput = z.infer<typeof SubmitSchema>;

// `SubmitSchema` exists to pin the empty-body contract (U-S4). The submit
// route deliberately does NOT parse a body — the RPC is the boundary — so this
// schema is test-only by design. Do not "wire it in" or delete it in confusion.
