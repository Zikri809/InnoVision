import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireStudent } from "@/lib/classes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { AnswerSchema } from "@/lib/sessions/validation";
import {
  checkSameOrigin,
  firstIssueMessage,
  forbidden,
  internalError,
  invalidBody,
  invalidJson,
  jsonError,
  notFound,
  rateLimited,
  unauthorized,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Per-user rate limit on answers (30 questions + retries comfortably fits).
const ANSWER_RATE = { limit: 120, windowMs: 60 * 1000 };

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
 *  - `time_expired` → 403 `{ error: "time_expired" }`
 *  - `already_answered` → 409 `{ error: "already_answered" }` (KEYLESS —
 *    assessment answers stay secrecy-safe; the RPC replays the stored result
 *    for practice)
 *  - `invalid_question` / `invalid_selected_index` → 400
 *  - transport error → 503
 *  - success → 200 with the RPC payload passed through after mechanical
 *    key mapping (is_correct→isCorrect; practice adds correct_index→
 *    correctIndex, explanation).
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = AnswerSchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid answer payload."));
  }

  const { data, error } = await supabase.rpc("answer_question", {
    p_session_id: id,
    p_question_id: parsed.data.questionId,
    p_selected_index: parsed.data.selectedIndex,
  });

  if (error) {
    console.error("answer_question error:", error);
    return internalError("Could not record the answer right now.");
  }

  const payload = data as Record<string, unknown> | null;

  if (payload?.error === "not_student") return forbidden();
  if (payload?.error === "not_authenticated") return unauthorized();
  if (payload?.error === "not_owner") return notFound();
  if (payload?.error === "session_not_active") {
    return jsonError("session_not_active", undefined, 409);
  }
  if (payload?.error === "quiz_not_live") {
    return jsonError("quiz_not_live", undefined, 409);
  }
  if (payload?.error === "time_expired") {
    return jsonError("time_expired", undefined, 403);
  }
  if (payload?.error === "already_answered") {
    // Payload passed through, key-mapped only — never synthesized. Pre-reveal
    // the assessment replay carries NO is_correct (keyless; I10 pins the 409).
    return NextResponse.json(
      { error: "already_answered" },
      { status: 409, headers: { "content-type": "application/json" } },
    );
  }
  if (payload?.error === "invalid_question" || payload?.error === "invalid_selected_index") {
    return jsonError(String(payload.error), undefined, 400);
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

  console.error("answer_question unexpected payload:", payload);
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
  if ("explanation" in payload && payload.explanation != null) {
    out.explanation = payload.explanation;
  }
  return out;
}
