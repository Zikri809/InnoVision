import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireStudentQuizOwner } from "@/lib/student-quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { ReorderSchema } from "@/lib/quizzes/validation";
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
const REORDER_RATE = { limit: 30, windowMs: 60 * 60 * 1000 };

/**
 * POST /api/student-quizzes/[id]/reorder — atomically renumber questions to
 * the exact given order via the reorder_student_questions RPC (validates the
 * full id set: no foreign ids, duplicates, or count drift).
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

  if (!rateLimit(`sq-reorder:${owner.userId}`, REORDER_RATE)) {
    return rateLimited("Too many reorder requests. Try again later.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = ReorderSchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid reorder data."));
  }

  const { error } = await supabase.rpc("reorder_student_questions", {
    p_quiz_id: id,
    p_ordered_ids: parsed.data.questionIds,
  });

  if (error) {
    const msg = error.message ?? "";
    console.error("Reorder student questions error:", error);
    if (
      msg.includes("not_owner") ||
      msg.includes("quiz_not_found") ||
      msg.includes("foreign_question_id") ||
      msg.includes("id_count_mismatch")
    ) {
      return notFound();
    }
    return internalError("Could not reorder the questions right now.");
  }

  return NextResponse.json({ ok: true });
}
