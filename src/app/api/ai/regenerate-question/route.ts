import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireLecturer } from "@/lib/classes/guards";
import { requireQuizOwner } from "@/lib/quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { RegenerateQuestionSchema } from "@/lib/ai/validation";
import { createAiClient, chatCompletions, AI_MODEL } from "@/lib/ai/client";
import { regenerateQuestion } from "@/lib/ai/quiz-prompt";
import { normalizeOptions, type AiQuestion } from "@/lib/ai/quiz-schema";
import {
  firstIssueMessage,
  internalError,
  invalidBody,
  invalidJson,
  notDraft,
  notFound,
  rateLimited,
  unprocessable,
} from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const REGENERATE_RATE = { limit: 20, windowMs: 60 * 60 * 1000 };

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/ai/regenerate-question — rewrite ONE question on a DRAFT quiz.
 *
 * Input: { questionId, instruction? } (no quizId in the body — the route
 * derives it from the question row, which is user-scoped via RLS).
 *
 * Airtight sequence (S3):
 *  1. requireLecturer.
 *  2. Fetch the question via the USER-SCOPED anon client (RLS denies
 *     non-owners → 404, no oracle).
 *  3. requireQuizOwner(quiz_id) → 404 for non-owner lecturers.
 *  4. Draft check → 409.
 *  5. Rate limit.
 *  6. AI call (45s timeout).
 *  7. Only on success: quiz-scoped UPDATE (WHERE id AND quiz_id) — failure
 *     leaves the original untouched (I17).
 */
export async function POST(request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) return notFound();

  // 1. requireLecturer FIRST (a student must get 403, not a 404 from the RLS
  //    question fetch — the no-oracle guarantee applies to non-owner LECTURERS,
  //    not to wrong-role callers).
  const auth = await requireLecturer(supabase);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = RegenerateQuestionSchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid regenerate payload."));
  }
  const { questionId, instruction } = parsed.data;

  // 2. Fetch the question user-scoped (RLS: lecturer-of-quiz only).
  const { data: questionRow, error: qErr } = await supabase
    .from("questions")
    .select("id, quiz_id, order_index, type, prompt, options, correct_index, explanation")
    .eq("id", questionId)
    .maybeSingle();

  if (qErr) {
    console.error("Question fetch error:", qErr);
    return internalError("Could not load the question right now.");
  }
  if (!questionRow) return notFound();

  // 3-4. Owner + draft.
  const owner = await requireQuizOwner(supabase, questionRow.quiz_id);
  if (!owner.ok) return owner.response;
  if (owner.quiz.status !== "draft") return notDraft();

  // 5. Rate limit.
  if (!rateLimit(`aiRegenerate:${owner.userId}`, REGENERATE_RATE)) {
    return rateLimited("Too many regenerations. Try again in an hour.");
  }

  // Load siblings for coherence (excluding the target).
  const { data: siblingRows, error: sibErr } = await supabase
    .from("questions")
    .select("id, quiz_id, order_index, type, prompt, options, correct_index, explanation")
    .eq("quiz_id", questionRow.quiz_id)
    .neq("id", questionId)
    .order("order_index", { ascending: true });

  if (sibErr) {
    console.error("Siblings fetch error:", sibErr);
    return internalError("Could not load the question list right now.");
  }

  const toAi = (r: typeof questionRow): AiQuestion => ({
    type: r.type,
    prompt: r.prompt,
    options: r.options,
    correct_index: r.correct_index,
    explanation: r.explanation ?? undefined,
  });
  const target = toAi(questionRow);
  const siblings = (siblingRows ?? []).map(toAi);

  // 6. AI call.
  const ai = createAiClient();
  const result = await regenerateQuestion({
    chat: (messages) =>
      chatCompletions({ client: ai, model: AI_MODEL, messages }).then((r) => r),
    question: target,
    siblings,
    instruction,
  });

  if (!result.ok) {
    if (result.error === "timeout") {
      return internalError("The AI request timed out. Please try again.");
    }
    if (result.error === "ai_unavailable") {
      return unprocessable("The AI service is unavailable right now. Try again later.", "ai_unavailable");
    }
    return unprocessable(
      "The AI did not return a valid question. Try again.",
      "invalid_ai_output",
    );
  }

  // Normalize options + remap correct_index before writing (U-A8/I-A8).
  const q = result.question;
  const normalized = normalizeOptions(q.options, q.correct_index);
  if (!normalized) {
    return unprocessable("The regenerated question lost its correct answer. Try again.", "invalid_ai_output");
  }

  // 7. Quiz-scoped UPDATE (WHERE id AND quiz_id); trigger error → 409.
  const { data: updated, error: updErr } = await supabase
    .from("questions")
    .update({
      type: q.type,
      prompt: q.prompt,
      options: normalized.options,
      correct_index: normalized.correct_index,
      explanation: q.explanation ?? null,
    })
    .eq("id", questionId)
    .eq("quiz_id", questionRow.quiz_id)
    .select("id, quiz_id, order_index, type, prompt, options, correct_index, explanation")
    .single();

  if (updErr) {
    const msg = updErr.message ?? "";
    console.error("Regenerate update error:", updErr);
    if (msg.includes("questions_locked_quiz_not_draft")) return notDraft();
    if (msg.includes("violates check constraint") || msg.includes("duplicate_options")) {
      return unprocessable("The regenerated question failed validation. Try again.", "invalid_ai_output");
    }
    return internalError("Could not save the regenerated question right now.");
  }
  if (!updated) return notFound();

  return NextResponse.json({ question: updated });
}
