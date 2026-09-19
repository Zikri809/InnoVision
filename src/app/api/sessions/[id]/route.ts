import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { coerceScore } from "@/lib/results/derive";
import { internalError, notFound, rateLimited, unauthorized } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Per-user rate limit on session GETs (flagged-poll + stale-nonce recovery).
const GET_RATE = { limit: 60, windowMs: 60 * 1000 };

// Shared envelope columns. `verify_nonce` is deliberately NOT in the shared
// list: it is the student's replay token and must never be selected for the
// lecturer path. The base-table columns `score`/`is_correct` are column-revoked
// from `authenticated` (PLAN_REVEAL_RESULTS v4 §3) — ALL reads go through the
// owner-privilege views below, which re-expose them only under the correct
// predicate.
const ENVELOPE_COLS =
  "id, status, quiz_id, mode, started_at, submitted_at, score, face_exempt, face_fail_streak, face_unavailable_at, last_activity_at, student_id";
const OWN_COLS = `${ENVELOPE_COLS}, verify_nonce`;

/**
 * GET /api/sessions/[id] — read the session envelope.
 *
 * AuthZ: the OWN student reads their session; the quiz LECTURER reads any of
 * the quiz's sessions (P8 status reads + unlock/exempt UI). Missing/not-owned
 * → 404 (no oracle).
 *
 * Reads go through the sealed views: `student_session_view` (score reveal-gated
 * for assessment) and `lecturer_session_view` (full score for the quiz's
 * lecturer).
 *
 * Envelope: `{ id, status, quiz_id, mode, started_at, submitted_at, score,
 * face_exempt, face_fail_streak, face_unavailable_at, last_activity_at }` +
 * `verify_nonce` for the own student ONLY (the lecturer SELECT never fetches
 * the nonce) + `remainingMs` for the own student's ACTIVE timed session
 * (D-F2 — the countdown re-sync seed) + `pending_count`/`failed_count`/
 * `revealed` for the own student (FS-4: the play client's pending banner must
 * work PRE-reveal, where `student_results` is unreachable).
 */
export async function GET(_request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) return notFound();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  // audit-1 P1-12: a logged-out caller gets 401 (recoverable — the play
  // client redirects to login); a signed-in caller probing foreign sessions
  // still gets 404 (no-oracle discipline unchanged).
  if (!user) return unauthorized();

  // Rate-limit BEFORE the profile read (cheap, and an unauthenticated caller
  // with a session cookie is still throttled).
  if (!rateLimit(`session-get:${user.id}`, GET_RATE)) {
    return rateLimited("Too many requests. Try again in a minute.");
  }

  // Own-student path via student_session_view (own-row only, score reveal-gated).
  const own = await supabase
    .from("student_session_view")
    .select(OWN_COLS)
    .eq("id", id)
    .eq("student_id", user.id)
    .maybeSingle();

  if (own.error) {
    // Transient DB failure must NOT read as "no session" (404) — surface 503.
    console.error("Session fetch error:", own.error);
    return internalError("Could not load the session right now.");
  }
  if (own.data) {
    return Response.json(await studentEnvelope(supabase, own.data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // Lecturer path via lecturer_session_view (is_lecturer_of_quiz). The SELECT
  // omits verify_nonce entirely.
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (profile?.role === "lecturer") {
    const lect = await supabase
      .from("lecturer_session_view")
      .select(ENVELOPE_COLS)
      .eq("id", id)
      .maybeSingle();
    if (lect.error) {
      console.error("Session fetch error:", lect.error);
      return internalError("Could not load the session right now.");
    }
    if (lect.data && typeof lect.data.quiz_id === "string") {
      const isLecturerOfQuiz = await supabase.rpc("is_lecturer_of_quiz", {
        p_quiz_id: lect.data.quiz_id,
      });
      if (isLecturerOfQuiz.error) {
        console.error("is_lecturer_of_quiz error:", isLecturerOfQuiz.error);
        return internalError("Could not load the session right now.");
      }
      if (isLecturerOfQuiz.data === true) {
        return Response.json(envelope(lect.data), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
  }

  return notFound();
}

/**
 * Student envelope: assessment score stays NULL until the quiz's results are
 * revealed (the lecturer view of the same session is unaffected). The reveal
 * state is derived from quiz metadata via RLS — no dedicated read needed here.
 * QC-2: a closed+revealed quiz falls out of the live-only view; the closed-
 * revealed view is the fallback so recovered results still reach the student.
 *
 * D-F2: for an ACTIVE timed session the envelope also carries `remainingMs`
 * (the same ungraced deadline arithmetic as lib/sessions/timer.ts). The
 * flagged poll observes status='active' here after a lecturer unlock, so the
 * client can re-sync its countdown instead of resuming from the frozen
 * pre-pause reading.
 *
 * FS-4: the envelope also carries `pending_count`/`failed_count`/`revealed`
 * from `student_pending_count` — an OWN-session count that is deliberately NOT
 * reveal-gated, because the pending banner must render while `student_results`
 * still answers `not_revealed`.
 */
async function studentEnvelope(
  supabase: Awaited<ReturnType<typeof createClient>>,
  s: Record<string, unknown>,
) {
  const row = envelope(s);
  // The pending count is read BEFORE the quiz-metadata short-circuit below:
  // the banner is needed pre-reveal, when neither the score nor the deadline
  // arm applies. `not_found` is unreachable here (the caller already matched
  // this session to the caller), and a transport error degrades to nulls so
  // the status poll's primary contract survives an auxiliary read.
  const pending = await supabase.rpc("student_pending_count", { p_session_id: String(s.id) });
  if (pending.error) {
    console.error("student_pending_count error:", pending.error);
  } else {
    const p = pending.data as {
      pending_count?: unknown;
      failed_count?: unknown;
      revealed?: unknown;
      error?: unknown;
    } | null;
    // `{error: 'not_found'}` is a payload, not a transport failure — a
    // session the caller can see here can never legitimately produce it, so
    // leaving the fields absent is the honest read.
    if (p && p.error === undefined) {
      row.pending_count = p.pending_count ?? 0;
      row.failed_count = p.failed_count ?? 0;
      row.revealed = p.revealed === true;
    }
  }
  if (typeof row.quiz_id !== "string") return row;
  // Quiz metadata is needed for the reveal gate (score non-null) and/or the
  // active-session deadline (D-F2). One read serves both.
  const needsQuizMeta =
    (row.mode === "assessment" && row.score != null) || row.status === "active";
  if (!needsQuizMeta) return row;
  const { data: quiz } = await supabase
    .from("student_quiz_view")
    .select("id, results_revealed_at, time_limit_sec")
    .eq("id", row.quiz_id)
    .maybeSingle()
    .then(async (r) =>
      r.data
        ? r
        : supabase
            .from("student_closed_revealed_quiz_view")
            .select("id, results_revealed_at, time_limit_sec")
            .eq("id", row.quiz_id as string)
            .maybeSingle(),
    );
  if (row.mode === "assessment" && row.score != null && !quiz?.results_revealed_at) {
    row.score = null;
  }
  if (
    row.status === "active" &&
    quiz?.time_limit_sec != null &&
    typeof row.started_at === "string"
  ) {
    const deadline = Date.parse(row.started_at) + quiz.time_limit_sec * 1000;
    // Server-computed seed (the client never reads its own clock for this).
    (row as Record<string, unknown>).remainingMs = Math.max(0, deadline - Date.now());
  }
  return row;
}

function envelope(s: Record<string, unknown>) {
  return {
    id: s.id,
    status: s.status,
    quiz_id: s.quiz_id,
    mode: s.mode,
    started_at: s.started_at,
    submitted_at: s.submitted_at,
    // D8: NUMERIC crosses PostgREST as a string — coerce at the envelope
    // boundary so both the student and lecturer paths emit a number or null.
    score: coerceScore(s.score),
    face_exempt: s.face_exempt,
    face_fail_streak: s.face_fail_streak,
    face_unavailable_at: s.face_unavailable_at,
    last_activity_at: s.last_activity_at,
    ...(s.verify_nonce !== undefined ? { verify_nonce: s.verify_nonce } : {}),
  } as Record<string, unknown>;
}
