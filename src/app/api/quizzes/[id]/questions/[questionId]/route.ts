import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { QUESTION_IMAGES_BUCKET, isOwnedQuestionImagePath } from "@/lib/media/validation";
import { removeStorageObjects } from "@/lib/media/cleanup";
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

// Per-lecturer authoring budget. audit-4 M7: the spec pins AUTHOR at 30/min
// (the pre-v4.9 120/hour was a spec-letter deviation — 15× stricter
// sustained, but 4× burst-looser). 30/min still lets a lecturer paste a
// full 30-question quiz in one sitting.
const AUTHOR_RATE = { limit: 30, windowMs: 60 * 1000 };

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

  // The question must belong to this quiz (no cross-quiz moves). Reads go
  // through `lecturer_questions_view`: 0054 revoked the key columns from
  // `authenticated`, so the base table is no longer readable here.
  const { data: existing, error: existingError } = await supabase
    .from("lecturer_questions_view")
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

  const { type, prompt, options, correctIndex, correctIndices, answerKey, explanation } =
    parsed.data;

  // Normalize "" → NULL to match append_question's NULLIF behavior, so both
  // write paths store the same representation for a cleared explanation.
  const explanationValue = explanation ? explanation : null;

  // Multi-select rows (QT-1) carry the answer key in correctIndices and null
  // the scalar; single-answer types are the reverse. Zod's superRefine
  // enforces the strictly-symmetric shape. `type` is written too: an edit that
  // switches a row INTO short_text must land the new type in the same UPDATE
  // as its rubric (the DB CHECK rejects the row otherwise).
  // 0054 revoked `questions` from `authenticated`, so a user-scoped write
  // fails 42501. The admin client is the documented fix for lecturer-only
  // question routes: ownership is already proved above, and the statement
  // stays scoped by id AND quiz_id.
  const { data: question, error } = await createAdminClient()
    .from("questions")
    .update({
      type,
      prompt,
      options,
      correct_index: correctIndex ?? null,
      correct_indices: correctIndices ?? null,
      answer_key: answerKey ?? null,
      explanation: explanationValue,
    })
    .eq("id", questionId)
    .eq("quiz_id", id)
    // RETURNING runs on the base table (the view is read-only); the route
    // re-reads through `lecturer_questions_view` below so the caller sees the
    // same projection as every other lecturer read.
    .select("id")
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

  const { data: row, error: readError } = await supabase
    .from("lecturer_questions_view")
    .select(
      "id, quiz_id, order_index, type, prompt, options, correct_index, correct_indices, answer_key, max_score, explanation, image_path, created_at",
    )
    .eq("id", questionId)
    .eq("quiz_id", id)
    .maybeSingle();

  if (readError) {
    // The write COMMITTED — the caller must not "retry" (it would re-apply an
    // identical UPDATE). Surface a 503 and let the builder refresh instead.
    console.error("Question readback error:", readError);
    return internalError("Could not update the question right now.");
  }

  return NextResponse.json({ question: row });
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

  // audit-1 P1-15: the row is gone — its image object must not linger as a
  // permanent orphan. The path is read BEFORE the delete because 0054 revoked
  // `image_path` from `authenticated`, so a DELETE ... RETURNING of it would
  // 403; reading through `lecturer_questions_view` also doubles as the
  // existence/ownership check (a foreign or missing id yields no row → 404).
  const { data: existing, error: existingError } = await supabase
    .from("lecturer_questions_view")
    .select("id, image_path")
    .eq("id", questionId)
    .eq("quiz_id", id)
    .maybeSingle();
  if (existingError) {
    console.error("Question lookup error:", existingError);
    return internalError("Could not delete the question right now.");
  }
  if (!existing) {
    return notFound();
  }

  const { data: deleted, error } = await createAdminClient()
    .from("questions")
    .delete()
    .eq("id", questionId)
    .eq("quiz_id", id)
    .select("id")
    // maybeSingle (not single): a concurrent DELETE must surface as a clean
    // 404, not a PGRST116 → 503.
    .maybeSingle();

  if (error) {
    console.error("Delete question error:", error);
    if (error.message?.includes("questions_locked_quiz_not_draft")) return notDraft();
    return internalError("Could not delete the question right now.");
  }
  if (!deleted) {
    return notFound();
  }

  const imagePath = existing.image_path;
  if (imagePath) {
    // audit-2 C-03: owner-pinned shape gate before the service-role remove —
    // the column is caller-writable at the DB layer, so a poisoned path must
    // fail closed (skip + log; 0046's CHECK/trigger backstop now makes the
    // poison unreachable for NEW writes anyway).
    if (isOwnedQuestionImagePath(imagePath, owner.userId)) {
      void removeStorageObjects(createAdminClient(), QUESTION_IMAGES_BUCKET, [imagePath]);
    } else {
      console.error("question delete: refusing malformed image_path", { quizId: id, questionId });
    }
  }

  return NextResponse.json({ ok: true });
}
