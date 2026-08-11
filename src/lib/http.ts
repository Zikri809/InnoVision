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
