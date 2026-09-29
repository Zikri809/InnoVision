import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { createServerActionClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isDemoModeEnabled, DEMO_JOIN_CODE } from "@/lib/demo/gate";
import {
  createGuestUser,
  joinDemoClass,
  countExistingGuests,
  countGuestAccounts,
  GUEST_ACCOUNT_CAP,
} from "@/lib/demo/guests";
import { rateLimit } from "@/lib/classes/rate-limit";
import { checkSameOrigin, readCappedJson } from "@/lib/http";
import { clientIpFromHeaders } from "@/lib/request-ip";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * POST /api/demo/guest — exhibition walk-up provisioning (PLAN_DEMO_MODE.md D2).
 *
 * Mints a fresh guest student account, signs it in (session cookies on THIS
 * response), enrolls it in the demo class, and returns a redirect target.
 *
 * Gate: `isDemoModeEnabled()` (NEXT_PUBLIC_DEMO_MODE=1). Flag-off responds with
 * the framework's own `notFound()` so the route's existence is not leaked by a
 * bespoke 404 shape (no oracle). Dead code in production.
 *
 * Why one account PER VISITOR: the attempt invariant is one active session per
 * (quiz, student) — a pooled account would collide on session rows, timers, and
 * results. Guests are cheap; each is a real student principal (accepted demo
 * risk, contained by per-user spend caps and the walk-up reset).
 *
 * Ordering follows the API preamble (ARCHITECTURE §3): gate → CSRF → rate limit
 * (per-IP, sized for the booth's shared egress) → hard-capped body read. There
 * is no auth guard by design (the caller is anonymous).
 */

/** Booth-NAT budget: the whole crowd shares one egress IP. */
const GUEST_RATE = { limit: 300, windowMs: 10 * 60_000 };

export async function POST(request: Request) {
  if (!isDemoModeEnabled()) notFound();

  const originError = checkSameOrigin(request);
  if (originError) return originError;

  // Per-IP budget. Hop-count posture (see request-ip.ts): behind the tunnel
  // (the deployed booth plan) leave TRUSTED_PROXY_COUNT unset (=1) so each
  // phone's tunnel-appended IP gets its own bucket; on the direct-LAN
  // fallback set TRUSTED_PROXY_COUNT=0 so a forged forwarding header cannot
  // mint a fresh bucket (at the cost of one shared global bucket).
  try {
    const ip = clientIpFromHeaders(await headers());
    if (!rateLimit(`demo-guest:${ip}`, GUEST_RATE)) {
      return NextResponse.json(
        { error: "rate_limited", message: "The demo queue is busy. Try again shortly." },
        { status: 429 },
      );
    }
  } catch {
    // headers() unavailable outside a request scope — never block the flow on it.
  }

  const body = await readCappedJson(request);
  if (!body.ok) return body.response;

  // Optional `code`: the visitor's scanned code. When supplied it must be the
  // demo code; the join below is pinned to DEMO_JOIN_CODE regardless (the route
  // is the authority, the client value is only a misuse check).
  const raw = body.data;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const code = (raw as Record<string, unknown>).code;
    if (typeof code === "string" && code.length > 0 && code !== DEMO_JOIN_CODE) {
      return NextResponse.json(
        { error: "invalid_code", message: "That join code is not valid." },
        { status: 400 },
      );
    }
  }

  const admin = createAdminClient();

  // The CAP uses the authoritative profile count (98xxxx matric range); the
  // bounded listUsers scan only supplies the cosmetic "Guest #N" label.
  // Null (DB error) degrades to 0: fail-open preserves the pre-existing
  // posture (a transient blip must not 503 the whole booth); the /demo
  // preflight surfaces the failure explicitly instead.
  const guestCount = (await countGuestAccounts(admin)) ?? 0;
  if (guestCount >= GUEST_ACCOUNT_CAP) {
    return NextResponse.json(
      { error: "demo_full", message: "The demo is at capacity right now." },
      { status: 503 },
    );
  }
  const labelNumber = (await countExistingGuests(admin)) + 1;

  let guest;
  try {
    guest = await createGuestUser(admin, { guestNumber: labelNumber });
  } catch (error) {
    logError("demo.guest.provision_failed", error, { subsystem: "demo" });
    return NextResponse.json(
      { error: "internal", message: "Could not start the demo right now." },
      { status: 503 },
    );
  }

  // Establish the guest's SESSION in this response's cookies. Route handlers run
  // where `cookies()` is writable; the pinned cookie name matches what the
  // middleware refreshes. (signInWithPassword is the correct mechanism — the
  // admin API cannot mint an SSR cookie session.)
  const userClient = await createServerActionClient();
  const { error: signInError } = await userClient.auth.signInWithPassword({
    email: guest.email,
    password: guest.password,
  });
  if (signInError) {
    logError("demo.guest.signin_failed", signInError, { subsystem: "demo" });
    return NextResponse.json(
      { error: "internal", message: "Could not start the demo right now." },
      { status: 503 },
    );
  }

  // The shared COOKIE_HANDLERS.setAll SWALLOWS cookie-write failures. Assert the
  // session actually took, or the visitor gets a 200 with no session (a silent
  // booth-killer).
  const {
    data: { user },
  } = await userClient.auth.getUser();
  // Bind the session to the JUST-CREATED guest: isGuestEmail alone only proves
  // the domain, so a caller already holding some other guest session could
  // otherwise pass. Identity equality is the real assertion.
  if (!user || user.id !== guest.id) {
    logError("demo.guest.session_missing", new Error("no session for the created guest"), {
      subsystem: "demo",
    });
    return NextResponse.json(
      { error: "internal", message: "Could not start the demo right now." },
      { status: 503 },
    );
  }

  // A1 (PLAN_DEMO_DAY_HARDENING): guests need biometric consent to start
  // assessments — start_quiz_session gates EVERY assessment start on
  // consent_given_at (0062), gestures-off included. grant_face_consent writes
  // ONLY consent_given_at under the app.consent_write GUC (0019) — no samples,
  // no camera, no enrollment state change. Guest consent ≠ guest enrollment:
  // the face stack stays off via gestures_enabled=false, never via identity
  // checks. Failure-tolerant by design: the practice quiz is the primary loop,
  // so a consent failure must NOT fail provisioning (same posture as join).
  try {
    const { error: consentError } = await userClient.rpc("grant_face_consent");
    if (consentError) {
      console.warn(`[demo] guest consent grant did not complete: ${consentError.message}`);
    }
  } catch {
    console.warn("[demo] guest consent grant threw; practice still playable");
  }

  // Enroll via the real RPC with the guest's own session. A join failure must
  // NOT strand the visitor: they are signed in, so send them to the quiz list
  // with a retry signal (A3) — the list renders a "Retry joining the demo"
  // button when ?join=retry is present and the list is empty. Without the
  // signal the guest would face a dead empty list with no recourse.
  const join = await joinDemoClass(userClient);
  if (!join.ok) {
    console.warn(`[demo] guest join did not complete: ${join.error}`);
    return NextResponse.json({
      redirect: "/student/quizzes?join=retry",
      joinError: join.error,
      guest: { name: guest.fullName },
    });
  }

  return NextResponse.json({ redirect: "/student/quizzes", guest: { name: guest.fullName } });
}
