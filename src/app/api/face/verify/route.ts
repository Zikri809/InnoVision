import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStudent } from "@/lib/classes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { VerifySchema } from "@/lib/face/schemas";
import { MAX_FRAME_BASE64_CHARS, VERIFY_FRAMES_PER_CHECK } from "@/lib/face/constants";
import { mapFaceError } from "@/lib/face/rpc-mapping";
import { selectPrimaryFace } from "@/lib/face/embedding";
import { spoofGateDecision, type SpoofFrameVerdict } from "@/lib/face/spoof";
import { shouldReportSecondFace } from "@/lib/face/second-face";
import { mintVerifyProof } from "@/lib/face/server/verify-proof";
import * as insightface from "@/lib/face/server/insightface-client";
import {
  checkSameOrigin,
  firstIssueMessage,
  invalidBody,
  internalError,
  MULTIPART_OVERHEAD_BYTES,
  notFound,
  payloadTooLarge,
  readCappedJson,
} from "@/lib/http";
import type { FaceCheckResult } from "@/lib/face/types";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
// The sidecar /extract runs in ~100-200ms per frame on CPU and the per-frame
// calls run in parallel, so the budget is a single extract + overhead.
export const maxDuration = 20;

// Per-user rate limit on verifies (10/min — cadence is 30–45s + Q-transitions).
const VERIFY_RATE = { limit: 10, windowMs: 60 * 1000 };

// audit-2 C-01: photo/replay gate posture. With FACE_SPOOF_ENFORCE=1 a
// majority-spoofed frame set forces the whole check to a FAIL vote; without
// it the MiniFASNet verdicts are recorded (frame_poses) but never enforce —
// right for dev sidecars without the baked weights, wrong for production.
if (process.env.NODE_ENV === "production" && process.env.FACE_SPOOF_ENFORCE !== "1") {
  console.warn(
    "FACE_SPOOF_ENFORCE is not set: anti-spoofing verdicts are recorded but do NOT force " +
      "verify fails (audit-2 C-01). Set FACE_SPOOF_ENFORCE=1 in production.",
  );
}

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
 *   4. `record_face_check(...)` with an HMAC proof minted HERE (0045 P0-1):
 *      HMAC-SHA256(secret, session:nonce:frame-concat). The RPC verifies the
 *      proof before its verdict, so a direct PostgREST caller — which can
 *      read the nonce but never the app_private secret — cannot forge
 *      similarities; a SQL-side 60/10-min attempt throttle bounds loops.
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

  // audit-1 P1-5: pre-parse body bound. The old flow parsed the WHOLE
  // body (unbounded on chunked requests) and only then 413'd per frame;
  // the streaming cap rejects an oversized body before it materializes.
  // 3 frames x MAX_FRAME_BASE64_CHARS + JSON/multipart slack.
  const VERIFY_BODY_LIMIT_BYTES =
    VERIFY_FRAMES_PER_CHECK * MAX_FRAME_BASE64_CHARS + MULTIPART_OVERHEAD_BYTES;
  const body = await readCappedJson(request, VERIFY_BODY_LIMIT_BYTES);
  if (!body.ok) return body.response;

  const parsed = VerifySchema.safeParse(body.data);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid verify payload."));
  }

  for (const frame of parsed.data.frames) {
    if (frame.length > MAX_FRAME_BASE64_CHARS) {
      return payloadTooLarge(`Frame exceeds the ${MAX_FRAME_BASE64_CHARS}-character limit.`);
    }
  }

  if (!isUuid(parsed.data.sessionId)) return notFound();

  // The RPC consumes EXACTLY this array (schema caps at 3, the slice is
  // defensive) — the proof below must cover the same bytes p_frames carries.
  const frames = parsed.data.frames.slice(0, VERIFY_FRAMES_PER_CHECK);

  // P0-1 (audit-1 / migration 0045 §9c): mint the HMAC proof the RPC
  // verifies before its verdict. The secret lives in app_private (never
  // PostgREST-exposed) and is read through a service_role-only getter;
  // without it no proof can be minted, so the route fails CLOSED — a 503
  // degradation the pipeline surfaces as `unavailable` (lecturer-visible),
  // never a silent proof-less call.
  let proof: string;
  try {
    const admin = createAdminClient();
    const { data: secretData, error: secretError } = await admin.rpc("get_verify_proof_secret");
    if (secretError || typeof secretData !== "string" || secretData.length === 0) {
      throw secretError ?? new Error("empty verify-proof secret");
    }
    proof = mintVerifyProof(secretData, parsed.data.sessionId, parsed.data.nonce, frames);
  } catch (secretError) {
    console.error("get_verify_proof_secret error:", secretError);
    return mapFaceError({ error: "proof_secret_unavailable" }) ?? internalError("Something went wrong.");
  }

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

  // audit-2 C-02: corroborate that a verify ATTEMPT reached the server for
  // this session (any outcome — even a sidecar 503). The silence cron's
  // outage-claim exemption (0046) now requires recent corroboration: a
  // tampered client that blocks verify POSTs while re-arming
  // report_face_unavailable every few minutes produces NO attempts and is no
  // longer exempt forever. Fire-and-forget, owner-scoped (the row above
  // proves the caller owns the session); an admin write because RLS exposes
  // no update policy and a failure must never fail the verify.
  if (sessionRow.data) {
    void Promise.resolve(
      createAdminClient()
        .from("quiz_sessions")
        .update({ face_verify_attempted_at: new Date().toISOString() })
        .eq("id", parsed.data.sessionId),
    )
      .then((r) => {
        if (r.error) console.error("face_verify_attempted_at touch error:", r.error);
      })
      .catch(() => {});
  }

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
  // the majority fails). Each frame's FULL face list is kept (not just the
  // primary's similarity) for the server-side second-face advisory below.
  type FrameOutcome = {
    similarity: number;
    faces: insightface.InsightFaceExtractResult["faces"];
    spoof: insightface.SpoofVerdict | null;
  } | { error: string };
  const results = await Promise.all(
    frames.map(async (frame): Promise<FrameOutcome> => {
      if (frame === "") return { similarity: 0, faces: [], spoof: null };
      // MISMATCH marker → 0-vote WITHOUT a sidecar call or RPC compare (no
      // sidecar exists in CI — a fetch would 503 instead of failing as a
      // vote, which would kill the pause/streak specs).
      if (insightface.isMockMismatchFrame(frame)) return { similarity: 0, faces: [], spoof: null };
      const extracted = await insightface.extractFace(frame, auth.userId);
      if ("error" in extracted) return { error: extracted.error };
      const sim = await comparePrimaryFace(supabase, extracted.faces);
      const spoof = extracted.spoof ?? null;
      if (typeof sim === "number") return { similarity: sim, faces: extracted.faces, spoof };
      return sim;
    }),
  );

  // Any sidecar/compare failure fails the WHOLE check honestly (503 →
  // pipeline `unavailable` passthrough, never a partial verdict).
  const firstError = results.find((r): r is { error: string } => "error" in r);
  if (firstError) {
    return mapFaceError(firstError) ?? internalError("Something went wrong.");
  }

  let similarities = (results as Array<{ similarity: number }>).map((r) =>
    Math.min(1, Math.max(0, r.similarity)),
  );

  // audit-2 C-01 — photo/replay gate: the sidecar's MiniFASNet ensemble
  // judges the PRIMARY face of every extracted frame. When enforcement is
  // on and spoofed frames are the majority of verdicts, the whole check is
  // forced to a FAIL vote (recorded — the streak machinery and lecturer
  // audit see it — but `matched` can never be true for a photo/replay).
  // Verdict-less frames (mock markers, no face, weights absent) are
  // "unknown" and never fail (see lib/face/spoof.ts).
  const spoofEnforced = process.env.FACE_SPOOF_ENFORCE === "1";
  const spoofVerdicts: SpoofFrameVerdict[] = (
    results as Array<{ spoof: insightface.SpoofVerdict | null }>
  ).map((r) => r.spoof);
  const spoof = spoofGateDecision(spoofVerdicts);
  if (spoofEnforced && spoof.forcedFail) {
    console.error("verify: spoof gate forced a FAIL vote", {
      sessionId: parsed.data.sessionId,
      trigger: parsed.data.trigger,
      ...spoof,
      scores: spoofVerdicts.map((v) => v?.score ?? null),
    });
    similarities = similarities.map(() => 0);
  }

  // The subject is ROUTE-derived (always the authenticated uid) — the RPC's
  // `p_subject = auth.uid()` check stays as defense in depth against direct
  // RPC callers, but a browser client can never claim another identity here.
  const { data, error } = await supabase.rpc("record_face_check", {
    p_session_id: parsed.data.sessionId,
    p_subject: auth.userId,
    p_similarities: similarities,
    p_trigger: parsed.data.trigger,
    p_nonce: parsed.data.nonce,
    p_frames: frames,
    p_proof: proof,
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
    // Server-recorded second_face advisory (integrity hardening): the client's
    // own attention monitor is suppressible by a tampered browser, but the
    // frames the server just judged are not. Fired ONLY after record_face_check
    // succeeded (never on the 503 path), fire-and-forget — an advisory failure
    // must never fail the verify. The pure gates (≥2 frames, ≥15% area, one
    // span displaced, det floor) live in second-face.ts; the RPC's own owner/
    // assessment/status gates + 55s throttle bound the write.
    const frameFaces = (results as Array<{ faces: insightface.InsightFaceExtractResult["faces"] }>).map(
      (r) => r.faces,
    );
    if (shouldReportSecondFace(frameFaces)) {
      void Promise.resolve(
        supabase.rpc("report_session_advisory", {
          p_session_id: parsed.data.sessionId,
          p_type: "second_face",
        }),
      )
        .then((r) => {
          if (r.error) console.error("report_session_advisory error:", r.error);
        })
        .catch(() => {});
    }
    // audit-2 C-01 (minimum viable): bind the sidecar's per-frame pose to
    // the recorded check. The route still cannot gate liveness server-side
    // (no spoof model — a static photo with plausible yaw passes), but the
    // yaw/pitch/roll trail now lives in face_checks.frame_poses for lecturer
    // audit: a photo-replay shows near-constant pose across every check of
    // the exam, which a live student does not produce. Fire-and-forget; a
    // failure must never fail the verify.
    const poses = frameFaces.map((faces, i) => {
      const primary = selectPrimaryFace(faces);
      // audit-2 C-01: the raw P(real) rides along with the pose so a
      // lecturer can see borderline/spoofed frames even when the gate
      // passed them (record-only mode) or failed them (enforced mode).
      const spoofScore = spoofVerdicts[i]?.score ?? null;
      return primary
        ? { yaw: primary.yaw, pitch: primary.pitch, roll: primary.roll, spoof: spoofScore }
        : { spoof: spoofScore };
    });
    void Promise.resolve(
      supabase.rpc("attach_frame_poses", {
        p_session_id: parsed.data.sessionId,
        p_nonce: parsed.data.nonce,
        p_poses: poses,
      }),
    )
      .then((r) => {
        if (r.error) console.error("attach_frame_poses error:", r.error);
      })
      .catch(() => {});
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
 * typed error (the whole check fails honestly). The full face list travels
 * back to the caller for the second-face advisory.
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
