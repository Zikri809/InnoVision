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

type Params = { params: Promise<{ id: string }> };

const BODY_LIMIT_BYTES = 64 * 1024;
const APPEND_RATE = { limit: 60, windowMs: 60 * 60 * 1000 };
const QUESTION_CAP = 50;

/**
 * POST /api/student-quizzes/[id]/questions — add a question. `order_index` is
 * computed atomically inside the append_student_question RPC (per-quiz advisory
 * lock, same key as the DB-side 50-question cap trigger → no oversubscription).
 */
export async function POST(request: Request, { params }: Params) {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const lenHeader = request.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > BODY_LIMIT_BYTES) {
    return payloadTooLarge("Request body too large.");
  }

  const supabase = await createClient();
  const { id } = await params;
  if (!isUuid(id)) return notFound();

  const owner = await requireStudentQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;

  if (!rateLimit(`sq-append:${owner.userId}`, APPEND_RATE)) {
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

  const { data: question, error } = await supabase.rpc("append_student_question", {
    p_quiz_id: id,
    p_type: type,
    p_prompt: prompt,
    p_options: options,
    p_correct_index: correctIndex,
    // The RPC normalizes "" → NULL (NULLIF), so passing a non-null string keeps
    // the generated RPC arg type happy and the DB semantics identical.
    p_explanation: explanation ?? "",
  });

  if (error) {
    const msg = error.message ?? "";
    console.error("Add student question error:", error);
    if (msg.includes("not_owner") || msg.includes("quiz_not_found")) {
      return notFound();
    }
    if (
      msg.includes("question_cap_reached") ||
      msg.includes("student_questions_cap")
    ) {
      return rateLimited(`A practice quiz can hold up to ${QUESTION_CAP} questions.`);
    }
    if (
      msg.includes("duplicate_options") ||
      msg.includes("empty_option") ||
      msg.includes("option_too_long") ||
      msg.includes("explanation_too_long") ||
      // Table CHECK-constraint violations (e.g. true_false with 3 options)
      // surface as generic "violates check constraint" messages — map to 400.
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
