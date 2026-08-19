import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireQuizOwner } from "@/lib/quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { UpdateQuizSchema } from "@/lib/quizzes/validation";
import { buildQuizUpdates } from "@/lib/quizzes/updates";
import {
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

/**
 * PATCH /api/quizzes/[id] — rename / change mode / change time limit.
 * Draft-only (a live/closed quiz is immutable). Owner only.
 */
export async function PATCH(request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) {
    return notFound();
  }

  const owner = await requireQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;
  if (owner.quiz.status !== "draft") return notDraft();

  // CSRF: reject cross-origin state changes (AI/session-route precedent).
  const originError = checkSameOrigin(request);
  if (originError) return originError;

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
  const { title, mode, timeLimitSec } = parsed.data;
  if (title === undefined && mode === undefined && timeLimitSec === undefined) {
    return invalidBody("No editable fields provided.");
  }

  const updates = buildQuizUpdates({ title, mode, timeLimitSec }, owner.quiz.mode);

  const { data: quiz, error } = await supabase
    .from("quizzes")
    .update(updates)
    .eq("id", id)
    .select("id, class_id, title, mode, status, time_limit_sec, created_at")
    .maybeSingle();

  if (error) {
    console.error("Update quiz error:", error);
    if (error.message?.includes("quiz_not_draft_edit")) {
      return notDraft();
    }
    if (
      error.message?.includes("quizzes_practice_untimed") ||
      error.message?.includes("quizzes_time_limit_sec_check") ||
      error.message?.includes("quizzes_title_check") ||
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
