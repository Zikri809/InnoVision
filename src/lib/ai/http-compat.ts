/**
 * [OI]-compatible chat helper for LOCAL GLM-OCR (Docker/vLLM).
 *
 * Since the GLM-OCR container became loopback-bound and is reached through
 * `POST /api/extract/ocr` (server-side proxy), this helper runs in the ROUTE,
 * not the browser — the header comment here used to claim browser-only and
 * "carries no API key", which stopped being true when the proxy landed.
 *
 * SSRF guard (S8): the caller must NEVER derive `baseUrl` from a request body.
 * The route sources it from `GLM_BASE_URL` only; `lib/ai/client.ts` owns every
 * other provider.
 *
 * audit-3 R3-DEP-F2: `apiKey` sends `Authorization: Bearer …` so the compose
 * side can enable vLLM's `--api-key`. It is optional because a loopback-bound
 * container without a key is the existing posture; when the compose service
 * sets `VLLM_API_KEY`, the same value must be present here or every OCR call
 * 401s. Never log or echo the key.
 */


/** A single multimodal content part (OpenAI vision-chat shape). */
export type HttpChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type HttpChatMessage = {
  role: "system" | "user" | "assistant";
  /** Plain text for system/assistant; multimodal parts for vision requests. */
  content: string | HttpChatContentPart[];
};

export type HttpChatResult =
  | { ok: true; text: string }
  | { ok: false; error: "timeout" | "rate_limited" | "http_error" | "ai_error"; message?: string };

/**
 * POST an OpenAI-compatible chat request and return the assistant's text.
 * Intended for GLM-OCR (vision-language transcription) against the local
 * vLLM/Docker endpoint.
 */
export async function httpChatCompletions(opts: {
  baseUrl: string; // ROOT URL, e.g. http://localhost:11434 (no /v1)
  model: string;
  messages: HttpChatMessage[];
  maxTokens?: number;
  timeoutMs?: number;
  /** audit-3 R3-DEP-F2: vLLM `--api-key` value, when the container sets one. */
  apiKey?: string;
}): Promise<HttpChatResult> {
  const { baseUrl, model, messages, maxTokens = 2000, timeoutMs = 60_000, apiKey } = opts;
  const endpoint = `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0 }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // audit-3 F-F10: an upstream 429 (vLLM concurrency/queue rejection) is a
      // RETRYABLE capacity signal, not a page-read failure — keep it distinct
      // so the OCR route can surface `glm_rate_limited` instead of `glm_error`.
      if (res.status === 429) {
        return {
          ok: false,
          error: "rate_limited",
          message: "GLM-OCR is at capacity (HTTP 429).",
        };
      }
      return {
        ok: false,
        error: "http_error",
        message: `GLM-OCR returned HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text) return { ok: false, error: "ai_error", message: "Empty model response." };
    return { ok: true, text };
  } catch (err) {
    const aborted =
      controller.signal.aborted ||
      (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"));
    if (aborted) return { ok: false, error: "timeout" };
    const msg = err instanceof Error ? err.message : "Unknown HTTP error";
    return { ok: false, error: "http_error", message: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe whether the local GLM-OCR endpoint is reachable and serves the model.
 * Uses the OpenAI-compatible `GET {baseUrl}/v1/models` (works with vLLM and
 * Ollama alike). Returns true when the model id is listed. Short timeout so
 * the engine picker degrades instantly when the container is not running.
 */
export async function probeGlmModel(opts: {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  /** audit-3 R3-DEP-F2: required when the container runs with `--api-key`. */
  apiKey?: string;
}): Promise<boolean> {
  const { baseUrl, model, timeoutMs = 2000, apiKey } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/models`, {
      headers,
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { data?: { id?: string }[] };
    return (data.data ?? []).some(
      (m) => m.id === model || (m.id ?? "").startsWith(`${model}:`),
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
