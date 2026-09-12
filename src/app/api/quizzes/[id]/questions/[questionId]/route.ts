import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { QUESTION_IMAGES_BUCKET, isOwnedQuestionImagePath } from "@/lib/media/validation";
import { requireQuizOwner } from "@/lib/quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { QuestionInputSchema } from "@/lib/quizzes/validation";
import {
  checkSameOrigin,
  firstIssueMessage,
  internalError,
  invalidBody,
  jsonError,
  notDraft,
  notFound,
  readCappedJson,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; questionId: string }> };

// Per-lecturer authoring budget (student-surface parity; abuse bound).
const AUTHOR_RATE = { limit: 120, windowMs: 60 * 60 * 1000 };

/**
 * PATCH /api/quizzes/[id]/questions/[questionId] — replace a question on a
 * DRAFT quiz. The body is the FULL question shape (no partial — the builder
 * always sends the whole edited question, which keeps options/correctIndex
 * consistent in one write).
 */
export async function PATCH(request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id, questionId } = await params;

  if (!isUuid(id) || !isUuid(questionId)) {
    return notFound();
  }

  const owner = await requireQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;
  if (owner.quiz.status !== "draft") return notDraft();

  // CSRF: reject cross-origin question edits (AI/session-route precedent).
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`quiz-author:${owner.userId}`, AUTHOR_RATE)) {
    return jsonError("rate_limited", "Too many edits. Try again later.", 429);
  }

  // The question must belong to this quiz (no cross-quiz moves).
  const { data: existing, error: existingError } = await supabase
    .from("questions")
    .select("id")
    .eq("id", questionId)
    .eq("quiz_id", id)
    .maybeSingle();
  if (existingError) {
    console.error("Question lookup error:", existingError);
    return internalError("Could not update the question right now.");
  }
  if (!existing) {
    return notFound();
  }

  const body = await readCappedJson(request);
  if (!body.ok) return body.response;

  const parsed = QuestionInputSchema.safeParse(body.data);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid question data."));
  }

  const { type, prompt, options, correctIndex, correctIndices, explanation } = parsed.data;

  // Normalize "" → NULL to match append_question's NULLIF behavior, so both
  // write paths store the same representation for a cleared explanation.
  const explanationValue = explanation ? explanation : null;

  // Multi-select rows (QT-1) carry the answer key in correctIndices and null
  // the scalar; single-answer types are the reverse. Zod's superRefine
  // enforces the strictly-symmetric shape.
  const { data: question, error } = await supabase
    .from("questions")
    .update({
      type,
      prompt,
      options,
      correct_index: correctIndex ?? null,
      correct_indices: correctIndices ?? null,
      explanation: explanationValue,
    })
    .eq("id", questionId)
    .eq("quiz_id", id)
    .select("id, quiz_id, order_index, type, prompt, options, correct_index, correct_indices, explanation, created_at")
    // maybeSingle (not single): a concurrent DELETE between the pre-check and
    // this UPDATE must surface as a clean 404, not a PGRST116 → 503.
    .maybeSingle();

  if (error) {
    console.error("Update question error:", error);
    // A concurrent publish can flip the quiz live between our draft pre-check
    // and the UPDATE; the DB trigger then raises questions_locked_quiz_not_draft.
    // Map that to a clean 409 business rule, not a 503 outage.
    if (error.message?.includes("questions_locked_quiz_not_draft")) return notDraft();
    if (
      error.message?.includes("violates check constraint") ||
      error.message?.includes("invalid_correct_indices")
    ) {
      return invalidBody("The question data is invalid. Check options are distinct and within limits.");
    }
    return internalError("Could not update the question right now.");
  }
  if (!question) {
    return notFound();
  }

  return NextResponse.json({ question });
}

/**
 * DELETE /api/quizzes/[id]/questions/[questionId] — remove a question from a
 * DRAFT quiz. Order gaps are tolerated (soft ordinal).
 */
export async function DELETE(request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id, questionId } = await params;

  if (!isUuid(id) || !isUuid(questionId)) {
    return notFound();
  }

  const owner = await requireQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;
  if (owner.quiz.status !== "draft") return notDraft();

  // CSRF: reject cross-origin question deletes (AI/session-route precedent).
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`quiz-author:${owner.userId}`, AUTHOR_RATE)) {
    return jsonError("rate_limited", "Too many edits. Try again later.", 429);
  }

  const { data: deleted, error } = await supabase
    .from("questions")
    .delete()
    .eq("id", questionId)
    .eq("quiz_id", id)
    .select("id, image_path")
    .maybeSingle();

  if (error) {
    console.error("Delete question error:", error);
    if (error.message?.includes("questions_locked_quiz_not_draft")) return notDraft();
    return internalError("Could not delete the question right now.");
  }
  if (!deleted) {
    return notFound();
  }

  // audit-1 P1-15: the row is gone — its image object must not linger as a
  // permanent orphan. Read from the DELETED row (delete-first keeps the
  // failure mode a swept orphan, never a dangling pointer).
  const imagePath = (deleted as { image_path: string | null }).image_path;
  if (imagePath) {
    // audit-2 C-03: owner-pinned shape gate before the service-role remove —
    // the column is caller-writable at the DB layer, so a poisoned path must
    // fail closed (skip + log; 0046's CHECK/trigger backstop now makes the
    // poison unreachable for NEW writes anyway).
    if (isOwnedQuestionImagePath(imagePath, owner.userId)) {
      void createAdminClient()
        .storage.from(QUESTION_IMAGES_BUCKET)
        .remove([imagePath])
        .catch(() => {});
    } else {
      console.error("question delete: refusing malformed image_path", { quizId: id, questionId });
    }
  }

  return NextResponse.json({ ok: true });
}
