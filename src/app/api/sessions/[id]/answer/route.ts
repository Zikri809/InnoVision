import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireStudent } from "@/lib/classes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { AnswerSchema } from "@/lib/sessions/validation";
import { MAX_FRAME_BASE64_CHARS } from "@/lib/face/constants";
import { selectPrimaryFace } from "@/lib/face/embedding";
import { spoofGateDecision, type SpoofFrameVerdict } from "@/lib/face/spoof";
import { shouldReportSecondFace } from "@/lib/face/second-face";
import * as insightface from "@/lib/face/server/insightface-client";
import { mintAnswerProof, mintVerifyProof } from "@/lib/face/server/verify-proof";
import { withFaceInference } from "@/lib/face/server/inference-limit";
import { logError } from "@/lib/log";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  checkSameOrigin,
  firstIssueMessage,
  forbidden,
  internalError,
  invalidBody,
  jsonError,
  notFound,
  rateLimited,
  readCappedJson,
  unauthorized,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Per-user rate limit on answers. audit-4 M7: spec §7 deliberately TIGHTENED
// this from the pre-v4.9 120/min to 60/min — short_text answers each queue an
// AI marking call, so the per-user budget is the first bound on marking spend.
const ANSWER_RATE = { limit: 60, windowMs: 60 * 1000 };

// Secondary per-session bound (audit-4 M7). 30/min matches the quiz's
// 30-question ceiling answered once, so a legitimate full run plus a small
// retry pass fits inside the window; a scripted loop or multi-tab retry storm
// against ONE session is capped even when the per-user budget has headroom.
// Keyed by (session, user) so two students sharing a device never throttle
// each other.
const ANSWER_SESSION_RATE = { limit: 30, windowMs: 60 * 1000 };

/**
 * POST /api/sessions/[id]/answer — grade + record an answer.
 *
 * The RPC is the SOLE authority: it re-validates role/ownership/status/timer/
 * enrollment/question-membership and decides practice-vs-assessment response
 * shape. The route performs NO status pre-check and NO mode re-read — it only
 * maps the RPC's typed jsonb payload (snake→camel on known keys, verbatim
 * otherwise) and never synthesizes `correctIndex`/`explanation`.
 *
 * Mappings:
 *  - `not_owner` → 404 (single no-oracle)
 *  - `session_not_active` → 409 `{ error: "session_not_active" }` (paused /
 *    flagged / completed all map here — single code)
 *  - `quiz_not_live` → 409 (lecturer closed quiz mid-session / student removed)
 *  - `quiz_window_closed` → 409 (closes_at passed mid-session — QC-3; in-flight
 *    students may still SUBMIT, but cannot answer further questions)
 *  - `time_expired` → 403 `{ error: "time_expired" }`
 *  - `already_answered` → 409 `{ error: "already_answered" }` (KEYLESS —
 *    assessment answers stay secrecy-safe; the RPC replays the stored result
 *    for practice)
 *  - `invalid_question` / `invalid_selected_index` /
 *    `invalid_selected_indices` (QT-1) / `invalid_answer_text` (short_text's
 *    1..500 trim bound) → 400
 *  - transport error → 503
 *  - success → 200 with the RPC payload passed through after mechanical
 *    key mapping (is_correct→isCorrect; practice adds correct_index→
 *    correctIndex, correct_indices→correctIndices (QT-1), explanation).
 */
export async function POST(request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) return notFound();

  const auth = await requireStudent(supabase);
  if (!auth.ok) return auth.response;

  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`answer:${auth.userId}`, ANSWER_RATE)) {
    return rateLimited("Too many answers. Try again in a minute.");
  }
  if (!rateLimit(`answer-session:${id}:${auth.userId}`, ANSWER_SESSION_RATE)) {
    return rateLimited("Too many answers for this session. Try again in a minute.");
  }

  // Body cap: selectedIndices is Zod-capped at 5 elements, but a huge JSON
  // body would be parsed BEFORE Zod sees it (sibling-route convention).
  // audit-1 P1-5: the streaming-capped read aborts mid-stream, so chunked
  // bodies cannot bypass the cap the way a header-only check allowed.
  const body = await readCappedJson(request);
  if (!body.ok) return body.response;

  const parsed = AnswerSchema.safeParse(body.data);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid answer payload."));
  }

  let similarities: number[] | null = null;
  let poses: Array<Record<string, number | null>> | null = null;
  let frameProof: string | null = null;
  let answerProof: string | null = null;
  let facesForAdvisory: insightface.InsightFaceExtractResult["faces"][] | null = null;
  if (parsed.data.faceVerification) {
    const { frames, nonce } = parsed.data.faceVerification;
    if (frames.length !== 3 || frames.some((f) => !f || f.length > MAX_FRAME_BASE64_CHARS)) {
      return invalidBody("Answer verification requires three valid frames.");
    }
    try {
      const admin = createAdminClient();
      const { data: secret, error: secretError } = await admin.rpc("get_verify_proof_secret");
      if (secretError || typeof secret !== "string" || !secret) throw secretError ?? new Error("missing proof secret");
      const results = await Promise.all(frames.map(async (frame) => {
        if (frame === "") return { similarity: 0, faces: [] as insightface.InsightFaceExtractResult["faces"], spoof: null };
        const extracted = await withFaceInference(() => insightface.extractFace(frame, auth.userId));
        if ("error" in extracted) return extracted;
        const primary = selectPrimaryFace(extracted.faces);
        if (!primary) return { similarity: 0, faces: extracted.faces, spoof: extracted.spoof ?? null };
        const compared = await supabase.rpc("compare_face_baseline" as never, { p_embedding: primary.embedding } as never);
        const result = compared.data as Record<string, unknown> | null;
        if (compared.error || typeof result?.similarity !== "number") return { error: "insightface_unavailable" as const };
        return { similarity: result.present === true ? Math.max(0, Math.min(1, result.similarity)) : 0, faces: extracted.faces, spoof: extracted.spoof ?? null };
      }));
      const failed = results.find((r) => "error" in r);
      if (failed && "error" in failed) {
        return failed.error === "invalid_frame"
          ? jsonError("invalid_frame", undefined, 400)
          : jsonError("verification_unavailable", undefined, 503);
      }
      facesForAdvisory = results.map((r) => (r as { faces: insightface.InsightFaceExtractResult["faces"] }).faces);
      similarities = results.map((r) => Math.max(0, Math.min(1, (r as { similarity: number }).similarity)));
      const spoofVerdicts: SpoofFrameVerdict[] = results.map((r) => (r as { spoof: insightface.SpoofVerdict | null }).spoof);
      const spoof = spoofGateDecision(spoofVerdicts);
      if (process.env.FACE_SPOOF_ENFORCE === "1" && spoof.forcedFail) similarities = similarities.map(() => 0);
      poses = results.map((r): Record<string, number | null> => {
        const primary = selectPrimaryFace((r as { faces: insightface.InsightFaceExtractResult["faces"] }).faces);
        return primary
          ? { yaw: primary.yaw, pitch: primary.pitch, roll: primary.roll, spoof: (r as { spoof: insightface.SpoofVerdict | null }).spoof?.score ?? null }
          : { spoof: (r as { spoof: insightface.SpoofVerdict | null }).spoof?.score ?? null };
      });
      frameProof = mintVerifyProof(secret, id, nonce, frames);
      answerProof = mintAnswerProof(secret, id, nonce, frames, parsed.data);
    } catch (err) {
      logError("answer.face_verification", err, { subsystem: "verification", errorCode: "insightface_unavailable", sessionId: id });
      return jsonError("verification_unavailable", undefined, 503);
    }
  }

  // Exactly one answer field is present (Zod one-of). supabase-js drops
  // `undefined` keys, and every 0055 RPC param defaults to null/false — so the
  // absent side resolves to its SQL default at the RPC (the pre-0055 arities
  // were dropped, so there is no overload to fall into).
  const { data, error } = await supabase.rpc("commit_answer", {
    p_session_id: id,
    p_question_id: parsed.data.questionId,
    p_selected_index: parsed.data.selectedIndex,
    p_selected_indices: parsed.data.selectedIndices,
    p_answer_text: parsed.data.answerText,
    p_skipped: parsed.data.skipped,
    p_nonce: parsed.data.faceVerification?.nonce,
    p_frames: parsed.data.faceVerification?.frames,
    p_similarities: similarities ?? undefined,
    p_proof: frameProof ?? undefined,
    p_answer_proof: answerProof ?? undefined,
    p_poses: poses ?? undefined,
  });

  if (error) {
    logError("answer.answer_question", error, {
      subsystem: "quiz-play",
      errorCode: "answer_question_failed",
      sessionId: id,
    });
    return internalError("Could not record the answer right now.");
  }

  const payload = data as Record<string, unknown> | null;
  const faceCheck = payload?.faceCheck as Record<string, unknown> | undefined;
  if (faceCheck && typeof faceCheck.nextNonce === "string") {
    if (facesForAdvisory && shouldReportSecondFace(facesForAdvisory)) {
      void Promise.resolve(supabase.rpc("report_session_advisory", { p_session_id: id, p_type: "second_face" })).catch(() => {});
    }
  }

  if (payload?.error === "not_student") return forbidden();
  if (payload?.error === "not_authenticated") return unauthorized();
  if (payload?.error === "not_owner") return notFound();
  if (payload?.error === "session_not_active") {
    return rpcError(payload, 409);
  }
  if (payload?.error === "face_verification_required") {
    return rpcError(payload, 409);
  }
  if (payload?.error === "face_mismatch") {
    return NextResponse.json({ error: "face_mismatch", faceCheck: payload.faceCheck }, { status: 409, headers: { "content-type": "application/json" } });
  }
  if (payload?.error === "nonce_mismatch") {
    return NextResponse.json({ error: "verification_stale", ...(payload.faceCheck ? { faceCheck: payload.faceCheck } : {}) }, { status: 409, headers: { "content-type": "application/json" } });
  }
  if (payload?.error === "rate_limited") return rateLimited("Too many verification attempts. Try again shortly.");
  if (payload?.error === "not_enrolled" || payload?.error === "consent_required") return rpcError(payload, 403);
  if (payload?.error === "invalid_frame" || payload?.error === "invalid_trigger") return rpcError(payload, 400);
  if (payload?.error === "proof_invalid" || payload?.error === "proof_required") return rpcError(payload, 403);
  if (payload?.error === "quiz_not_live") {
    return rpcError(payload, 409);
  }
  // Availability window hard stop (QC-3) — schedule state, same 409 family.
  if (payload?.error === "quiz_window_closed") {
    return rpcError(payload, 409);
  }
  if (payload?.error === "time_expired") {
    return rpcError(payload, 403);
  }
  if (payload?.error === "already_answered") {
    // Payload passed through, key-mapped only — never synthesized. Pre-reveal
    // the assessment replay carries NO is_correct (keyless; I10 pins the 409).
    return NextResponse.json(
      { error: "already_answered", ...(payload.faceCheck ? { faceCheck: payload.faceCheck } : {}) },
      { status: 409, headers: { "content-type": "application/json" } },
    );
  }
  if (
    payload?.error === "invalid_question" ||
    payload?.error === "invalid_selected_index" ||
    payload?.error === "invalid_selected_indices" ||
    payload?.error === "invalid_answer_text"
  ) {
    return rpcError(payload, 400);
  }

  // Success gate accepts BOTH the practice payload (is_correct) and the
  // assessment keyless ack (`recorded: true`) — never requires is_correct.
  if (
    payload &&
    payload.error === undefined &&
    ("is_correct" in payload || payload.recorded === true)
  ) {
    return NextResponse.json(mapAnswerPayload(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  logError("answer.answer_question_unexpected", undefined, {
    subsystem: "quiz-play",
    errorCode: "unexpected_payload",
    sessionId: id,
    payload,
  });
  return internalError("Could not record the answer right now.");
}

/**
 * Mechanical snake→camel mapping of the RPC's success payload. Only keys the
 * RPC actually returned are re-keyed — assessment's keyless ack passes through
 * as `{ recorded: true }`, never a synthesized correctness.
 */
function mapAnswerPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if ("is_correct" in payload) out.isCorrect = payload.is_correct;
  if ("recorded" in payload) out.recorded = payload.recorded === true;
  if ("correct_index" in payload) out.correctIndex = payload.correct_index;
  // QT-1: multi-select practice feedback carries the correct SET (the scalar
  // key arrives as null for multi rows — mapped verbatim so the client's
  // highlight logic can branch on it).
  if ("correct_indices" in payload) out.correctIndices = payload.correct_indices;
  if ("explanation" in payload && payload.explanation != null) {
    out.explanation = payload.explanation;
  }
  if ("faceCheck" in payload) out.faceCheck = payload.faceCheck;
  return out;
}

function rpcError(payload: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(
    { error: String(payload.error), ...(payload.faceCheck ? { faceCheck: payload.faceCheck } : {}) },
    { status, headers: { "content-type": "application/json" } },
  );
}
