"use server";

import { createServerActionClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/classes/rate-limit";
import { clientIpFromHeaders } from "@/lib/request-ip";
import { resolveSiteOrigin } from "@/lib/auth/site-url";

import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE_NAME } from "@/i18n/config";
import { tFor } from "@/lib/i18n/messages";
import type { SupportedLocale } from "@/lib/types/aliases";

const envLimit = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name] ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const RESET_EMAIL_RATE = { limit: envLimit("RESET_RATE_LIMIT", 5), windowMs: 60_000 };
const RESET_IP_RATE = { limit: envLimit("RESET_IP_RATE_LIMIT", 10), windowMs: 60_000 };
const CONFIRM_RATE = { limit: envLimit("RESET_CONFIRM_RATE_LIMIT", 10), windowMs: 60_000 };

export interface ResetResult {
  error?: string;
}

async function locale(): Promise<SupportedLocale> {
  const cookieStore = await cookies();
  return cookieStore.get(LOCALE_COOKIE_NAME)?.value === "ms" ? "ms" : "en";
}

/**
 * Password-reset server actions.
 *
 * - `requestReset` sends the GoTrue recovery email. The response is ALWAYS
 *   generic success copy: whether the address exists must not leak (no
 *   enumeration oracle — same posture as the login action's generic
 *   "invalid email or password").
 * - `confirmReset` completes the flow once the user has landed back through
 *   /auth/callback carrying a recovery session: validate, then
 *   updateUser({ password }).
 */

export async function requestReset({ email }: { email: string }): Promise<ResetResult> {
  const t = tFor(await locale());

  const trimmedEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    return { error: t("authErrors.invalidEmail") };
  }

  // Two budgets (per-email AND per-IP) must both pass: a per-email cap alone
  // would let an attacker rotate victims; a per-IP cap alone would let one
  // address be spammed from many sources. Mirrors the register action's
  // combined-cap pattern.
  try {
    const hdrs = await headers();
    const ip = clientIpFromHeaders(hdrs);
    if (!rateLimit(`reset-ip:${ip}`, RESET_IP_RATE)) {
      return { error: t("authErrors.tooManyAttempts") };
    }
  } catch {
    // headers() unavailable outside a request scope — never block the flow.
  }
  if (!rateLimit(`reset-email:${trimmedEmail}`, RESET_EMAIL_RATE)) {
    return { error: t("authErrors.tooManyAttempts") };
  }

  const supabase = await createServerActionClient();
  // audit-2 H-02: the origin for the emailed link comes from SITE_URL (or,
  // in dev only, the request headers). It used to be assembled from
  // x-forwarded-host verbatim, so requestReset({email: victim}) with a
  // forged Host header pointed the recovery link at the attacker's origin.
  // resolveSiteOrigin returns null in prod-without-env → the RELATIVE path
  // below, which GoTrue resolves against its own configured Site URL.
  const origin = resolveSiteOrigin(await headers().catch(() => undefined));
  const { error } = await supabase.auth.resetPasswordForEmail(trimmedEmail, {
    redirectTo: `${origin ?? ""}/auth/callback?redirect=/reset-password/confirm`,
  });

  if (error) {
    // Swallow the raw GoTrue error; the caller shows the generic confirmation
    // either way. Still surface the generic rate-limit message when Supabase
    // itself throttles, so honest users get actionable feedback.
    console.error("resetPasswordForEmail error:", error.message);
    if (error.status === 429) {
      return { error: t("authErrors.tooManyAttempts") };
    }
  }

  return {};
}

export async function confirmPassword({
  password,
}: {
  password: string;
}): Promise<ResetResult> {
  const t = tFor(await locale());

  if (typeof password !== "string" || password.length < 6) {
    return { error: t("authErrors.passwordShort") };
  }

  try {
    const hdrs = await headers();
    const ip = clientIpFromHeaders(hdrs);
    if (!rateLimit(`reset-confirm:${ip}`, CONFIRM_RATE)) {
      return { error: t("authErrors.tooManyAttempts") };
    }
  } catch {
    // headers() unavailable outside a request scope — never block the flow.
  }

  const supabase = await createServerActionClient();
  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    console.error("updateUser(password) error:", error.message);
    return { error: t("authErrors.resetFailed") };
  }

  return {};
}
