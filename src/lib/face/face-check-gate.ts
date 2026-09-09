/**
 * Pure occlusion/hand-activity gate for the mid-quiz face precheck.
 *
 * The pipeline previously deferred ONLY on `lightingOk === false`; a raised
 * hand, a palm covering the face, or a mid-gesture snapshot produced false
 * FAIL rows. This predicate decides whether a scheduled check should DEFER
 * (silently retry later) or PROCEED (capture; the server is the authority).
 *
 * Policy (bounded deferral, integrity-conservative):
 *  - `start` never defers: blink liveness has already passed when it runs,
 *    and the gate must not be soft-locked by desk conditions.
 *  - Retries are BOUNDED — exhaustion falls through to capture, and a real
 *    frame is judged server-side. Sustained occlusion therefore surfaces as
 *    an honest FAIL row (pause → blink recovery) instead of an invisible
 *    blind spot. Deferral is for TRANSIENT conditions (hand coming down,
 *    settling after a gesture), never a suppression mechanism.
 *  - `null` health (trackers without `getFaceHealth`, incl. the legacy
 *    captureFrame path) proceeds — this module must never gate harder than
 *    the pre-existing lighting check did.
 *
 * PURE and env-free (house precedent: `cadence.ts`, `constants.ts`) so it is
 * unit-testable without DOM/React. The `isHandActive` input is the pipeline's
 * existing ref mirror (`holdProgress !== null` — mid commit); broader gesture
 * state was deliberately NOT folded in (sticky `gestureActive`/inverted
 * `handWarn` would starve the bounded budget every check).
 */
export type FaceCheckHealth = {
  aligned?: boolean;
  lightingOk?: boolean;
  faceDetected?: boolean;
};

/** Should this scheduled face check defer itself and retry shortly? */
export function shouldDeferFaceCheck(
  health: FaceCheckHealth | null,
  isHandActive: boolean,
  trigger: "start" | "question" | "periodic",
  retries: number,
  maxRetries: number,
): boolean {
  if (trigger === "start") return false;
  if (retries >= maxRetries) return false;
  if (isHandActive) return true;
  if (!health) return false;
  return (
    health.lightingOk === false || health.faceDetected === false || health.aligned === false
  );
}
