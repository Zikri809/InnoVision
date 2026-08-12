/**
 * Pure timer/scoring helpers for quiz sessions.
 *
 * IMPORTANT: this module is 100% pure — `graceSec` is ALWAYS an argument and
 * there is NO `process.env` access — so it can never break a client bundle.
 * It is imported only by server components, route handlers, and unit tests;
 * the client receives server-computed `initialIndex`/`initialRemainingMs`
 * props and never imports this module.
 *
 * This is a pure MIRROR of the SQL timer used by the `answer_question` RPC
 * (migration 0008_sessions.sql). It is NOT a production enforcement point —
 * the RPC is authoritative (SQL constant 5s grace, `clock_timestamp()`). The
 * JS mirror exists so unit tests (U-T1..U-T6) and the server component can
 * reason about the same deadline without hitting the DB.
 */

export type AnswerForScore = { is_correct: boolean };

/**
 * Is `now` still within the quiz's time limit plus grace?
 * Untimed quizzes (`timeLimitSec === null`) are always within limit.
 * Boundary is INCLUSIVE: exactly `limit + grace` is still within (U-T5).
 *
 * NOTE: this function is kept as a testable pure MIRROR of the SQL timer
 * (U-T1/U-T2/U-T5) — no production module calls it. The authoritative 5s
 * grace lives as a SQL constant `interval '5 seconds'` in migration
 * 0008_sessions.sql; the `graceSec` argument here is a TEST FIXTURE only and
 * must never be treated as a tunable enforcement knob.
 */
export function isWithinTimeLimit(opts: {
  startedAt: number;
  timeLimitSec: number | null;
  graceSec: number;
  now: number;
}): boolean {
  const { startedAt, timeLimitSec, graceSec, now } = opts;
  if (timeLimitSec === null) return true;
  return now <= startedAt + (timeLimitSec + graceSec) * 1000;
}

/**
 * Count of correct answers (each answer counted once). Pure mirror of
 * `submit_session`'s server-side grading (U-T3) — no production module calls
 * it; the RPC computes the real score.
 */
export function computeScore(answers: AnswerForScore[]): number {
  return answers.reduce((sum, a) => (a.is_correct ? sum + 1 : sum), 0);
}

/**
 * Index of the first question not in the answered set, or -1 when all are
 * answered. Server-computed on the play page and passed to the client as a
 * prop; the client never imports this module.
 */
export function firstUnansweredIndex(
  questions: { id: string }[],
  answeredQuestionIds: string[],
): number {
  const answered = new Set(answeredQuestionIds);
  return questions.findIndex((q) => !answered.has(q.id));
}

/**
 * Milliseconds remaining until the (ungraced) client countdown hits zero, or
 * `null` for untimed quizzes. The server computes this once; the client
 * counts down monotonically from it (no laptop clock skew).
 */
export function remainingMs(opts: {
  startedAt: number;
  timeLimitSec: number | null;
  serverNow: number;
}): number | null {
  const { startedAt, timeLimitSec, serverNow } = opts;
  if (timeLimitSec === null) return null;
  return startedAt + timeLimitSec * 1000 - serverNow;
}
