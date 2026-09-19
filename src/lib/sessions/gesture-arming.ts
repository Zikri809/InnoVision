/**
 * Gesture-arming predicates (v4.9 / audit-4 M4 — U-65).
 *
 * These were inline literals in `play-client.tsx`; they are extracted here so
 * the arming matrix is unit-testable WITHOUT mounting the play island (which
 * has no component-test harness). The rules:
 *
 *   R6 — `short_text` never arms the AnswerPad. The set is an ALLOW-list so a
 *        future type is disarmed by default, not silently armed.
 *   B6-7/B7-5 — the palm-next `< MAX_ANSWER_FINGERS` gate applies only when
 *        the type HAS finger input. A 0-option short_text must keep palm-next;
 *        for a 5-option MCQ finger 5 could be a valid answer, so the gate holds.
 */

export const TYPE_HAS_FINGER_INPUT: ReadonlySet<string> = new Set([
  "mcq",
  "true_false",
  "multi_select",
]);

/** Whether a question of this type can receive gesture answers at all (R6). */
export function typeHasFingerInput(type: string): boolean {
  return TYPE_HAS_FINGER_INPUT.has(type);
}

/**
 * The `armed` predicate passed to GestureLayer: the pad is live only in the
 * question phase, before an answer is committed, and only for a type with
 * finger input (R6 — a short_text question never arms it).
 */
export function isAnswerPadArmed(opts: {
  phase: string;
  answered: boolean;
  type: string;
}): boolean {
  return opts.phase === "question" && !opts.answered && typeHasFingerInput(opts.type);
}

/**
 * The palm-next gate (B6-7/B7-5): finger 5 means "next" when the type has no
 * finger input (the optionCount term is meaningless there) or when the option
 * count cannot claim finger 5 as an answer.
 */
export function isPalmNextAllowed(opts: {
  hasFingerInput: boolean;
  optionCount: number;
  maxAnswerFingers: number;
}): boolean {
  return !opts.hasFingerInput || opts.optionCount < opts.maxAnswerFingers;
}
