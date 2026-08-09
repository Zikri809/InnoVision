import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { forbidden, profileUnavailable, unauthorized } from "@/lib/http";

export type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; response: Response };

/**
 * Resolve the authenticated user + role from the cookie session.
 *
 * Route handlers can be hit directly (bypassing page layouts), so every
 * handler must self-check. We read the profile via the anon cookie client so
 * RLS applies. A missing profile row (trigger race on signup) is a transient
 * condition → 503, not 403. A DB error is an outage → 503, not a silent 403.
 *
 * Exported so feature guards (e.g. lib/quizzes/guards.ts) can reuse the same
 * role check instead of duplicating it.
 */
export async function requireUser(
  supabase: SupabaseClient<Database>,
  role: "lecturer" | "student",
): Promise<AuthResult> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, response: unauthorized() };
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    // PGRST116 is handled by maybeSingle (returns null, no error). Any other
    // error here is a real DB problem → 503.
    return { ok: false, response: profileUnavailable() };
  }

  if (!profile) {
    // Profile row not created yet (signup trigger race) → transient.
    return { ok: false, response: profileUnavailable() };
  }

  if (profile.role !== role) {
    return { ok: false, response: forbidden() };
  }

  return { ok: true, userId: user.id };
}

export const requireLecturer = (supabase: SupabaseClient<Database>) =>
  requireUser(supabase, "lecturer");

export const requireStudent = (supabase: SupabaseClient<Database>) =>
  requireUser(supabase, "student");
