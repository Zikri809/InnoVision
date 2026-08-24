/**
 * Browser-only OpenAI-compatible chat helper for LOCAL GLM-OCR (Docker/vLLM).
 *
 * This module MUST NOT be imported from server code. It performs a plain fetch
 * from the lecturer's browser to `{GLM_BASE_URL}/v1/chat/completions` — the
 * local GLM-OCR endpoint (vLLM in Docker, loopback-bound) — and carries no API
 * key.
 *
 * SSRF guard (S8): server routes must NEVER derive `baseURL` from a request
 * body. The server only ever talks to env-configured providers through
 * `lib/ai/client.ts`. This helper is browser-only, so the "baseURL" it talks
 * to is the lecturer's own machine, by design.
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
  | { ok: false; error: "timeout" | "http_error" | "ai_error"; message?: string };

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
}): Promise<HttpChatResult> {
  const { baseUrl, model, messages, maxTokens = 2000, timeoutMs = 60_000 } = opts;
  const endpoint = `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0 }),
      signal: controller.signal,
    });
    if (!res.ok) {
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
}): Promise<boolean> {
  const { baseUrl, model, timeoutMs = 2000 } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/models`, {
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
