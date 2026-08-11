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
 * Ollama. Config via env: AI_BASE_URL / AI_API_KEY / AI_MODEL.
 *
 * `import "server-only"` guarantees this module (and the API key) can never be
 * bundled into a client component (S8 from the P4 plan review).
 */

export const AI_MODEL = process.env.AI_MODEL ?? "gpt-4o-mini";
export const VISION_MODEL = process.env.OCR_VISION_MODEL ?? AI_MODEL;

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

export type ChatResult =
  | { ok: true; text: string }
  | { ok: false; error: "timeout" | "ai_error"; message?: string };

/**
 * One chat-completions round-trip with a hard wall-clock timeout. Routes run
 * under `maxDuration = 60`, so the AI call must never eat the whole budget —
 * a 45s abort leaves time for a clean 503 `timeout` response.
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
    const text = completion.choices?.[0]?.message?.content ?? "";
    if (!text) return { ok: false, error: "ai_error", message: "Empty model response." };
    return { ok: true, text };
  } catch (err) {
    const aborted =
      controller.signal.aborted ||
      (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"));
    if (aborted) return { ok: false, error: "timeout" };
    const msg = err instanceof Error ? err.message : "Unknown AI error";
    return { ok: false, error: "ai_error", message: msg };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}
