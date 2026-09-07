/**
 * The generation event wire contract (docs/plans/agentic-generation.md Phase 1).
 *
 * Safe for BOTH server and client import: types, the opt-in header name, and
 * the NDJSON reader live here. No secrets, no server-only deps.
 *
 * Generate routes speak TWO protocols on the same POST body:
 *  - LEGACY (default): a single JSON response — every byte of today's behavior,
 *    statuses and error codes included. The AI e2e suite and the ~25 pinned
 *    route tests run on this path exclusively.
 *  - STREAM (opt-in via `Accept: application/x-ndjson`): an NDJSON stream of
 *    the events below, one JSON object per line. The HTTP status is 200 from
 *    the first byte on, so EVERY failure after the stream opens is an `error`
 *    event carrying the same code the legacy JSON would have had (the
 *    "two-segment error contract" — pre-stream guards keep statuses, post-stream
 *    failures are events).
 *
 * Deliberate constraints:
 *  - `content_delta` / `reasoning` carry RAW MODEL TEXT. It is unvalidated
 *    (validation happens on the final parse) and must be rendered as inert
 *    plain text only — never markdown/HTML — and kept visually distinct from
 *    server-generated chrome (S7 untrusted-source posture).
 *  - `ping` is the heartbeat. The client's dead-stream detector keys on it:
 *    no bytes (pings included) for 30s means the route is gone.
 *  - `saved_refresh_failed` is the post-save/refetch-failure branch: the save
 *    COMMITTED but the quiz refetch failed. Retrying would wipe and re-bill a
 *    successful save, so the client must NOT offer "Try again" here.
 */

export type GenerationStage = "parse" | "search" | "draft" | "refine" | "save";
export type StageStatus = "start" | "done" | "skip";

export type ToolCallEvent = {
  type: "tool_call";
  /** Currently only the web-search phase of grounded generation. */
  tool: "web_search";
  /** The search query being issued (server-derived chrome, not model text). */
  query: string;
};

export type ToolResultEvent = {
  type: "tool_result";
  tool: "web_search";
  /** For fetch failures the "query" field carries the page URL. */
  query: string;
  /** Search-hit count or 0 for skipped fetches. */
  resultCount: number;
  /** Present when this line reports a SKIPPED fetch (per-URL error). */
  skipped?: number;
  /** Skip reason / error code (`target_http_error`, `timeout`, …). */
  reason?: string;
};

export type GenerationEvent =
  | { type: "stage"; stage: GenerationStage; status: StageStatus; detail?: string }
  | { type: "ping" }
  /** Server-chrome tool line: a web-search query is being issued. */
  | ToolCallEvent
  /** Server-chrome tool line: search result count / skipped fetch report. */
  | ToolResultEvent
  /** Raw model reasoning text (unvalidated — inert plain text only). */
  | { type: "reasoning"; text: string }
  /** Raw model content text (unvalidated — inert plain text only). */
  | { type: "content_delta"; text: string }
  /** Same `code`/`message` shape as the legacy JSON error body. */
  | { type: "error"; code: string; message?: string }
  /** Client/server-side cancel acknowledged; no save happened. */
  | { type: "cancelled" }
  /** Save committed but the quiz refetch failed — success-ish, no retry. */
  | { type: "saved_refresh_failed"; questions: unknown[] }
  /** Terminal success. `payload` matches the legacy JSON body exactly. */
  | { type: "done"; payload: unknown };

/** Header value that opts a generate route into the NDJSON stream protocol. */
export const STREAM_ACCEPT = "application/x-ndjson";

/** True when the request opts into the stream protocol. */
export function wantsStream(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes(STREAM_ACCEPT);
}

/** Headers for the NDJSON response (no-store; disable intermediary buffering). */
export const STREAM_RESPONSE_HEADERS: Record<string, string> = {
  "content-type": `${STREAM_ACCEPT}; charset=utf-8`,
  "cache-control": "no-store, no-transform",
  "x-accel-buffering": "no",
};

/** Client-side NDJSON line reader: yields parsed events as they arrive. */
export async function* readGenerationEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<GenerationEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line) as GenerationEvent;
        } catch {
          // A torn line means the route died mid-write; the caller's
          // dead-stream/EOF handling owns the recovery.
          yield { type: "error", code: "stream_corrupt", message: line.slice(0, 200) };
        }
      }
    }
    // Flush the decoder's pending multi-byte tail AFTER the buffered text
    // (the flush logically follows whatever buffer already held).
    const tail = buffer.trim() + decoder.decode();
    if (tail.trim()) {
      try {
        yield JSON.parse(tail.trim()) as GenerationEvent;
      } catch {
        yield { type: "error", code: "stream_corrupt", message: tail.trim().slice(0, 200) };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
