import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireQuizOwner } from "@/lib/quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { QuestionInputSchema } from "@/lib/quizzes/validation";
import {
  checkBodyLimit,
  checkSameOrigin,
  firstIssueMessage,
  internalError,
  invalidBody,
  invalidJson,
  notDraft,
  notFound,
  rateLimited,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Per-lecturer authoring budget (student-surface parity; abuse bound).
const AUTHOR_RATE = { limit: 120, windowMs: 60 * 60 * 1000 };

/**
 * POST /api/quizzes/[id]/questions — add a question to a DRAFT quiz.
 * `order_index` is computed atomically inside the append_question RPC (per-quiz
 * advisory lock), so concurrent adds can never produce duplicates.
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

  // CSRF: reject cross-origin question adds (AI/session-route precedent).
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`quiz-author:${owner.userId}`, AUTHOR_RATE)) {
    return rateLimited("Too many edits. Try again later.");
  }

  const sizeError = checkBodyLimit(request);
  if (sizeError) return sizeError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = QuestionInputSchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid question data."));
  }

  const { type, prompt, options, correctIndex, correctIndices, explanation } = parsed.data;

  const { data: question, error } = await supabase.rpc("append_question", {
    p_quiz_id: id,
    p_type: type,
    p_prompt: prompt,
    p_options: options,
    // Multi-select rows (QT-1) carry the answer key in correctIndices and
    // leave the scalar NULL; single-answer types are the reverse. Zod's
    // superRefine enforces the strictly-symmetric shape. Undefined keys are
    // dropped by supabase-js and the RPC's default-null params apply.
    p_correct_index: correctIndex,
    p_correct_indices: correctIndices,
    // The RPC normalizes "" → NULL (NULLIF), so passing a non-null string keeps
    // the generated RPC arg type happy and the DB semantics identical.
    p_explanation: explanation ?? "",
  });

  if (error) {
    const msg = error.message ?? "";
    console.error("Add question error:", error);
    if (msg.includes("not_owner") || msg.includes("quiz_not_found")) {
      return notFound();
    }
    if (msg.includes("questions_locked_quiz_not_draft")) return notDraft();
    if (
      msg.includes("duplicate_options") ||
      msg.includes("empty_option") ||
      msg.includes("option_too_long") ||
      msg.includes("explanation_too_long") ||
      msg.includes("invalid_correct_indices") ||
      // Table CHECK-constraint violations (e.g. true_false with 3 options,
      // correct_index out of range, prompt too long) surface as generic
      // "violates check constraint" messages — map to 400, not 503.
      msg.includes("violates check constraint")
    ) {
      return invalidBody(
        "The question data is invalid. Check options are distinct and within limits.",
      );
    }
    return internalError("Could not add the question right now.");
  }

  return NextResponse.json({ question }, { status: 201 });
}
