/**
 * AX-3 — timer milestone announcements (pure, Node-testable).
 *
 * The countdown pill must stay SILENT per tick (aria-live off — a per-second
 * live region spams screen readers), so discrete milestones fire instead:
 * polite warnings at T-10m/5m/1m and a single assertive warning below 30s
 * (coinciding with the pill's red flip — WARNING_THRESHOLD_MS twin).
 *
 * Milestone keys are durable strings (not raw copy) so the client maps them
 * through i18n; "once" semantics are enforced by the caller's announced-set.
 */

export type TimerMilestone = "m10" | "m5" | "m1" | "s30";

/** The <30s assertive boundary — must match progress-hud's red-flip threshold. */
export const ASSERTIVE_THRESHOLD_MS = 30_000;

/**
 * Map remaining time → the milestone that boundary represents, or null when
 * `remainingMs` sits between milestones. Inclusive lower bounds: the tick that
 * first reaches (or overshoots past) a boundary announces it.
 */
export function milestoneFor(remainingMs: number): TimerMilestone | null {
  if (remainingMs <= 0) return null;
  if (remainingMs <= ASSERTIVE_THRESHOLD_MS) return "s30";
  if (remainingMs <= 60_000) return "m1";
  if (remainingMs <= 300_000) return "m5";
  if (remainingMs <= 600_000) return "m10";
  return null;
}

/** All milestones, for callers that seed/filters announced sets. */
export const ALL_MILESTONES: TimerMilestone[] = ["m10", "m5", "m1", "s30"];
