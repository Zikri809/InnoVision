import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireStudent } from "@/lib/classes/guards";
import { rateLimit } from "@/lib/classes/rate-limit";
import { StartSessionSchema } from "@/lib/sessions/validation";
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
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

// Per-user rate limit on session starts (double-click/two-tab abuse guard).
const START_RATE = { limit: 10, windowMs: 60 * 1000 };

/**
 * POST /api/sessions — start (or rejoin) a quiz session.
 *
 * Input: `{ quizId }`. Student-only. The RPC is authoritative: it re-validates
 * role/live/enrollment and returns typed errors (never raises for business
 * rules). The route only maps them:
 *  - `not_student` → 403 (defensive; requireStudent already runs first)
 *  - `quiz_not_live` / `not_enrolled` → 404 (single no-oracle error — a
 *    draft/closed/nonexistent quiz is indistinguishable to a student)
 *  - `consent_required` / `face_enrollment_pending` → 403 (audit-5 M2: the
 *    assessment face-eligibility gate now lives in the RPC — a direct
 *    caller can no longer start unverified. `consent_required` mirrors the
 *    face routes' 403; `face_enrollment_pending` is a pending_review
 *    enrollment, not a missing one)
 *  - `already_attempted` → 409 `{ error, session_id }` (E5 clean message)
 *  - transport error → 503
 *  - success → 201 `{ session }` (for practice this may be an existing
 *    non-terminal session id — rejoin is expected, not a bug).
 */
export async function POST(request: Request) {
  const supabase = await createClient();

  const auth = await requireStudent(supabase);
  if (!auth.ok) return auth.response;

  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`start:${auth.userId}`, START_RATE)) {
    return rateLimited("Too many quiz starts. Try again in a minute.");
  }

  // audit-1 P1-5: streaming-capped read (chunked/lying-header bodies used
  // to materialize unbounded before Zod ran).
  const body = await readCappedJson(request);
  if (!body.ok) return body.response;

  const parsed = StartSessionSchema.safeParse(body.data);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid start payload."));
  }

  const { data, error } = await supabase.rpc("start_quiz_session", {
    p_quiz_id: parsed.data.quizId,
  });

  if (error) {
    logError("sessions.start_quiz_session", error, {
      subsystem: "quiz-play",
      errorCode: "start_failed",
      quizId: parsed.data.quizId,
    });
    return internalError("Could not start the quiz right now.");
  }

  const payload = data as Record<string, unknown> | null;

  if (payload?.error === "not_student") return forbidden();
  if (payload?.error === "not_authenticated") return unauthorized();
  // audit-5 M2: assessment face-eligibility (RPC-authoritative). Both are
  // client errors, not outages — a raw 503 would read as "try again".
  if (payload?.error === "consent_required") {
    return jsonError("consent_required", undefined, 403);
  }
  if (payload?.error === "face_enrollment_pending") {
    return jsonError("face_enrollment_pending", undefined, 403);
  }
  if (payload?.error === "quiz_not_live" || payload?.error === "not_enrolled") {
    return notFound();
  }
  // Schedule state (QC-3): distinct from the identity 404s — an ENROLLED
  // student legitimately learns the window state so SQ copy can say
  // "not open yet" / "already closed". Unenrolled probers never reach these
  // (the RPC checks enrollment first and folds to not_enrolled → 404).
  if (payload?.error === "quiz_not_open" || payload?.error === "quiz_window_closed") {
    return jsonError(payload.error, undefined, 409);
  }
  if (payload?.error === "already_attempted") {
    return NextResponse.json(
      { error: "already_attempted", session_id: payload.session_id ?? null },
      { status: 409, headers: { "content-type": "application/json" } },
    );
  }
  if (payload?.session) {
    return NextResponse.json(
      { session: payload.session },
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }

  // Unknown RPC payload → treat as an internal failure (never a raw message).
  logError("sessions.start_quiz_session_unexpected", undefined, {
    subsystem: "quiz-play",
    errorCode: "unexpected_payload",
    quizId: parsed.data.quizId,
    payload,
  });
  return internalError("Could not start the quiz right now.");
}
