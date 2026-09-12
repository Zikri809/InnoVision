"use server";

import { createServerActionClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/classes/rate-limit";
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
const LOGIN_EMAIL_RATE = { limit: envLimit("LOGIN_EMAIL_RATE_LIMIT", 5), windowMs: 60_000 };
const LOGIN_IP_RATE = { limit: envLimit("LOGIN_IP_RATE_LIMIT", 30), windowMs: 60_000 };

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

  // Per-IP budget first (headers() unavailable outside request scope —
  // never block the flow on that), then per-account. Both must pass.
  try {
    const ip = clientIpFromHeaders(await headers());
    if (!rateLimit(`login-ip:${ip}`, LOGIN_IP_RATE)) {
      return { error: t("authErrors.loginTooManyAttempts") };
    }
  } catch {
    // headers() unavailable outside a request scope — never block the flow.
  }
  if (!rateLimit(`login-email:${normalizedEmail}`, LOGIN_EMAIL_RATE)) {
    return { error: t("authErrors.loginTooManyAttempts") };
  }

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
    return { error: t("authErrors.loginFailed") };
  }

  return {};
}
