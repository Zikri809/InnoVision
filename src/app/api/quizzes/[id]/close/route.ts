import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireQuizOwner } from "@/lib/quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { checkSameOrigin, internalError, jsonError, notFound } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Per-lecturer close budget (mirrors publish's abuse bound).
const CLOSE_RATE = { limit: 30, windowMs: 60 * 60 * 1000 };

/**
 * POST /api/quizzes/[id]/close — terminal live→closed flip (QC-1).
 *
 * Preamble mirrors publish/route.ts with ONE deliberate deviation: the
 * idempotent short-circuit sits AFTER the rate limiter (publish puts its
 * own before it, leaving live→live unthrottled — don't inherit that).
 *
 * Semantics:
 *  - draft → 409 quiz_not_live (owner-only surface; requireQuizOwner already
 *    404s non-owners, so this leaks nothing).
 *  - closed → 200 idempotent (same-state retry, publish-style).
 *  - live → compare-and-swap UPDATE `.eq("status", "live")`. 0 rows means a
 *    concurrent close/delete won → RE-FETCH: now-closed → 200; gone → 404.
 *    Never fabricate a 200 {quiz} for a nonexistent row.
 *  - Straggler semantics (documented in the plan): submit_session stays
 *    status-free (submit-only grace); new starts are blocked by the
 *    live-only view + start RPC; answer_question hard-stops via its own
 *    live gate.
 */
export async function POST(request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) {
    return notFound();
  }

  const owner = await requireQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;

  // CSRF: reject cross-origin closes (publish/session-route precedent).
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`quiz-close:${owner.userId}`, CLOSE_RATE)) {
    return jsonError("rate_limited", "Too many close attempts. Try again later.", 429);
  }

  if (owner.quiz.status === "draft") {
    return jsonError("quiz_not_live", "Only a live quiz can be closed.", 409);
  }

  // Idempotent re-close.
  if (owner.quiz.status === "closed") {
    return NextResponse.json({ quiz: owner.quiz });
  }

  // Compare-and-swap close: the `.eq("status","live")` guard makes a
  // concurrent close lose the race with a 0-row result instead of erroring.
  const { data, error } = await supabase
    .from("quizzes")
    .update({ status: "closed" })
    .eq("id", id)
    .eq("status", "live")
    .select("id, class_id, title, mode, status, time_limit_sec, created_at")
    .maybeSingle();

  if (error) {
    console.error("Close quiz error:", error);
    if (error.message?.includes("closed_quiz_cannot_transition")) {
      return jsonError("quiz_closed", "A closed quiz cannot be re-published.", 409);
    }
    if (error.message?.includes("quiz_not_draft_edit")) {
      return jsonError("quiz_not_draft", "Only draft quizzes can be edited.", 409);
    }
    return internalError("Could not close the quiz right now.");
  }

  if (!data) {
    // 0 rows: a concurrent close won, or the quiz was deleted concurrently
    // (quizzes are deletable while unattempted). Re-fetch to distinguish; a
    // failed re-fetch is a transient DB error, not "not found".
    const { data: fresh, error: refetchError } = await supabase
      .from("quizzes")
      .select("id, class_id, title, mode, status, time_limit_sec, created_at")
      .eq("id", id)
      .maybeSingle();
    if (refetchError) {
      console.error("Close quiz re-fetch error:", refetchError);
      return internalError("Could not close the quiz right now.");
    }
    if (fresh) {
      return NextResponse.json({ quiz: fresh });
    }
    return notFound();
  }

  return NextResponse.json({ quiz: data });
}