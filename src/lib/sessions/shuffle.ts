/**
 * Deterministic per-session question/option shuffling (QT-3).
 *
 * The permutation is NEVER stored: it is derived at read time from
 * (sessionId, scope, n) so that every load of the same session — server
 * component, route handler, or the student's browser — computes the SAME
 * order, and a retake (new session id, QC-4) reshuffles for free.
 *
 * Pipeline: FNV-1a 32-bit string hash → mulberry32 PRNG → Fisher-Yates.
 * Pure integer ops (Math.imul / shifts), so the sequence is identical in
 * every JS engine; no Node/crypto APIs, hence safe to import from client
 * components AND server code. There is deliberately NO `server-only`
 * import here.
 *
 * Trust note (QT-3 plan): this is presentation obfuscation against
 * shoulder-surfing, NOT a security boundary. The seed inputs (session id,
 * question ids) are already known to the client, and `answer_question`
 * still validates and grades whatever canonical index arrives.
 *
 * Stability invariant: the plan is only stable because question rows and
 * their option arrays are draft-frozen (quiz_not_draft_edit). The
 * "questions" scope is POSITIONAL — a future live-question editor would
 * desync persisted canonical answers from the presented mapping on reload.
 */

/** plan[presented] = canonical: the presented slot p displays canonical slot plan[p]. */
export type ShufflePlan = number[];

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Scope key for the question-ORDER permutation (positional — see invariant above). */
export const QUESTION_ORDER_SCOPE = "questions";

/** Scope key for one question's OPTION permutation. */
export function optionScope(questionId: string): string {
  return `${questionId}:options`;
}

/**
 * Deterministic permutation of [0..n-1]. n < 2 short-circuits to the
 * identity (1-question quizzes / 2-option true-false pairs degrade
 * cleanly). Same (sessionId, scope, n) ⇒ same plan, always.
 */
export function shufflePlan(sessionId: string, scope: string, n: number): ShufflePlan {
  const plan: ShufflePlan = Array.from({ length: n }, (_, i) => i);
  if (n < 2) return plan;
  const rand = mulberry32(fnv1a(`${sessionId}:${scope}`));
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = plan[i];
    plan[i] = plan[j];
    plan[j] = tmp;
  }
  return plan;
}

/** Presented slot → canonical slot. Out-of-range / null pass through unchanged. */
export function toCanonical(presented: number | null, plan: ShufflePlan): number | null {
  if (presented === null || presented < 0 || presented >= plan.length) return presented;
  return plan[presented];
}

/** Canonical slot → presented slot. Out-of-range / null pass through unchanged. */
export function toPresented(canonical: number | null, plan: ShufflePlan): number | null {
  if (canonical === null || canonical < 0 || canonical >= plan.length) return canonical;
  return plan.indexOf(canonical);
}

/** Minimal shape the envelope transform needs. */
export interface ShufflableQuestion {
  id: string;
  options: string[];
}

/**
 * Envelope transform: reorder the question array (question-order scope) and
 * each question's options (per-question option scope) into presented order.
 * All other row fields ride along untouched.
 */
export function applyQuestionShuffle<T extends ShufflableQuestion>(
  sessionId: string,
  questions: T[],
): T[] {
  const questionPlan = shufflePlan(sessionId, QUESTION_ORDER_SCOPE, questions.length);
  return questionPlan.map((qi) => {
    const q = questions[qi];
    const plan = shufflePlan(sessionId, optionScope(q.id), q.options.length);
    return { ...q, options: plan.map((oi) => q.options[oi]) };
  });
}

/** Minimal shape one `student_results` breakdown row needs. */
export interface ShufflableBreakdownRow {
  question_id: string;
  order_index: number;
  options: string[];
  selected_index: number | null;
  correct_index: number | null;
  /** QT-1 multi-select rows: canonical sets, translated element-wise. */
  selected_indices?: number[] | null;
  correct_indices?: number[] | null;
}

/** Translate an index SET element-by-element (null passthrough per element). */
function translateSet(indices: number[] | null | undefined, plan: ShufflePlan, mode: "toPresented" | "toCanonical"): number[] | null {
  if (indices == null) return null;
  const fn = mode === "toPresented" ? toPresented : toCanonical;
  return indices.map((i) => fn(i, plan) ?? i);
}

/**
 * Breakdown transform for the EndScreen: reorder rows into the presented
 * question order (keyed by id against the presented questions array), permute
 * each row's options, and translate selected/correct indices into presented
 * space so highlights match what the student actually saw and clicked.
 *
 * `order_index` is overwritten with the presented position — EndScreen renders
 * `order_index + 1` as the display number, which must be the student's own
 * sequence, not the canonical one. Rows whose ids are absent from
 * `presentedQuestionIds` (defensive: a row set that doesn't mirror the
 * question projection) keep canonical order at the end, untranslated — the
 * closed+revealed review path passes presented ids derived from the rows
 * themselves, so normal calls never hit this branch. A null selected_index
 * (unanswered row) stays null. QT-1 multi rows carry `selected_indices` /
 * `correct_indices` sets, translated element-wise with the same null
 * passthrough.
 */
export function applyBreakdownShuffle<T extends ShufflableBreakdownRow>(
  sessionId: string,
  presentedQuestionIds: string[],
  rows: T[],
): T[] {
  const canonicalIds = new Set(presentedQuestionIds);
  const byId = new Map(rows.map((r) => [r.question_id, r]));

  const presented: T[] = [];
  presentedQuestionIds.forEach((id, position) => {
    const row = byId.get(id);
    if (!row) return;
    const plan = shufflePlan(sessionId, optionScope(id), row.options.length);
    presented.push({
      ...row,
      order_index: position,
      options: plan.map((oi) => row.options[oi]),
      selected_index: toPresented(row.selected_index, plan),
      correct_index: toPresented(row.correct_index, plan) ?? row.correct_index,
      selected_indices: translateSet(row.selected_indices, plan, "toPresented"),
      correct_indices: translateSet(row.correct_indices, plan, "toPresented"),
    });
  });

  for (const row of rows) {
    if (!canonicalIds.has(row.question_id)) presented.push(row);
  }
  return presented;
}
