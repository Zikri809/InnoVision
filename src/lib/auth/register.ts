"use server";

import { createServerActionClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidInviteCode } from "@/lib/auth/invite-code";
import { rateLimit } from "@/lib/classes/rate-limit";

import { cookies } from "next/headers";
import { LOCALE_COOKIE_NAME } from "@/i18n/config";
import { tFor } from "@/lib/i18n/messages";
import type { SupportedLocale } from "@/lib/types/aliases";



export interface RegisterResult {
  session: boolean;
  error?: string;
}

// Invite-code brute-force guard: a fixed budget per source IP per window.
// This is a per-process limiter (adequate for the demo scale); the constant-time
// compare in isValidInviteCode already defeats timing side-channels.
const INVITE_RATE = { limit: 10, windowMs: 60_000 };

/**
 * Self-signup server action.
 *
 * - role is NEVER taken from the client. Self-signup always creates a
 *   `student` profile; the DB trigger also hardcodes `student` as a safety net.
 * - A `lecturer` signup is only possible when a valid LECTURER_INVITE_CODE is
 *   supplied (validated server-side, constant-time). The user is then promoted
 *   via the service-role admin client (bypasses RLS, but only after the invite
 *   check passes). user_metadata.role stays untrusted.
 */
export async function register({
  email,
  password,
  fullName,
  inviteCode,
  locale = "en",
}: {
  email: string;
  password: string;
  fullName?: string;
  inviteCode?: string;
  locale?: SupportedLocale;
}): Promise<RegisterResult> {
  const wantsLecturer = Boolean(inviteCode && inviteCode.trim().length > 0);
  const userLocale: SupportedLocale = locale === "ms" ? "ms" : "en";
  const t = tFor(userLocale);

  // Basic input validation BEFORE any DB/auth work. Mirrors the bounds used
  // elsewhere (title/prompt) so a pathological payload can't bloat the DB or
  // reach Supabase's auth API with garbage. Email format + password minimum
  // match the client-side checks; full_name is capped because it is rendered
  // on every roster page.
  const trimmedEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    return { session: false, error: t("authErrors.invalidEmail") };
  }
  if (typeof password !== "string" || password.length < 6) {
    return { session: false, error: t("authErrors.passwordShort") };
  }
  const trimmedName = fullName?.trim() ?? "";
  if (trimmedName.length > 200) {
    return { session: false, error: t("authErrors.nameTooLong") };
  }

  // Rate-limit lecturer signup attempts (the invite code is a shared secret;
  // without a cap an attacker could brute-force it via repeated calls).
  // Both budgets must pass (&&): the per-email cap AND the global cap, so an
  // attacker rotating emails can't bypass the global throttle via short-circuit.
  if (wantsLecturer) {
    const rateKey = `invite:${trimmedEmail}`;
    const allowed =
      rateLimit(rateKey, INVITE_RATE) && rateLimit("invite:global", {
        limit: 100,
        windowMs: 60_000,
      });
    if (!allowed) {
      return {
        session: false,
        error: t("authErrors.tooManyAttempts"),
      };
    }
  }

  // Validate the invite code BEFORE creating any account so an invalid code
  // never produces a (student) account that the caller didn't intend.
  if (wantsLecturer && !isValidInviteCode(inviteCode)) {
    return { session: false, error: t("authErrors.invalidInviteCode") };
  }

  const supabase = await createServerActionClient();

  const { data, error } = await supabase.auth.signUp({
    email: trimmedEmail,
    password,
    options: {
      data: {
        // role is intentionally FIXED to "student" for self-signup.
        // The client role picker is display-only; never trust user_metadata.role.
        role: "student",
        full_name: fullName || undefined,
        locale: userLocale,
      },
    },
  });

  if (error) {
    console.error("signUp error:", error.message);
    return { session: false, error: t("authErrors.signupFailed") };
  }

  // Persist chosen language in cookies
  try {
    const cookieStore = await cookies();
    cookieStore.set(LOCALE_COOKIE_NAME, userLocale, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
  } catch {
    // Non-blocking cookie set
  }

  const userId = data.user?.id;
  if (!userId) {
    // Email confirmation flow — no session yet; nothing more to do server-side.
    return { session: Boolean(data.session) };
  }

  const consentAt = new Date().toISOString();

  if (wantsLecturer) {
    try {
      const admin = createAdminClient();
      // Single admin write: set role + consent in one service-role upsert
      // (the RLS update policy blocks self-promotion, so this must bypass RLS).
      // Use upsert on the PK so the trigger-race case (profile row not yet
      // created by handle_new_user) still gets the row created with the
      // lecturer role instead of silently updating 0 rows.
      const { error: roleError } = await admin
        .from("profiles")
        .upsert(
          {
            id: userId,
            role: "lecturer",
            full_name: fullName || null,
            locale: userLocale,
            consent_given_at: consentAt,
          },
          { onConflict: "id" },
        )
        .select("id, role")
        .single();

      if (roleError) {
        console.error("Failed to promote profile to lecturer:", roleError);
        return {
          session: false,
          error: t("authErrors.promotionFailed"),
        };
      }

      // Keep auth.users metadata in sync (belt-and-suspenders).
      await admin.auth.admin.updateUserById(userId, {
        user_metadata: {
          role: "lecturer",
          full_name: fullName || undefined,
          locale: userLocale,
        },
      });

      // Verify promotion actually took effect; if not, surface a clear error
      // rather than leaving the user stuck with a student profile.
      const { data: profile } = await admin
        .from("profiles")
        .select("role")
        .eq("id", userId)
        .maybeSingle();

      if (profile?.role !== "lecturer") {
        console.error("Lecturer promotion not reflected in profile for", userId);
        return {
          session: false,
          error: t("authErrors.promotionFailed"),
        };
      }
    } catch (err) {
      console.error("Lecturer promotion error:", err);
      return {
        session: false,
        error: t("authErrors.promotionFailed"),
      };
    }
  } else {
    // Student: record consent via the sanctioned RPC. The profiles
    // restricted-columns trigger blocks every direct authenticated write to
    // consent_given_at (anti-forgery), so the direct update this used to do
    // would now fail with cannot_change_consent_directly. The chosen locale
    // is unrestricted — persisted via a separate plain update.
    const { data: grantData, error: grantError } = await supabase.rpc("grant_face_consent");
    if (grantError || (grantData as Record<string, unknown> | null)?.ok !== true) {
      console.error("grant_face_consent failed during registration:", grantError ?? grantData);
    }

    await supabase.from("profiles").update({ locale: userLocale }).eq("id", userId);

    const { data: profile } = await supabase
      .from("profiles")
      .select("consent_given_at")
      .eq("id", userId)
      .maybeSingle();

    const consentWritten = profile?.consent_given_at != null;

    if (consentWritten) {
      // Consent written — done.
    } else {
      // RPC race (or failure): create/repair via service role (bypasses RLS
      // and passes the trigger, since auth.role() is 'service_role').
      const admin = createAdminClient();
      const { error: adminError } = await admin
        .from("profiles")
        .upsert(
          {
            id: userId,
            role: "student",
            full_name: fullName || null,
            locale: userLocale,
            consent_given_at: consentAt,
          },
          { onConflict: "id" },
        );
      if (adminError) {
        console.error("Failed to record consent (admin fallback):", adminError);
        return {
          session: false,
          error: t("authErrors.consentFailed"),
        };
      }
    }
  }


  return { session: Boolean(data.session) };
}
