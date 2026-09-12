/**
 * Pure incident-flush transition predicate (integrity suite).
 *
 * Extracted from `useIncidentRecorder` so the PRIVACY CONTRACT is unit-test
 * pinned: footage uploads ONLY on a verified→incident status edge, and a
 * clean submit discards. The hook's effect cleanup runs on EVERY status
 * change (React tears down and re-runs the effect), so the previous status
 * must survive that cycle — the hook now keeps it on its module-lifetime
 * machine object and consults this predicate. The audit (2026-09) found the
 * flush branch was dead code for exactly this reason: a ref the cleanup
 * nulled made `prev` always null, so NO incident clip was ever uploaded.
 *
 * Policy (mirrors PLAN_INTEGRITY_SUITE §4):
 *  - `ready` → paused | flagged | unavailable : FLUSH (the incident).
 *  - `recovering` → paused | flagged | unavailable : FLUSH (the unlock
 *    re-verify path routes flagged→recovering→paused; those incidents
 *    deserve footage too).
 *  - anything → `ready` : START (arm/resume recording), never flush.
 *  - any other pair : no-op.
 */
export type IncidentFlushStatus = "ready" | "recovering" | "paused" | "flagged" | "unavailable";

const INCIDENT_ORIGINS: readonly IncidentFlushStatus[] = ["ready", "recovering"];
const INCIDENT_TARGETS: readonly IncidentFlushStatus[] = ["paused", "flagged", "unavailable"];

export function shouldFlushIncident(
  prev: IncidentFlushStatus | null,
  next: IncidentFlushStatus,
): boolean {
  return (
    prev !== null &&
    INCIDENT_ORIGINS.includes(prev) &&
    INCIDENT_TARGETS.includes(next)
  );
}

/**
 * Clip reason for the flush: a `paused` incident is labeled with its CAUSE
 * (face / focus_lost / fullscreen_exit) so the lecturer can tie footage to a
 * trigger; flagged/unavailable incidents keep the status token (the route
 * caps at 40 chars).
 */
export function incidentClipReason(next: IncidentFlushStatus, pausedReason: string): string {
  return next === "paused" ? pausedReason : next;
}
