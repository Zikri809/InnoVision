"use server";

import { createServerActionClient } from "@/lib/supabase/server";
import { rateLimit, recordRateLimitHit, resetRateLimit } from "@/lib/classes/rate-limit";
import { clientIpFromHeaders } from "@/lib/request-ip";
import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE_NAME } from "@/i18n/config";
import { tFor } from "@/lib/i18n/messages";

const envLimit = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name] ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// audit-2 H-01: login was the ONLY auth action with no rate limit (register/
// reset/SSO/matric all had budgets) — unlimited online password guessing on
// the highest-value endpoint. Two budgets, mirroring reset.ts: a per-account
// cap stops single-victim brute force; a per-IP cap stops victim rotation.
// The IP budget is deliberately loose (classroom NAT shares one egress IP —
// the SSO limiter's 60/min precedent) so honest lab sessions never hit it.
//
// audit-3 A-F4: the per-account budget is now a FAILURE counter, not a
// request gate. As a request gate it was a free denial-of-service against any
// known address: 5 bogus attempts/min on victim@x kept the victim locked out
// of their own account for as long as the attacker kept going (the 60s window
// self-cleared, but the attacker refilled it — no success-clear, no backoff),
// which is a live-demo outage for a lecturer.
//
// Any failure-keyed GATE has that property (an attacker who can fail
// indefinitely can also block indefinitely), so the gate is removed and the
// counter becomes a detection signal: every attempt is recorded, a SUCCESS
// resets it, and crossing the threshold is logged.
//
// RESIDUAL RISK (deliberate, documented): without a per-account gate, password
// guessing against ONE account is bounded only by the per-IP budget
// (LOGIN_IP_RATE = 30/min, shared across all accounts from that IP) and by
// TRUSTED_PROXY_COUNT attribution. A single host can therefore attempt roughly
// 43k passwords/day against one address, versus the old 5/min/account cap.
// That is the accepted cost of not handing every known address a lockout
// switch; the complete fix is a durable per-account counter with exponential
// delay (or a CAPTCHA/proof-of-work step), which this scale does not have —
// see the audit ledger's A-F4 entry.
const LOGIN_EMAIL_FAIL_WINDOW_MS = 15 * 60_000;
const LOGIN_EMAIL_FAIL_THRESHOLD = envLimit("LOGIN_EMAIL_FAIL_THRESHOLD", 5);
const LOGIN_IP_RATE = { limit: envLimit("LOGIN_IP_RATE_LIMIT", 30), windowMs: 60_000 };

/**
 * Longest email we will use as a rate-limit key. RFC 5321 caps a path at 256
 * octets; 254 is the practical address maximum. The counter key is built from
 * raw form input on a directly POSTable server action, so an unbounded string
 * would let a caller mint arbitrarily large map entries (audit-3 adversarial
 * review). Over-long input is never a real account, so it is keyed by a fixed
 * sentinel instead of its own text.
 */
const MAX_EMAIL_KEY_LENGTH = 254;

export interface LoginResult {
  error?: string;
}

export async function login({
  email,
  password,
}: {
  email: string;
  password: string;
}): Promise<LoginResult> {
  const t = tFor((await cookies()).get(LOCALE_COOKIE_NAME)?.value === "ms" ? "ms" : "en");

  // L-13: normalize like register/reset (trim + lower) so `User@X.com ` and
  // case variants don't behave differently from the signup path.
  const normalizedEmail = email.trim().toLowerCase();
  // Bound the counter key: raw form input on a directly POSTable action must
  // not become an unbounded map entry (see MAX_EMAIL_KEY_LENGTH).
  const failKey =
    normalizedEmail.length > 0 && normalizedEmail.length <= MAX_EMAIL_KEY_LENGTH
      ? `login-email-fails:${normalizedEmail}`
      : "login-email-fails:__invalid__";

  // Per-IP budget first (headers() unavailable outside request scope —
  // never block the flow on that). This is the request gate.
  try {
    const ip = clientIpFromHeaders(await headers());
    if (!rateLimit(`login-ip:${ip}`, LOGIN_IP_RATE)) {
      return { error: t("authErrors.loginTooManyAttempts") };
    }
  } catch {
    // headers() unavailable outside a request scope — never block the flow.
  }

  // audit-3 A-F4: a saturated FAILURE counter is a detection signal, never a
  // gate — the account owner can still sign in with the right password, which
  // is what breaks the indefinite-lockout DoS. Every attempt is recorded here
  // (before the credential check, so a success can clear it below); the count
  // only ever feeds the log line, never a rejection.
  const priorFailures = recordRateLimitHit(failKey, { windowMs: LOGIN_EMAIL_FAIL_WINDOW_MS });
  const overThreshold = priorFailures > LOGIN_EMAIL_FAIL_THRESHOLD;

  const supabase = await createServerActionClient();

  const { error } = await supabase.auth.signInWithPassword({
    email: normalizedEmail,
    password,
  });

  if (error) {
    // Localized generic message: raw Supabase errors are English-only, and a
    // generic response also avoids revealing whether the email or the
    // password was wrong.
    console.error("signInWithPassword error:", error.message);
    if (overThreshold) {
      // Visible in logs instead of silently ignored (and instead of a
      // lockout nobody can see the cause of).
      console.warn(
        `[login] repeated failed sign-ins for ${normalizedEmail}: ${priorFailures} in the last ${LOGIN_EMAIL_FAIL_WINDOW_MS / 60_000} min`,
      );
    }
    return { error: t("authErrors.loginFailed") };
  }

  // Success clears the failure counter — the half that stops an attacker
  // keeping a legitimate account locked out indefinitely.
  resetRateLimit(failKey);
  return {};
}
