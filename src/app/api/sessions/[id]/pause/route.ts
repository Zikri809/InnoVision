import { createClient } from "@/lib/supabase/server";
import { requireStudent } from "@/lib/classes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { mapFaceError } from "@/lib/face/rpc-mapping";
import { z } from "zod";
import {
  checkSameOrigin,
  internalError,
  invalidBody,
  invalidJson,
  readCappedText,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Per-user rate limit on pauses (coalesced per episode — 20/min is generous).
const PAUSE_RATE = { limit: 20, windowMs: 60 * 1000 };

// audit-4 P2-2 replay suppression: a retried POST after a dropped response,
// or two tabs mirroring the same blur, double-fires the strike counter — the
// RPC counts on already-paused sessions too, so ONE real focus loss could
// register 2 strikes and flag the student at their 2nd genuine loss. A short
// per-(user, session, reason) window coalesces the duplicates; a genuinely
// new episode (recover → pause again) falls outside it.
const PAUSE_REPLAY_WINDOW_MS = 10_000;
const recentPauseAt = new Map<string, number>();

function stampPauseReplay(key: string, now: number): void {
  recentPauseAt.set(key, now);
  // Bounded growth: sweep the map when it gets large.
  if (recentPauseAt.size > 1024) {
    for (const [k, ts] of recentPauseAt) {
      if (now - ts > PAUSE_REPLAY_WINDOW_MS * 10) recentPauseAt.delete(k);
    }
  }
}

// D-F5: the Zod enum MUST mirror the pause_session RPC enum verbatim
// (0046:665 accepts 'focus_lost' | 'hard_blur' | 'fullscreen_exit' |
// 'hand_loss'). It used to omit 'hard_blur', so the route rejected a value
// the RPC accepts — a contract skew that would 400 the day a sender used it.
//
// TRAP (documented, 0046:692-694): the RPC's counting is
// `focus_lost` → focus_pause_count; `fullscreen_exit` → fullscreen_pause_count;
// EVERY OTHER reason (hand_loss AND hard_blur) → hand_pause_count, with a
// 3-strike auto-flag. So adding a reason here without a matching RPC branch
// silently makes it a hand-pause strike. Add a branch in the RPC first.
const PauseSchema = z.object({
  reason: z
    .enum(["hand_loss", "focus_lost", "fullscreen_exit", "hard_blur"])
    .default("hand_loss"),
});

/**
 * POST /api/sessions/[id]/pause — server-side pause (P7 + integrity suite).
 *
 * Moves client-only pauses INTO the server state machine:
 * `active` → `paused` (idempotent), assessment only, owner only. A
 * re-shown hand / refocused window can't answer a server-paused session
 * before blink-recovery.
 *
 * `reason: 'focus_lost'` additionally accumulates `focus_pause_count`; the
 * RPC FLAGS the session at the threshold (3) — a lecturer decision — and
 * audits it. `reason: 'fullscreen_exit'` (client hardening) accumulates
 * `fullscreen_pause_count` (0043) but NEVER auto-flags — repeat
 * exit→think→recover cycling is lecturer-visible on the results dashboard,
 * while the escalation decision stays with the lecturer. The response's
 * `sessionStatus` is authoritative.
 *
 * Preamble: guard → CSRF → rate-limit → RPC → `mapFaceError`.
 *
 * success → 200 `{ sessionStatus: 'paused' | 'flagged' }`
 */
export async function POST(request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) {
    return mapFaceError({ error: "not_owner" }) ?? internalError("Something went wrong.");
  }

  const auth = await requireStudent(supabase);
  if (!auth.ok) return auth.response;

  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`pause:${auth.userId}`, PAUSE_RATE)) {
    return mapFaceError({ error: "rate_limited" }) ?? internalError("Something went wrong.");
  }

  // Body is OPTIONAL: the hand-loss client sends `{}`, the focus-loss client
  // sends `{reason:'focus_lost'}`, and an empty body defaults to hand_loss.
  // audit-1 P1-5: the raw `request.text()` here was UNBOUNDED — a chunked
  // request could buffer arbitrarily before the tiny PauseSchema ran. 1 KB
  // is far above any honest body ({"reason":"fullscreen_exit"} ≈ 30 B).
  let reason = "hand_loss";
  const textRead = await readCappedText(request, 1024);
  if (!textRead.ok) return textRead.response;
  const text = textRead.text;
  if (text.trim().length > 0) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return invalidJson();
    }
    const parsed = PauseSchema.safeParse(body);
    if (!parsed.success) {
      return invalidBody(
        "reason must be 'hand_loss', 'focus_lost', 'fullscreen_exit' or 'hard_blur'.",
      );
    }
    reason = parsed.data.reason;
  }

  // Replay suppression (audit-4 P2-2) BEFORE the RPC: mirrors the override
  // route's recentHitCount pattern. A duplicate POST inside the window
  // returns the last known-good shape without re-striking — but ONLY while
  // the session is STILL paused: a self-recovery between two pauses is a
  // genuine new episode (the 3-strike escalation test recovers between
  // strikes), so an active session always re-enters the RPC. The window is
  // stamped ONLY after a durable paused/flagged write (override-route
  // pattern) — stamping on entry turned a failed first attempt into a
  // fabricated {sessionStatus:paused} on retry.
  //
  // Already-paused coalesce: pause_session counts strikes on ALREADY-PAUSED
  // rows too (0046 else-branch), so a duplicate signal for an episode that
  // is already recorded — second tab, retry after a dropped response,
  // cross-pod replay (the Map above is per-process) — would increment the
  // counters a second time and could flag a student on their 2nd genuine
  // loss. While paused no NEW episode can exist (answering is blocked; only
  // a recovery back to active opens one), so return the durable shape
  // WITHOUT re-entering the RPC. flagged/completed still go through the RPC
  // to preserve their exact 409 shapes.
  const replayKey = `pause:${auth.userId}:${id}:${reason}`;
  const statusProbe = await supabase
    .from("quiz_sessions")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (statusProbe.error) {
    // A probe blip must not fake a replay hit or a pass-through — the RPC is
    // the authority on status; fall through to it.
    console.error("pause status probe error:", statusProbe.error);
  }
  const currentStatus = (statusProbe.data as { status?: string } | null)?.status;
  if (currentStatus === "paused") {
    // The paused state is already durable (either from the replay window or
    // an earlier recorded episode) — coalesce without a strike.
    stampPauseReplay(replayKey, Date.now());
    return Response.json(
      { sessionStatus: "paused" },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  const { data, error } = await supabase.rpc("pause_session", {
    p_session_id: id,
    p_reason: reason,
  });

  if (error) {
    console.error("pause_session error:", error);
    return internalError("Could not pause the session right now.");
  }

  const payload = data as Record<string, unknown> | null;

  const mapped = mapFaceError(payload, {});
  if (mapped) return mapped;

  if (
    payload?.sessionStatus === "paused" ||
    payload?.sessionStatus === "flagged"
  ) {
    stampPauseReplay(replayKey, Date.now());
    return Response.json(
      { sessionStatus: payload.sessionStatus },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  console.error("pause_session unexpected payload:", payload);
  return internalError("Could not pause the session right now.");
}
