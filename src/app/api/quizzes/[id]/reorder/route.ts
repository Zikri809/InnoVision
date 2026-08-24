import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireQuizOwner } from "@/lib/quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { ReorderSchema } from "@/lib/quizzes/validation";
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

// Per-lecturer authoring budget (student-surface parity; abuse bound).
const REORDER_RATE = { limit: 60, windowMs: 60 * 60 * 1000 };

/**
 * POST /api/quizzes/[id]/reorder — atomically renumber questions via the
 * security-definer `reorder_questions` RPC. Draft-only. The RPC validates the
 * exact id set (count + membership + uniqueness) so a stale client payload
 * can't corrupt the order or touch another quiz's questions.
 *
 * RPC typed errors → HTTP:
 *   not_owner / quiz_not_found      → 404
 *   id_count_mismatch               → 400
 *   foreign_question_id             → 400
 *   questions_locked_quiz_not_draft → 409
 */
export async function POST(request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) {
    return notFound();
  }

  const owner = await requireQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;
  if (owner.quiz.status !== "draft") return notDraft();

  // CSRF: reject cross-origin reorders (AI/session-route precedent).
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`quiz-author:${owner.userId}`, REORDER_RATE)) {
    return jsonError("rate_limited", "Too many edits. Try again later.", 429);
  }

  const sizeError = checkBodyLimit(request);
  if (sizeError) return sizeError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = ReorderSchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid reorder payload."));
  }

  const { questionIds } = parsed.data;

  const { error } = await supabase.rpc("reorder_questions", {
    p_quiz_id: id,
    p_ordered_ids: questionIds,
  });

  if (error) {
    const msg = error.message ?? "";
    console.error("Reorder error:", error);
    if (msg.includes("not_owner") || msg.includes("quiz_not_found")) {
      return notFound();
    }
    if (msg.includes("id_count_mismatch") || msg.includes("foreign_question_id")) {
      return invalidBody("The question list does not match the quiz. Refresh and try again.");
    }
    if (msg.includes("questions_locked_quiz_not_draft")) return notDraft();
    return internalError("Could not reorder the questions right now.");
  }

  return NextResponse.json({ ok: true });
}
