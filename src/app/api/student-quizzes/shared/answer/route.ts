import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAnyUser } from "@/lib/student-quizzes/guards";
import { rateLimit } from "@/lib/classes/rate-limit";
import {
  checkSameOrigin,
  firstIssueMessage,
  internalError,
  invalidBody,
  invalidJson,
  rateLimited,
} from "@/lib/http";

export const dynamic = "force-dynamic";

const BODY_LIMIT_BYTES = 64 * 1024;
const ANSWER_RATE = { limit: 60, windowMs: 60 * 1000 };

// NULL selections are rejected HERE (not just in the RPC) so a keyless probe
// can never be confused with a real answer — the reveal requires an actual pick.
// Upper bound = PG int4 ceiling so out-of-options values fold server-side into
// the no-oracle `unavailable` shape instead of erroring as integer-overflow.
const AnswerSchema = z.object({
  questionId: z.string().uuid("Invalid question."),
  selectedIndex: z
    .number({ message: "Select an answer first." })
    .int("Select an answer first.")
    .min(0, "Select an answer first.")
    .max(2_147_483_647, "Select an answer first."),
});

/**
 * POST /api/student-quizzes/shared/answer — grade ONE answer (stateless play).
 *
 * Authz: any authenticated user (D-SQ6). Grading is delegated ENTIRELY to the
 * answer_student_question RPC, which re-checks shared-or-creator and
 * bounds-checks the selection in a single snapshot; any miss folds into its
 * no-oracle {error:'unavailable'}, surfaced here as a uniform 404. Performs
 * zero writes anywhere.
 */
export async function POST(request: Request) {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const lenHeader = request.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > BODY_LIMIT_BYTES) {
    return NextResponse.json(
      { error: "payload_too_large", message: "Request body too large." },
      { status: 413 },
    );
  }

  const supabase = await createClient();

  const auth = await requireAnyUser(supabase);
  if (!auth.ok) return auth.response;

  if (!rateLimit(`sq-answer:${auth.userId}`, ANSWER_RATE)) {
    return rateLimited("Too many answers. Slow down a little.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = AnswerSchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Select an answer first."));
  }

  const { data, error } = await supabase.rpc("answer_student_question", {
    p_question_id: parsed.data.questionId,
    p_selected_index: parsed.data.selectedIndex,
  });

  if (error) {
    console.error("Grade student answer error:", error);
    return internalError("Could not check that answer right now.");
  }

  if (
    !data ||
    typeof data === "object" &&
      "error" in (data as Record<string, unknown>)
  ) {
    // Deleted / unshared / foreign / out-of-bounds — one indistinguishable shape.
    return NextResponse.json(
      { error: "unavailable", message: "This practice quiz is no longer available." },
      { status: 404 },
    );
  }

  return NextResponse.json(data);
}
