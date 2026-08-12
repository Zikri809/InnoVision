import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireStudent } from "@/lib/classes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import {
  checkSameOrigin,
  forbidden,
  internalError,
  jsonError,
  notFound,
  rateLimited,
  unauthorized,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Per-user rate limit on submits (double-click/auto-submit guard).
const SUBMIT_RATE = { limit: 10, windowMs: 60 * 1000 };

/**
 * POST /api/sessions/[id]/submit — complete a session and compute the score.
 *
 * DELIBERATE DEVIATION (PLAN_PHASE5 §2): there is NO timer check here. The
 * `submit_session` RPC accepts submits past the deadline (the timer's job is
 * stopping ANSWERS; rejecting a late submit would strand a student whose
 * auto-submit arrives >grace late). A maintainer must NOT re-add a timer
 * check — D45/E10 pin this behavior.
 *
 * Mappings:
 *  - `not_owner` → 404
 *  - `session_not_active` → 409
 *  - `already_submitted` → 409 `{ error: "already_submitted", session, score,
 *    total }` (idempotent re-submit; no score change — I13)
 *  - transport error → 503
 *  - success → 200 `{ session, score, total }`
 */
export async function POST(_request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) return notFound();

  const auth = await requireStudent(supabase);
  if (!auth.ok) return auth.response;

  const originError = checkSameOrigin(_request);
  if (originError) return originError;

  if (!rateLimit(`submit:${auth.userId}`, SUBMIT_RATE)) {
    return rateLimited("Too many submits. Try again in a minute.");
  }

  const { data, error } = await supabase.rpc("submit_session", {
    p_session_id: id,
  });

  if (error) {
    console.error("submit_session error:", error);
    return internalError("Could not submit the quiz right now.");
  }

  const payload = data as Record<string, unknown> | null;

  if (payload?.error === "not_student") return forbidden();
  if (payload?.error === "not_authenticated") return unauthorized();
  if (payload?.error === "not_owner") return notFound();
  if (payload?.error === "session_not_active") {
    return jsonError("session_not_active", undefined, 409);
  }

  if (payload?.already_submitted === true) {
    return NextResponse.json(
      {
        error: "already_submitted",
        session: payload.session ?? null,
        score: payload.score ?? null,
        total: payload.total ?? null,
      },
      { status: 409, headers: { "content-type": "application/json" } },
    );
  }

  if (payload && payload.session && typeof payload.score === "number") {
    return NextResponse.json(
      { session: payload.session, score: payload.score, total: payload.total ?? 0 },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  console.error("submit_session unexpected payload:", payload);
  return internalError("Could not submit the quiz right now.");
}
