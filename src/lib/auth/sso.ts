"use server";

import { createServerActionClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/classes/rate-limit";
import { clientIpFromHeaders } from "@/lib/request-ip";
import { isSsoConfigured } from "@/lib/auth/institutional";
import { resolveSiteOrigin } from "@/lib/auth/site-url";
import { sanitizeRedirect } from "@/lib/auth/redirect";

import { headers } from "next/headers";

// Classroom-NAT scale: an entire lecture hall can share ONE egress IP
// (campus Wi-Fi / eduroam), and mass QR onboarding is exactly when SSO
// starts spike. 10/min per IP locked out SSO login #11+; 60/min keeps the
// classroom flowing while still blunting scripted abuse (join abuse itself
// is throttled per-USER by /api/classes/join + the DB lockout, so this
// limiter is not the join-attack control).
const SSO_START_RATE = { limit: 60, windowMs: 60_000 };

export interface SsoStartResult {
  error?: string;
  /** The provider's absolute authorization URL — navigate the browser to it. */
  url?: string;
  /** Set when SSO is not configured (button shouldn't be visible anyway). */
  disabled?: boolean;
}

/**
 * AU-2 — start the Microsoft institutional sign-in (Azure OIDC via Supabase).
 *
 * The redirect lands on the shared PKCE callback (/auth/callback), which
 * enforces the domain allowlist + same-email linking transparency before the
 * session is usable. The button is only rendered when
 * INSTITUTIONAL_EMAIL_DOMAINS is configured, so an error here is a
 * misconfiguration, not a user mistake — still surfaced generically.
 */
export async function startInstitutionalSso({
  redirect,
}: {
  redirect?: string;
} = {}): Promise<SsoStartResult> {
  if (!isSsoConfigured()) {
    return { disabled: true };
  }

  try {
    const hdrs = await headers();
    const ip = clientIpFromHeaders(hdrs);
    if (!rateLimit(`sso-start:${ip}`, SSO_START_RATE)) {
      return { error: "too_many_attempts" };
    }
  } catch {
    // headers() unavailable outside a request scope — never block the flow.
  }

  const supabase = await createServerActionClient();
  // audit-2 H-02: the OAuth redirectTo origin resolves from SITE_URL (dev
  // only: request headers) — never from caller-writable Host headers. A null
  // origin degrades to a RELATIVE callback URL, which GoTrue resolves against
  // its own configured Site URL (safe failure mode; sso.ts precedent).
  const origin = resolveSiteOrigin(await headers().catch(() => undefined)) ?? "";
  // The callback defaults a missing `redirect` param to /dashboard
  // (sanitizeRedirect).
  // Post-login bounce-back (QR class join): when the login form passes a
  // redirect target, it is forwarded to the callback as its `redirect` query
  // param. The client copy is NEVER trusted — re-sanitized here server-side
  // (sanitizeRedirect is origin-aware; garbage folds to /dashboard), and
  // /auth/callback re-sanitizes AGAIN at the point of use.
  const safeRedirect = sanitizeRedirect(redirect ?? null, origin || "http://localhost");
  // NOTE on the empty-origin fallback: a relative redirectTo is resolved by
  // GoTrue against the configured Site URL, so the degraded path still works
  // hosted (reset.ts documents the round-trip requirement that the PRIMARY
  // path must stay absolute). sanitizeRedirect against the localhost fallback
  // base preserves local-path targets — the origin check passes for any base.
  // Only append when the caller actually supplied a target: an absent param
  // must keep the bare callback URL (byte-identical to the pre-QR flow), so
  // existing SSO logins are unaffected and the redirect stays the exception.
  const callbackUrl =
    redirect && safeRedirect !== "/dashboard"
      ? `${origin}/auth/callback?redirect=${encodeURIComponent(safeRedirect)}`
      : `${origin}/auth/callback`;
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "azure",
    options: {
      // `email` is the only claim the callback needs — no Graph API access.
      scopes: "email profile",
      redirectTo: callbackUrl,
    },
  });

  if (error) {
    console.error("signInWithOAuth(azure) error:", error.message);
    return { error: "sso_failed" };
  }
  if (!data?.url) {
    console.error("signInWithOAuth(azure) returned no url");
    return { error: "sso_failed" };
  }

  return { url: data.url };
}
