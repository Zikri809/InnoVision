import type { FaceStatus, FaceCheckResult } from "./types";

/**
 * Pure verify-outcome resolution (Phase 7).
 *
 * Maps a `record_face_check` RPC result (success payload OR a typed error key)
 * to the next pipeline state. Centralizes the DB→UI mapping so routes, hooks,
 * and tests share ONE translation table.
 *
 * Error branches (PLAN_PHASE7 §2 / COMPREFACE_MIGRATION §3):
 *  - `not_enrolled` (403) → explicit client state: the student must enroll or
 *    use the click-fallback surface — NOT an undefined branch.
 *  - `consent_required` (403) → explicit: re-show the consent surface.
 *  - `nonce_mismatch` (409) → surface a retry (the pipeline refetches via GET
 *    and retries once before this resolves).
 *  - `session_not_active` (409) → session is completed/paused/flagged server-
 *    side; surface the state.
 *  - `duplicate_detected` (409) → enrollment was held for lecturer review
 *    (CompreFace migration L10); re-show the enroll surface.
 *  - any other error / unknown → surface as `unavailable` (fail-open the
 *    L14 passthrough, NEVER a silent `ready` — an unrecognized/empty verify
 *    outcome must not mark the student verified with no recorded row).
 */

export type VerifyOutcome =
  | { next: FaceStatus; retryNonce?: string; surfaceEnd?: boolean }
  | { next: FaceStatus; surfaceError: string };

export type RpcErrorPayload = { error?: string; message?: string };

export function resolveVerifyOutcome(
  result: FaceCheckResult | RpcErrorPayload | null | undefined,
): VerifyOutcome {
  // Success payload (has `matched` + `sessionStatus`).
  if (result && typeof result === "object" && "matched" in result && !("error" in result)) {
    const r = result as FaceCheckResult;
    return { next: faceStatusFromCheckResult(r), retryNonce: r.nextNonce };
  }

  const err = (result as RpcErrorPayload | null | undefined)?.error;

  switch (err) {
    case "nonce_mismatch":
      return { next: "ready", surfaceError: "nonce_mismatch" };
    case "not_enrolled":
      return { next: "gate", surfaceError: "not_enrolled" };
    case "consent_required":
      return { next: "gate", surfaceError: "consent_required" };
    case "session_not_active":
      return { next: "unavailable", surfaceEnd: true };
    case "quiz_not_live":
      return { next: "unavailable", surfaceEnd: true };
    case "flagged":
      return { next: "flagged", surfaceError: "flagged" };
    case "duplicate_detected":
      return { next: "gate", surfaceError: "duplicate_detected" };
    case "compreface_unavailable":
      return { next: "unavailable", surfaceError: "compreface_unavailable" };
    default:
      // FAIL-CLOSED: an unrecognized error / unparsed body (429 rate_limited,
      // 413 oversized frame, 401/404, or a stripped 200) must NEVER resolve to
      // `ready` (a silent pass with no recorded row). `unavailable` is the
      // honest fail-open passthrough (lecturer-visible).
      return { next: "unavailable", surfaceError: "unexpected" };
  }
}

/**
 * Single DB→UI mapping for a successful `record_face_check` payload.
 *
 * Priority pinned (outcome.test.ts): the exempt short-circuit returns
 * `sessionStatus` = the CURRENT status with `distance: null` — a
 * `sessionStatus:'paused'` with `distance:null` maps to `'paused'`, NEVER to
 * `'ready'`/`'exempt'` (the status is authoritative over the exempt marker).
 */
export function faceStatusFromCheckResult(result: FaceCheckResult): FaceStatus {
  switch (result.sessionStatus) {
    case "active":
      return result.matched ? "ready" : "paused";
    case "paused":
      return "paused";
    case "flagged":
      return "flagged";
    default:
      return "ready";
  }
}
