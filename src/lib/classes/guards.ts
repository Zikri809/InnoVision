import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

export type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; response: Response };

const UNAUTHORIZED = () =>
  new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

const FORBIDDEN = () =>
  new Response(JSON.stringify({ error: "forbidden" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });

const SERVICE_UNAVAILABLE = () =>
  new Response(
    JSON.stringify({ error: "profile_unavailable", message: "Your profile is not ready yet. Try again." }),
    { status: 503, headers: { "content-type": "application/json" } },
  );

/**
 * Resolve the authenticated user + role from the cookie session.
 *
 * Route handlers can be hit directly (bypassing page layouts), so every
 * handler must self-check. We read the profile via the anon cookie client so
 * RLS applies. A missing profile row (trigger race on signup) is a transient
 * condition → 503, not 403. A DB error is an outage → 503, not a silent 403.
 */
async function requireUser(
  supabase: SupabaseClient<Database>,
  role: "lecturer" | "student",
): Promise<AuthResult> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, response: UNAUTHORIZED() };
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    // PGRST116 is handled by maybeSingle (returns null, no error). Any other
    // error here is a real DB problem → 503.
    return { ok: false, response: SERVICE_UNAVAILABLE() };
  }

  if (!profile) {
    // Profile row not created yet (signup trigger race) → transient.
    return { ok: false, response: SERVICE_UNAVAILABLE() };
  }

  if (profile.role !== role) {
    return { ok: false, response: FORBIDDEN() };
  }

  return { ok: true, userId: user.id };
}

export const requireLecturer = (supabase: SupabaseClient<Database>) =>
  requireUser(supabase, "lecturer");

export const requireStudent = (supabase: SupabaseClient<Database>) =>
  requireUser(supabase, "student");
