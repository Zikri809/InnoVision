import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStudentQuizOwner } from "@/lib/student-quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import {
  GenerateStudentQuizSchema,
  STUDENT_AI_DAILY_LIMIT,
} from "@/lib/ai/validation";
import { normalizePath } from "@/lib/ai/validation";
import { createAiClient, chatCompletions, AI_MODEL } from "@/lib/ai/client";
import { generateQuiz, type GenerateQuizResult } from "@/lib/ai/quiz-prompt";
import { aiQuizToRows, GENERATION_BUDGET_MS } from "@/lib/ai/quiz-schema";
import { nativeExtract } from "@/lib/extract/native";
import {
  MAX_AGGREGATE_CHARS,
  MAX_FILE_BYTES,
  MAX_TOTAL_UPLOAD_BYTES,
} from "@/lib/extract/types";
import {
  checkBodyLimit,
  checkSameOrigin,
  firstIssueMessage,
  internalError,
  invalidBody,
  invalidJson,
  notFound,
  payloadTooLarge,
  rateLimited,
  timeout,
  unprocessable,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Token-cost guards (plan D7): tighter than the lecturer's 10/h because
// signup is uninvited. In-memory window resets on restart / doesn't aggregate
// across instances — the DB-side DAILY counter below is the durable backstop.
const STUDENT_GENERATE_RATE = { limit: 5, windowMs: 60 * 60 * 1000 };
const BODY_LIMIT_BYTES = 512 * 1024;
const PARSE_TIMEOUT_MS = 120_000;
const QUESTION_CAP = 50;

// In-process in-flight guard (S4 precedent): a scripted double-POST must not
// fire two LLM calls for the same practice quiz.
const inFlight = new Set<string>();

/**
 * POST /api/student-quizzes/[id]/generate — AI-generate questions into the
 * caller's OWN private practice quiz.
 *
 * Mirrors the lecturer pipeline (`/api/ai/generate-quiz`) by composing the
 * SAME lib functions (quiz-prompt / quiz-schema / client) with student-scoped
 * glue — the lecturer route itself is untouched. Differences (plan F1):
 *   - guard = creator ownership (created_by), not class ownership;
 *   - NO title/source-metadata mutation (the bulk RPC writes questions only);
 *   - save rides `save_student_quiz_questions`; when the quiz already holds
 *     questions the generation APPENDS (clamped to the 50-cap), otherwise it
 *     replaces (i.e., seeds) — the student surface has no replace/append UI;
 *   - daily usage counter in `ai_generation_usage` incremented AFTER a
 *     successful save (failed generations don't burn budget).
 *
 * Invalid AI output after the internal retry ⇒ 422 with ZERO rows written.
 */
export async function POST(request: Request, { params }: Params) {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const sizeError = checkBodyLimit(request, BODY_LIMIT_BYTES);
  if (sizeError) return sizeError;

  const supabase = await createClient();
  const { id } = await params;
  if (!isUuid(id)) return notFound();

  const owner = await requireStudentQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;

  if (!rateLimit(`sq-generate:${owner.userId}`, STUDENT_GENERATE_RATE)) {
    return rateLimited("Too many AI generations. Try again in an hour.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = GenerateStudentQuizSchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid generation payload."));
  }

  // Durable daily budget (admin client; table is service-role only). Day is
  // UTC — accepted per plan D7: a fixed boundary is fine for a soft cost
  // guard (local-morning users get an "early" reset; harmless direction).
  const admin = createAdminClient();
  const day = new Date().toISOString().slice(0, 10);
  const { data: usageRow } = await admin
    .from("ai_generation_usage")
    .select("count")
    .eq("user_id", owner.userId)
    .eq("day", day)
    .maybeSingle();
  if ((usageRow?.count ?? 0) >= STUDENT_AI_DAILY_LIMIT) {
    return rateLimited("Daily AI generation limit reached. Try again tomorrow.");
  }

  if (inFlight.has(id)) {
    return rateLimited("A generation for this quiz is already in progress.");
  }
  inFlight.add(id);
  try {
    return await handleGenerate({
      supabase,
      admin,
      quizId: id,
      userId: owner.userId,
      body: parsed.data,
      day,
      usedToday: usageRow?.count ?? 0,
    });
  } finally {
    inFlight.delete(id);
  }
}

async function handleGenerate(ctx: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  admin: ReturnType<typeof createAdminClient>;
  quizId: string;
  userId: string;
  body: import("zod").infer<typeof GenerateStudentQuizSchema>;
  day: string;
  usedToday: number;
}): Promise<NextResponse> {
  const { supabase, admin, quizId, userId, body, day, usedToday } = ctx;
  const deadlineMs = Date.now() + GENERATION_BUDGET_MS;

  const { extractedText, sourcePaths, difficulty = "mixed", language = "auto" } = body;

  // Append-clamp pre-check: how many slots remain under the practice cap?
  const { count: existingCount, error: countError } = await supabase
    .from("student_quiz_questions")
    .select("*", { count: "exact", head: true })
    .eq("quiz_id", quizId);
  if (countError) return internalError("Could not check existing quiz questions.");
  const existing = existingCount ?? 0;
  const remaining = QUESTION_CAP - existing;
  if (remaining <= 0) {
    return unprocessable(
      `A practice quiz can hold up to ${QUESTION_CAP} questions.`,
      "question_cap_reached",
    );
  }

  let text = extractedText;
  const paths = sourcePaths ?? [];

  // Strict tenant isolation: every path must live in `${uid}/${quizId}/`.
  const expectedPrefix = `${userId.toLowerCase()}/${quizId.toLowerCase()}/`;
  for (const p of paths) {
    const lower = p.toLowerCase();
    if (!lower.startsWith(expectedPrefix)) {
      return invalidBody("All source files must reside in this quiz's storage folder.");
    }
    if (p.includes("..") || p.includes("//") || normalizePath(p) !== p) {
      return invalidBody("sourcePath contains invalid path traversal segments.");
    }
  }

  if (!text && paths.length === 0) {
    return invalidBody("No extracted text or source file provided.");
  }

  if (!text) {
    const extractedTexts: string[] = [];
    let totalBytes = 0;
    for (let i = 0; i < paths.length; i++) {
      const parse = await downloadAndParseNative(supabase, paths[i]);
      if (parse.error) return parse.error;
      totalBytes += parse.byteLength ?? 0;
      if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
        return payloadTooLarge(
          `Total size of all source files exceeds the ${MAX_TOTAL_UPLOAD_BYTES / 1_000_000} MB limit.`,
        );
      }
      if (parse.lowConfidence && paths.length === 1) {
        return unprocessable(
          "This file has too little extractable text. Re-upload it and run OCR in the browser.",
          "use_browser_ocr",
        );
      }
      if (parse.text?.trim()) {
        const filename = paths[i].split("/").pop() ?? `Document ${i + 1}`;
        extractedTexts.push(
          paths.length > 1
            ? `=== SOURCE [${i + 1}/${paths.length}]: ${filename} ===\n${parse.text.trim()}`
            : parse.text.trim(),
        );
      }
    }
    text = extractedTexts.join("\n\n");
  }

  if (!text?.trim()) {
    return unprocessable("Extracted text is empty. Try a different file.", "empty_text");
  }
  if (text.length > MAX_AGGREGATE_CHARS) {
    text = text.slice(0, MAX_AGGREGATE_CHARS);
  }

  const requested = body.questionCount ?? 10;
  const effectiveCount = Math.min(requested, remaining);
  const ai = createAiClient();
  const result: GenerateQuizResult = await generateQuiz({
    chat: (messages, timeoutMs) =>
      chatCompletions({ client: ai, model: AI_MODEL, messages, timeoutMs }),
    text,
    questionCount: effectiveCount,
    language,
    difficulty,
    formatDistribution: "mixed",
    steeringPrompt: undefined,
    deadlineMs,
  });

  if (!result.ok) {
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
      "The AI did not return a valid quiz. Try a different file or model.",
      "invalid_ai_output",
    );
  }

  const rowsAll = aiQuizToRows(result.quiz);
  // Models may over-deliver vs the requested count; clamp so an over-generous
  // batch can never push past the 50-cap (the bulk RPC would otherwise reject
  // the WHOLE batch atomically). remaining > 0 is guaranteed by the pre-check.
  const rows = rowsAll.slice(0, remaining);
  if (rows.length === 0) {
    return unprocessable(
      `A practice quiz can hold up to ${QUESTION_CAP} questions.`,
      "question_cap_reached",
    );
  }
  const mode = existing > 0 ? "append" : "replace";

  const { data: saved, error: rpcError } = await supabase.rpc(
    "save_student_quiz_questions",
    {
      p_quiz_id: quizId,
      p_questions: rows,
      p_mode: mode,
    } as unknown as never,
  );

  if (rpcError) {
    const msg = rpcError.message ?? "";
    console.error("save_student_quiz_questions error:", rpcError);
    if (
      msg.includes("not_owner") ||
      msg.includes("not_authenticated") ||
      msg.includes("not_student") ||
      msg.includes("quiz_not_found")
    ) {
      return notFound();
    }
    if (msg.includes("question_cap_reached")) {
      return unprocessable(
        `Appending these questions exceeds the maximum limit of ${QUESTION_CAP} per practice quiz.`,
        "question_cap_reached",
      );
    }
    if (msg.includes("invalid_mode")) {
      return unprocessable("Invalid save mode.", "invalid_mode");
    }
    if (
      msg.includes("invalid_questions_json") ||
      msg.includes("invalid_question_fields") ||
      msg.includes("violates check constraint") ||
      msg.includes("duplicate_options") ||
      msg.includes("empty_option") ||
      msg.includes("option_too_long") ||
      msg.includes("explanation_too_long")
    ) {
      return unprocessable(
        "The AI produced questions that failed validation. Try again.",
        "invalid_ai_output",
      );
    }
    return internalError("Could not save the generated questions right now.");
  }

  // Budget consumed ONLY on success (soft last-writer-wins increment is fine
  // for a cost guard).
  await admin
    .from("ai_generation_usage")
    .upsert(
      { user_id: userId, day, count: usedToday + 1 },
      { onConflict: "user_id,day" },
    );

  return NextResponse.json(
    {
      questions: saved ?? [],
      // True when the model over-delivered past the remaining cap slots and
      // rows were dropped — the client surfaces a partial-add notice.
      capped: rowsAll.length > rows.length,
    },
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Download + native-parse a stored file with server-side bounds (lecturer-route parity). */
async function downloadAndParseNative(
  supabase: Awaited<ReturnType<typeof createClient>>,
  path: string,
): Promise<{ text?: string; lowConfidence?: boolean; byteLength?: number; error?: NextResponse }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      downloadParse(supabase, path),
      new Promise<{ error: NextResponse }>((_, reject) => {
        timer = setTimeout(() => reject(new Error("parse_timeout")), PARSE_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    if ((err as Error)?.message === "parse_timeout") {
      return {
        error: timeout(
          "The file could not be parsed in time. Try a smaller file or run OCR in the browser.",
        ),
      };
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function downloadParse(
  supabase: Awaited<ReturnType<typeof createClient>>,
  path: string,
): Promise<{ text?: string; lowConfidence?: boolean; byteLength?: number; error?: NextResponse }> {
  let blob: Blob;
  try {
    const { data, error } = await supabase.storage.from("quiz-sources").download(path);
    if (error) return { error: notFound() };
    blob = data;
  } catch {
    return { error: notFound() };
  }

  const bytes = await blob.arrayBuffer();
  if (bytes.byteLength > MAX_FILE_BYTES) {
    return { error: payloadTooLarge("The source file exceeds the 25 MB limit.") };
  }

  try {
    const result = await nativeExtract(bytes, path.split("/").pop() ?? "file", { node: true });
    return { text: result.text, lowConfidence: result.lowConfidence, byteLength: bytes.byteLength };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg === "unsupported_file_type") {
      return {
        error: unprocessable(
          "This file type cannot be parsed server-side. Re-upload it and run OCR in the browser.",
          "unsupported_file_type",
        ),
      };
    }
    return {
      error: unprocessable("Could not parse the file server-side. Run OCR in the browser.", "parse_error"),
    };
  }
}
