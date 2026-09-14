import { NextResponse } from "next/server";

/**
 * Shared JSON response builders for route handlers.
 *
 * Route handlers are hit directly (bypassing page layouts) and must return
 * typed, consistent error bodies. Centralizing them removes the duplicated
 * response objects that used to live in every guard/route module, so error
 * shapes and status codes can't drift between endpoints.
 *
 * Every builder returns a `Response`/`NextResponse` with `content-type:
 * application/json`.
 */

export function jsonError(
  error: string,
  message: string | undefined,
  status: number,
): NextResponse {
  return NextResponse.json(
    { error, ...(message ? { message } : {}) },
    { status, headers: { "content-type": "application/json" } },
  );
}

/** 400 — malformed request body (invalid JSON). */
export const invalidJson = () =>
  jsonError("invalid_json", "Request body must be valid JSON.", 400);

/** 400 — Zod validation failed on the request body. */
export function invalidBody(message: string): NextResponse {
  return jsonError("invalid_body", message, 400);
}

/** 404 — resource not found or not owned (no oracle). */
export const notFound = () => jsonError("not_found", undefined, 404);

/** 401 — unauthenticated. */
export const unauthorized = () => jsonError("unauthorized", undefined, 401);

/** 403 — authenticated but wrong role / forbidden. */
export const forbidden = () => jsonError("forbidden", undefined, 403);

/** 409 — quiz is not in a draft state (edits/publish locked). */
export const notDraft = () =>
  jsonError("quiz_not_draft", "Only draft quizzes can be edited.", 409);

/** 413 — request payload too large (vision OCR body limits). */
export function payloadTooLarge(message: string): NextResponse {
  return jsonError("payload_too_large", message, 413);
}

/**
 * Default pre-parse JSON body cap for authoring routes. Zod string caps only
 * apply AFTER the body has materialized, so oversized payloads are rejected
 * by the streaming readers below at this cap.
 */
export const JSON_BODY_LIMIT_BYTES = 64 * 1024;

type CappedRead =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; response: NextResponse };

/**
 * Consume `request.body` chunk-by-chunk under a HARD byte cap (audit-1 P1-5).
 *
 * A header-only check trusts the `content-length` header; a chunked transfer
 * (no header) or a lying one bypasses it and the body materializes in full
 * before any Zod cap runs. This reader aborts the moment accumulated bytes
 * exceed `maxBytes`, so the cap holds regardless of what the headers claim.
 */
async function readCappedBytes(
  request: Request,
  maxBytes: number,
): Promise<CappedRead> {
  const lenHeader = request.headers.get("content-length");
  const declared = Number(lenHeader);
  if (lenHeader && Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, response: payloadTooLarge("Request body too large.") };
  }
  const stream = request.body;
  if (!stream) {
    // No body at all: yield EMPTY bytes and let each reader decide —
    // readCappedJson 400s on the unparseable empty string, while
    // readCappedText returns "" for routes whose body is optional (pause).
    return { ok: true, bytes: new Uint8Array(0) };
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, response: payloadTooLarge("Request body too large.") };
      }
      chunks.push(value);
    }
  } catch {
    // Stream died mid-read (aborted / malformed framing) — never a 500.
    return { ok: false, response: invalidJson() };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/**
 * Streaming-capped JSON body reader — the drop-in replacement for the old
 * header-only cap + `await request.json()` pair on the heaviest endpoints
 * (verify/enroll/start/join/advisory/answer). Returns a typed result instead
 * of throwing so routes stay linear:
 *   `{ ok: true, data }`               — parsed JSON, within the cap
 *   `{ ok: false, response }`          — 413 over cap (header OR stream),
 *                                        400 for missing/malformed JSON
 */
export async function readCappedJson(
  request: Request,
  maxBytes: number = JSON_BODY_LIMIT_BYTES,
): Promise<{ ok: true; data: unknown } | { ok: false; response: NextResponse }> {
  const read = await readCappedBytes(request, maxBytes);
  if (!read.ok) return read;
  try {
    return { ok: true, data: JSON.parse(new TextDecoder().decode(read.bytes)) };
  } catch {
    return { ok: false, response: invalidJson() };
  }
}

/**
 * Streaming-capped raw-text reader for routes with OPTIONAL bodies (pause:
 * an empty body defaults the reason; `{}` and `{"reason":"focus_lost"}` are
 * both valid). The cap still binds — an unbounded `request.text()` lets a
 * chunked request buffer gigabytes before JSON.parse ever runs.
 */
export async function readCappedText(
  request: Request,
  maxBytes: number = JSON_BODY_LIMIT_BYTES,
): Promise<{ ok: true; text: string } | { ok: false; response: NextResponse }> {
  const read = await readCappedBytes(request, maxBytes);
  if (!read.ok) return read;
  return { ok: true, text: new TextDecoder().decode(read.bytes) };
}

/** Multipart overhead slack (boundary, part headers) over the file cap. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * Streaming-capped `formData()` reader (audit-1 P1-5, incident clip upload).
 *
 * `request.formData()` buffers the ENTIRE multipart body before the route
 * can measure anything, so a lying `content-length` pre-check reads gigabytes
 * first. The body is piped through a counting TransformStream that errors the
 * moment the cap is exceeded — the multipart parse then fails fast on an
 * aborted stream instead of materializing the oversized payload.
 */
export async function readCappedFormData(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; form: FormData } | { ok: false; response: NextResponse }> {
  const lenHeader = request.headers.get("content-length");
  const declared = Number(lenHeader);
  if (lenHeader && Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, response: payloadTooLarge("Request body too large.") };
  }
  const stream = request.body;
  if (!stream) {
    return { ok: false, response: invalidBody("Expected multipart/form-data.") };
  }
  let total = 0;
  const counting = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.error(new Error("body_too_large"));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  try {
    const capped = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: stream.pipeThrough(counting),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    return { ok: true, form: await capped.formData() };
  } catch (err) {
    if (err instanceof Error && err.message === "body_too_large") {
      return { ok: false, response: payloadTooLarge("Request body too large.") };
    }
    return { ok: false, response: invalidBody("Expected multipart/form-data.") };
  }
}

/** 422 — AI output invalid / extraction needs browser OCR. */
export function unprocessable(message: string, error = "unprocessable"): NextResponse {
  return jsonError(error, message, 422);
}

/** 429 — rate limit exceeded. */
export function rateLimited(message: string): NextResponse {
  return jsonError("rate_limited", message, 429);
}

/** 503 — AI/LLM request timed out (used by AI routes after the 45s abort). */
export function timeout(message: string): NextResponse {
  return jsonError("timeout", message, 503);
}

/** 503 — transient outage / DB error. */
export function internalError(message: string): NextResponse {
  return jsonError("internal", message, 503);
}

/** 403 — CSRF: request Origin (if present) does not match this app's host. */
export function invalidOrigin(): NextResponse {
  return jsonError("invalid_origin", "Cross-origin request rejected.", 403);
}

/**
 * Cheap CSRF defense for state-changing JSON routes. Rejects when an `Origin`
 * header is present and its host differs from this app's host. Same-site Lax
 * cookies + this check closes the realistic CSRF surface (the classic
 * Lax-only gap is same-site subdomain attacks). Returns a typed 403
 * NextResponse if rejected, or `null` if the origin is acceptable (or absent
 * — non-browser callers won't send Origin).
 *
 * "This app's host" resolves in order:
 *   1. the literal request host (direct access)
 *   2. `TRUSTED_ORIGINS` (comma-separated, scheme included) — proxies like
 *      cloudflared rewrite `Host` to the upstream service address and strip
 *      forwarding headers, so neither 1 matches the public origin.
 *      Full origin match (scheme + host): an `http://` entry must not admit
 *      the `https://` variant of the same host. An empty list keeps the
 *      original direct-access behavior.
 *
 * audit-2 M-01: `x-forwarded-host` is NO LONGER trusted as "this app's
 * host" — it is a caller-writable header on any direct-access deployment,
 * so `Origin: https://evil.com` + `x-forwarded-host: evil.com` used to pass
 * the check on one header. Proxies that legitimately set XFH but rewrite
 * Host are covered by TRUSTED_ORIGINS; a browser cannot forge a same-origin
 * Host+Origin pair, so no honest flow regresses.
 */
export function checkSameOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return invalidOrigin();
  }

  try {
    const reqHost = new URL(request.url).host.toLowerCase();
    if (originHost === reqHost) return null;
  } catch {
    return invalidOrigin();
  }

  const trusted = (process.env.TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const entry of trusted) {
    try {
      const entryUrl = new URL(entry);
      const originUrl = new URL(origin);
      if (
        originHost === entryUrl.host.toLowerCase() &&
        originUrl.protocol === entryUrl.protocol
      ) {
        return null;
      }
    } catch {
      // Malformed TRUSTED_ORIGINS entry — skip it rather than crash routes.
    }
  }

  return invalidOrigin();
}

/** 503 — authenticated but the profile row isn't ready yet (signup race). */
export function profileUnavailable(): NextResponse {
  return jsonError(
    "profile_unavailable",
    "Your profile is not ready yet. Try again.",
    503,
  );
}

/**
 * Extract the first non-empty Zod issue message from a failed parse, falling
 * back to a generic message. In Zod v4 the first issue may carry an empty/
 * undefined message while a later issue has the real text, so scan all issues
 * rather than trusting issues[0]. Keeps validation responses consistent.
 */
export function firstIssueMessage(
  issues: { message?: string }[],
  fallback: string,
): string {
  const first = issues.find((i) => i.message && i.message.length > 0);
  return first?.message || fallback;
}
