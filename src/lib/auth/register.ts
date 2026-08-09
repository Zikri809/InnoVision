"use server";

import { createServerActionClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidInviteCode } from "@/lib/auth/invite-code";
import { isSameTimestamp } from "@/lib/auth/consent";
import { rateLimit } from "@/lib/classes/rate-limit";

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
}: {
  email: string;
  password: string;
  fullName?: string;
  inviteCode?: string;
}): Promise<RegisterResult> {
  const wantsLecturer = Boolean(inviteCode && inviteCode.trim().length > 0);

  // Rate-limit lecturer signup attempts (the invite code is a shared secret;
  // without a cap an attacker could brute-force it via repeated calls).
  // Both budgets must pass (&&): the per-email cap AND the global cap, so an
  // attacker rotating emails can't bypass the global throttle via short-circuit.
  if (wantsLecturer) {
    const rateKey = `invite:${email.trim().toLowerCase()}`;
    const allowed =
      rateLimit(rateKey, INVITE_RATE) && rateLimit("invite:global", {
        limit: 100,
        windowMs: 60_000,
      });
    if (!allowed) {
      return {
        session: false,
        error: "Too many registration attempts. Please try again later.",
      };
    }
  }

  // Validate the invite code BEFORE creating any account so an invalid code
  // never produces a (student) account that the caller didn't intend.
  if (wantsLecturer && !isValidInviteCode(inviteCode)) {
    return { session: false, error: "Invalid lecturer invite code." };
  }

  const supabase = await createServerActionClient();

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        // role is intentionally FIXED to "student" for self-signup.
        // The client role picker is display-only; never trust user_metadata.role.
        role: "student",
        full_name: fullName || undefined,
      },
    },
  });

  if (error) {
    return { session: false, error: error.message };
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
          { id: userId, role: "lecturer", consent_given_at: consentAt },
          { onConflict: "id" },
        )
        .select("id, role")
        .single();

      if (roleError) {
        console.error("Failed to promote profile to lecturer:", roleError);
        return {
          session: false,
          error: "Account created but role promotion failed. Contact support.",
        };
      }

      // Keep auth.users metadata in sync (belt-and-suspenders).
      await admin.auth.admin.updateUserById(userId, {
        user_metadata: { role: "lecturer", full_name: fullName || undefined },
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
          error: "Account created but role promotion failed. Contact support.",
        };
      }
    } catch (err) {
      console.error("Lecturer promotion error:", err);
      return {
        session: false,
        error: "Account created but role promotion failed. Contact support.",
      };
    }
  } else {
    // Student: record consent via the user's own session (server-side).
    // Plain UPDATE (RLS allows self-update with role='student'). In the normal
    // flow the signup trigger has already created the profile row, so this
    // succeeds. The real race: the UPDATE matches 0 rows because the trigger
    // hasn't inserted yet, THEN the trigger inserts the row (consent NULL).
    // So we verify the consent VALUE after the update, not just row existence,
    // and fall back to a service-role upsert when consent is still unset.
    const { error: consentError } = await supabase
      .from("profiles")
      .update({ consent_given_at: consentAt })
      .eq("id", userId);

    if (consentError) {
      console.error("Failed to record consent:", consentError);
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("consent_given_at")
      .eq("id", userId)
      .maybeSingle();

    // Compare by epoch ms via isSameTimestamp, NOT string equality: PostgREST
    // serializes timestamptz as "...+00:00" while `consentAt` is a JS ISO
    // string ("...Z"), so a direct === never matches and would make the admin
    // fallback run unconditionally.
    const consentWritten = isSameTimestamp(profile?.consent_given_at, consentAt);

    if (consentWritten) {
      // Consent written — done.
    } else {
      // Trigger race (or consent still missing): create/repair via service
      // role (bypasses RLS, which has no client INSERT policy by design).
      const admin = createAdminClient();
      const { error: adminError } = await admin
        .from("profiles")
        .upsert(
          { id: userId, role: "student", consent_given_at: consentAt },
          { onConflict: "id" },
        );
      if (adminError) {
        console.error("Failed to record consent (admin fallback):", adminError);
        return {
          session: false,
          error: "Account created but consent could not be recorded. Contact support.",
        };
      }
    }
  }

  return { session: Boolean(data.session) };
}
