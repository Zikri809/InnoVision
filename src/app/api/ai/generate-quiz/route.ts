import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireQuizOwner } from "@/lib/quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { GenerateQuizSchema } from "@/lib/ai/validation";
import { createAiClient, chatCompletions, AI_MODEL } from "@/lib/ai/client";
import { generateQuiz, type GenerateQuizResult } from "@/lib/ai/quiz-prompt";
import { aiQuizToRows } from "@/lib/ai/quiz-schema";
import { nativeExtract } from "@/lib/extract/native";
import {
  MAX_EXTRACT_CHARS,
  MAX_FILE_BYTES,
} from "@/lib/extract/types";
import {
  firstIssueMessage,
  internalError,
  invalidBody,
  invalidJson,
  notDraft,
  notFound,
  payloadTooLarge,
  rateLimited,
  timeout,
  unprocessable,
} from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Per-user rate limit on generation (token cost guard, S4). In-memory and
// per-process — accepted at demo scale (documented in SECURITY_AUDIT).
const GENERATE_RATE = { limit: 10, windowMs: 60 * 60 * 1000 };

// Per PLAN §S1: ~10s parse timeout. A pathological file can otherwise eat the
// full `maxDuration=60` budget. The underlying parse continues to run in the
// isolate (we can't truly abort pdf.js/mammoth/jszip), but the route returns
// a clean 503 and Vercel reclaims the worker on the 60s cap.
const PARSE_TIMEOUT_MS = 15_000;

// In-process in-flight guard so a scripted double-POST can't fire two LLM
// calls for the same quiz (S4). Single-instance caveat documented.
const inFlight = new Set<string>();

/**
 * POST /api/ai/generate-quiz — AI-generate a full quiz into a DRAFT quiz.
 *
 * Input: { quizId, extractedText?, sourcePath?, questionCount? }
 *  - `extractedText` (client did extraction/OCR) is used directly.
 *  - Otherwise the stored file at `sourcePath` (or the quiz's source_file_url)
 *    is parsed SERVER-SIDE with the native extractor (bounded: 25 MB, ≤50
 *    pages, ≤15k chars). Scanned (low-density) stored files → 422 asking the
 *    lecturer to re-upload and run OCR in the browser.
 *
 * Rules:
 *  - Lecturer + quiz owner + draft-only.
 *  - Rate-limited per user; in-flight guard per quiz.
 *  - Invalid AI output (after one retry) → 422 with ZERO rows inserted — the
 *    atomic replace RPC is never reached.
 *  - Success → `replace_quiz_questions` replaces all draft questions
 *    atomically and sets title/source fields.
 */
export async function POST(request: Request, context?: { params?: Promise<{ id?: string }> }) {
  const supabase = await createClient();

  // The route has no URL params (quizId comes from the body). Accept the
  // optional context Next.js passes for route-handler compatibility.
  void context;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = GenerateQuizSchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid generation payload."));
  }

  const quizId = parsed.data.quizId;

  if (!isUuid(quizId)) return notFound();

  const owner = await requireQuizOwner(supabase, quizId);
  if (!owner.ok) return owner.response;
  if (owner.quiz.status !== "draft") return notDraft();

  // Rate-limit immediately after auth + ownership, before any heavy work (S4).
  if (!rateLimit(`aiGenerate:${owner.userId}`, GENERATE_RATE)) {
    return rateLimited("Too many quiz generations. Try again in an hour.");
  }

  // In-flight guard: prevent duplicate LLM spend for the same quiz.
  if (inFlight.has(quizId)) {
    return rateLimited("A generation for this quiz is already in progress.");
  }
  inFlight.add(quizId);
  try {
    return await handleGenerate(request, {
      supabase,
      quizId,
      userId: owner.userId,
      body: parsed.data,
    });
  } finally {
    inFlight.delete(quizId);
  }
}

async function handleGenerate(
  _request: Request,
  ctx: {
    supabase: Awaited<ReturnType<typeof createClient>>;
    quizId: string;
    userId: string;
    body: z.infer<typeof GenerateQuizSchema>;
  },
): Promise<NextResponse> {
  const { supabase, quizId, userId, body } = ctx;

  const { extractedText, sourcePath, questionCount } = body;

  let text = extractedText;
  let sourcePathFinal = sourcePath;

  // No client text → server-side native parse of the stored file.
  if (!text) {
    if (sourcePathFinal) {
      // Defense-in-depth: Zod already rejects `..` and `//` in the regex +
      // refinements, but re-verify the path STARTS with `${userId}/` so a
      // future Zod-schema drift can't silently bypass the per-tenant boundary.
      const prefix = `${userId.toLowerCase()}/`;
      if (!sourcePathFinal.toLowerCase().startsWith(prefix)) {
        return invalidBody("The source file must be in your own storage folder.");
      }
    } else {
      // Fall back to the quiz's stored source_file_url.
      const { data: quizRow } = await supabase
        .from("quizzes")
        .select("source_file_url")
        .eq("id", quizId)
        .maybeSingle();
      if (quizRow?.source_file_url) {
        sourcePathFinal = quizRow.source_file_url;
      } else {
        return invalidBody("No extracted text or source file provided.");
      }
    }

    const parse = await downloadAndParseNative(supabase, sourcePathFinal);
    if (parse.error) return parse.error;
    if (parse.lowConfidence) {
      return unprocessable(
        "This file has too little extractable text. Re-upload it and run OCR in the browser.",
        "use_browser_ocr",
      );
    }
    text = parse.text;
  }

  if (!text?.trim()) {
    return unprocessable("Extracted text is empty. Try a different file.", "empty_text");
  }

  // Run the AI generation (one retry inside generateQuiz). Share a single
  // deadline across attempt + retry so the second call doesn't burn another
  // full 45s when most of the 50s window is already gone.
  const ai = createAiClient();
  const result: GenerateQuizResult = await generateQuiz({
    chat: (messages, timeoutMs) =>
      chatCompletions({ client: ai, model: AI_MODEL, messages, timeoutMs }).then(
        (r) => r,
      ),
    text: text.slice(0, MAX_EXTRACT_CHARS),
    questionCount: questionCount ?? 10,
  });

  if (!result.ok) {
    if (result.error === "timeout") {
      return timeout("The AI request timed out. Please try again.");
    }
    if (result.error === "ai_unavailable") {
      return unprocessable("The AI service is unavailable right now. Try again later.", "ai_unavailable");
    }
    return unprocessable(
      "The AI did not return a valid quiz. Try a different file or model.",
      "invalid_ai_output",
    );
  }

  const rows = aiQuizToRows(result.quiz);

  const { data: questions, error: rpcError } = await supabase.rpc(
    "replace_quiz_questions",
    {
      p_quiz_id: quizId,
      p_title: result.quiz.title,
      // The generated arg type marks source fields non-null even though the
      // SQL accepts NULL (supabase gen-types limitation); cast at the boundary.
      p_source_file_url: sourcePathFinal ?? null,
      p_source_text: text.slice(0, MAX_EXTRACT_CHARS),
      // Pass the array directly (not JSON.stringify): PostgREST serializes a
      // jsonb arg as a real JSON array, so jsonb_typeof(p_questions) = 'array'.
      p_questions: rows,
    } as unknown as never,
  );

  if (rpcError) {
    const msg = rpcError.message ?? "";
    console.error("replace_quiz_questions error:", rpcError);
    if (msg.includes("not_owner") || msg.includes("quiz_not_found")) return notFound();
    if (msg.includes("questions_locked_quiz_not_draft")) return notDraft();
    // Distinguish "model emitted malformed JSON" (could fix with retry / file
    // choice) from "content exceeds DB limits" (route should report which
    // field so the lecturer can act on it).
    if (msg.includes("invalid_questions_json")) {
      return unprocessable(
        "The AI returned malformed JSON. Try a different file or model.",
        "invalid_ai_output",
      );
    }
    if (msg.includes("invalid_title")) {
      return unprocessable(
        "The AI returned a title outside the allowed range. Try again.",
        "invalid_ai_output",
      );
    }
    if (msg.includes("source_text_too_long")) {
      return unprocessable(
        "The source text exceeded the 15k character limit. Try a shorter file.",
        "source_text_too_long",
      );
    }
    if (
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
    return internalError("Could not save the generated quiz right now.");
  }

  const { data: quiz, error: quizError } = await supabase
    .from("quizzes")
    .select("id, class_id, title, mode, status, time_limit_sec, source_text, source_file_url, created_at")
    .eq("id", quizId)
    .single();

  if (quizError) {
    console.error("Quiz refetch error:", quizError);
    return internalError("Could not load the updated quiz right now.");
  }

  return NextResponse.json({ quiz, questions });
}

/** Download + native-parse a stored file with server-side bounds (S1). */
async function downloadAndParseNative(
  supabase: Awaited<ReturnType<typeof createClient>>,
  path: string,
): Promise<{ text?: string; lowConfidence?: boolean; error?: NextResponse }> {
  // Parse with a wall-clock timeout (PLAN §S1) so a pathological file can't
  // consume the full `maxDuration=60` budget. We race the ENTIRE
  // download+arrayBuffer+parse chain against a 15s deadline: the storage
  // download, the size check, AND the PDF/DOCX/PPTX parse are all covered.
  // The underlying work continues in the isolate (we can't truly abort
  // pdf.js/mammoth/jszip), but the route returns a clean 503 and Vercel
  // reclaims the worker on the 60s cap.
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
): Promise<{ text?: string; lowConfidence?: boolean; error?: NextResponse }> {
  let blob: Blob;
  try {
    const { data, error } = await supabase.storage.from("quiz-sources").download(path);
    if (error) {
      return { error: notFound() };
    }
    blob = data;
  } catch {
    return { error: notFound() };
  }

  // Server-side size re-check (defense in depth on top of bucket limits).
  const bytes = await blob.arrayBuffer();
  if (bytes.byteLength > MAX_FILE_BYTES) {
    return { error: payloadTooLarge("The source file exceeds the 25 MB limit.") };
  }

  try {
    const result = await nativeExtract(bytes, path.split("/").pop() ?? "file", { node: true });
    return { text: result.text, lowConfidence: result.lowConfidence };
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
    return { error: unprocessable("Could not parse the file server-side. Run OCR in the browser.", "parse_error") };
  }
}
