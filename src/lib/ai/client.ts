import "server-only";
import OpenAI from "openai";
import {
  AI_MAX_OUTPUT_TOKENS,
  AI_ROUND_TRIP_TIMEOUT_MS,
} from "@/lib/ai/quiz-schema";

/**
 * OpenAI-compatible AI client (SERVER-ONLY).
 *
 * PLAN §0 locked decision: `openai` npm SDK with a `baseURL` override, so the
 * same client works with OpenAI, OpenRouter, Gemini-compatible endpoints, and
 * local vLLM. Config via env: AI_BASE_URL / AI_API_KEY / AI_MODEL.
 *
 * `import "server-only"` guarantees this module (and the API key) can never be
 * bundled into a client component (S8 from the P4 plan review).
 */

export const AI_MODEL = process.env.AI_MODEL ?? "gpt-4o-mini";

let client: OpenAI | null = null;

export function createAiClient(): OpenAI {
  if (client) return client;
  const baseURL = process.env.AI_BASE_URL;
  const apiKey = process.env.AI_API_KEY;
  if (!baseURL || !apiKey) {
    throw new Error("AI_BASE_URL and AI_API_KEY must be set to use the AI client.");
  }
  client = new OpenAI({ baseURL, apiKey });
  return client;
}

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatUsage = {
  /** Provider-reported total tokens, 0 when the body carried no usage. */
  totalTokens: number;
  /** True when the body actually carried recognisable usage numbers. */
  usagePresent: boolean;
};

/** No usage was parsed (transport failure / absent field) — never a fake 0. */
export const NO_CHAT_USAGE: ChatUsage = { totalTokens: 0, usagePresent: false };

/**
 * Normalise the SDK's `usage` object (snake_case, possibly absent or
 * malformed). Coercion mirrors `http-compat.ts`'s parseUsage: a numeric
 * STRING is accepted, anything non-finite collapses to 0 with
 * `usagePresent:false` — a billed call must never be recorded as free, and a
 * garbage value must never become NaN in the spend ledger.
 */
function parseChatUsage(raw: unknown): ChatUsage {
  if (raw === null || typeof raw !== "object") return NO_CHAT_USAGE;
  const rec = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => {
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const prompt = num(rec.prompt_tokens);
  const completion = num(rec.completion_tokens);
  const total = num(rec.total_tokens);
  const present = prompt !== null || completion !== null || total !== null;
  if (!present) return NO_CHAT_USAGE;
  return {
    totalTokens: Math.max(0, total ?? (prompt ?? 0) + (completion ?? 0)),
    usagePresent: true,
  };
}

export type ChatResult =
  // audit-4 M1: the ok arm carries the provider's usage so the marking
  // worker can book tokens/usd into `ai_marking_ledger` — without it the
  // sweep's spend caps summed zeros forever and never tripped.
  | { ok: true; text: string; usage: ChatUsage }
  // audit-2 M-21: "cancelled" (caller aborted — navigate/close/client
  // timeout) is distinct from "timeout" (deadline). The legacy
  // chatCompletions path used to collapse both, so a user-cancel surfaced as
  // the retryable 503 timeout.
  | { ok: false; error: "timeout" | "cancelled" | "ai_error"; message?: string; usage: ChatUsage };

/**
 * Salvage the last JSON object embedded in a reasoning trace (Kenari docs:
 * reasoning passes through unfiltered, and thinking models sometimes emit the
 * COMPLETE answer only into the reasoning channel with `content` empty —
 * observed live with GLM: full quiz JSON in `reasoning`, empty content,
 * finish_reason "stop"). Scans for balanced `{...}` spans — string-aware, so
 * braces inside JSON strings don't break the count — JSON.parse-checks each
 * candidate, and returns the LAST parseable one: reasoning traces often draft
 * and abandon earlier attempts, so the final object is the considered answer.
 * Returns null when the trace holds no parseable object. Callers downstream
 * still schema-validate, so salvage only converts a hard failure into a
 * validated attempt.
 */
export function salvageJsonFromReasoning(reasoningText: string): string | null {
  // Two passes, because reasoning traces break in BOTH directions:
  //  1. String-aware: quotes delimit strings so braces inside them (U-ST12)
  //     don't unbalance the scan. But an UNTERMINATED draft string
  //     (`{"title":"draft … nah`) flips parity and poisons everything after.
  //  2. String-blind (only if pass 1 found nothing): brace matching alone,
  //     with JSON.parse as the only gate — recovers from parity poisoning
  //     (U-ST11). Abandoned drafts leave unclosed `{`s on the stack, which is
  //     harmless: only parseable completions update `lastGood`, and the
  //     outermost object of the final group closes last ("last parseable" =
  //     the considered answer).
  for (const stringAware of [true, false]) {
    const open: number[] = [];
    let inString = false;
    let escaped = false;
    let lastGood: string | null = null;
    for (let i = 0; i < reasoningText.length; i++) {
      const ch = reasoningText[i];
      if (stringAware && inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (stringAware && ch === '"') {
        inString = true;
      } else if (ch === "{") {
        open.push(i);
      } else if (ch === "}") {
        if (open.length > 0) {
          const candidate = reasoningText.slice(open.pop()!, i + 1);
          try {
            JSON.parse(candidate);
            lastGood = candidate;
          } catch {
            // Not parseable (prose fragment, ellipsized draft) — keep scanning.
          }
        }
      }
    }
    if (lastGood !== null) return lastGood;
  }
  return null;
}

/**
 * One chat-completions round-trip with a hard wall-clock timeout. Local-only
 * deployment: the timeout is a generous ceiling (10 min default, clamped by
 * any caller-provided deadline) so long 30-question generations aren't aborted
 * mid-stream.
 */
export async function chatCompletions(opts: {
  client: OpenAI;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /**
   * When false, omit `response_format: { type: "json_object" }`. OpenAI and
   * some compatible providers reject this mode unless the word "json" appears
   * in the messages; for OCR transcription routes this is wrong. Defaults to
   * true (JSON) so existing callers stay unchanged.
   */
  jsonMode?: boolean;
  /**
   * Sampling temperature. Defaults to 0.7 for creative generation; OCR
   * transcription routes should pass 0 for deterministic output.
   */
  temperature?: number;
  /**
   * Hard deadline for THIS call in milliseconds. If set, the per-call 45s
   * abort timer is clamped to the smaller of the two — lets callers that
   * chain calls (e.g. attempt+retry in `generateQuiz`) share a single
   * deadline so the second call doesn't get the full 45s budget when only
   * 5s of the overall 50s remain.
   */
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ChatResult> {
  const { client: ai, model, messages, maxTokens = AI_MAX_OUTPUT_TOKENS, jsonMode = true, temperature = 0.7 } = opts;
  // audit-3 F-F9: an already-aborted outer signal must bail BEFORE issuing the
  // request — the listener below only fires on a FUTURE abort, so a client
  // that disconnected while the prompt was being assembled still bought a
  // full-priced LLM round trip.
  if (opts.signal?.aborted) return { ok: false, error: "cancelled", usage: NO_CHAT_USAGE };
  const controller = new AbortController();
  const perCallTimeout = opts.timeoutMs
    ? Math.min(AI_ROUND_TRIP_TIMEOUT_MS, opts.timeoutMs)
    : AI_ROUND_TRIP_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), perCallTimeout);

  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort);

  try {
    const completion = await ai.chat.completions.create(
      {
        model,
        messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        temperature,
        max_tokens: maxTokens,
        ...(jsonMode ? { response_format: { type: "json_object" as const } } : {}),
      },
      { signal: controller.signal },
    );
    // A billed call reports its usage on EVERY arm from here on (audit-4
    // M1), including the truncated/reasoning-only failures.
    const usage = parseChatUsage((completion as { usage?: unknown }).usage);
    const choice = completion.choices?.[0];
    if (choice?.finish_reason === "length") {
      return {
        ok: false,
        error: "ai_error",
        message: "Response truncated (token budget reached).",
        usage,
      };
    }
    const text = choice?.message?.content ?? "";
    if (!text) {
      // Reasoning-only answer (Kenari/GLM): the full JSON sometimes lands in
      // message.reasoning with content empty — salvage it instead of failing.
      const reasoning = (choice?.message as { reasoning?: string | null } | undefined)?.reasoning ?? "";
      const salvaged = reasoning ? salvageJsonFromReasoning(reasoning) : null;
      if (salvaged) return { ok: true, text: salvaged, usage };
      return { ok: false, error: "ai_error", message: "Empty model response.", usage };
    }
    return { ok: true, text, usage };
  } catch (err) {
    const aborted =
      controller.signal.aborted ||
      (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"));
    if (aborted) {
      // audit-2 M-21: the outer (caller) abort and the deadline both abort
      // this controller — tell them apart so a cancel never reads as the
      // retryable timeout.
      if (opts.signal?.aborted) return { ok: false, error: "cancelled", usage: NO_CHAT_USAGE };
      return { ok: false, error: "timeout", usage: NO_CHAT_USAGE };
    }
    const msg = err instanceof Error ? err.message : "Unknown AI error";
    return { ok: false, error: "ai_error", message: msg, usage: NO_CHAT_USAGE };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * One STREAMING chat-completions round-trip (Phase 1.5 — the prerequisite for
 * reasoning deltas, tool loops, and incremental question parsing). Buffers the
 * full content (the return shape stays ChatResult-compatible so `generateQuiz`
 * callers are unchanged) while forwarding every delta to `onDelta` as it
 * arrives.
 *
 * Timeout model (differs from `chatCompletions` on purpose):
 *  - `timeoutMs` still caps the WHOLE call.
 *  - An additional INTER-CHUNK idle timeout (`AI_STREAM_IDLE_TIMEOUT_MS`,
 *    default 90s) aborts when the upstream goes silent mid-stream — a stalled
 *    proxy must not hold the generation open until the full deadline. The
 *    e2e harness overrides it to 3s so stall scenarios are testable.
 *  - Abort REASONS are distinguished: `deadline` (whole-call budget),
 *    `idle` (upstream silence), `cancelled` (caller/request signal) — callers
 *    can tell a user cancel from a timeout instead of every abort mapping to
 *    "timeout" like the legacy path does.
 *
 * Reasoning passthrough: Kenari emits `reasoning_content` (and duplicates it
 * as `reasoning`) on reasoning models — verified by scripts/spike-kenari.mjs.
 * The SDK (openai@7.4.0) does not type these fields, hence the local cast.
 * Tool-call fragments are accumulated by index (id/name once, arguments
 * concatenated across chunks) and returned for the Phase 5 calc loop.
 */
export type StreamDelta = {
  reasoning: string;
  content: string;
  toolCalls: Array<{ index: number; id?: string; name?: string; arguments: string }>;
};

export type ChatStreamResult =
  | {
      ok: true;
      text: string;
      reasoningText: string;
      finishReason: string | null;
      toolCalls: Array<{ index: number; id?: string; name?: string; arguments: string }>;
    }
  | { ok: false; error: "timeout" | "cancelled" | "ai_error"; message?: string; finishReason?: string | null };

type StreamToolAcc = Map<number, { id?: string; name?: string; arguments: string }>;

export async function chatStream(opts: {
  client: OpenAI;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  jsonMode?: boolean;
  temperature?: number;
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
  /** Hard deadline for THIS call in milliseconds (whole-call budget). */
  timeoutMs?: number;
  /** Abort when no chunk arrives for this long (default env / 90s). */
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  onDelta?: (delta: StreamDelta) => void;
}): Promise<ChatStreamResult> {
  const {
    client: ai,
    model,
    messages,
    maxTokens = AI_MAX_OUTPUT_TOKENS,
    jsonMode = true,
    temperature = 0.7,
  } = opts;
  const idleMs = opts.idleTimeoutMs ?? Number(process.env.AI_STREAM_IDLE_TIMEOUT_MS ?? 90_000);

  // audit-3 F-F9: same entry check as the legacy path — an outer signal that
  // is already aborted must not open a stream (and a paid call) at all.
  if (opts.signal?.aborted) return { ok: false, error: "cancelled" };

  const controller = new AbortController();
  // Held in an object because TS narrowing can't see the timer callbacks'
  // mutations; the reason at catch-time is whichever abort fired first.
  const abortState: { reason: "deadline" | "idle" | "cancelled" } = { reason: "deadline" };
  const wholeCallTimer = setTimeout(() => {
    abortState.reason = "deadline";
    controller.abort("deadline");
  }, opts.timeoutMs ? Math.min(AI_ROUND_TRIP_TIMEOUT_MS, opts.timeoutMs) : AI_ROUND_TRIP_TIMEOUT_MS);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimer = () => {
    if (idleMs <= 0) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      abortState.reason = "idle";
      controller.abort("idle");
    }, idleMs);
  };

  const onOuterAbort = () => {
    abortState.reason = "cancelled";
    controller.abort("cancelled");
  };
  opts.signal?.addEventListener("abort", onOuterAbort);

  try {
    armIdleTimer();
    const completion = await ai.chat.completions.create(
      {
        model,
        stream: true,
        messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        temperature,
        max_tokens: maxTokens,
        ...(jsonMode ? { response_format: { type: "json_object" as const } } : {}),
        ...(opts.tools ? { tools: opts.tools } : {}),
      },
      { signal: controller.signal },
    );

    let text = "";
    let reasoningText = "";
    let finishReason: string | null = null;
    const toolAcc: StreamToolAcc = new Map();

    for await (const chunk of completion) {
      clearTimeout(idleTimer);
      armIdleTimer();
      const choice = (chunk.choices ?? [])[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      // Kenari duplicates reasoning as both `reasoning` and `reasoning_content`
      // (spike-verified); prefer the canonical field, fall back to the twin.
      // The SDK (openai@7.4.0) types neither, hence the local widening.
      const delta = choice.delta as OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
        reasoning_content?: string | null;
        reasoning?: string | null;
      };
      const reasoning = (delta.reasoning_content ?? delta.reasoning ?? "") ?? "";
      const content = delta.content ?? "";
      const fragments = delta.tool_calls ?? [];
      for (const f of fragments) {
        const acc = toolAcc.get(f.index) ?? { id: undefined, name: undefined, arguments: "" };
        if (f.id) acc.id = f.id;
        if (f.function?.name) acc.name = f.function.name;
        if (f.function?.arguments) acc.arguments += f.function.arguments;
        toolAcc.set(f.index, acc);
      }
      if (reasoning || content || fragments.length > 0) {
        opts.onDelta?.({
          reasoning,
          content,
          toolCalls: fragments.map((f) => ({
            index: f.index,
            id: f.id,
            name: f.function?.name,
            arguments: f.function?.arguments ?? "",
          })),
        });
      }
      text += content;
      reasoningText += reasoning;
    }

    if (finishReason === "length") {
      return {
        ok: false,
        error: "ai_error",
        message: "Response truncated (token budget reached).",
        finishReason,
      };
    }
    // Belt-and-suspenders: an abort the SDK swallowed (iterator resolved
    // anyway) must still map to its reason, never to a fake success.
    if (controller.signal.aborted) {
      if (abortState.reason === "cancelled") return { ok: false, error: "cancelled" };
      return {
        ok: false,
        error: "timeout",
        message: abortState.reason === "idle" ? "The AI stream went silent." : undefined,
      };
    }
    if (!text && toolAcc.size === 0) {
      // Reasoning-only answer (Kenari/GLM): thinking models sometimes emit the
      // COMPLETE answer only into the reasoning channel (finish_reason "stop",
      // content empty — observed live with quiz JSON in `reasoning`). Salvage
      // the last parseable JSON object from the trace; if none, keep the
      // distinct budget-exhausted signature.
      const salvaged = reasoningText ? salvageJsonFromReasoning(reasoningText) : null;
      if (salvaged) {
        return { ok: true, text: salvaged, reasoningText, finishReason, toolCalls: [] };
      }
      return {
        ok: false,
        error: "ai_error",
        message: reasoningText
          ? "The model spent its whole budget thinking and returned no answer."
          : "Empty model response.",
        finishReason,
      };
    }
    const toolCalls = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, v]) => ({ index, id: v.id, name: v.name, arguments: v.arguments }));
    return { ok: true, text, reasoningText, finishReason, toolCalls };
  } catch (err) {
    const aborted = controller.signal.aborted;
    if (aborted && abortState.reason === "cancelled") {
      return { ok: false, error: "cancelled" };
    }
    if (aborted && (abortState.reason === "deadline" || abortState.reason === "idle")) {
      return {
        ok: false,
        error: "timeout",
        message: abortState.reason === "idle" ? "The AI stream went silent." : undefined,
      };
    }
    const msg = err instanceof Error ? err.message : "Unknown AI error";
    return { ok: false, error: "ai_error", message: msg };
  } finally {
    clearTimeout(wholeCallTimer);
    clearTimeout(idleTimer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}
