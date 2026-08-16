import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { requireQuizOwner } from "@/lib/quizzes/guards";
import {
  checkSameOrigin,
  internalError,
  notFound,
  rateLimited,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Per-user rate limit on reveals (guards against a misbehaving client).
const REVEAL_RATE = { limit: 10, windowMs: 60 * 1000 };

/**
 * POST /api/quizzes/[id]/reveal — release assessment results to students.
 *
 * One-way + live-only (PLAN_REVEAL_RESULTS v4 §9/§10):
 *  - `status = 'live'` is REQUIRED (revealing a closed quiz would strand the
 *    class: student_quiz_view is live-only, so nothing could ever reach the
 *    released results).
 *  - Idempotent: a second reveal is a 0-row no-op → 200 `{ already: true }`.
 *  - The DB trigger `quiz_reveal_once` is the backstop: any UPDATE that
 *    changes a non-null `results_revealed_at` raises `reveal_once_only`.
 */
export async function POST(_request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) return notFound();

  const owner = await requireQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;

  // Raise the route's rate limit inside the guard so anonymous callers are
  // throttled before the profile read.
  const rate = owner.userId ? rateLimit(`reveal:${owner.userId}`, REVEAL_RATE) : false;
  if (!rate) return rateLimited("Too many requests. Try again in a minute.");

  const originError = checkSameOrigin(_request);
  if (originError) return originError;

  if (owner.quiz.mode !== "assessment") {
    return NextResponse.json(
      { error: "practice_always_revealed" },
      { status: 409, headers: { "content-type": "application/json" } },
    );
  }
  if (owner.quiz.status !== "live") {
    return NextResponse.json(
      { error: "quiz_not_live" },
      { status: 409, headers: { "content-type": "application/json" } },
    );
  }

  // Guarded one-way-safe UPDATE (mirrors the auto-reveal flip in submit_session).
  const { data, error } = await supabase
    .from("quizzes")
    .update({ results_revealed_at: new Date().toISOString() })
    .eq("id", id)
    .is("results_revealed_at", null)
    .eq("status", "live")
    .select("id, results_revealed_at")
    .maybeSingle();

  if (error) {
    console.error("reveal quiz error:", error);
    return internalError("Could not reveal the results right now.");
  }

  // 0 rows (already revealed) → idempotent success.
  return NextResponse.json(
    { revealed: true, already: !data },
    { status: 200, headers: { "content-type": "application/json" } },
  );
}