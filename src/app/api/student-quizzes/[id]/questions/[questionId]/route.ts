import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireStudentQuizOwner } from "@/lib/student-quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { QuestionInputSchema } from "@/lib/quizzes/validation";
import { rateLimit } from "@/lib/classes/rate-limit";
import {
  checkSameOrigin,
  firstIssueMessage,
  internalError,
  invalidBody,
  invalidJson,
  notFound,
  payloadTooLarge,
  rateLimited,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; questionId: string }> };

const BODY_LIMIT_BYTES = 64 * 1024;
const EDIT_RATE = { limit: 60, windowMs: 60 * 60 * 1000 };

/**
 * PATCH /api/student-quizzes/[id]/questions/[questionId] — edit one question.
 * Always editable (practice content has no lock state). The explicit
 * quiz_id + created_by-scoped guard runs first so foreign ids are a clean
 * no-oracle 404 before any write.
 */
export async function PATCH(request: Request, { params }: Params) {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const lenHeader = request.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > BODY_LIMIT_BYTES) {
    return payloadTooLarge("Request body too large.");
  }

  const supabase = await createClient();
  const { id, questionId } = await params;
  if (!isUuid(id) || !isUuid(questionId)) return notFound();

  const owner = await requireStudentQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;

  if (!rateLimit(`sq-edit:${owner.userId}`, EDIT_RATE)) {
    return rateLimited("Too many question updates. Try again later.");
  }

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

  const { type, prompt, options, correctIndex, explanation } = parsed.data;

  const { data, error } = await supabase
    .from("student_quiz_questions")
    .update({
      type,
      prompt,
      options,
      correct_index: correctIndex,
      explanation: explanation ?? null,
    })
    .eq("id", questionId)
    .eq("quiz_id", id)
    .select(
      "id, quiz_id, order_index, type, prompt, options, correct_index, explanation",
    )
    .maybeSingle();

  if (error) {
    const msg = error.message ?? "";
    console.error("Update student question error:", error);
    if (
      msg.includes("duplicate_options") ||
      msg.includes("empty_option") ||
      msg.includes("option_too_long") ||
      msg.includes("explanation_too_long") ||
      msg.includes("violates check constraint")
    ) {
      return invalidBody(
        "The question data is invalid. Check options are distinct and within limits.",
      );
    }
    return internalError("Could not update the question right now.");
  }

  if (!data) return notFound();

  return NextResponse.json({ question: data });
}

/**
 * DELETE /api/student-quizzes/[id]/questions/[questionId] — remove one question.
 */
export async function DELETE(request: Request, { params }: Params) {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const supabase = await createClient();
  const { id, questionId } = await params;
  if (!isUuid(id) || !isUuid(questionId)) return notFound();

  const owner = await requireStudentQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;

  if (!rateLimit(`sq-edit:${owner.userId}`, EDIT_RATE)) {
    return rateLimited("Too many question updates. Try again later.");
  }

  const { data, error } = await supabase
    .from("student_quiz_questions")
    .delete()
    .eq("id", questionId)
    .eq("quiz_id", id)
    .select("id");

  if (error) {
    console.error("Delete student question error:", error);
    return internalError("Could not delete the question right now.");
  }

  if (!data || data.length === 0) return notFound();

  return NextResponse.json({ ok: true });
}
