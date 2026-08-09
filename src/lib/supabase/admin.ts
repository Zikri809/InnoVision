import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

/**
 * Service-role Supabase client (SERVER-ONLY).
 *
 * Bypasses RLS. Use ONLY for privileged operations that must not be
 * client-controllable:
 *   - lecturer role promotion (validated via LECTURER_INVITE_CODE first)
 *   - (future) grading / face-compare / audit writes
 *
 * NEVER import this into a client component or expose it via a route that
 * a non-privileged user can reach.
 */
let adminClient: SupabaseClient<Database> | null = null;

export function createAdminClient(): SupabaseClient<Database> {
  if (adminClient) return adminClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to use the admin client.",
    );
  }

  adminClient = createClient<Database>(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return adminClient;
}
