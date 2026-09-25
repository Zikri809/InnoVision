import { NextResponse } from "next/server";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isDemoModeEnabled } from "@/lib/demo/gate";
import { resetWalkup, DEMO_LECTURER_EMAIL } from "@/lib/demo/walkup-reset";
import { checkSameOrigin, readCappedJson, forbidden, unauthorized } from "@/lib/http";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * POST /api/demo/reset-walkup — the mid-day booth reset (PLAN_DEMO_MODE.md D6).
 *
 * AUTHORIZATION (not just the flag): the caller must hold a session whose email
 * is the seeded demo lecturer. Flag-gating alone would let any visitor phone on
 * the booth LAN fire a service-role reset (checkSameOrigin passes trivially —
 * the visitor IS same-origin). The demo-lecturer check needs no new secret on
 * the printed sheet.
 *
 * Body: { confirm: true, maxAgeHours?: number }. The explicit confirm flag
 * keeps an accidental double-click / replayed request from deleting guests.
 *
 * Flag-off → notFound() (framework-identical 404, no shape oracle).
 */
const BODY_LIMIT = 4 * 1024;

export async function POST(request: Request) {
  if (!isDemoModeEnabled()) notFound();

  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return unauthorized();
  if (user.email !== DEMO_LECTURER_EMAIL) return forbidden();

  const body = await readCappedJson(request, BODY_LIMIT);
  if (!body.ok) return body.response;
  const raw = body.data;
  const confirm =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).confirm === true
      : false;
  if (!confirm) {
    return NextResponse.json(
      { error: "confirm_required", message: "Set confirm:true to reset the walk-up demo." },
      { status: 400 },
    );
  }
  const maxAgeHoursRaw =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).maxAgeHours
      : undefined;
  // Clamp the age override: an unbounded value would force `cutoffMs` arbitrarily
  // negative and delete the ENTIRE guest population in one request, defeating
  // the documented 2h blast radius the confirm dialog promises.
  const maxAgeHours =
    typeof maxAgeHoursRaw === "number" && Number.isFinite(maxAgeHoursRaw) && maxAgeHoursRaw >= 0
      ? Math.min(maxAgeHoursRaw, 24)
      : undefined;

  try {
    const summary = await resetWalkup(undefined, { maxAgeHours });
    return NextResponse.json({ ok: true, summary });
  } catch (error) {
    logError("demo.reset.walkup_failed", error, { subsystem: "demo" });
    return NextResponse.json(
      { error: "internal", message: "Walk-up reset failed." },
      { status: 503 },
    );
  }
}
