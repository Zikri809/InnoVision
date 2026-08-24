import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireQuizOwner } from "@/lib/quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { checkSameOrigin, internalError, jsonError, notFound } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Per-lecturer publish budget (student-surface parity; abuse bound).
const PUBLISH_RATE = { limit: 30, windowMs: 60 * 60 * 1000 };

/**
 * POST /api/quizzes/[id]/publish — set a draft quiz to live.
 *
 * Rules (locked in PLAN_PHASE3 §2):
 *  - draft→live requires ≥1 question (route pre-check; DB trigger is backstop).
 *  - live→live is an idempotent no-op (double-click safe).
 *  - closed→live is rejected (one-way state machine).
 */
export async function POST(request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) {
    return notFound();
  }

  const owner = await requireQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;

  // CSRF: reject cross-origin publishes (AI/session-route precedent).
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  // Idempotent re-publish.
  if (owner.quiz.status === "live") {
    return NextResponse.json({ quiz: owner.quiz });
  }

  if (!rateLimit(`quiz-publish:${owner.userId}`, PUBLISH_RATE)) {
    return jsonError("rate_limited", "Too many publish attempts. Try again later.", 429);
  }

  if (owner.quiz.status === "closed") {
    return jsonError("quiz_closed", "A closed quiz cannot be re-published.", 409);
  }

  // Route pre-check for a clean 409; the DB trigger enforces it as backstop.
  const { count, error: countError } = await supabase
    .from("questions")
    .select("id", { count: "exact", head: true })
    .eq("quiz_id", id);

  if (countError) {
    console.error("Publish count error:", countError);
    return internalError("Could not publish the quiz right now.");
  }

  if ((count ?? 0) === 0) {
    return jsonError("no_questions", "Add at least one question before publishing.", 409);
  }

  const { data: quiz, error } = await supabase
    .from("quizzes")
    .update({ status: "live" })
    .eq("id", id)
    .select("id, class_id, title, mode, status, time_limit_sec, created_at")
    .single();

  if (error) {
    // A trigger exception (e.g. state-machine violation) surfaces as a DB
    // error — map to a clean 409/503 rather than leaking a raw message.
    console.error("Publish quiz error:", error);
    if (error.message?.includes("cannot_publish_empty_quiz")) {
      return jsonError("no_questions", "Add at least one question before publishing.", 409);
    }
    if (error.message?.includes("live_quiz_cannot_reopen") || error.message?.includes("closed_quiz_cannot_transition")) {
      return jsonError("quiz_closed", "A closed quiz cannot be re-published.", 409);
    }
    return internalError("Could not publish the quiz right now.");
  }

  return NextResponse.json({ quiz });
}
