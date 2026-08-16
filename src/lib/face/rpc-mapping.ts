import { forbidden, internalError, jsonError, notFound, unauthorized } from "@/lib/http";

/**
 * Shared RPC-error → HTTP mapping for face routes (Phase 7 — CompreFace migration).
 *
 * The common keys are automatic (single source of truth — route bullets list
 * ONLY overrides): `not_owner`→404, `session_not_active`→409, `not_authenticated`
 * →401, `not_student`→403, `quiz_not_live`→409, transport/unknown→503. A route
 * passes `overrides` for its own keys (e.g. `consent_required`→403 on enroll).
 *
 * CompreFace migration additions: `duplicate_detected`→409,
 * `compreface_unavailable`→503, `invalid_frame`→400, `pose_invalid`→400.
 *
 * Returns `null` when the payload is NOT an error (caller continues to the
 * success mapping).
 */
export function mapFaceError(
  payload: Record<string, unknown> | null | undefined,
  overrides: Record<string, { status: number; error?: string }> = {},
): Response | null {
  if (!payload || payload.error === undefined) return null;

  const err = String(payload.error);
  const override = overrides[err];

  if (override) {
    return jsonError(override.error ?? err, undefined, override.status);
  }

  switch (err) {
    case "not_owner":
      return notFound();
    case "not_authenticated":
      return unauthorized();
    case "not_student":
    case "not_lecturer":
      return forbidden();
    case "session_not_active":
    case "quiz_not_live":
      return jsonError(err, undefined, 409);
    case "duplicate_detected":
      return jsonError(err, undefined, 409);
    case "not_assessment":
      // Mode mismatch is a client error, not an outage.
      return jsonError(err, undefined, 400);
    case "invalid_frame":
    case "pose_invalid":
      return jsonError(err, undefined, 400);
    case "compreface_unavailable":
      return jsonError("compreface_unavailable", "Face recognition service is temporarily unavailable.", 503);
    case "compreface_error":
      // CompreFace responded with a non-2xx (bad API key, 500, etc.) — an
      // outage-ish condition, not a client error. Never leak the upstream body.
      return jsonError("compreface_error", "Face recognition service returned an error.", 503);
    case "rate_limited":
      return jsonError("rate_limited", "Too many requests. Try again in a minute.", 429);
    default:
      // Unknown RPC payload → treat as an internal failure (never a raw message).
      console.error("mapFaceError: unexpected payload:", payload);
      return internalError("Something went wrong.");
  }
}

// Re-exported convenience so route files can stay terse.
export { forbidden, internalError, jsonError, notFound, unauthorized };
