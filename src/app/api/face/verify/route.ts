import { createClient } from "@/lib/supabase/server";
import { requireStudent } from "@/lib/classes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { VerifySchema } from "@/lib/face/schemas";
import { MAX_FRAME_BASE64_CHARS, VERIFY_FRAMES_PER_CHECK } from "@/lib/face/constants";
import { mapFaceError } from "@/lib/face/rpc-mapping";
import { selectPrimaryFace } from "@/lib/face/embedding";
import * as insightface from "@/lib/face/server/insightface-client";
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
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
// The sidecar /extract runs in ~100-200ms per frame on CPU and the per-frame
// calls run in parallel, so the budget is a single extract + overhead.
export const maxDuration = 20;

// Per-user rate limit on verifies (10/min — cadence is 30–45s + Q-transitions).
const VERIFY_RATE = { limit: 10, windowMs: 60 * 1000 };

type Db = Awaited<ReturnType<typeof createClient>>;

/**
 * POST /api/face/verify — frames → InsightFace sidecar → compare_face_baseline
 * → record_face_check.
 *
 * The client sends up to VERIFY_FRAMES_PER_CHECK base64 JPEG frames captured
 * over ~2s. For each NON-EMPTY frame the route:
 *   1. E2E mock short-circuit FIRST (marker frames never reach the sidecar —
 *      without a sidecar in CI a fetch would 503 instead of voting): MATCH →
 *      the caller's deterministic mock embedding → baseline compare; MISMATCH
 *      → a 0-vote with no sidecar call and no RPC compare.
 *   2. Real frames: sidecar `/extract` → pick the ONE primary face (largest
 *      bbox, det_score ≥ floor — NEVER max-over-faces: a second person's face
 *      must not drag the score UP; faces[0] is detector-order).
 *   3. `compare_face_baseline(emb)` — max cosine against the student's OWN
 *      enrolled samples (1:1-by-baseline; no gallery involvement), clamped to
 *      [0,1] by the RPC.
 * Empty frames are FAIL votes (the no-face sentinel stays
 * integrity-conservative). The RPC computes `matched` as the STRICT MAJORITY
 * of votes ≥ 0.5 — NO client-supplied verdict.
 *
 * Cutover guard: an empty baseline (present=false — enrolled pre-migration
 * with samples never stored) → 403 not_enrolled BEFORE any sidecar call.
 *
 * Mappings (overrides only):
 *  - `nonce_mismatch` → 409
 *  - `consent_required` → 403
 *  - `not_enrolled` → 403
 *  - `not_assessment` → 400
 *  - `quiz_not_live` → 409
 *  - `insightface_unavailable` → 503
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

  // Exempt probe BEFORE the baseline guard: 0020's step-6 exempt short-circuit
  // runs before the enrollment check inside the RPC, and the route-side
  // baseline guard must not reorder that (an exempted student may legitimately
  // have no stored samples). Reading the flag here is owner-scoped (RLS) and
  // only decides whether the guard applies — the verdict itself stays
  // RPC-computed. not_found → fall through (the RPC re-checks ownership).
  const sessionRow = await supabase
    .from("quiz_sessions")
    .select("face_exempt")
    .eq("id", parsed.data.sessionId)
    .eq("student_id", auth.userId)
    .maybeSingle();
  const faceExempt = sessionRow.data?.face_exempt === true;

  // Cutover / integrity guard: the student must have a stored baseline
  // BEFORE any sidecar work. `present=false` covers pre-migration enrollees
  // (samples never stored); the honest response is not_enrolled (the
  // pre-start gate makes this unreachable for NEW sessions). Exempt sessions
  // skip the guard (the RPC short-circuits them before the enrollment check).
  if (!faceExempt) {
    const baseline = await supabase.rpc("face_baseline_status");
    const baselinePayload = baseline.data as Record<string, unknown> | null;
    if (baseline.error || !baselinePayload || baselinePayload.present !== true) {
      return mapFaceError({ error: "not_enrolled" }, { not_enrolled: { status: 403 } }) ??
        internalError("Something went wrong.");
    }
  }

  // One extract + compare per non-empty frame, in parallel (enroll pattern).
  // An empty string is the no-face sentinel for that slot → a FAIL vote with
  // similarity 0 (never skipped silently — the row still lands as a fail when
  // the majority fails).
  const results = await Promise.all(
    frames.map(async (frame): Promise<number | { error: string }> => {
      if (frame === "") return 0;
      // MISMATCH marker → 0-vote WITHOUT a sidecar call or RPC compare (no
      // sidecar exists in CI — a fetch would 503 instead of failing as a
      // vote, which would kill the pause/streak specs).
      if (insightface.isMockMismatchFrame(frame)) return 0;
      const extracted = await insightface.extractFace(frame, auth.userId);
      if ("error" in extracted) return { error: extracted.error };
      return comparePrimaryFace(supabase, extracted.faces);
    }),
  );

  // Any sidecar/compare failure fails the WHOLE check honestly (503 →
  // pipeline `unavailable` passthrough, never a partial verdict).
  const firstError = results.find((r): r is { error: string } => typeof r === "object");
  if (firstError) {
    return mapFaceError(firstError) ?? internalError("Something went wrong.");
  }

  const similarities = (results as number[]).map((s) => Math.min(1, Math.max(0, s)));

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

/**
 * Pick the primary face from the extract result and compare it against the
 * caller's OWN baseline. No qualifying face → 0-vote (FAIL); an RPC failure →
 * typed error (the whole check fails honestly).
 */
async function comparePrimaryFace(
  supabase: SupabaseClient,
  faces: insightface.InsightFaceExtractResult["faces"],
): Promise<number | { error: string }> {
  const primary = selectPrimaryFace(faces);
  if (!primary) return 0;
  const { data, error } = await supabase.rpc("compare_face_baseline", {
    p_embedding: primary.embedding,
  });
  if (error) {
    console.error("compare_face_baseline error:", error);
    return { error: "internal" };
  }
  const payload = data as Record<string, unknown> | null;
  if (!payload || typeof payload.similarity !== "number") {
    return { error: "internal" };
  }
  // present=false here would contradict the pre-check; a 0-vote is the safe
  // resolution either way.
  return payload.present === true ? Math.min(1, Math.max(0, payload.similarity)) : 0;
}

export type { Db as VerifyRouteDb };
