import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { tryCreateAdminClient } from "@/lib/supabase/admin";
import { requireStudentQuizOwner } from "@/lib/student-quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { StudentQuestionInputSchema } from "@/lib/quizzes/validation";
import { rateLimit } from "@/lib/classes/rate-limit";
import { QUESTION_IMAGES_BUCKET, isOwnedQuestionImagePath } from "@/lib/media/validation";
import { removeStorageObjects } from "@/lib/media/cleanup";
import {
  checkSameOrigin,
  firstIssueMessage,
  internalError,
  invalidBody,
  notFound,
  rateLimited,
  readCappedJson,
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

  const supabase = await createClient();
  const { id, questionId } = await params;
  if (!isUuid(id) || !isUuid(questionId)) return notFound();

  const owner = await requireStudentQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;

  if (!rateLimit(`sq-edit:${owner.userId}`, EDIT_RATE)) {
    return rateLimited("Too many question updates. Try again later.");
  }

  const body = await readCappedJson(request, BODY_LIMIT_BYTES);
  if (!body.ok) return body.response;

  // Strict single-answer schema: multi-select is lecturer-quiz only (the
  // student_quiz_questions table carries a CHECK rejecting the type) — the
  // boundary 400s here instead of dying on the direct UPDATE as a 500.
  const parsed = StudentQuestionInputSchema.safeParse(body.data);
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
 *
 * audit-3 G-F3: mirrors the lecturer twin (quizzes/[id]/questions/[questionId]
 * /route.ts:173-177) by eagerly removing the question's image object instead of
 * orphaning it until the (unscheduled) media-cleanup cron runs.
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

  // Read the image reference BEFORE the delete (the row is gone after it).
  const { data: existing } = await supabase
    .from("student_quiz_questions")
    .select("id, image_path")
    .eq("id", questionId)
    .eq("quiz_id", id)
    .maybeSingle();

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

  const imagePath = (existing as { image_path: string | null } | null)?.image_path ?? null;
  if (imagePath) {
    if (isOwnedQuestionImagePath(imagePath, owner.userId)) {
      // Best-effort: a missing service-role key degrades to a cron-swept
      // orphan, never a 500 on an already-committed delete.
      const admin = tryCreateAdminClient();
      if (admin) await removeStorageObjects(admin, QUESTION_IMAGES_BUCKET, [imagePath]);
    } else {
      console.error("student question delete: refusing malformed image_path", {
        quizId: id,
        questionId,
      });
    }
  }

  return NextResponse.json({ ok: true });
}
