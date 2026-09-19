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
import {
  createAiClient,
  chatCompletions,
  chatStream,
  AI_MODEL,
  NO_CHAT_USAGE,
  type ChatMessage,
  type ChatResult,
} from "@/lib/ai/client";
import { generateQuiz, type GenerateQuizLibEvent, type GenerateQuizResult } from "@/lib/ai/quiz-prompt";
import { aiQuizToRows, GENERATION_BUDGET_MS } from "@/lib/ai/quiz-schema";
import { nativeExtract } from "@/lib/extract/native";
import {
  MAX_AGGREGATE_CHARS,
  MAX_FILE_BYTES,
  MAX_TOTAL_UPLOAD_BYTES,
} from "@/lib/extract/types";
import {
  STREAM_RESPONSE_HEADERS,
  wantsStream,
  type GenerationEvent,
} from "@/lib/ai/events";
import {
  checkSameOrigin,
  firstIssueMessage,
  internalError,
  invalidBody,
  jsonError,
  notFound,
  payloadTooLarge,
  rateLimited,
  readCappedJson,
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

// Heartbeat cadence for stream mode (lecturer-route parity; comfortably below
// the client's 30s dead-stream detector).
const HEARTBEAT_MS = 12_000;

// In-process in-flight guard (S4 precedent): a scripted double-POST must not
// fire two LLM calls for the same practice quiz.
const inFlight = new Set<string>();

/**
 * POST /api/student-quizzes/[id]/generate — AI-generate questions into the
 * caller's OWN private practice quiz.
 *
 * Mirrors the lecturer pipeline (`/api/ai/generate-quiz`) by composing the
 * SAME lib functions (quiz-prompt / quiz-schema / client) with student-scoped
 * glue. Differences (plan F1):
 *   - guard = creator ownership (created_by), not class ownership;
 *   - NO title/source-metadata mutation (the bulk RPC writes questions only);
 *   - save rides `save_student_quiz_questions`; when the quiz already holds
 *     questions the generation APPENDS (clamped to the 50-cap), otherwise it
 *     replaces (i.e., seeds) — the student surface has no replace/append UI;
 *   - daily usage counter in `ai_generation_usage` incremented AFTER a
 *     successful save (failed generations don't burn budget).
 *
 * Response protocols: the same two-segment contract as the lecturer route
 * (docs/plans/agentic-generation.md). Legacy JSON stays the default; stream
 * mode is opt-in via `Accept: application/x-ndjson`. The durable daily-limit
 * check is a PRE-stream guard and keeps its JSON 429; the post-save usage
 * upsert is a write, not a guard. Invalid AI output after the internal retry
 * ⇒ 422 (legacy) / error event (stream) with ZERO rows written. A cancelled
 * generation skips the save.
 */
export async function POST(request: Request, { params }: Params) {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const supabase = await createClient();
  const { id } = await params;
  if (!isUuid(id)) return notFound();

  const owner = await requireStudentQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;

  if (!rateLimit(`sq-generate:${owner.userId}`, STUDENT_GENERATE_RATE)) {
    return rateLimited("Too many AI generations. Try again in an hour.");
  }

  const body = await readCappedJson(request, BODY_LIMIT_BYTES);
  if (!body.ok) return body.response;

  const parsed = GenerateStudentQuizSchema.safeParse(body.data);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid generation payload."));
  }

  // Durable daily budget (admin client; table is service-role only). Day is
  // UTC — accepted per plan D7: a fixed boundary is fine for a soft cost
  // guard (local-morning users get an "early" reset; harmless direction).
  // PRE-stream guard: stays a JSON 429 in both protocols.
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
    // Distinct code (lecturer-route parity): "already running" ≠ quota spent.
    return jsonError("already_running", "A generation for this quiz is already in progress.", 429);
  }
  inFlight.add(id);

  // Append-clamp pre-check — pre-stream JSON segment (both protocols).
  const { count: existingCount, error: countError } = await supabase
    .from("student_quiz_questions")
    .select("*", { count: "exact", head: true })
    .eq("quiz_id", id);
  if (countError) {
    inFlight.delete(id);
    return internalError("Could not check existing quiz questions.");
  }
  const existing = existingCount ?? 0;
  const remaining = QUESTION_CAP - existing;
  if (remaining <= 0) {
    inFlight.delete(id);
    return unprocessable(
      `A practice quiz can hold up to ${QUESTION_CAP} questions.`,
      "question_cap_reached",
    );
  }

  // audit-3 H3-ATOM-F1: snapshot the ids that exist BEFORE the LLM call. The
  // save's replace branch deletes ONLY these (plus, for the legacy path, no
  // rows at all when the list is null), so a manual question appended while
  // the 30-900 s generation runs is never destroyed. Previously the mode was
  // latched from `existing` and the RPC's replace branch deleted every row.
  let existingIds: string[] = [];
  if (existing > 0) {
    const { data: idRows, error: idsError } = await supabase
      .from("student_quiz_questions")
      .select("id")
      .eq("quiz_id", id);
    if (idsError) {
      inFlight.delete(id);
      return internalError("Could not check existing quiz questions.");
    }
    existingIds = (idRows ?? []).map((r) => r.id);
  }

  const ctx: GenerationContext = {
    supabase,
    admin,
    quizId: id,
    userId: owner.userId,
    body: parsed.data,
    day,
    usedToday: usageRow?.count ?? 0,
    existing,
    existingIds,
    remaining,
    deadlineMs: Date.now() + GENERATION_BUDGET_MS,
  };

  if (!wantsStream(request)) {
    try {
      return await runLegacyGeneration(ctx, request.signal);
    } finally {
      inFlight.delete(id);
    }
  }
  return streamGeneration(ctx, request);
}

// ─── Shared context ──────────────────────────────────────────────────────────

type GenerationContext = {
  supabase: Awaited<ReturnType<typeof createClient>>;
  admin: ReturnType<typeof createAdminClient>;
  quizId: string;
  userId: string;
  body: import("zod").infer<typeof GenerateStudentQuizSchema>;
  day: string;
  usedToday: number;
  existing: number;
  /** Ids present BEFORE the LLM call (audit-3 H3-ATOM-F1 replace scope). */
  existingIds: string[];
  remaining: number;
  deadlineMs: number;
};

// ─── Phase 1: source preparation (parse) ─────────────────────────────────────

type PreparedSource =
  | { ok: true; text: string; parsed: boolean }
  | { ok: false; response: NextResponse };

async function prepareSource(ctx: GenerationContext): Promise<PreparedSource> {
  const { supabase, quizId, userId, body } = ctx;
  let text = body.extractedText;
  // Truth marker for the stream wrapper's Parse stage (lecturer-route parity):
  // extractedText present = no server-side parse happened.
  let parsed = false;
  const paths = body.sourcePaths ?? [];

  // Strict tenant isolation: every path must live in `${uid}/${quizId}/`.
  const expectedPrefix = `${userId.toLowerCase()}/${quizId.toLowerCase()}/`;
  for (const p of paths) {
    const lower = p.toLowerCase();
    if (!lower.startsWith(expectedPrefix)) {
      return { ok: false, response: invalidBody("All source files must reside in this quiz's storage folder.") };
    }
    if (p.includes("..") || p.includes("//") || normalizePath(p) !== p) {
      return { ok: false, response: invalidBody("sourcePath contains invalid path traversal segments.") };
    }
  }

  if (!text && paths.length === 0) {
    return { ok: false, response: invalidBody("No extracted text or source file provided.") };
  }

  if (!text) {
    parsed = true;
    const extractedTexts: string[] = [];
    let totalBytes = 0;
    for (let i = 0; i < paths.length; i++) {
      const parse = await downloadAndParseNative(supabase, paths[i]);
      if (parse.error) return { ok: false, response: parse.error };
      totalBytes += parse.byteLength ?? 0;
      if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
        return {
          ok: false,
          response: payloadTooLarge(
            `Total size of all source files exceeds the ${MAX_TOTAL_UPLOAD_BYTES / 1_000_000} MB limit.`,
          ),
        };
      }
      if (parse.lowConfidence && paths.length === 1) {
        return {
          ok: false,
          response: unprocessable(
            "This file has too little extractable text. Re-upload it and run OCR in the browser.",
            "use_browser_ocr",
          ),
        };
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
    return { ok: false, response: unprocessable("Extracted text is empty. Try a different file.", "empty_text") };
  }
  if (text.length > MAX_AGGREGATE_CHARS) {
    text = text.slice(0, MAX_AGGREGATE_CHARS);
  }

  return { ok: true, text, parsed };
}

// ─── Phase 2: AI generation ──────────────────────────────────────────────────

async function runAiGeneration(
  ctx: GenerationContext,
  text: string,
  opts: {
    signal?: AbortSignal;
    onDelta?: Parameters<typeof chatStream>[0]["onDelta"];
    /** Milestone observer (stream mode): forwards the lib's validation-retry
     * marker so the stream can emit the Refine stage (lecturer-route parity). */
    onLibEvent?: (ev: GenerateQuizLibEvent) => void;
  } = {},
): Promise<GenerateQuizResult> {
  const ai = createAiClient();

  const chat: (messages: ChatMessage[], timeoutMs?: number) => Promise<ChatResult> = opts.onDelta
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
          if (r.error === "timeout") {
            return { ok: false, error: "timeout", usage: NO_CHAT_USAGE };
          }
          return {
            ok: false,
            error: "ai_error",
            message: r.error === "cancelled" ? "cancelled" : r.message,
            usage: NO_CHAT_USAGE,
          };
        }
        // The streaming path does not parse usage (no booking consumer).
        return { ok: true, text: r.text, usage: NO_CHAT_USAGE };
      }
    : async (messages, timeoutMs) =>
        chatCompletions({ client: ai, model: AI_MODEL, messages, timeoutMs, signal: opts.signal });

  return generateQuiz({
    chat,
    text,
    questionCount: Math.min(ctx.body.questionCount ?? 10, ctx.remaining),
    language: ctx.body.language,
    difficulty: ctx.body.difficulty,
    formatDistribution: "mixed",
    steeringPrompt: undefined,
    deadlineMs: ctx.deadlineMs,
    onEvent: opts.onLibEvent,
  });
}

/** Map a failed GenerateQuizResult to the exact legacy error response. */
function generationErrorResponse(result: Exclude<GenerateQuizResult, { ok: true }>): NextResponse {
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
    "The AI did not return a valid quiz. Try a different file or model.",
    "invalid_ai_output",
  );
}

// ─── Phase 3: save ───────────────────────────────────────────────────────────

type SaveOutcome =
  | { kind: "ok"; payload: { questions: unknown[]; capped: boolean } }
  | { kind: "error"; response: NextResponse };

async function saveGeneration(
  ctx: GenerationContext,
  text: string,
  result: Extract<GenerateQuizResult, { ok: true }>,
  opts: { signal?: AbortSignal } = {},
): Promise<SaveOutcome> {
  const { supabase, admin, quizId, userId, day, usedToday, remaining, existingIds } = ctx;
  const rowsAll = aiQuizToRows(result.quiz);
  // Models may over-deliver vs the requested count; clamp so an over-generous
  // batch can never push past the 50-cap (the bulk RPC would otherwise reject
  // the WHOLE batch atomically). remaining > 0 is guaranteed by the pre-check.
  const rows = rowsAll.slice(0, remaining);
  if (rows.length === 0) {
    return {
      kind: "error",
      response: unprocessable(
        `A practice quiz can hold up to ${QUESTION_CAP} questions.`,
        "question_cap_reached",
      ),
    };
  }
  // audit-3 H3-ATOM-F1: replace vs append is decided by the SNAPSHOT taken
  // before the LLM call (ctx.existingIds), and the replace branch is scoped
  // to exactly those ids — a manual question appended during the generation
  // survives. An empty snapshot means "seed a new quiz" (replace).
  const mode = ctx.existing > 0 ? "append" : "replace";

  // Cancel checkpoint: a cancelled generation must NOT persist rows the
  // client never saw (no zombie save).
  if (opts.signal?.aborted) {
    return { kind: "error", response: jsonError("cancelled", "Generation cancelled.", 409) };
  }

  const { data: saved, error: rpcError } = await supabase.rpc(
    "save_student_quiz_questions",
    {
      p_quiz_id: quizId,
      p_questions: rows,
      p_mode: mode,
      // audit-1 P1-10: an append retry after a post-commit abort is deduped
      // by this tag (the RPC returns the saved rows instead of re-appending).
      p_generation_id: ctx.body.generationId ?? null,
      // audit-3 H3-ATOM-F1: scope the replace delete to the rows that existed
      // BEFORE the LLM call — a manual question appended meanwhile survives.
      // Null on append (unused by that branch).
      p_replace_ids: mode === "replace" ? existingIds : null,
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
      return { kind: "error", response: notFound() };
    }
    if (msg.includes("question_cap_reached")) {
      return {
        kind: "error",
        response: unprocessable(
          `Appending these questions exceeds the maximum limit of ${QUESTION_CAP} per practice quiz.`,
          "question_cap_reached",
        ),
      };
    }
    if (msg.includes("invalid_mode")) {
      return { kind: "error", response: unprocessable("Invalid save mode.", "invalid_mode") };
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
      return {
        kind: "error",
        response: unprocessable(
          "The AI produced questions that failed validation. Try again.",
          "invalid_ai_output",
        ),
      };
    }
    return { kind: "error", response: internalError("Could not save the generated questions right now.") };
  }

  // Budget consumed ONLY on success (soft last-writer-wins increment is fine
  // for a cost guard). Post-save write — its failure is deliberately
  // swallowed (cost guard drift is acceptable; a data error is not).
  await admin
    .from("ai_generation_usage")
    .upsert(
      { user_id: userId, day, count: usedToday + 1 },
      { onConflict: "user_id,day" },
    );

  return {
    kind: "ok",
    payload: {
      questions: saved ?? [],
      // True when the model over-delivered past the remaining cap slots and
      // rows were dropped — the client surfaces a partial-add notice.
      capped: rowsAll.length > rows.length,
    },
  };
}

// ─── Protocol runners ────────────────────────────────────────────────────────

/** LEGACY (default) protocol — byte-identical behavior to the pre-stream route. */
async function runLegacyGeneration(ctx: GenerationContext, signal: AbortSignal): Promise<NextResponse> {
  const prepared = await prepareSource(ctx);
  if (!prepared.ok) return prepared.response;

  const result = await runAiGeneration(ctx, prepared.text, { signal });
  if (!result.ok) return generationErrorResponse(result);

  const saved = await saveGeneration(ctx, prepared.text, result, { signal });
  if (saved.kind === "ok") {
    return NextResponse.json(saved.payload, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return saved.response;
}

/** STREAM (opt-in) protocol — NDJSON events (lecturer-route parity). */
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
          closed = true;
        }
      };
      const sendError = async (r: NextResponse) => {
        const body = (await r.clone().json().catch(() => null)) as
          | { error?: string; message?: string }
          | null;
        send({ type: "error", code: body?.error ?? "internal", message: body?.message });
      };
      // Heartbeat scoped to silent phases (lecturer-route parity): skipped
      // once deltas flow (deltas prove liveness).
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
        // Truth rule (lecturer-route parity): Parse events only on real parse
        // work; client-extracted text marks the stage skipped.
        if (prepared.parsed) {
          send({ type: "stage", stage: "parse", status: "start" });
          send({ type: "stage", stage: "parse", status: "done", detail: String(prepared.text.length) });
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
        const saved = await saveGeneration(ctx, prepared.text, result, { signal: internal.signal });
        if (saved.kind === "error") {
          if (internal.signal.aborted) {
            send({ type: "cancelled" });
          } else {
            await sendError(saved.response);
          }
          return;
        }
        // audit-1 P1-10 (post-commit abort honesty): the RPC has NO
        // abort signal — an abort landing mid-RPC still commits, and the
        // old code answered the dead stream with `done` (never delivered)
        // or nothing. Say CANCELLED: the user asked to cancel, and the
        // idempotency key makes the retry safe either way.
        if (internal.signal.aborted) {
          send({ type: "cancelled" });
          return;
        }
        send({ type: "done", payload: saved.payload });
      } catch (err) {
        console.error("student generation stream error:", err);
        send({ type: "error", code: "internal", message: "Could not generate the questions right now." });
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
      internal.abort("cancelled");
      releaseGuard();
      request.signal.removeEventListener("abort", onClientAbort);
    },
  });

  return new Response(stream, { headers: STREAM_RESPONSE_HEADERS });
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
