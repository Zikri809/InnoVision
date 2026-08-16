/**
 * Constants for the results dashboard (Phase 8).
 *
 * ABANDON_STALE_MS is the "no `last_activity_at` updates for 2h" abandonment
 * threshold (TESTING U-T4). It is a MIRROR-ONLY constant: the RSC computes the
 * display state in JS; the DB is never touched for abandonment. Keep in sync
 * with the U-T4 spec if it ever changes.
 */
export const ABANDON_STALE_MS = 2 * 60 * 60 * 1000;

/** Cap on the number of sessions the results RSC fetches (D8 truncation). */
export const RESULTS_SESSION_LIMIT = 200;

/** Cap on the lecturer_audit_view read (symmetry with the session cap). */
export const RESULTS_AUDIT_LIMIT = 500;
