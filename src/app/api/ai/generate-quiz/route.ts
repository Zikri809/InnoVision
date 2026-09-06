import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireQuizOwner } from "@/lib/quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { GenerateQuizSchema } from "@/lib/ai/validation";
import { createAiClient, chatCompletions, chatStream, AI_MODEL, type ChatMessage, type ChatResult } from "@/lib/ai/client";
import {
  generateQuiz,
  type GenerateQuizLibEvent,
  type GenerateQuizResult,
} from "@/lib/ai/quiz-prompt";
import { aiQuizToRows, GENERATION_BUDGET_MS } from "@/lib/ai/quiz-schema";
import { normalizePath } from "@/lib/ai/validation";
import { nativeExtract } from "@/lib/extract/native";
import { MAX_AGGREGATE_CHARS, MAX_FILE_BYTES, MAX_TOTAL_UPLOAD_BYTES } from "@/lib/extract/types";
import {
  STREAM_RESPONSE_HEADERS,
  wantsStream,
  type GenerationEvent,
} from "@/lib/ai/events";
import {
  checkBodyLimit,
  firstIssueMessage,
  internalError,
  invalidBody,
  invalidJson,
  jsonError,
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

// Heartbeat cadence for stream mode: comfortably below the client's 30s
// dead-stream detector, comfortably above noisy per-chunk traffic.
const HEARTBEAT_MS = 12_000;

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
 * Response protocols (two-segment contract — docs/plans/agentic-generation.md):
 *  - LEGACY (default): one JSON body `{quiz, questions}`; every failure is a
 *    typed JSON status exactly as before the stream feature existed.
 *  - STREAM (opt-in via `Accept: application/x-ndjson`): NDJSON events —
 *    stage / ping / reasoning / content_delta / error / cancelled /
 *    saved_refresh_failed / done. All guards that run before the first stream
 *    byte keep their JSON statuses; everything after is an event.
 *
 * Rules (unchanged):
 *  - Lecturer + quiz owner + draft-only.
 *  - Rate-limited per user; in-flight guard per quiz. Cancelling still burns
 *    the rate-limit hit (documented trade-off), but the in-flight slot is
 *    released when the stream dies so an immediate retry is possible.
 *  - Invalid AI output (after one retry) → ZERO rows inserted — the atomic
 *    replace RPC is never reached.
 *  - Success → `save_quiz_questions` (replace mode) replaces all draft
 *    questions atomically and sets title/source fields.
 *  - Cancel (request abort) propagates into the AI call and SKIPS the save —
 *    a cancelled generation must not persist rows the client never saw.
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

  // In-flight guard: prevent duplicate LLM spend for the same quiz. Uses a
  // DISTINCT error code (`already_running`) so the client can tell "a
  // generation is genuinely running" from the hourly quota 429 — the console
  // must never claim a generation is running when the bucket is merely spent.
  if (inFlight.has(quizId)) {
    return jsonError("already_running", "A generation for this quiz is already in progress.", 429);
  }
  inFlight.add(quizId);

  const streamMode = wantsStream(request);

  // Append-mode capacity pre-check — the LAST segment of the two-segment
  // contract that must stay a JSON STATUS, so it runs before the stream opens
  // (stream mode included). Legacy order preserved: guard → precheck → work.
  if (parsed.data.mode === "append") {
    const precheck = await appendCapacityError(supabase, quizId, parsed.data.questionCount ?? 10);
    if (precheck) {
      inFlight.delete(quizId);
      return precheck;
    }
  }

  const ctx: GenerationContext = {
    supabase,
    quizId,
    userId: owner.userId,
    quizTitle: owner.quiz.title,
    body: parsed.data,
    deadlineMs: Date.now() + GENERATION_BUDGET_MS,
  };

  if (!streamMode) {
    try {
      return await runLegacyGeneration(ctx, request.signal);
    } finally {
      inFlight.delete(quizId);
    }
  }
  return streamGeneration(ctx, request);
}

// ─── Shared context ──────────────────────────────────────────────────────────

type GenerationContext = {
  supabase: Awaited<ReturnType<typeof createClient>>;
  quizId: string;
  userId: string;
  quizTitle: string;
  body: z.infer<typeof GenerateQuizSchema>;
  deadlineMs: number;
};

/** 422/400 for an append request that can't fit (pre-stream JSON segment). */
async function appendCapacityError(
  supabase: GenerationContext["supabase"],
  quizId: string,
  questionCount: number,
): Promise<NextResponse | null> {
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
  const maxAppendable = 30 - current;
  if (questionCount > maxAppendable) {
    return invalidBody(
      `Cannot append ${questionCount} questions. Only ${maxAppendable} more questions can be added to reach the 30-question limit.`,
    );
  }
  return null;
}

// ─── Phase 1: source preparation (parse) ─────────────────────────────────────

type PreparedSource =
  | { ok: true; text: string; sourcePathFinal: string | null; parsed: boolean }
  | { ok: false; response: NextResponse };

/** Resolve the source text: client-extracted text directly, or a bounded
 * server-side parse of the stored file(s). Errors return the EXACT legacy
 * responses (both protocols reuse them — stream mode converts to events).
 * `parsed` reports whether real parse work happened — the stream wrapper uses
 * it to decide whether Parse stage events are TRUE (truth rule: no invented
 * stages; client-extracted text means nothing was parsed). */
async function prepareSource(ctx: GenerationContext): Promise<PreparedSource> {
  const { supabase, quizId, userId, body } = ctx;

  let text = body.extractedText;
  // Truth marker: extractedText present means NO server-side parse happens —
  // validation/clamping is real but is not "Parse" in the stage-rail sense.
  let parsed = false;
  const pathsToProcess: string[] = [];

  if (body.sourcePaths && body.sourcePaths.length > 0) {
    pathsToProcess.push(...body.sourcePaths);
  } else if (body.sourcePath) {
    pathsToProcess.push(body.sourcePath);
  }

  // Strict tenant + quiz isolation verification on all paths
  const expectedPrefix = `${userId.toLowerCase()}/${quizId.toLowerCase()}/`;
  for (const p of pathsToProcess) {
    const lower = p.toLowerCase();
    if (!lower.startsWith(expectedPrefix)) {
      return { ok: false, response: invalidBody("All source files must reside in your quiz storage folder.") };
    }
    if (p.includes("..") || p.includes("//") || normalizePath(p) !== p) {
      return { ok: false, response: invalidBody("sourcePath contains invalid path traversal segments.") };
    }
  }

  let sourcePathFinal: string | null = pathsToProcess[0] ?? null;

  // No client text → server-side native parse of the stored file(s).
  if (!text) {
    parsed = true;
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
          return { ok: false, response: invalidBody("The source file must be in your quiz storage folder.") };
        }
        if (
          sourcePathFinal.includes("..") ||
          sourcePathFinal.includes("//") ||
          normalizePath(sourcePathFinal) !== sourcePathFinal
        ) {
          return { ok: false, response: invalidBody("The source file path contains invalid path traversal segments.") };
        }
        pathsToProcess.push(sourcePathFinal);
      } else {
        return { ok: false, response: invalidBody("No extracted text or source file provided.") };
      }
    }

    const extractedTexts: string[] = [];
    let totalDownloadedBytes = 0;
    for (let i = 0; i < pathsToProcess.length; i++) {
      const p = pathsToProcess[i];
      const parse = await downloadAndParseNative(supabase, p);
      if (parse.error) return { ok: false, response: parse.error };
      totalDownloadedBytes += parse.byteLength ?? 0;
      if (totalDownloadedBytes > MAX_TOTAL_UPLOAD_BYTES) {
        return {
          ok: false,
          response: payloadTooLarge(
            `Total size of all source files exceeds the ${MAX_TOTAL_UPLOAD_BYTES / 1_000_000} MB limit.`,
          ),
        };
      }
      if (parse.lowConfidence && pathsToProcess.length === 1) {
        return {
          ok: false,
          response: unprocessable(
            "This file has too little extractable text. Re-upload it and run OCR in the browser.",
            "use_browser_ocr",
          ),
        };
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
    return { ok: false, response: unprocessable("Extracted text is empty. Try a different file.", "empty_text") };
  }

  // Guard: enforce MAX_AGGREGATE_CHARS ceiling on server-extracted multi-file text
  if (text.length > MAX_AGGREGATE_CHARS) {
    text = text.slice(0, MAX_AGGREGATE_CHARS);
  }

  return { ok: true, text, sourcePathFinal, parsed };
}

// ─── Phase 2: AI generation ──────────────────────────────────────────────────

async function runAiGeneration(
  ctx: GenerationContext,
  text: string,
  opts: {
    signal?: AbortSignal;
    /** Stream mode: forwarded model deltas (inert raw text — S7 posture). */
    onDelta?: Parameters<typeof chatStream>[0]["onDelta"];
    /** Stream mode: lib milestones (attempt_start/attempt_retry). */
    onLibEvent?: (event: GenerateQuizLibEvent) => void;
  } = {},
): Promise<GenerateQuizResult> {
  const { body } = ctx;
  const ai = createAiClient();

  const chat: (messages: ChatMessage[], timeoutMs?: number) => Promise<ChatResult> =
    opts.onDelta
      ? async (messages, timeoutMs) => {
          const r = await chatStream({
            client: ai,
            model: AI_MODEL,
            messages,
            timeoutMs,
            signal: opts.signal,
            onDelta: opts.onDelta,
          });
          if (!r.ok) {
            if (r.error === "timeout") return { ok: false, error: "timeout" };
            // Cancelled maps into the generic channel; the ROUTE checks the
            // abort signal between phases and emits the dedicated
            // `cancelled` event instead.
            return {
              ok: false,
              error: "ai_error",
              message: r.error === "cancelled" ? "cancelled" : r.message,
            };
          }
          return { ok: true, text: r.text };
        }
      : async (messages, timeoutMs) =>
          chatCompletions({ client: ai, model: AI_MODEL, messages, timeoutMs, signal: opts.signal });

  return generateQuiz({
    chat,
    text,
    questionCount: body.questionCount ?? 10,
    language: body.language,
    difficulty: body.difficulty,
    formatDistribution: body.formatDistribution,
    allowMultiSelect: body.allowMultiSelect,
    steeringPrompt: body.steeringPrompt,
    deadlineMs: ctx.deadlineMs,
    onEvent: opts.onLibEvent,
  });
}

/** Map a failed GenerateQuizResult to the exact legacy error response. */
function generationErrorResponse(result: Exclude<GenerateQuizResult, { ok: true }>): NextResponse {
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

// ─── Phase 3: save ───────────────────────────────────────────────────────────

type SaveOutcome =
  | { kind: "ok"; payload: { quiz: unknown; questions: unknown[] } }
  | { kind: "error"; response: NextResponse }
  | { kind: "saved_refresh_failed"; questions: unknown[] };

async function saveGeneration(
  ctx: GenerationContext,
  prepared: { text: string; sourcePathFinal: string | null },
  result: Extract<GenerateQuizResult, { ok: true }>,
  opts: { signal?: AbortSignal } = {},
): Promise<SaveOutcome> {
  const { supabase, quizId, quizTitle } = ctx;
  const rows = aiQuizToRows(result.quiz);

  // Cancel checkpoint: a cancelled generation must NOT persist rows the
  // client never saw (no zombie save).
  if (opts.signal?.aborted) {
    return { kind: "error", response: jsonError("cancelled", "Generation cancelled.", 409) };
  }

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
    p_source_file_url: prepared.sourcePathFinal ?? null,
    p_source_text: prepared.text,
    p_questions: rows,
    p_mode: ctx.body.mode,
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
      return { kind: "error", response: notFound() };
    }
    if (msg.includes("quiz_not_draft") || msg.includes("questions_locked_quiz_not_draft")) {
      return { kind: "error", response: notDraft() };
    }
    if (msg.includes("quiz_question_limit_exceeded")) {
      return {
        kind: "error",
        response: unprocessable(
          "Appending these questions exceeds the maximum limit of 30 questions per quiz.",
          "quiz_question_limit_exceeded",
        ),
      };
    }
    if (msg.includes("invalid_questions_json")) {
      return {
        kind: "error",
        response: unprocessable(
          "The AI returned malformed JSON. Try a different file or model.",
          "invalid_ai_output",
        ),
      };
    }
    if (msg.includes("invalid_title")) {
      return {
        kind: "error",
        response: unprocessable(
          "The AI returned a title outside the allowed range. Try again.",
          "invalid_ai_output",
        ),
      };
    }
    if (
      msg.includes("violates check constraint") ||
      msg.includes("duplicate_options") ||
      msg.includes("empty_option") ||
      msg.includes("option_too_long") ||
      msg.includes("explanation_too_long") ||
      msg.includes("invalid_question_fields") ||
      msg.includes("invalid_correct_indices")
    ) {
      return {
        kind: "error",
        response: unprocessable(
          "The AI produced questions that failed validation. Try again.",
          "invalid_ai_output",
        ),
      };
    }
    return { kind: "error", response: internalError("Could not save the generated quiz right now.") };
  }

  const { data: quiz, error: quizError } = await supabase
    .from("quizzes")
    .select("id, class_id, title, mode, status, time_limit_sec, source_text, source_file_url, sources, created_at")
    .eq("id", quizId)
    .single();

  if (quizError) {
    console.error("Quiz refetch error:", quizError);
    // The save COMMITTED — the client must not "retry" (it would wipe and
    // re-bill a successful save). Stream mode carries a dedicated event;
    // legacy keeps its historical 503.
    return { kind: "saved_refresh_failed", questions: questions ?? [] };
  }

  return { kind: "ok", payload: { quiz, questions: questions ?? [] } };
}

// ─── Protocol runners ────────────────────────────────────────────────────────

/** LEGACY (default) protocol — byte-identical behavior to the pre-stream route. */
async function runLegacyGeneration(ctx: GenerationContext, signal: AbortSignal): Promise<NextResponse> {
  const prepared = await prepareSource(ctx);
  if (!prepared.ok) return prepared.response;

  const result = await runAiGeneration(ctx, prepared.text, { signal });
  if (!result.ok) return generationErrorResponse(result);

  const saved = await saveGeneration(
    ctx,
    { text: prepared.text, sourcePathFinal: prepared.sourcePathFinal },
    result,
    { signal },
  );
  if (saved.kind === "ok") return NextResponse.json(saved.payload);
  if (saved.kind === "saved_refresh_failed") {
    return internalError("Could not load the updated quiz right now.");
  }
  return saved.response;
}

/** STREAM (opt-in) protocol — NDJSON events with heartbeats and lifecycle-safe
 * in-flight guard release. */
function streamGeneration(ctx: GenerationContext, request: Request): Response {
  const enc = new TextEncoder();
  const internal = new AbortController();
  let guardReleased = false;
  const releaseGuard = () => {
    if (guardReleased) return;
    guardReleased = true;
    inFlight.delete(ctx.quizId);
  };
  const onClientAbort = () => internal.abort("cancelled");
  request.signal.addEventListener("abort", onClientAbort);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: GenerationEvent) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(JSON.stringify(event) + "\n"));
        } catch {
          closed = true; // stream torn down under us (client gone)
        }
      };
      /** Convert a legacy JSON error response into an event with the SAME code. */
      const sendError = async (r: NextResponse) => {
        const body = (await r.clone().json().catch(() => null)) as
          | { error?: string; message?: string }
          | null;
        send({ type: "error", code: body?.error ?? "internal", message: body?.message });
      };
      // Heartbeat (12s) keeps intermediaries from buffering a silent stream.
      // Scoped to silent phases: cleared once content/reasoning deltas flow
      // (the deltas themselves prove liveness), re-armed when the silent
      // save phase starts.
      let deltasFlowing = false;
      const ping = setInterval(() => {
        if (!deltasFlowing) send({ type: "ping" });
      }, HEARTBEAT_MS);

      try {
        const prepared = await prepareSource(ctx);
        if (!prepared.ok) {
          await sendError(prepared.response);
          return;
        }
        // Truth rule: Parse stage events ONLY when real parse work happened
        // (stored-file route). Client-extracted text skips the rail stage —
        // validation/clamping is real work but is not "Parse".
        if (prepared.parsed) {
          send({ type: "stage", stage: "parse", status: "start" });
          send({
            type: "stage",
            stage: "parse",
            status: "done",
            detail: String(prepared.text.length),
          });
        } else {
          send({ type: "stage", stage: "parse", status: "skip" });
        }
        if (internal.signal.aborted) {
          send({ type: "cancelled" });
          return;
        }

        send({ type: "stage", stage: "draft", status: "start" });
        let refineActive = false;
        const result = await runAiGeneration(ctx, prepared.text, {
          signal: internal.signal,
          onDelta: (d) => {
            deltasFlowing = true;
            if (d.reasoning) send({ type: "reasoning", text: d.reasoning });
            if (d.content) send({ type: "content_delta", text: d.content });
          },
          onLibEvent: (ev) => {
            if (ev.type === "attempt_retry") {
              refineActive = true;
              send({ type: "stage", stage: "refine", status: "start" });
            }
          },
        });
        if (internal.signal.aborted) {
          send({ type: "cancelled" });
          return;
        }
        if (!result.ok) {
          await sendError(generationErrorResponse(result));
          return;
        }
        send({ type: "stage", stage: "draft", status: "done" });
        // A retry pass happened: close the Refine stage so the rail doesn't
        // spin forever on the success screen (truth rule — it DID refine).
        if (refineActive) {
          send({ type: "stage", stage: "refine", status: "done" });
        }

        // Save is a silent phase again — re-arm the heartbeat.
        deltasFlowing = false;
        send({ type: "stage", stage: "save", status: "start" });
        const saved = await saveGeneration(
          ctx,
          { text: prepared.text, sourcePathFinal: prepared.sourcePathFinal },
          result,
          { signal: internal.signal },
        );
        if (saved.kind === "error") {
          if (internal.signal.aborted) {
            send({ type: "cancelled" });
          } else {
            await sendError(saved.response);
          }
          return;
        }
        if (saved.kind === "saved_refresh_failed") {
          send({ type: "saved_refresh_failed", questions: saved.questions });
          return;
        }
        send({ type: "done", payload: saved.payload });
      } catch (err) {
        console.error("generation stream error:", err);
        send({ type: "error", code: "internal", message: "Could not generate the quiz right now." });
      } finally {
        clearInterval(ping);
        releaseGuard();
        request.signal.removeEventListener("abort", onClientAbort);
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed/cancelled */
        }
      }
    },
    cancel() {
      // Client navigated away or hit Cancel: stop the upstream spend and
      // release the in-flight slot immediately so a retry is not locked out.
      internal.abort("cancelled");
      releaseGuard();
      request.signal.removeEventListener("abort", onClientAbort);
    },
  });

  return new Response(stream, { headers: STREAM_RESPONSE_HEADERS });
}

/** Download + native-parse a stored file with server-side bounds (S1). */
async function downloadAndParseNative(
  supabase: Awaited<ReturnType<typeof createClient>>,
  path: string,
): Promise<{ text?: string; lowConfidence?: boolean; byteLength?: number; error?: NextResponse }> {
  // Parse with a wall-clock timeout so a pathological file can't stall the
  // route indefinitely. We race the ENTIRE download+arrayBuffer+parse chain
  // against the PARSE_TIMEOUT_MS deadline: the storage download, the
  // size check, AND the PDF/DOCX/PPTX parse are all covered. The underlying
  // work continues (we can't truly abort pdf.js/mammoth/jszip), but the route
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
