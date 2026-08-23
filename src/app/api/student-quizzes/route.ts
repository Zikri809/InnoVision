import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireStudent } from "@/lib/classes/guards";
import { CreateStudentQuizSchema } from "@/lib/student-quizzes/validation";
import { rateLimit } from "@/lib/classes/rate-limit";
import {
  checkSameOrigin,
  firstIssueMessage,
  internalError,
  invalidBody,
  invalidJson,
  payloadTooLarge,
  rateLimited,
} from "@/lib/http";

export const dynamic = "force-dynamic";

const BODY_LIMIT_BYTES = 64 * 1024;
const CREATE_RATE = { limit: 5, windowMs: 60 * 60 * 1000 };
const QUIZ_CAP = 25;

/**
 * GET /api/student-quizzes — list the caller's own quizzes with question
 * counts. Two queries total (no N+1): quizzes via the creator filter, then
 * ONE quiz_id scan over own questions reduced into counts in memory.
 */
export async function GET() {
  const supabase = await createClient();
  const auth = await requireStudent(supabase);
  if (!auth.ok) return auth.response;

  const { data: quizzes, error } = await supabase
    .from("student_quizzes")
    .select(
      "id, title, description, share_code, created_at, updated_at",
    )
    .eq("created_by", auth.userId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error("List student quizzes error:", error);
    return internalError("Could not load your quizzes right now.");
  }

  const rows = quizzes ?? [];
  const ids = rows.map((q) => q.id);

  let counts = new Map<string, number>();
  if (ids.length > 0) {
    const { data: qrows, error: qerr } = await supabase
      .from("student_quiz_questions")
      .select("quiz_id")
      .in("quiz_id", ids);
    if (!qerr) {
      counts = (qrows ?? []).reduce((acc, r) => {
        acc.set(r.quiz_id, (acc.get(r.quiz_id) ?? 0) + 1);
        return acc;
      }, new Map<string, number>());
    }
    // A failed count query must not blank the list — degrade to count-less rows.
  }

  return NextResponse.json({
    quizzes: rows.map((q) => ({ ...q, question_count: counts.get(q.id) ?? 0 })),
  });
}

/**
 * POST /api/student-quizzes — create an empty practice quiz (title/description).
 * Questions are added afterwards via the append RPC. The 25-per-student cap is
 * enforced DB-side (trigger); surfaced here as a typed 429.
 */
export async function POST(request: Request) {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const lenHeader = request.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > BODY_LIMIT_BYTES) {
    return payloadTooLarge("Request body too large.");
  }

  const supabase = await createClient();
  const auth = await requireStudent(supabase);
  if (!auth.ok) return auth.response;

  if (!rateLimit(`sq-create:${auth.userId}`, CREATE_RATE)) {
    return rateLimited("Too many quizzes created. Try again later.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = CreateStudentQuizSchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid quiz data."));
  }

  const { title, description } = parsed.data;

  const { data: quiz, error } = await supabase
    .from("student_quizzes")
    .insert({
      created_by: auth.userId,
      title,
      description: description ?? null,
    })
    .select("id, title, description, share_code, created_at, updated_at")
    .single();

  if (error) {
    console.error("Create student quiz error:", error);
    const msg = error.message ?? "";
    if (
      msg.includes("quiz_cap_reached") ||
      msg.includes("student_quizzes_cap")
    ) {
      return rateLimited(`You can keep up to ${QUIZ_CAP} practice quizzes.`);
    }
    if (msg.includes("check constraint")) {
      return invalidBody("Invalid quiz data.");
    }
    return internalError("Could not create the quiz right now.");
  }

  return NextResponse.json({ quiz }, { status: 201 });
}
