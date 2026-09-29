/**
 * A4 (PLAN_DEMO_DAY_HARDENING) — live-updates polling predicate for the
 * lecturer results dashboard.
 *
 * Pure (no DOM, no env): the client evaluates it on every poll tick so a
 * refresh never races a lecturer mutation, fires while a dialog is open, or
 * spins while the tab is hidden (projector-tab + laptop-battery friendly).
 */
export const LIVE_REFRESH_MS = 8000;

export function shouldLiveRefresh(opts: {
  hidden: boolean;
  dialogOpen: boolean;
  busy: boolean;
}): boolean {
  return !opts.hidden && !opts.dialogOpen && !opts.busy;
}
