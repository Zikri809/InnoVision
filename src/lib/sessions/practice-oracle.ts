/**
 * Practice-mode oracle guard (v4.9, E-58).
 *
 * Practice quizzes reveal correctness INSTANTLY — that is their whole value
 * as a study tool, and also what makes them useless as a rehearsal for graded
 * work: a student who drills a quiz in practice has effectively seen the
 * answer key. This module is the advisory half of that trade-off.
 *
 * ADVISORY, NOT ENFORCED. The counter lives in `localStorage` and the student
 * can clear it (or open a private window). That is deliberate and matches the
 * repo's posture on client-side deterrence (see the gesture/shuffle "advisory,
 * not a security boundary" notes): the alternative — a server-side attempt
 * table — would spend real write traffic to stop a student from studying, and
 * the quiz's graded counterpart is unaffected either way. The point is to make
 * the trade-off VISIBLE, not to win an arms race with the student.
 *
 * Pure and storage-injected so it is Node-unit-testable without a DOM.
 */

/** Attempts of one question before the limit message appears. */
export const PRACTICE_ORACLE_LIMIT = 3;

/** localStorage key for one (quiz, question) pair. */
export function practiceAttemptKey(quizId: string, questionId: string): string {
  return `innovision:practice-attempts:${quizId}:${questionId}`;
}

/**
 * Minimal storage surface. `null` is accepted so a caller can pass a failed
 * `localStorage` lookup (private mode, disabled storage) without a guard.
 */
export type AttemptStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /**
   * Optional: present on the real `Storage`, absent on minimal test stores.
   * `clearPracticeAttempts` prefers it so cleared counters are REMOVED rather
   * than tombstoned as `"0"` (n24); a store without it falls back to the
   * tombstone write, which reads back as 0 via `readPracticeAttempts`.
   */
  removeItem?(key: string): void;
};

/**
 * Read the stored attempt count. Anything unparseable — absent, garbage, a
 * negative number, a float — reads as 0 rather than throwing: a corrupt entry
 * must never break the quiz.
 */
export function readPracticeAttempts(
  store: AttemptStore | null,
  quizId: string,
  questionId: string,
): number {
  if (!store) return 0;
  try {
    const raw = store.getItem(practiceAttemptKey(quizId, questionId));
    if (raw === null) return 0;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Increment and persist the count, returning the NEW value. A storage failure
 * (quota, disabled) still returns the incremented count so the current page
 * view is correct even when it cannot be remembered.
 */
export function bumpPracticeAttempts(
  store: AttemptStore | null,
  quizId: string,
  questionId: string,
): number {
  const next = readPracticeAttempts(store, quizId, questionId) + 1;
  if (!store) return next;
  try {
    store.setItem(practiceAttemptKey(quizId, questionId), String(next));
  } catch {
    // Storage unavailable — the count is still right for this page view.
  }
  return next;
}

/** Whether the limit message should show for a given attempt count. */
export function isPracticeOracleExhausted(attempts: number): boolean {
  return attempts >= PRACTICE_ORACLE_LIMIT;
}

/**
 * Clear every practice counter for one quiz — the "Try again" path, where a
 * fresh attempt should start with a clean slate.
 *
 * `localStorage` has no prefix scan, so this needs the `length`/`key`
 * enumeration that the minimal `AttemptStore` deliberately omits. Callers
 * pass the real `Storage`; a store without enumeration is a silent no-op,
 * which is the right degradation (a stale counter only re-shows a message).
 *
 * n24: keys are REMOVED, not tombstoned. The old `setItem(k, "0")` left a
 * `"0"` row per question that a real `Storage` keeps forever; `read` treated
 * it as 0, so behaviour was correct but the store accumulated dead keys and
 * "cleared" was indistinguishable from "never counted". A store lacking
 * `removeItem` falls back to the tombstone write (still reads as 0).
 */
export function clearPracticeAttempts(store: AttemptStore | null, quizId: string): void {
  if (!store) return;
  try {
    const prefix = `innovision:practice-attempts:${quizId}:`;
    const anyStore = store as unknown as Partial<Storage>;
    if (typeof anyStore.length !== "number" || typeof anyStore.key !== "function") return;
    const doomed: string[] = [];
    for (let i = 0; i < anyStore.length; i += 1) {
      const k = anyStore.key(i);
      if (k && k.startsWith(prefix)) doomed.push(k);
    }
    for (const k of doomed) {
      if (typeof store.removeItem === "function") store.removeItem(k);
      else store.setItem(k, "0");
    }
  } catch {
    // Best-effort: a stale counter only re-shows the advisory message.
  }
}
