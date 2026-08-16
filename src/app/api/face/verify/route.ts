import { createClient } from "@/lib/supabase/server";
import { requireStudent } from "@/lib/classes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { VerifySchema } from "@/lib/face/schemas";
import { MAX_FRAME_BASE64_CHARS } from "@/lib/face/constants";
import { mapFaceError } from "@/lib/face/rpc-mapping";
import * as compreface from "@/lib/face/server/compreface-client";
import {
  checkSameOrigin,
  firstIssueMessage,
  invalidBody,
  invalidJson,
  internalError,
  notFound,
  payloadTooLarge,
} from "@/lib/http";
import type { FaceCheckResult } from "@/lib/face/types";

export const dynamic = "force-dynamic";
// CompreFace /recognize can be slow under load; give the route breathing room
// so a slow-but-alive container isn't platform-killed into a silent 504.
export const maxDuration = 20;

// Per-user rate limit on verifies (10/min — cadence is 30–45s + Q-transitions;
// lowered from 30 because frames are ~25× larger than the old 192-float payload).
const VERIFY_RATE = { limit: 10, windowMs: 60 * 1000 };

/**
 * POST /api/face/verify — frame → CompreFace → metadata → record_face_check.
 *
 * The client sends a base64 JPEG frame; the route calls CompreFace
 * `/recognize`, extracts the top-2 subjects, and passes the RAW metadata
 * (p_subject / p_similarity / p_second_subject / p_second_similarity) + the
 * frame to the `record_face_check` RPC. The RPC computes `matched` from SQL
 * constants (0.5 similarity + 0.15 margin) — NO client-supplied verdict.
 *
 * Exempt sessions: the RPC short-circuits (step 6) BEFORE the metadata-based
 * computation, returning `{matched:true, distance:null}`. The CompreFace call
 * is "wasted" for exempt sessions (rare; accepted trade-off — see
 * PLAN_PHASE7_COMPREFACE_MIGRATION §7).
 *
 * Mappings (overrides only):
 *  - `nonce_mismatch` → 409
 *  - `consent_required` → 403
 *  - `not_enrolled` → 403
 *  - `not_assessment` → 400
 *  - `quiz_not_live` → 409
 *  - `compreface_unavailable` → 503
 *  - `invalid_frame` / `invalid_trigger` → 400
 *  - success → 200 `FaceCheckResult` (camelCase keys)
 */
export async function POST(request: Request) {
  const supabase = await createClient();

  const auth = await requireStudent(supabase);
  if (!auth.ok) return auth.response;

  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`face-verify:${auth.userId}`, VERIFY_RATE)) {
    return mapFaceError({ error: "rate_limited" }) ?? internalError("Something went wrong.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = VerifySchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid verify payload."));
  }

  if (parsed.data.frame.length > MAX_FRAME_BASE64_CHARS) {
    return payloadTooLarge(`Frame exceeds the ${MAX_FRAME_BASE64_CHARS}-character limit.`);
  }

  if (!isUuid(parsed.data.sessionId)) return notFound();

  const { frame } = parsed.data;

  // No-face sentinel (the client POSTs `""` when captureFrame() returns null —
  // camera not ready / no face detected). We do NOT call CompreFace: a null
  // capture must land as a FAIL row in the FLAT window (integrity-conservative;
  // the "persistent camera-null" edge is indistinguishable from a wrong face by
  // design). Passing `p_subject=''` + `p_similarity=0` makes the RPC compute
  // `matched=false` — never a client-supplied verdict.
  let top: { subject: string | null; similarity: number } | null = null;
  let second: { subject: string | null; similarity: number } | null = null;
  if (frame !== "") {
    // CompreFace /recognize (top-2 for the margin rule). In E2E mock mode the
    // fake frame marker `FAKE_FRAME_MATCH` returns a canned "mock-subject" —
    // substitute the authenticated student's uid so the RPC's
    // `p_subject = auth.uid()` check passes (a "match" must be a self-match).
    const rec = await compreface.recognize(frame);
    if ("error" in rec) return mapFaceError(rec) ?? internalError("Something went wrong.");

    const subjects = rec.subjects.map((s) =>
      compreface.isMockMatchFrame(frame)
        ? { subject: auth.userId, similarity: s.similarity }
        : s,
    );
    top = subjects[0] ?? null;
    second = subjects[1] ?? null;
  }

  // The generated RPC args are typed non-null, but the SQL params accept NULL
  // (a `text`/`real` param without NOT NULL). Casts mirror the enroll route's
  // `p_duplicate_subject: dupSubject as string` convention.
  const { data, error } = await supabase.rpc("record_face_check", {
    p_session_id: parsed.data.sessionId,
    p_subject: (top?.subject ?? null) as string,
    p_similarity: top?.similarity ?? 0,
    p_second_subject: (second?.subject ?? null) as string,
    p_second_similarity: (second?.similarity ?? null) as number,
    p_trigger: parsed.data.trigger,
    p_nonce: parsed.data.nonce,
    p_frame: frame,
  });

  if (error) {
    console.error("record_face_check error:", error);
    return internalError("Could not verify right now.");
  }

  const payload = data as Record<string, unknown> | null;

  const mapped = mapFaceError(payload, {
    nonce_mismatch: { status: 409 },
    consent_required: { status: 403 },
    not_enrolled: { status: 403 },
    not_assessment: { status: 400 },
    invalid_frame: { status: 400, error: "invalid_frame" },
    invalid_trigger: { status: 400, error: "invalid_trigger" },
  });
  if (mapped) return mapped;

  if (payload && typeof payload.matched === "boolean" && typeof payload.nextNonce === "string") {
    const result: FaceCheckResult = {
      matched: payload.matched,
      distance: typeof payload.distance === "number" ? payload.distance : null,
      sessionStatus: payload.sessionStatus as FaceCheckResult["sessionStatus"],
      nextNonce: payload.nextNonce,
      faceFailStreak: typeof payload.faceFailStreak === "number" ? payload.faceFailStreak : 0,
    };
    return Response.json(result, { status: 200, headers: { "content-type": "application/json" } });
  }

  console.error("record_face_check unexpected payload:", payload);
  return internalError("Could not verify right now.");
}
