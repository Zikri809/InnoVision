import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireQuizOwner } from "@/lib/quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { UpdateQuizSchema } from "@/lib/quizzes/validation";
import { buildQuizUpdates, hasNonWindowFields, hasRetakeFields, hasWindowFields } from "@/lib/quizzes/updates";
import {
  checkBodyLimit,
  checkSameOrigin,
  firstIssueMessage,
  internalError,
  invalidBody,
  invalidJson,
  jsonError,
  notDraft,
  notFound,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Per-lecturer mutation budget (student-surface parity; abuse bound).
const MUTATE_RATE = { limit: 60, windowMs: 60 * 60 * 1000 };

/**
 * PATCH /api/quizzes/[id] — rename / change mode / change time limit /
 * set availability windows (opens_at/closes_at) / set retake config
 * (allowRetake/maxAttempts).
 * Metadata fields (title/mode/time limit) are DRAFT-ONLY (a live/closed quiz
 * is immutable — DB trigger backstop). Window and retake fields bypass the
 * draft lock: both are live-quiz management (PLAN_R_QUIZ_LIFECYCLE QC-3/QC-4).
 * Owner only.
 */
export async function PATCH(request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) {
    return notFound();
  }

  const owner = await requireQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;

  // CSRF: reject cross-origin state changes (AI/session-route precedent).
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`quiz-mutate:${owner.userId}`, MUTATE_RATE)) {
    return jsonError("rate_limited", "Too many updates. Try again later.", 429);
  }

  const sizeError = checkBodyLimit(request);
  if (sizeError) return sizeError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = UpdateQuizSchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid quiz data."));
  }

  // UpdateQuizSchema has NO defaults (see validation.ts), so an empty body
  // parses to {} and this guard is reachable — it is not dead code.
  const { title, mode, timeLimitSec, opensAt, closesAt, allowRetake, maxAttempts, shuffleQuestions } = parsed.data;
  if (
    title === undefined &&
    mode === undefined &&
    timeLimitSec === undefined &&
    opensAt === undefined &&
    closesAt === undefined &&
    allowRetake === undefined &&
    maxAttempts === undefined &&
    shuffleQuestions === undefined
  ) {
    return invalidBody("No editable fields provided.");
  }

  const patch = { title, mode, timeLimitSec, opensAt, closesAt, allowRetake, maxAttempts, shuffleQuestions };

  // Availability windows (QC-3) and retake config (QC-4) are LIVE-quiz
  // management: a payload carrying ONLY those fields bypasses the draft-only
  // lock. Any non-window/retake field (title/mode/time limit/shuffle — QT-3
  // is frozen metadata) on a non-draft quiz keeps the blanket 409 (DB trigger
  // quiz_not_draft_edit is the backstop).
  const liveManageableOnly =
    (hasWindowFields(patch) || hasRetakeFields(patch)) && !hasNonWindowFields(patch);
  if (owner.quiz.status !== "draft" && !liveManageableOnly) return notDraft();

  const updates = buildQuizUpdates(patch, owner.quiz.mode);

  const { data: quiz, error } = await supabase
    .from("quizzes")
    .update(updates)
    .eq("id", id)
    .select("id, class_id, title, mode, status, time_limit_sec, opens_at, closes_at, allow_retake, max_attempts, shuffle_questions, created_at")
    .maybeSingle();

  if (error) {
    console.error("Update quiz error:", error);
    if (error.message?.includes("quiz_not_draft_edit")) {
      return notDraft();
    }
    if (error.message?.includes("quizzes_window_order_check")) {
      return invalidBody("The closing time must be after the opening time.");
    }
    if (
      error.message?.includes("quizzes_practice_untimed") ||
      error.message?.includes("quizzes_time_limit_sec_check") ||
      error.message?.includes("quizzes_title_check") ||
      error.message?.includes("quizzes_max_attempts_check") ||
      error.message?.includes("check constraint")
    ) {
      return invalidBody("Invalid quiz data.");
    }
    return internalError("Could not update the quiz right now.");
  }

  if (!quiz) {
    return notFound();
  }

  return NextResponse.json({ quiz });
}

/**
 * DELETE /api/quizzes/[id] — owner only. Cascades questions.
 *
 * P5 prerequisite guard: a quiz with student attempts cannot be deleted
 * (prevents a lecturer accidentally destroying attendance). This is an
 * advisory, route-level guard — the count-then-delete has a narrow TOCTOU
 * window (a session started between the two round trips would cascade-delete)
 * that is accepted at demo scale; a `before delete on quizzes` trigger would
 * close it but would also block class deletion via cascade (deferred, §5).
 * The DB layer is `on delete cascade` by design (D41 is route-owned → I-S12).
 */
export async function DELETE(request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) {
    return notFound();
  }

  const owner = await requireQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;

  // CSRF: reject cross-origin deletes (the P5 session routes set the
  // precedent; a cross-site DELETE could otherwise cascade student sessions).
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`quiz-mutate:${owner.userId}`, MUTATE_RATE)) {
    return jsonError("rate_limited", "Too many updates. Try again later.", 429);
  }

  const { count, error: countError } = await supabase
    .from("quiz_sessions")
    .select("id", { count: "exact", head: true })
    .eq("quiz_id", id);

  if (countError) {
    console.error("Quiz delete session-count error:", countError);
    return internalError("Could not delete the quiz right now.");
  }

  if ((count ?? 0) > 0) {
    return jsonError(
      "quiz_has_sessions",
      "This quiz has student attempts. Close or reset them before deleting.",
      409,
    );
  }

  const { error } = await supabase.from("quizzes").delete().eq("id", id);
  if (error) {
    console.error("Delete quiz error:", error);
    return internalError("Could not delete the quiz right now.");
  }

  return NextResponse.json({ ok: true });
}
