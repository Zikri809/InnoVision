import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireQuizOwner } from "@/lib/quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { GenerateQuizSchema } from "@/lib/ai/validation";
import { createAiClient, chatCompletions, AI_MODEL } from "@/lib/ai/client";
import { generateQuiz, type GenerateQuizResult } from "@/lib/ai/quiz-prompt";
import { aiQuizToRows, GENERATION_BUDGET_MS } from "@/lib/ai/quiz-schema";
import { normalizePath } from "@/lib/ai/validation";
import { nativeExtract } from "@/lib/extract/native";
import { MAX_AGGREGATE_CHARS, MAX_FILE_BYTES, MAX_TOTAL_UPLOAD_BYTES } from "@/lib/extract/types";
import {
  checkBodyLimit,
  firstIssueMessage,
  internalError,
  invalidBody,
  invalidJson,
  notDraft,
  notFound,
  payloadTooLarge,
  rateLimited,
  checkSameOrigin,
  timeout,
  unprocessable,
} from "@/lib/http";

export const dynamic = "force-dynamic";
// Local-only deployment (the lecturer's machine) — no Vercel 60s function cap.
// A 30-question generation on a large deck can legitimately take a couple of
// minutes, so the route is free to run as long as it needs.
// export const maxDuration = 60; // (removed for local runs)

// Per-user rate limit on generation (token cost guard, S4). In-memory and
// per-process — accepted at demo scale (documented in SECURITY_AUDIT).
const GENERATE_RATE = { limit: 10, windowMs: 60 * 60 * 1000 };

// Generous parse timeout: a pathological file can otherwise stall the route
// indefinitely. The underlying parse continues to run (we can't truly abort
// pdf.js/mammoth/jszip), but the route returns a clean 503.
const PARSE_TIMEOUT_MS = 120_000;

// Overall wall-clock budget for the whole generation (parse + AI attempt +
// retry). Local tuning: 15 minutes is far beyond what a real generation needs
// but bounds the route against a genuinely hung upstream.
// (Constant GENERATION_BUDGET_MS lives in quiz-schema.ts, shared with
// regenerate-question.)

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
 *    pages). Scanned (low-density) stored files → 422 asking the lecturer to
 *    re-upload and run OCR in the browser.
 *
 * Rules:
 *  - Lecturer + quiz owner + draft-only.
 *  - Rate-limited per user; in-flight guard per quiz.
 *  - Invalid AI output (after one retry) → 422 with ZERO rows inserted — the
 *    atomic replace RPC is never reached.
 *  - Success → `save_quiz_questions` (replace mode) replaces all draft
 *    questions atomically and sets title/source fields.
 */
export async function POST(request: Request, context?: { params?: Promise<{ id?: string }> }) {
  const supabase = await createClient();

  // The route has no URL params (quizId comes from the body). Accept the
  // optional context Next.js passes for route-handler compatibility.
  void context;

  // CSRF: reject cross-origin POSTs (mitigates the SameSite=Lax subdomain gap).
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  // Reject oversized bodies BEFORE buffering: extractedText can legitimately
  // approach ~400 KB, so this generous cap only stops abusive payloads.
  const sizeError = checkBodyLimit(request, 512 * 1024);
  if (sizeError) return sizeError;

  // Authenticate before parsing — an unauthenticated caller must not be able
  // to force large-body materialization on the server.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return notFound();

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
    return await handleGenerate({
      supabase,
      quizId,
      userId: owner.userId,
      quizTitle: owner.quiz.title,
      body: parsed.data,
    });
  } finally {
    inFlight.delete(quizId);
  }
}

async function handleGenerate(
  ctx: {
    supabase: Awaited<ReturnType<typeof createClient>>;
    quizId: string;
    userId: string;
    quizTitle: string;
    body: z.infer<typeof GenerateQuizSchema>;
  },
): Promise<NextResponse> {
  const { supabase, quizId, userId, quizTitle, body } = ctx;

  // Single overall deadline for parse + AI attempt + retry (local tuning —
  // generous 15m budget; see GENERATION_BUDGET_MS).
  const deadlineMs = Date.now() + GENERATION_BUDGET_MS;

  const {
    extractedText,
    sourcePath,
    sourcePaths,
    questionCount,
    mode = "replace",
    difficulty = "mixed",
    formatDistribution = "mixed",
    steeringPrompt,
    language = "auto",
  } = body;

  // Pre-flight check for append mode capacity
  if (mode === "append") {
    const { count: existingCount, error: countError } = await supabase
      .from("questions")
      .select("*", { count: "exact", head: true })
      .eq("quiz_id", quizId);

    if (countError) {
      return internalError("Could not check existing quiz questions.");
    }
    const current = existingCount ?? 0;
    if (current >= 30) {
      return unprocessable(
        "This quiz already has the maximum limit of 30 questions.",
        "quiz_question_limit_exceeded",
      );
    }
    const requested = questionCount ?? 10;
    const maxAppendable = 30 - current;
    if (requested > maxAppendable) {
      return invalidBody(
        `Cannot append ${requested} questions. Only ${maxAppendable} more questions can be added to reach the 30-question limit.`,
      );
    }
  }

  let text = extractedText;
  const pathsToProcess: string[] = [];

  if (sourcePaths && sourcePaths.length > 0) {
    pathsToProcess.push(...sourcePaths);
  } else if (sourcePath) {
    pathsToProcess.push(sourcePath);
  }

  // Strict tenant + quiz isolation verification on all paths
  const expectedPrefix = `${userId.toLowerCase()}/${quizId.toLowerCase()}/`;
  for (const p of pathsToProcess) {
    const lower = p.toLowerCase();
    if (!lower.startsWith(expectedPrefix)) {
      return invalidBody("All source files must reside in your quiz storage folder.");
    }
    if (p.includes("..") || p.includes("//") || normalizePath(p) !== p) {
      return invalidBody("sourcePath contains invalid path traversal segments.");
    }
  }

  let sourcePathFinal: string | null = pathsToProcess[0] ?? null;

  // No client text → server-side native parse of the stored file(s).
  if (!text) {
    if (pathsToProcess.length === 0) {
      // Fall back to the quiz's stored source_file_url.
      const { data: quizRow } = await supabase
        .from("quizzes")
        .select("source_file_url")
        .eq("id", quizId)
        .maybeSingle();
      if (quizRow?.source_file_url) {
        sourcePathFinal = quizRow.source_file_url;
        const lower = sourcePathFinal.toLowerCase();
        if (!lower.startsWith(expectedPrefix)) {
          return invalidBody("The source file must be in your quiz storage folder.");
        }
        if (
          sourcePathFinal.includes("..") ||
          sourcePathFinal.includes("//") ||
          normalizePath(sourcePathFinal) !== sourcePathFinal
        ) {
          return invalidBody("The source file path contains invalid path traversal segments.");
        }
        pathsToProcess.push(sourcePathFinal);
      } else {
        return invalidBody("No extracted text or source file provided.");
      }
    }

    const extractedTexts: string[] = [];
    let totalDownloadedBytes = 0;
    for (let i = 0; i < pathsToProcess.length; i++) {
      const p = pathsToProcess[i];
      const parse = await downloadAndParseNative(supabase, p);
      if (parse.error) return parse.error;
      totalDownloadedBytes += parse.byteLength ?? 0;
      if (totalDownloadedBytes > MAX_TOTAL_UPLOAD_BYTES) {
        return payloadTooLarge(
          `Total size of all source files exceeds the ${MAX_TOTAL_UPLOAD_BYTES / 1_000_000} MB limit.`,
        );
      }
      if (parse.lowConfidence && pathsToProcess.length === 1) {
        return unprocessable(
          "This file has too little extractable text. Re-upload it and run OCR in the browser.",
          "use_browser_ocr",
        );
      }
      if (parse.text?.trim()) {
        const filename = p.split("/").pop() ?? `Document ${i + 1}`;
        extractedTexts.push(
          pathsToProcess.length > 1
            ? `=== SOURCE [${i + 1}/${pathsToProcess.length}]: ${filename} ===\n${parse.text.trim()}`
            : parse.text.trim(),
        );
      }
    }
    text = extractedTexts.join("\n\n");
  }

  if (!text?.trim()) {
    return unprocessable("Extracted text is empty. Try a different file.", "empty_text");
  }

  // Guard: enforce MAX_AGGREGATE_CHARS ceiling on server-extracted multi-file text
  if (text.length > MAX_AGGREGATE_CHARS) {
    text = text.slice(0, MAX_AGGREGATE_CHARS);
  }

  // Run the AI generation (one retry inside generateQuiz). Share a single
  // deadline across attempt + retry so the second call doesn't burn another
  // full 45s when most of the window is already gone.
  const ai = createAiClient();
  const result: GenerateQuizResult = await generateQuiz({
    chat: (messages, timeoutMs) =>
      chatCompletions({ client: ai, model: AI_MODEL, messages, timeoutMs }),
    text,
    questionCount: questionCount ?? 10,
    language,
    difficulty,
    formatDistribution,
    steeringPrompt,
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

  const rows = aiQuizToRows(result.quiz);

  // Build the RPC args with a typed boundary.
  type SaveQuizQuestionsArgs = {
    p_quiz_id: string;
    p_title: string;
    p_source_file_url: string | null;
    p_source_text: string | null;
    p_questions: unknown;
    p_mode: string;
  };
  const rpcArgs: SaveQuizQuestionsArgs = {
    p_quiz_id: quizId,
    p_title: quizTitle,
    p_source_file_url: sourcePathFinal ?? null,
    p_source_text: text,
    p_questions: rows,
    p_mode: mode,
  };

  const { data: questions, error: rpcError } = await supabase.rpc(
    "save_quiz_questions",
    rpcArgs as unknown as never,
  );

  if (rpcError) {
    const msg = rpcError.message ?? "";
    console.error("save_quiz_questions error:", rpcError);
    // 0019's save_quiz_questions raises not_quiz_owner / quiz_not_draft; the
    // older codes are kept so the mapping survives future rewrites.
    if (
      msg.includes("not_owner") ||
      msg.includes("not_quiz_owner") ||
      msg.includes("quiz_not_found")
    ) {
      return notFound();
    }
    if (msg.includes("quiz_not_draft") || msg.includes("questions_locked_quiz_not_draft")) {
      return notDraft();
    }
    if (msg.includes("quiz_question_limit_exceeded")) {
      return unprocessable(
        "Appending these questions exceeds the maximum limit of 30 questions per quiz.",
        "quiz_question_limit_exceeded",
      );
    }
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
    .select("id, class_id, title, mode, status, time_limit_sec, source_text, source_file_url, sources, created_at")
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
): Promise<{ text?: string; lowConfidence?: boolean; byteLength?: number; error?: NextResponse }> {
  // Parse with a wall-clock timeout so a pathological file can't stall the
  // route indefinitely. We race the ENTIRE download+arrayBuffer+parse chain
  // against the PARSE_TIMEOUT_MS deadline: the storage download, the size
  // check, AND the PDF/DOCX/PPTX parse are all covered. The underlying work
  // continues (we can't truly abort pdf.js/mammoth/jszip), but the route
  // returns a clean 503.
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
    return { error: unprocessable("Could not parse the file server-side. Run OCR in the browser.", "parse_error") };
  }
}
