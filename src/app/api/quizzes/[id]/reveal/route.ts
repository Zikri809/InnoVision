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
 * One-way; live OR closed (QC-2 closed-before-reveal recovery — the
 * reveal_once_only trigger only guards CHANGES to a non-null timestamp, so
 * first-time reveal on a closed quiz is trigger-legal):
 *  - draft → 409 quiz_not_revealable (nothing to reveal into; students
 *    can never reach a draft).
 *  - closed + unrevealed → allowed (the recovery surface; student reachability
 *    rides student_results/sealed views which have no status term, plus the
 *    closed+revealed metadata view).
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

  // CSRF BEFORE the rate limiter (close-route parity): a cross-origin probe
  // must not burn the owner's reveal budget.
  const originError = checkSameOrigin(_request);
  if (originError) return originError;

  const rate = owner.userId ? rateLimit(`reveal:${owner.userId}`, REVEAL_RATE) : false;
  if (!rate) return rateLimited("Too many requests. Try again in a minute.");

  if (owner.quiz.mode !== "assessment") {
    return NextResponse.json(
      { error: "practice_always_revealed" },
      { status: 409, headers: { "content-type": "application/json" } },
    );
  }
  if (owner.quiz.status === "draft") {
    return NextResponse.json(
      { error: "quiz_not_revealable" },
      { status: 409, headers: { "content-type": "application/json" } },
    );
  }

  // Guarded one-way-safe UPDATE (mirrors the auto-reveal flip in
  // submit_session). No status term: the `.is(null)` guard carries one-way
  // idempotency; `quiz_reveal_once` remains the trigger backstop.
  const { data, error } = await supabase
    .from("quizzes")
    .update({ results_revealed_at: new Date().toISOString() })
    .eq("id", id)
    .is("results_revealed_at", null)
    .select("id, results_revealed_at")
    .maybeSingle();

  if (error) {
    console.error("reveal quiz error:", error);
    if (error.message?.includes("reveal_once_only")) {
      // Concurrent reveal won the race; the quiz IS revealed now → idempotent.
      return NextResponse.json(
        { revealed: true, already: true },
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return internalError("Could not reveal the results right now.");
  }

  // 0 rows (already revealed) → idempotent success.
  return NextResponse.json(
    { revealed: true, already: !data },
    { status: 200, headers: { "content-type": "application/json" } },
  );
}