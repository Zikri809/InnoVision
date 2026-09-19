import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireLecturer } from "@/lib/classes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit, recordRateLimitHit, recentHitCount } from "@/lib/classes/rate-limit";
import {
  checkSameOrigin,
  firstIssueMessage,
  internalError,
  invalidBody,
  jsonError,
  notFound,
  rateLimited,
  readCappedJson,
  unauthorized,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Per-lecturer adjudication budget. Adjudicating a class of 30 with a handful
// of pending short_text answers is a few dozen clicks; 30/min leaves room for
// a correction pass while bounding a scripted loop.
const OVERRIDE_RATE = { limit: 30, windowMs: 60 * 1000 };

// Replay window for an identical adjudication. A double-click (or a client
// retry after a dropped response) replays the SAME mark for the same answer;
// the DB has no idempotency key for override, so the route suppresses the
// second call inside this window. Kept short: a lecturer who genuinely wants
// to re-apply the same mark twice (e.g. after an intervening reset) waits it
// out rather than losing the write.
//
// n14: the bucket map is PER-PROCESS (see rate-limit.ts), so a replay that
// lands on another pod double-executes. Only the SCORE is benign — the D10
// recompute is deterministic, so the second write converges on the same mark.
// The epoch and audit trail are NOT idempotent across pods: `attempt_version`
// bumps twice and two audit rows land. Accepted for the demo-scale single-
// instance posture; a distributed store is the fix if this ever scales out.
const OVERRIDE_REPLAY_WINDOW_MS = 60 * 1000;

/**
 * `mark` is the 0/0.5/1 half-mark ladder (D10) — a numeric literal, never a
 * string. `reason` is the adjudication note that lands in `audit_events` and
 * is required by the RPC (5..500 chars); the 5-char floor is mirrored here so
 * a too-short note fails at the boundary with a readable message.
 */
const OverrideSchema = z.object({
  questionId: z.string().uuid("questionId must be a valid UUID."),
  mark: z.union([z.literal(0), z.literal(0.5), z.literal(1)], {
    message: "The mark must be 0, 0.5, or 1.",
  }),
  reason: z
    .string()
    .trim()
    .min(5, "Give a reason of at least 5 characters.")
    .max(500, "The reason must be at most 500 characters."),
});

/**
 * POST /api/sessions/[id]/override — lecturer adjudicates one answer's mark.
 *
 * Preamble (house order): lecturer guard → CSRF → rate limit → capped body →
 * Zod → RPC. `override_answer_mark` is the sole authority: it re-checks
 * ownership through the quiz's class, validates the mark against the
 * question's `max_score`, bumps `attempt_version` (invalidating any in-flight
 * AI mark), recomputes the session score with the D10 SUM, and re-publishes
 * the results when they were already revealed.
 *
 * Mappings:
 *  - `not_owner` → 404 (no oracle: a foreign session is indistinguishable
 *    from a missing one)
 *  - `invalid_mark` / `reason_required` / `mark_exceeds_max` → 400
 *  - `not_found` → 404 (foreign question id, or no answer row for it)
 *  - transport error → 503
 *  - success → 200 `{ ok: true }`
 *
 * Replay guard: an identical (session, question, mark, reason) submission
 * inside OVERRIDE_REPLAY_WINDOW_MS returns the same 200 without a second RPC —
 * `recordRateLimitHit` is the in-process counter the login path already uses
 * for detection, reused here as the keyed window.
 */
export async function POST(request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) return notFound();

  const auth = await requireLecturer(supabase);
  if (!auth.ok) return auth.response;

  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`override:${auth.userId}`, OVERRIDE_RATE)) {
    return rateLimited("Too many overrides. Try again in a minute.");
  }

  const body = await readCappedJson(request);
  if (!body.ok) return body.response;

  const parsed = OverrideSchema.safeParse(body.data);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid override payload."));
  }

  const { questionId, mark, reason } = parsed.data;

  // The reason is hashed, never keyed verbatim: the bucket map is a
  // process-wide structure and an adjudication note is lecturer prose.
  const reasonHash = createHash("sha256").update(reason, "utf8").digest("hex").slice(0, 16);
  const replayKey = `override:${id}:${questionId}:${mark}:${reasonHash}`;
  // audit-4 B2: this key only ever records a SUCCEEDED adjudication. It is
  // stamped AFTER the RPC returns `ok:true` — recording on entry turned any
  // failed first attempt (404/400/503) into a fabricated `{ok:true}` 200 on
  // an identical retry within the window.
  if (isReplay(replayKey)) {
    return NextResponse.json(
      { ok: true },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  const { data, error } = await supabase.rpc("override_answer_mark", {
    p_session_id: id,
    p_question_id: questionId,
    p_mark: mark,
    p_reason: reason,
  });

  if (error) {
    console.error("override_answer_mark error:", error);
    return internalError("Could not save the override right now.");
  }

  const payload = data as Record<string, unknown> | null;

  // Unreachable behind the lecturer guard, but mapped rather than falling to
  // the shape-assert below: the RPC reports it as a payload, not a throw.
  if (payload?.error === "not_authenticated") return unauthorized();
  // Both 404 arms collapse to ONE body — a foreign session and a foreign
  // question id must be indistinguishable (no-oracle).
  if (payload?.error === "not_owner" || payload?.error === "not_found") return notFound();
  if (
    payload?.error === "invalid_mark" ||
    payload?.error === "reason_required" ||
    payload?.error === "mark_exceeds_max"
  ) {
    return jsonError(String(payload.error), undefined, 400);
  }

  if (payload?.ok === true) {
    // Stamp the replay window only now that the write is durable. A replay
    // inside the window is answered from this bucket, so a dropped response
    // still resolves idempotently for the lecturer.
    recordRateLimitHit(replayKey, { windowMs: OVERRIDE_REPLAY_WINDOW_MS });
    return NextResponse.json(
      { ok: true },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  console.error("override_answer_mark unexpected payload:", payload);
  return internalError("Could not save the override right now.");
}

/**
 * True when an identical adjudication succeeded inside the replay window.
 * `recordRateLimitHit` never rejects (it is a detection counter), so the
 * bucket is read directly: any hit inside the window is a prior success —
 * failures never stamp the key (audit-4 B2).
 */
function isReplay(replayKey: string): boolean {
  return recentHitCount(replayKey, { windowMs: OVERRIDE_REPLAY_WINDOW_MS }) > 0;
}
