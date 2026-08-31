"use server";

import { createServerActionClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/classes/rate-limit";
import { isSsoConfigured } from "@/lib/auth/institutional";

import { headers } from "next/headers";

const SSO_START_RATE = { limit: 10, windowMs: 60_000 };

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
export async function startInstitutionalSso(): Promise<SsoStartResult> {
  if (!isSsoConfigured()) {
    return { disabled: true };
  }

  try {
    const hdrs = await headers();
    const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (!rateLimit(`sso-start:${ip}`, SSO_START_RATE)) {
      return { error: "too_many_attempts" };
    }
  } catch {
    // headers() unavailable outside a request scope — never block the flow.
  }

  const supabase = await createServerActionClient();
  // GoTrue's /authorize validates `redirect_to` against the Site URL, so it
  // must be ABSOLUTE (reset.ts precedent — a relative value fails the hosted
  // round-trip). The callback defaults a missing `redirect` param to
  // /dashboard (sanitizeRedirect), so no query param is needed — one fewer
  // string for the allow-list to match.
  let origin = "";
  try {
    const hdrs = await headers();
    const host = hdrs.get("x-forwarded-host") ?? hdrs.get("host");
    const proto = hdrs.get("x-forwarded-proto") ?? "http";
    if (host) origin = `${proto}://${host}`;
  } catch {
    // headers() unavailable — GoTrue resolves a relative redirectTo against
    // the configured site URL; keep the empty-origin fallback.
  }
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "azure",
    options: {
      // `email` is the only claim the callback needs — no Graph API access.
      scopes: "email profile",
      redirectTo: `${origin}/auth/callback`,
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
