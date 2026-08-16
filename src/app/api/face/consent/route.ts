import { createClient } from "@/lib/supabase/server";
import { requireStudent } from "@/lib/classes/guards";
import { rateLimit } from "@/lib/classes/rate-limit";
import { ConsentSchema } from "@/lib/face/schemas";
import { mapFaceError } from "@/lib/face/rpc-mapping";
import * as compreface from "@/lib/face/server/compreface-client";
import {
  checkSameOrigin,
  firstIssueMessage,
  invalidBody,
  invalidJson,
  internalError,
} from "@/lib/http";

export const dynamic = "force-dynamic";
// The revoke path calls CompreFace deleteSubject (can be slow under load).
export const maxDuration = 20;

// Per-user rate limit on consent set/revoke.
const CONSENT_RATE = { limit: 5, windowMs: 60 * 1000 };

/**
 * POST /api/face/consent — set or revoke biometric consent.
 *
 * `{ consent: true }` → writes `consent_given_at = now()` via the user's own
 * session. (There is no guard trigger on this column — the new guard is
 * `UPDATE OF face_enrollment_status`, which does not fire here.)
 *
 * `{ consent: false }` → CompreFace migration (L17):
 *   1. `revoke_face_consent()` RPC FIRST — DB state cleaned (consent null,
 *      `face_enrollment_status` null, `face_deletion_pending` true), in-progress
 *      assessments flagged, completed face_checks deleted, audited.
 *   2. CompreFace `deleteSubject(auth.uid())` AFTER the RPC (best-effort). If
 *      CompreFace is down, `face_deletion_pending` stays true and the retry
 *      path (enroll-route check + `npm run compreface:cleanup`) deletes it later.
 * Re-consent restores `consent_given_at` only — it does NOT un-flag or
 * re-enroll.
 *
 * Preamble: guard → CSRF → rate-limit → parse → Zod → RPC/update → CompreFace →
 * `mapFaceError`.
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
    const { error } = await supabase
      .from("profiles")
      .update({ consent_given_at: new Date().toISOString() })
      .eq("id", auth.userId);
    if (error) {
      console.error("consent update error:", error);
      return internalError("Could not update consent right now.");
    }
    return Response.json({ consent: true }, { status: 200, headers: { "content-type": "application/json" } });
  }

  // 1. RPC first — DB state is authoritative; CompreFace deletion is retriable.
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

  // 2. Best-effort CompreFace subject deletion. If it fails, `face_deletion_pending`
  //    remains true (set by the RPC) and the retry path (`compreface:cleanup`,
  //    the enroll-route check) cleans up later. If it SUCCEEDS, clear the flag
  //    so the cleanup script never deletes a recreated subject and the flag
  //    reflects the true state.
  const del = await compreface.deleteSubject(auth.userId);
  if (!("error" in del)) {
    await supabase.from("profiles").update({ face_deletion_pending: false }).eq("id", auth.userId);
  }

  return Response.json(
    { consent: false, flagged_sessions: payload.flagged_sessions ?? [] },
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
