import { NextResponse } from "next/server";
import { z } from "zod";
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
  unprocessable,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Per-lecturer authoring budget — the import dialog replaces N single-add
// calls with ONE batch, so it shares the quiz-author budget's ceiling.
const IMPORT_RATE = { limit: 120, windowMs: 60 * 60 * 1000 };

// 30 rows × (2000-char prompt + 5×500-char options) ≈ 78 KB of legit JSON,
// comfortably above the 64 KiB default — same override generate-quiz uses.
const IMPORT_BODY_LIMIT_BYTES = 512 * 1024;

const QUIZ_QUESTION_CAP = 30;

/** One parsed question row as the bulk RPC expects it (snake_case jsonb). */
interface ImportRow {
  type: string;
  prompt: string;
  options: string[];
  correct_index: number;
  explanation: string | null;
}

const ImportSchema = z.object({
  questions: z
    .array(QuestionInputSchema)
    .min(1, "Import must include at least one question.")
    .max(QUIZ_QUESTION_CAP, "A single import cannot exceed 30 questions."),
});

/**
 * POST /api/quizzes/[id]/import-questions — bulk-append parsed questions to
 * a DRAFT quiz (AP-1, PLAN_R_AUTHORING_PRODUCTIVITY).
 *
 * The client parses pipe-separated text into rows and previews them; this
 * route re-validates every row through the same QuestionInputSchema the
 * single-add path uses, then hands the batch to the EXISTING
 * save_quiz_questions RPC in append mode — no second writer. Title/source
 * args are NULL on purpose: 0025's append branch only touches the quizzes
 * row's provenance fields for non-NULL args, so an import can never pollute
 * the quiz's AI-source metadata.
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

  // CSRF: reject cross-origin imports (questions-route precedent).
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`quiz-import:${owner.userId}`, IMPORT_RATE)) {
    return rateLimited("Too many imports. Try again later.");
  }

  const sizeError = checkBodyLimit(request, IMPORT_BODY_LIMIT_BYTES);
  if (sizeError) return sizeError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = ImportSchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid import payload."));
  }

  // Head-count for a friendly remaining-capacity message. The RPC's own cap
  // check (behind its advisory lock) stays authoritative — this pre-check
  // just avoids the generic RPC error for the common over-paste case.
  const { count: existingCount, error: countError } = await supabase
    .from("questions")
    .select("*", { count: "exact", head: true })
    .eq("quiz_id", id);
  if (countError) {
    console.error("Import head-count error:", countError);
    return internalError("Could not check existing quiz questions.");
  }
  const current = existingCount ?? 0;
  if (current >= QUIZ_QUESTION_CAP) {
    return unprocessable(
      "This quiz already has the maximum limit of 30 questions.",
      "quiz_question_limit_exceeded",
    );
  }
  const maxAppendable = QUIZ_QUESTION_CAP - current;
  if (parsed.data.questions.length > maxAppendable) {
    return invalidBody(
      `Cannot import ${parsed.data.questions.length} questions. Only ${maxAppendable} more can be added to reach the 30-question limit.`,
    );
  }

  // camelCase wire → snake_case jsonb rows. save_quiz_questions reads
  // `correct_index` (0025:120) and raises invalid_question_fields on the
  // camelCase shape — the aiQuizToRows mapping is load-bearing here too.
  const rows: ImportRow[] = parsed.data.questions.map((q) => ({
    type: q.type,
    prompt: q.prompt,
    options: q.options,
    correct_index: q.correctIndex,
    explanation: q.explanation ?? null,
  }));

  const { error: rpcError } = await supabase.rpc("save_quiz_questions", {
    p_quiz_id: id,
    p_title: null,
    p_source_file_url: null,
    p_source_text: null,
    p_questions: rows,
    p_mode: "append",
  } as never);

  if (rpcError) {
    const msg = rpcError.message ?? "";
    console.error("Import save_quiz_questions error:", rpcError);
    // Structure mirrors generate-quiz's mapping with import-appropriate
    // copy. The invalid_* / not_authenticated arms are unreachable when
    // this route is correct (hardcoded 'append', NULL provenance args,
    // Zod-validated rows); the check-constraint arm maps to 400 exactly
    // like the sibling questions route (drift insurance, not a 503).
    if (msg.includes("not_owner") || msg.includes("not_quiz_owner") || msg.includes("quiz_not_found")) {
      return notFound();
    }
    if (msg.includes("quiz_not_draft") || msg.includes("questions_locked_quiz_not_draft")) {
      return notDraft();
    }
    if (msg.includes("quiz_question_limit_exceeded")) {
      return unprocessable(
        "Importing these questions exceeds the maximum limit of 30 questions per quiz.",
        "quiz_question_limit_exceeded",
      );
    }
    if (
      msg.includes("violates check constraint") ||
      msg.includes("duplicate_options") ||
      msg.includes("empty_option") ||
      msg.includes("option_too_long") ||
      msg.includes("explanation_too_long")
    ) {
      return invalidBody(
        "The imported questions failed validation. Check options are distinct and within limits.",
      );
    }
    return internalError("Could not import the questions right now.");
  }

  return NextResponse.json({ added: rows.length }, { status: 200 });
}
