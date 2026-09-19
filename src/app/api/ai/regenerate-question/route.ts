import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireLecturer } from "@/lib/classes/guards";
import { requireQuizOwner } from "@/lib/quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { RegenerateQuestionSchema } from "@/lib/ai/validation";
import { createAiClient, chatCompletions, AI_MODEL } from "@/lib/ai/client";
import { regenerateQuestion } from "@/lib/ai/quiz-prompt";
import { normalizeOptions, GENERATION_BUDGET_MS, type AiQuestion } from "@/lib/ai/quiz-schema";
import {
  firstIssueMessage,
  internalError,
  invalidBody,
  jsonError,
  notDraft,
  notFound,
  rateLimited,
  readCappedJson,
  checkSameOrigin,
  timeout,
  unprocessable,
} from "@/lib/http";

export const dynamic = "force-dynamic";
// Local-only deployment — no Vercel 60s function cap (see generate-quiz).
// export const maxDuration = 60; // (removed for local runs)

const REGENERATE_RATE = { limit: 20, windowMs: 60 * 60 * 1000 };

const inFlight = new Set<string>();

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
 *  5. Rate limit & In-flight check.
 *  6. AI call (45s timeout).
 *  7. Only on success: quiz-scoped UPDATE (WHERE id AND quiz_id) — failure
 *     leaves the original untouched (I17).
 */
export async function POST(request: Request, context?: { params?: Promise<{ id?: string }> }) {
  const supabase = await createClient();

  // The route has no URL params (questionId comes from the body). Accept the
  // optional context Next.js passes for route-handler compatibility.
  void context;

  // CSRF: reject cross-origin POSTs (mitigates the SameSite/Lax subdomain gap).
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  // 1. requireLecturer FIRST (a student must get 403, not a 404 from the RLS
  //    question fetch — the no-oracle guarantee applies to non-owner LECTURERS,
  //    not to wrong-role callers).
  const auth = await requireLecturer(supabase);
  if (!auth.ok) return auth.response;

  const body = await readCappedJson(request);
  if (!body.ok) return body.response;

  const parsed = RegenerateQuestionSchema.safeParse(body.data);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid regenerate payload."));
  }
  const { questionId, instruction } = parsed.data;

  if (!isUuid(questionId)) return notFound();

  // 2. Fetch the question with the SERVICE-ROLE client (D2-19): 0054 revoked
  //    the base table from `authenticated`, and the `is_lecturer_of_quiz`
  //    predicate this view enforces needs the quiz id we are about to read —
  //    so the row is fetched first and ownership is proven by
  //    `requireQuizOwner` on the next step.
  const admin = createAdminClient();
  const { data: questionRow, error: qErr } = await admin
    .from("questions")
    .select("id, quiz_id, order_index, type, prompt, options, correct_index, correct_indices, explanation")
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

  // In-flight guard: prevent double-spend on rapid clicks. In-process only
  // (same mechanism + single-instance caveat as generate-quiz); keyed per
  // question so unrelated questions can regenerate concurrently. Distinct
  // code (generate-route parity): "already running" ≠ quota spent.
  if (inFlight.has(questionId)) {
    return jsonError("already_running", "A regeneration for this question is already in progress.", 429);
  }
  inFlight.add(questionId);

  // audit-3 F-F1: cancellation source for this request. The client closes the
  // dialog → fetch abort → request.signal fires; the route's own controller
  // mirrors it (and gives the handler a single signal to thread into the AI
  // call and to check before the DB write). Without this the `cancelled`
  // branch below was dead code: the full LLM round trip ran to completion and
  // then overwrote the question row.
  const controller = new AbortController();
  const onClientAbort = () => controller.abort();
  request.signal.addEventListener("abort", onClientAbort);
  // `addEventListener` does NOT fire for a signal that is already aborted, so
  // mirror the current state explicitly.
  if (request.signal.aborted) controller.abort();

  try {
    return await handleRegenerate({
      supabase,
      questionId,
      questionRow,
      instruction,
      signal: controller.signal,
    });
  } finally {
    request.signal.removeEventListener("abort", onClientAbort);
    inFlight.delete(questionId);
  }
}

async function handleRegenerate(ctx: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  questionId: string;
  questionRow: {
    id: string;
    quiz_id: string;
    order_index: number;
    type: "mcq" | "true_false" | "multi_select" | "short_text";
    prompt: string;
    options: string[];
    correct_index: number | null;
    correct_indices: number[] | null;
    explanation: string | null;
  };
  instruction?: string;
  signal: AbortSignal;
}): Promise<NextResponse> {
  const { supabase, questionId, questionRow, instruction, signal } = ctx;

  // short_text (v4.9) has no arm in the AI question contract: its key is a
  // lecturer-authored rubric, and a rewrite would have to invent one. Reject
  // it here rather than feed the model an option-less row it cannot answer
  // (the builder hides the button for the type; this is the route's backstop).
  if (questionRow.type === "short_text") {
    return unprocessable(
      "Short-text questions cannot be regenerated — edit the answer key instead.",
      "unsupported_question_type",
    );
  }

  // Load siblings for coherence (excluding the target). Service-role read —
  // same D2-19 reason as the target fetch above; ownership was proven before
  // this helper is reached.
  const { data: siblingRows, error: sibErr } = await createAdminClient()
    .from("questions")
    .select("id, quiz_id, order_index, type, prompt, options, correct_index, correct_indices, explanation")
    .eq("quiz_id", questionRow.quiz_id)
    .neq("id", questionId)
    .order("order_index", { ascending: true });

  if (sibErr) {
    console.error("Siblings fetch error:", sibErr);
    return internalError("Could not load the question list right now.");
  }

  const toAi = (r: typeof questionRow): AiQuestion =>
    r.type === "multi_select"
      ? {
          type: r.type,
          prompt: r.prompt,
          options: r.options,
          // The correct SET must flow into the AI context so a keep-SAME-type
          // regen can preserve it (QT-1).
          correct_indices: r.correct_indices ?? [],
          explanation: r.explanation ?? undefined,
        }
      : {
          type: r.type as "mcq" | "true_false",
          prompt: r.prompt,
          options: r.options,
          correct_index: r.correct_index ?? 0,
          explanation: r.explanation ?? undefined,
        };
  const target = toAi(questionRow);
  // short_text siblings carry no options/correct_index, so they cannot enter
  // the AI context as questions — they are dropped rather than coerced into a
  // shape the model would then imitate.
  const siblings = (siblingRows ?? [])
    .filter((r) => r.type !== "short_text")
    .map((r) => toAi(r as typeof questionRow));

  // 6. AI call. Explicit deadline (same budget as generate-quiz) so the route
  // never silently inherits a changed default inside regenerateQuestion. The
  // request signal rides into the fetch so closing the dialog stops the spend
  // (audit-3 F-F1).
  const ai = createAiClient();
  const result = await regenerateQuestion({
    chat: (messages, timeoutMs) =>
      chatCompletions({ client: ai, model: AI_MODEL, messages, timeoutMs, signal }),
    question: target,
    siblings,
    instruction,
    deadlineMs: Date.now() + GENERATION_BUDGET_MS,
    signal,
  });

  if (!result.ok) {
    if (result.error === "cancelled") {
      // audit-2 M-21: caller abort reads as `cancelled` 409, not the retryable
      // timeout 503 (a mislabeled cancel provoked retries with fresh spend).
      return jsonError("cancelled", "Generation cancelled.", 409);
    }
    if (result.error === "timeout") {
      return timeout("The AI request timed out. Please try again.");
    }
    if (result.error === "ai_unavailable") {
      return unprocessable(
        result.message ?? "The AI service is unavailable right now. Try again later.",
        "ai_unavailable",
      );
    }
    return unprocessable(
      "The AI did not return a valid question. Try again.",
      "invalid_ai_output",
    );
  }

  // Normalize options + remap the answer key before writing (U-A8/I-A8).
  // Multi-select (QT-1) remaps the sorted+distinct correct SET; a vanished
  // correct option (duplicate collapse) fails the regen cleanly.
  const q = result.question;
  const isMulti = q.type === "multi_select";
  const normalized = normalizeOptions(
    q.options,
    isMulti ? (q.correct_indices as number[]) : (q.correct_index as number),
  );
  if (!normalized) {
    return unprocessable("The regenerated question lost its correct answer. Try again.", "invalid_ai_output");
  }

  // audit-3 F-F1: cancel checkpoint BEFORE the DB write. Even when the abort
  // raced past the AI call (the model answered as the client disconnected),
  // the question row must not be silently overwritten — the user never saw
  // the result. Mirrors generate-quiz's saveGeneration checkpoint.
  if (signal.aborted) {
    return jsonError("cancelled", "Generation cancelled.", 409);
  }

  // 7. Quiz-scoped UPDATE (WHERE id AND quiz_id); trigger error → 409.
  //
  // The ADMIN client, not the user client: 0054 revoked the answer-key
  // columns from `authenticated`, and a table-level UPDATE grant is required
  // to write at all — the user-scoped write now fails 42501 "permission
  // denied for table questions". Authorization is unchanged: this route
  // already proved ownership via `requireQuizOwner` above, and the UPDATE is
  // still scoped by BOTH id and quiz_id. The readback is admin for the same
  // reason (it selects correct_index/correct_indices).
  const admin = createAdminClient();
  const { data: updated, error: updErr } = await admin
    .from("questions")
    .update({
      type: q.type,
      prompt: q.prompt,
      options: normalized.options,
      correct_index: isMulti ? null : (normalized.correct_index ?? null),
      correct_indices: isMulti ? (normalized.correct_indices ?? null) : null,
      explanation: q.explanation ?? null,
    })
    .eq("id", questionId)
    .eq("quiz_id", questionRow.quiz_id)
    .select("id, quiz_id, order_index, type, prompt, options, correct_index, correct_indices, explanation")
    .single();

  if (updErr) {
    const msg = updErr.message ?? "";
    console.error("Regenerate update error:", updErr);
    if (msg.includes("questions_locked_quiz_not_draft")) return notDraft();
    if (
      msg.includes("violates check constraint") ||
      msg.includes("duplicate_options") ||
      msg.includes("invalid_correct_indices")
    ) {
      return unprocessable("The regenerated question failed validation. Try again.", "invalid_ai_output");
    }
    return internalError("Could not save the regenerated question right now.");
  }
  if (!updated) return notFound();

  return NextResponse.json({ question: updated });
}
