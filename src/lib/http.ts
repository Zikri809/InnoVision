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
 * Default pre-parse JSON body cap for authoring routes. Mirrors the guard the
 * student-quiz surface ships inline (`BODY_LIMIT_BYTES`); Zod string caps only
 * apply AFTER `request.json()` has materialized the whole body, so oversized
 * payloads are rejected at the header instead.
 */
export const JSON_BODY_LIMIT_BYTES = 64 * 1024;

/**
 * Reject requests whose declared `content-length` exceeds `maxBytes` BEFORE
 * the body is buffered. Chunked encodings without the header fall through —
 * the Zod schema caps remain the real backstop for those.
 */
export function checkBodyLimit(
  request: Request,
  maxBytes: number = JSON_BODY_LIMIT_BYTES,
): NextResponse | null {
  const lenHeader = request.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > maxBytes) {
    return payloadTooLarge("Request body too large.");
  }
  return null;
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
 * header is present and its host differs from the request's own host. Same-
 * site Lax cookies + this check closes the realistic CSRF surface (the
 * classic Lax-only gap is same-site subdomain attacks). Returns a typed 403
 * NextResponse if rejected, or `null` if the origin is acceptable (or absent
 * — non-browser callers won't send Origin).
 */
export function checkSameOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const reqHost = new URL(request.url).host.toLowerCase();
    if (originHost === reqHost) return null;
  } catch {
    return invalidOrigin();
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
