/**
 * SQ-1/SQ-4 — pure list-shaping helpers for the student quiz list.
 *
 * Kept Node-pure (no DB, no React) so the deadline sort and class filter are
 * unit-pinned per repo convention (gradebook.ts / derive.ts precedent) — the
 * RSC page stays a thin fetch-and-wire layer.
 */

export type DeadlineSortableQuiz = {
  closes_at: string | null | undefined;
  created_at: string | null | undefined;
};

/**
 * SQ-1 deadline sort: quizzes with a future closes_at come first, closing
 * SOONEST first ("what needs my attention" order); undated quizzes follow,
 * newest-created first (preserving the historical created_at DESC recency);
 * a past closes_at (cron-lag "closed while still listed" case) sorts to the
 * very end. Stable on full ties.
 */
export function sortByDeadline<T extends DeadlineSortableQuiz>(rows: T[], nowMs: number): T[] {
  return [...rows].sort((a, b) => {
    const ta = a.closes_at ? Date.parse(a.closes_at) : NaN;
    const tb = b.closes_at ? Date.parse(b.closes_at) : NaN;
    const fa = Number.isNaN(ta) ? Infinity : ta <= nowMs ? Infinity : ta;
    const fb = Number.isNaN(tb) ? Infinity : tb <= nowMs ? Infinity : tb;
    if (fa !== fb) return fa - fb;
    return (Date.parse(b.created_at ?? "") || 0) - (Date.parse(a.created_at ?? "") || 0);
  });
}

/**
 * SQ-4 drill-down: keep only quizzes of the requested class. A null/empty
 * filter is a no-op (unfiltered list). An unknown id simply yields [] — RLS
 * already guarantees the student can only ever see enrolled classes, so no
 * validation beyond the shape check exists server-side either.
 */
export function filterByClass<T extends { class_id: string | null | undefined }>(
  rows: T[],
  classId: string | null | undefined,
): T[] {
  if (!classId) return rows;
  return rows.filter((q) => q.class_id === classId);
}
