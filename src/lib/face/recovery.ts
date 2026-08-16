import type { FaceStatus } from "./types";

/**
 * Pure recovery-flow helpers (Phase 7).
 *
 * After a `paused` status the student blinks to self-recover. `recoverFlow`
 * returns the next UI state for a blink-liveness attempt:
 *  - `'blink'` → wait for the blink (recovering).
 *  - `'failed'` → liveness timed out; re-offer the blink.
 *  - `'recovered'` → blink observed; call `self_recover_session`.
 *
 * `recoveryLanding` decides where the pipeline lands after a successful
 * self-recovery POST:
 *  - `hadStartVerify` → `'ready'` (a gate verify already ran — the gate is
 *    passed; continuous verify resumes).
 *  - otherwise → `'gate'` (the assessment gate was never passed — re-run the
 *    `'start'` verify).
 */
export type RecoveryStep = "blink" | "failed" | "recovered";

export function recoverFlow(blinkResult: "passed" | "failed"): RecoveryStep {
  return blinkResult === "passed" ? "recovered" : "failed";
}

export function recoveryLanding(hadStartVerify: boolean): FaceStatus {
  return hadStartVerify ? "ready" : "gate";
}
