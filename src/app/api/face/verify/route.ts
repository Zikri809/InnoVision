import { createClient } from "@/lib/supabase/server";
import { requireStudent } from "@/lib/classes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { VerifySchema } from "@/lib/face/schemas";
import { MAX_FRAME_BASE64_CHARS, VERIFY_FRAMES_PER_CHECK } from "@/lib/face/constants";
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
// so a slow-but-alive container isn't platform-killed into a silent 504. The
// per-frame calls run in parallel (enroll-route pattern), so the budget is a
// single recognize + overhead.
export const maxDuration = 20;

// Per-user rate limit on verifies (10/min — cadence is 30–45s + Q-transitions).
const VERIFY_RATE = { limit: 10, windowMs: 60 * 1000 };

/**
 * POST /api/face/verify — frames → CompreFace (1:1 by lookup) → record_face_check.
 *
 * The client sends up to VERIFY_FRAMES_PER_CHECK base64 JPEG frames captured
 * over ~2s. For each NON-EMPTY frame the route runs CompreFace `/recognize`
 * and extracts the CALLER'S OWN subject similarity (`selfSimilarity`) — any
 * nonzero similarity IS a self-similarity by construction, so a lookalike
 * classmate ranking top-1 can no longer fail the check (the old margin rule's
 * entire reason to exist). Empty frames are FAIL votes (the no-face sentinel
 * stays integrity-conservative). The RPC computes `matched` as the STRICT
 * MAJORITY of votes ≥ 0.5 — NO client-supplied verdict.
 *
 * Exempt sessions: the RPC short-circuits BEFORE the verdict computation,
 * returning `{matched:true, distance:null}`.
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

  for (const frame of parsed.data.frames) {
    if (frame.length > MAX_FRAME_BASE64_CHARS) {
      return payloadTooLarge(`Frame exceeds the ${MAX_FRAME_BASE64_CHARS}-character limit.`);
    }
  }

  if (!isUuid(parsed.data.sessionId)) return notFound();

  const { frames } = parsed.data;

  // One CompreFace call per non-empty frame, in parallel (enroll pattern).
  // An empty string is the no-face sentinel for that slot → a FAIL vote with
  // similarity 0 (never skipped silently — the row still lands as a fail when
  // the majority fails).
  const recognitions = await Promise.all(
    frames.map(async (frame): Promise<number | { error: string }> => {
      if (frame === "") return 0;
      const faces = await compreface.recognizeFaces(frame);
      if ("error" in faces) return { error: faces.error };
      // E2E mock seam: the canned response names "mock-subject" — substitute
      // the authenticated uid so selfSimilarity reads the marker as a
      // SELF-match (a fake "match" must be a match against the caller).
      const effective = compreface.isMockMatchFrame(frame)
        ? faces.map((f) => ({
            subjects: f.subjects.map((s) => ({ ...s, subject: auth.userId })),
          }))
        : faces;
      return compreface.selfSimilarity(effective, auth.userId);
    }),
  );

  // Any CompreFace failure fails the WHOLE check honestly (503 → pipeline
  // `unavailable` passthrough, never a partial verdict).
  const firstError = recognitions.find((r): r is { error: string } => typeof r === "object");
  if (firstError) {
    return mapFaceError(firstError) ?? internalError("Something went wrong.");
  }

  const similarities = recognitions as number[];

  // The subject is ROUTE-derived (always the authenticated uid) — the RPC's
  // `p_subject = auth.uid()` check stays as defense in depth against direct
  // RPC callers, but a browser client can never claim another identity here.
  const { data, error } = await supabase.rpc("record_face_check", {
    p_session_id: parsed.data.sessionId,
    p_subject: auth.userId,
    p_similarities: similarities,
    p_trigger: parsed.data.trigger,
    p_nonce: parsed.data.nonce,
    p_frames: frames.slice(0, VERIFY_FRAMES_PER_CHECK),
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
