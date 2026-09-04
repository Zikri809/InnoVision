import { createClient } from "@/lib/supabase/server";
import { requireStudent } from "@/lib/classes/guards";
import { rateLimit } from "@/lib/classes/rate-limit";
import { ConsentSchema } from "@/lib/face/schemas";
import { mapFaceError } from "@/lib/face/rpc-mapping";
import {
  checkSameOrigin,
  firstIssueMessage,
  invalidBody,
  invalidJson,
  internalError,
} from "@/lib/http";

export const dynamic = "force-dynamic";

// Per-user rate limit on consent set/revoke.
const CONSENT_RATE = { limit: 5, windowMs: 60 * 1000 };

/**
 * POST /api/face/consent — set or revoke biometric consent.
 *
 * `{ consent: true }` → `grant_face_consent()` RPC. The profiles
 * restricted-columns trigger blocks every direct authenticated write to
 * `consent_given_at` (anti-forgery), so the sanctioned path goes through a
 * SECURITY DEFINER RPC that opts in via `app.consent_write`.
 *
 * `{ consent: false }` → InsightFace migration (0039):
 *   `revoke_face_consent()` RPC — ONE atomic transaction: consent nulled,
 *   `face_enrollment_status` null, biometric samples purged
 *   (`profile_face_samples`), in-progress assessments flagged
 *   (`paused_at` reset), completed face_checks deleted, audited with the
 *   purge count. The old two-phase queue (`face_deletion_pending` +
 *   `confirm_face_subject_deleted` + cleanup cron) is retired — a revoke can
 *   never leave vectors of a non-consenting student behind.
 * Re-consent restores `consent_given_at` only — it does NOT re-enroll.
 *
 * Preamble: guard → CSRF → rate-limit → parse → Zod → RPC → `mapFaceError`.
 */
export async function POST(request: Request) {
  const supabase = await createClient();

  const auth = await requireStudent(supabase);
  if (!auth.ok) return auth.response;

  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`face-consent:${auth.userId}`, CONSENT_RATE)) {
    return mapFaceError({ error: "rate_limited" }) ?? internalError("Something went wrong.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = ConsentSchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid consent payload."));
  }

  if (parsed.data.consent) {
    const { data, error } = await supabase.rpc("grant_face_consent");

    if (error) {
      console.error("grant_face_consent RPC error:", error);
      return internalError("Could not update consent right now.");
    }

    const payload = data as Record<string, unknown> | null;
    const mapped = mapFaceError(payload, {});
    if (mapped) return mapped;

    if (payload?.ok !== true) {
      console.error("grant_face_consent unexpected payload:", payload);
      return internalError("Could not update consent right now.");
    }

    return Response.json({ consent: true }, { status: 200, headers: { "content-type": "application/json" } });
  }

  // One atomic RPC: DB state + biometric purge together (0039).
  const { data, error } = await supabase.rpc("revoke_face_consent");

  if (error) {
    console.error("revoke_face_consent error:", error);
    return internalError("Could not revoke consent right now.");
  }

  const payload = data as Record<string, unknown> | null;

  const mapped = mapFaceError(payload, {});
  if (mapped) return mapped;

  if (payload?.ok !== true) {
    console.error("revoke_face_consent unexpected payload:", payload);
    return internalError("Could not revoke consent right now.");
  }

  return Response.json(
    { consent: false, flagged_sessions: payload.flagged_sessions ?? [] },
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
