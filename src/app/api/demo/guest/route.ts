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

/**
 * Absolute ceiling on concurrently provisioned guest accounts. Per-user spend
 * caps bound AI spend, not account count; this caps roster bloat and keeps the
 * reset script's work bounded. Generous for a full exhibition day.
 */
const GUEST_ACCOUNT_CAP = 200;

export async function POST(request: Request) {
  if (!isDemoModeEnabled()) notFound();

  const originError = checkSameOrigin(request);
  if (originError) return originError;

  // Per-IP budget. With the booth's documented `TRUSTED_PROXY_COUNT=0`, a
  // forged forwarding header cannot mint a fresh bucket (see request-ip.ts).
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
  const guestCount = await countGuestAccounts(admin);
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

  // Enroll via the real RPC with the guest's own session. A join failure must
  // NOT strand the visitor: they are signed in, so send them to the quiz list
  // and let the confirm card retry the join. Only a transport failure is
  // reported, and even then we still return the redirect.
  const join = await joinDemoClass(userClient);
  if (!join.ok) {
    console.warn(`[demo] guest join did not complete: ${join.error}`);
  }

  return NextResponse.json({ redirect: "/student/quizzes", guest: { name: guest.fullName } });
}
