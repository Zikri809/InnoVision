import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit } from "@/lib/classes/rate-limit";
import { markClaimedBatch } from "@/lib/ai/marking-worker";
import {
  firstIssueMessage,
  internalError,
  invalidBody,
  rateLimited,
  readCappedJson,
  unauthorized,
} from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/internal/ai-mark-sweep — the AI marking worker route (phase 2).
 *
 * Called server-to-server by `sweep_ai_marks()`'s `net.http_post` (0057 §4)
 * after the claim commits, with the sweep's own `{claim_token, rows}` body.
 * Where pg_net is unavailable the same route is OPERATOR-invoked (curl) with
 * the identical payload — there is no edge scheduler in this repo.
 *
 * ── Auth (A5-4/A6-12) ────────────────────────────────────────────────
 * Bearer = the SAME secret the sweep reads from Vault / `app.settings` and
 * sends as `Authorization: Bearer <key>`. The value comes from
 * `AI_MARK_WORKER_KEY`, falling back to `SUPABASE_SERVICE_ROLE_KEY` when that
 * named knob is unset — so the default deployment needs no new secret, while a
 * deployment that wants a rotatable, marking-specific key can set one without
 * touching the service-role key. The fallback keeps the caller's contract
 * simple (a service-role function already holds the service-role key).
 * FAIL CLOSED: a missing configured key, a missing header, or any mismatch is
 * a 401 before the body is read. The comparison is constant time so the route
 * is not a byte-at-a-time oracle for the key.
 *
 * The matching `AI_MARK_WORKER_URL` is the sweep's POST target; it lives in
 * the DATABASE (`app.settings.ai_mark_worker_url`), not here — see
 * `deploy/sync-migrations.sh` for how both are provisioned at deploy time.
 *
 * ── CSRF ─────────────────────────────────────────────────────────────
 * EXEMPT from `checkSameOrigin`: the caller is a database, not a browser, and
 * it sends no Origin. The bearer is the whole gate.
 */
const SWEEP_RATE = { limit: 60, windowMs: 60 * 1000 };

/**
 * The bearer this route accepts. `AI_MARK_WORKER_KEY` wins when set; otherwise
 * the service-role key (the historical default, and what the sweep is given by
 * default). Exported so the unit tests and any operator tooling share one
 * resolution rule rather than re-implementing it.
 */
export function expectedSweepKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const named = env.AI_MARK_WORKER_KEY?.trim();
  if (named) return named;
  return env.SUPABASE_SERVICE_ROLE_KEY;
}

const SweepRowSchema = z.object({
  ledger_id: z.string().uuid(),
  session_id: z.string().uuid(),
  question_id: z.string().uuid(),
  attempt_version: z.number().int().min(1),
  quiz_id: z.string().uuid(),
});

const SweepSchema = z.object({
  claim_token: z.string().uuid("claim_token must be a valid UUID."),
  // The sweep's own LIMIT is 10; the cap here only bounds a hand-rolled
  // operator call, not the sweep.
  rows: z.array(SweepRowSchema).max(50),
});

/** Constant-time bearer comparison (never throws on a length mismatch). */
function bearerMatches(header: string | null, expected: string | undefined): boolean {
  if (!expected || !header) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const presented = Buffer.from(header.slice(prefix.length), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  // Length is not a secret worth hiding here (the key's length is fixed and
  // public), but timingSafeEqual throws on a mismatch, so compare lengths
  // first and keep the comparison itself constant time.
  if (presented.length !== wanted.length) return false;
  return timingSafeEqual(presented, wanted);
}

export async function POST(request: Request) {
  // Auth BEFORE the body: an unauthenticated caller must not be able to make
  // the route buffer (or act on) anything.
  if (!bearerMatches(request.headers.get("authorization"), expectedSweepKey())) {
    return unauthorized();
  }

  if (!rateLimit("ai-mark-sweep", SWEEP_RATE)) {
    return rateLimited("Too many sweep calls. Try again in a minute.");
  }

  const body = await readCappedJson(request);
  if (!body.ok) return body.response;

  const parsed = SweepSchema.safeParse(body.data);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid sweep payload."));
  }

  let result: Awaited<ReturnType<typeof markClaimedBatch>>;
  try {
    result = await markClaimedBatch(parsed.data);
  } catch (err) {
    // Never a raw 500 to the cron caller: the claim has already committed, so
    // the lease/attempt accounting owns recovery either way.
    console.error("ai-mark-sweep worker error:", err);
    return internalError("Could not run the marking sweep right now.");
  }

  // Escalation runs in its OWN transaction (A6-2: plpgsql cannot COMMIT
  // mid-body, so an escalation write inside the claim would share its locks
  // and roll back with it) — hence a separate RPC call AFTER the worker, not
  // inside it. This is what keeps escalation from being schedule-dependent:
  // even if the 5-min escalate job is missing, exhausted rows resolve here.
  const { data: escalated, error: escalateError } = await createAdminClient().rpc(
    "escalate_stale_marks",
  );
  if (escalateError) {
    // The marks themselves landed — a failed escalation only delays the
    // needs_review resolution to the next tick, so this is not a 503.
    console.error("escalate_stale_marks error:", escalateError);
  }

  return NextResponse.json(
    { ok: true, ...result, escalated: escalateError ? null : (escalated ?? 0) },
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
