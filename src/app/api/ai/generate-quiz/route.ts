import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireQuizOwner } from "@/lib/quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { GenerateQuizSchema } from "@/lib/ai/validation";
import { createAiClient, chatCompletions, chatStream, AI_MODEL, NO_CHAT_USAGE, type ChatMessage, type ChatResult } from "@/lib/ai/client";
import {
  generateQuiz,
  type GenerateQuizLibEvent,
  type GenerateQuizResult,
} from "@/lib/ai/quiz-prompt";
import type { GroundedSearchLibEvent } from "@/lib/ai/tinyfish";
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
  runGroundedSearch,
  type WebSourceEntry,
} from "@/lib/ai/tinyfish";
import {
  firstIssueMessage,
  internalError,
  invalidBody,
  jsonError,
  notDraft,
  notFound,
  payloadTooLarge,
  rateLimited,
  readCappedJson,
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

  // Authenticate before parsing — an unauthenticated caller must not be able
  // to force large-body materialization on the server.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return notFound();

  // Streaming-capped read (512 KB): extractedText can legitimately approach
  // ~400 KB, so this generous cap only stops abusive payloads.
  const body = await readCappedJson(request, 512 * 1024);
  if (!body.ok) return body.response;

  const parsed = GenerateQuizSchema.safeParse(body.data);
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
    const precheck = await appendCapacityError(quizId, parsed.data.questionCount ?? 10);
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

/**
 * 422/400 for an append request that can't fit (pre-stream JSON segment).
 *
 * Service-role read (D2-19): 0054 revoked the base `questions` table from
 * `authenticated`, so this count cannot run on the user-scoped client. The
 * route is already lecturer-and-owner gated above, and the RPC's own cap
 * check stays authoritative — this is only the friendly pre-check.
 */
async function appendCapacityError(
  quizId: string,
  questionCount: number,
): Promise<NextResponse | null> {
  const { count: existingCount, error: countError } = await createAdminClient()
    .from("questions")
    .select("id", { count: "exact", head: true })
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

// ─── Phase 1: source preparation (parse / web search) ────────────────────────

type PreparedSource =
  | { ok: true; text: string; sourcePathFinal: string | null; sourcePaths: string[]; parsed: boolean; webSources: WebSourceEntry[] | null; webAugmented?: boolean }
  | { ok: false; response: NextResponse };

/** Guaranteed share of the aggregate budget reserved for the web corpus
 * (audit-3 F-F6). The web corpus is the fresh-knowledge ADDITION, so it must
 * survive the aggregate slice; the material is truncated FIRST when the two
 * together exceed MAX_AGGREGATE_CHARS. 40k ≈ 10% of the 400k cap. */
const WEB_CORPUS_MIN_SHARE = 40_000;

/**
 * Merge material + web corpus under MAX_AGGREGATE_CHARS while guaranteeing the
 * web corpus a minimum share (audit-3 F-F6). The material is truncated FIRST,
 * so a long upload/paste can no longer slice the web contribution away while
 * its citations are still persisted and reported. If the web corpus must
 * itself be cut (only possible when it exceeds the reserved share), the
 * citations for pages whose `=== WEB SOURCE [i/N]` header did not survive are
 * dropped, so provenance can never claim a page the model did not read.
 * Headerless corpora (legacy/test shapes) keep their sources — the text is
 * retained as a whole in that case.
 */
function mergeWithWebReserve(
  materialText: string,
  webText: string,
  webSources: WebSourceEntry[],
): { text: string; webSources: WebSourceEntry[] } {
  const material = materialText.trim();
  const web = webText.trim();
  if (!web) return { text: material.slice(0, MAX_AGGREGATE_CHARS), webSources: [] };

  const separator = 2;
  // Guarantee the web corpus up to its reserved share; material takes what's
  // left (truncated first). Web text longer than the reserve only survives if
  // the material leaves room for it.
  const webShare = Math.min(web.length, Math.max(WEB_CORPUS_MIN_SHARE, MAX_AGGREGATE_CHARS - material.length - separator));
  const materialKeep = Math.min(material.length, Math.max(0, MAX_AGGREGATE_CHARS - webShare - separator));
  const webKeep = Math.min(web.length, Math.max(0, MAX_AGGREGATE_CHARS - materialKeep - separator));
  const webKept = web.slice(0, webKeep);
  const text = `${material.slice(0, materialKeep)}\n\n${webKept}`;

  // Full web corpus retained → every fetched page is cited (normal case).
  if (webKeep >= web.length) return { text, webSources };

  // Web corpus truncated: keep only citations whose envelope header survived.
  const hasHeaders = /===\s*WEB\s+SOURCE\s*\[\d+\/\d+\]/.test(web);
  if (!hasHeaders) return { text, webSources };
  const survivors = webSources.filter((_, i) =>
    webKept.includes(`=== WEB SOURCE [${i + 1}/${webSources.length}]:`),
  );
  return { text, webSources: survivors };
}

/** The web-search branch of source preparation (augmentation model): the
 * web corpus is APPENDED to the material text under its own fence (fresh
 * real-world knowledge the uploads may lack) and a failed/thin/unconfigured
 * search DEGRADES to material-only — never fails the generation.
 * Search-stage events are emitted by the CALLER (stream mode wires
 * onLibEvent → tool events); legacy mode runs silently. */
async function prepareWebSource(
  ctx: GenerationContext,
  opts: {
    onLibEvent?: (event: GroundedSearchLibEvent) => void;
    signal?: AbortSignal;
    /** Material base (REQUIRED — web search always augments material). */
    base: { text: string; sourcePathFinal: string | null; sourcePaths: string[]; parsed: boolean };
  },
): Promise<PreparedSource> {
  const augmented = true;
  // createAiClient() throws on missing env OUTSIDE runGroundedSearch's
  // non-throwing internals — map it to the typed unavailable error.
  let ai: ReturnType<typeof createAiClient>;
  try {
    ai = createAiClient();
  } catch {
    // Augmentation degradation: without an AI client there is no query
    // planning, but the material alone still works — degrade, don't fail.
    if (augmented) {
      return { ok: true, ...opts.base!, sourcePaths: opts.base!.sourcePaths, webSources: null, webAugmented: true };
    }
    return {
      ok: false,
      response: jsonError("search_unavailable", "Web search is unavailable right now.", 503),
    };
  }
  const result = await runGroundedSearch({
    topic: ctx.body.topic!,
    questionCount: ctx.body.questionCount ?? 10,
    language: ctx.body.language ?? "auto",
    ai,
    deadlineMs: ctx.deadlineMs,
    signal: opts.signal,
    onEvent: opts.onLibEvent,
    // Augmentation: a thin web corpus is FINE — the material still grounds
    // the generation; topic-only mode keeps the strict thin rejection.
    allowThin: augmented,
  });
  if (!result.ok) {
    // Augmentation degradation: a failed search in material+web mode must
    // NOT fail the generation — the uploaded material alone is sufficient.
    // (`search_unavailable` also degrades: the key being absent is a config
    // problem the lecturer can't fix mid-generation.)
    if (augmented) {
      return { ok: true, ...opts.base!, sourcePaths: opts.base!.sourcePaths, webSources: null, webAugmented: true };
    }
    const response =
      result.error === "search_corpus_thin"
        ? unprocessable(
            result.message ?? "The web pages found for this topic contain too little text.",
            "search_corpus_thin",
          )
        : result.error === "search_unavailable"
          ? jsonError(
              "search_unavailable",
              result.message ?? "Web search is unavailable right now. Try again later.",
              503,
            )
          : jsonError(
              "search_failed",
              result.message ?? "Web search failed. Try again.",
              502,
            );
    return { ok: false, response };
  }
  if (augmented) {
    // Merge: material first (primary grounding), then the web corpus under
    // its own fence header so the model can tell the kinds apart.
    //
    // audit-3 F-F6: the old merge-then-slice put the web corpus LAST and then
    // truncated the aggregate to MAX_AGGREGATE_CHARS — a long material corpus
    // (pasted text up to the cap) sliced the entire web contribution away
    // while the citations were still persisted and the payoff still reported
    // "N web pages". Reserve a guaranteed minimum share for the web corpus
    // (truncating the MATERIAL first when necessary) so persisted citations
    // always correspond to text the model actually read.
    const { text, webSources } = mergeWithWebReserve(
      opts.base!.text,
      result.text,
      result.sources,
    );
    return {
      ok: true,
      text,
      sourcePathFinal: opts.base!.sourcePathFinal,
      sourcePaths: opts.base!.sourcePaths,
      parsed: opts.base!.parsed,
      webSources,
      webAugmented: true,
    };
  }
  return {
    ok: true,
    text: result.text,
    sourcePathFinal: null,
    sourcePaths: [],
    parsed: false,
    webSources: result.sources,
  };
}

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
  // Every validated path that contributed text — forwarded to the save RPC as
  // p_source_paths so EACH file gets a provenance chip (0041; previously only
  // pathsToProcess[0] was persisted and the chip count under-reported).
  const contributedPaths: string[] = [];

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
        contributedPaths.push(p);
        extractedTexts.push(
          pathsToProcess.length > 1
            ? `=== SOURCE [${i + 1}/${pathsToProcess.length}]: ${filename} ===\n${parse.text.trim()}`
            : parse.text.trim(),
        );
      } else {
        // audit-3 F-F5: a file that yielded no text is NOT claimed as a source
        // (contributedPaths above only ever receives contributors) — and it is
        // no longer silent: log the drop so the API-only path leaves a trace.
        // The shipped UI extracts client-side, where the dialog reports the
        // skipped files to the user directly.
        console.warn(
          `[generate-quiz] source skipped (no extractable text): ${p}${parse.lowConfidence ? " (low confidence)" : ""}`,
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

  // Client-extracted text rides with sourcePaths — the files were uploaded
  // and are legitimate provenance even though no server parse happens.
  const finalPaths =
    contributedPaths.length > 0
      ? contributedPaths
      : body.sourcePaths && body.sourcePaths.length > 0
        ? body.sourcePaths
        : sourcePathFinal
          ? [sourcePathFinal]
          : [];

  return { ok: true, text, sourcePathFinal, sourcePaths: finalPaths, parsed, webSources: null };
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
            if (r.error === "timeout") {
              return { ok: false, error: "timeout", usage: NO_CHAT_USAGE };
            }
            // Cancelled maps into the generic channel; the ROUTE checks the
            // abort signal between phases and emits the dedicated
            // `cancelled` event instead.
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
  if (result.error === "cancelled") {
    // audit-2 M-21: a caller abort (navigate/close) that raced past the save
    // checkpoint must read as `cancelled` 409 — the old collapse to the
    // retryable timeout 503 provoked instant retries that re-appended
    // batches (compounding M-26). Same shape as the save checkpoint below.
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
  | { kind: "ok"; payload: { quiz: unknown; questions: unknown[] } }
  | { kind: "error"; response: NextResponse }
  | { kind: "saved_refresh_failed"; questions: unknown[] };

async function saveGeneration(
  ctx: GenerationContext,
  prepared: { text: string; sourcePathFinal: string | null; sourcePaths: string[]; webSources: WebSourceEntry[] | null },
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

  // Build the RPC args with a typed boundary. The generate route ALWAYS uses
  // save_quiz_questions_web (the 6-arg sibling stays reserved for its other
  // callers — the import route — per 0040's PostgREST overload note): the 0041
  // function carries p_web_sources AND p_source_paths (the full file list —
  // one provenance chip per uploaded file; the single p_source_file_url only
  // fed the primary path and under-counted multi-file builds).
  // audit-3 F-F7: the AI-generated title is a VALIDATION GATE only (see
  // AiQuizSchema's title contract) — it is never applied. The quiz already has
  // a lecturer-chosen NOT NULL title, so the RPC's coalesce(p_title, title)
  // is a no-op by construction; p_title carries that existing title.
  type SaveQuizQuestionsWebArgs = {
    p_quiz_id: string;
    p_title: string;
    p_source_file_url: string | null;
    p_source_text: string | null;
    p_questions: unknown;
    p_mode: string;
    p_web_sources?: unknown;
    p_source_paths?: unknown;
  };
  const rpcArgs: SaveQuizQuestionsWebArgs = {
    p_quiz_id: quizId,
    p_title: quizTitle,
    p_source_file_url: prepared.sourcePathFinal ?? null,
    p_source_text: prepared.text,
    p_questions: rows,
    p_mode: ctx.body.mode,
    p_source_paths: prepared.sourcePaths.length > 0 ? prepared.sourcePaths : null,
    // Web provenance: the RPC skips web-entry assembly for a null/empty set.
  };
  if (prepared.webSources !== null && prepared.webSources.length > 0) {
    rpcArgs.p_web_sources = prepared.webSources;
  }

  const { data: questions, error: rpcError } = await supabase.rpc(
    "save_quiz_questions_web",
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

  // The RPC returns VOID (0040/0041) — `questions` above is always null, so
  // both the stream done-event and the legacy JSON payload previously
  // reported "0 questions" on every success. Read the saved rows back: the
  // payload carries the REAL questions (and the client's count stops lying).
  // Service-role read (D2-19): 0054 revoked the base table from `authenticated`.
  const readBack = () =>
    createAdminClient()
      .from("questions")
      .select("id, quiz_id, order_index, type, prompt, options, correct_index, correct_indices, explanation")
      .eq("quiz_id", quizId)
      .order("order_index", { ascending: true });

  const { data: savedQuestions, error: readBackError } = await readBack();

  if (readBackError) {
    // audit-2 L-11: a failed readback used to degrade to an ok-with-[]
    // response — the client was told "success, 0 questions" for a committed
    // save, which provoked a retry that could duplicate the appended batch
    // (compounding M-26). Retry once; if it still fails, return the same
    // honest saved_refresh_failed contract the quiz-object arm uses.
    console.error("Saved question readback error (retrying once):", readBackError);
    const retry = await readBack();
    if (retry.error) {
      console.error("Saved question readback retry failed:", retry.error);
      return { kind: "saved_refresh_failed", questions: [] };
    }
    return {
      kind: "ok",
      payload: {
        quiz,
        questions: retry.data ?? [],
      },
    };
  }

  return {
    kind: "ok",
    payload: {
      quiz,
      questions: savedQuestions ?? [],
    },
  };
}

// ─── Protocol runners ────────────────────────────────────────────────────────

/** LEGACY (default) protocol — byte-identical behavior to the pre-stream route. */
async function runLegacyGeneration(ctx: GenerationContext, signal: AbortSignal): Promise<NextResponse> {
  // Web search is ALWAYS an augmentation of material (topic-only was
  // removed): prepareSource first (its no-source rejection is authoritative),
  // then the web corpus is appended — degrading to material-only when the
  // search fails or is unconfigured.
  if (ctx.body.useWebSearch) {
    const material = await prepareSource(ctx);
    if (!material.ok) return material.response;
    const prepared = await prepareWebSource(ctx, {
      signal,
      base: { text: material.text, sourcePathFinal: material.sourcePathFinal, sourcePaths: material.sourcePaths, parsed: material.parsed },
    });
    if (!prepared.ok) return prepared.response;

    const result = await runAiGeneration(ctx, prepared.text, { signal });
    if (!result.ok) return generationErrorResponse(result);
    const saved = await saveGeneration(
      ctx,
      { text: prepared.text, sourcePathFinal: prepared.sourcePathFinal, sourcePaths: prepared.sourcePaths, webSources: prepared.webSources },
      result,
      { signal },
    );
    if (saved.kind === "ok") return NextResponse.json(saved.payload);
    if (saved.kind === "saved_refresh_failed") {
      return internalError("Could not load the updated quiz right now.");
    }
    return saved.response;
  }

  const prepared = await prepareSource(ctx);
  if (!prepared.ok) return prepared.response;

  const result = await runAiGeneration(ctx, prepared.text, { signal });
  if (!result.ok) return generationErrorResponse(result);

  const saved = await saveGeneration(
    ctx,
    { text: prepared.text, sourcePathFinal: prepared.sourcePathFinal, sourcePaths: prepared.sourcePaths, webSources: null },
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
        // Web search is ALWAYS an augmentation of material: the material
        // parses FIRST (real Parse stage), then the search stage appends
        // fresh web knowledge; a failed/unconfigured search degrades to
        // material-only (never fails the run). Rail truth rule preserved:
        // Parse events always precede Search events.
        let prepared: PreparedSource;
        if (ctx.body.useWebSearch) {
          const material = await prepareSource(ctx);
          if (!material.ok) {
            await sendError(material.response);
            return;
          }
          if (material.parsed) {
            send({ type: "stage", stage: "parse", status: "start" });
            send({
              type: "stage",
              stage: "parse",
              status: "done",
              detail: String(material.text.length),
            });
          } else {
            send({ type: "stage", stage: "parse", status: "skip" });
          }
          if (internal.signal.aborted) {
            send({ type: "cancelled" });
            return;
          }
          send({ type: "stage", stage: "search", status: "start" });
          prepared = await prepareWebSource(ctx, {
            signal: internal.signal,
            base: { text: material.text, sourcePathFinal: material.sourcePathFinal, sourcePaths: material.sourcePaths, parsed: material.parsed },
            onLibEvent: (ev) => {
              if (ev.type === "tool_call") {
                send({ type: "tool_call", tool: ev.tool, query: ev.query });
              } else {
                send({
                  type: "tool_result",
                  tool: ev.tool,
                  query: ev.query,
                  resultCount: ev.resultCount,
                  ...(ev.skipped !== undefined ? { skipped: ev.skipped } : {}),
                  ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
                });
              }
            },
          });
          if (!prepared.ok) {
            // A user cancel during search must surface as `cancelled`, not a
            // search failure (mirror the save-phase pattern).
            if (internal.signal.aborted) {
              send({ type: "cancelled" });
              return;
            }
            await sendError(prepared.response);
            return;
          }
          send({
            type: "stage",
            stage: "search",
            status: "done",
            // Truthful payoff figure: pages actually fetched (≤3).
            detail: String(prepared.webSources?.length ?? 0),
          });
          if (internal.signal.aborted) {
            send({ type: "cancelled" });
            return;
          }
        } else {
          prepared = await prepareSource(ctx);
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
          { text: prepared.text, sourcePathFinal: prepared.sourcePathFinal, sourcePaths: prepared.sourcePaths, webSources: prepared.webSources },
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
        // audit-1 P1-10 (post-commit abort honesty): the save RPC has no
        // abort signal — an abort landing mid-RPC still commits, and the
        // old code answered a possibly-dead stream with `done`. The user
        // asked to cancel; tell them cancelled (rows remain tagged and the
        // builder refresh shows the truth on return).
        if (internal.signal.aborted) {
          send({ type: "cancelled" });
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
