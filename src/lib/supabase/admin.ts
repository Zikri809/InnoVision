import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { env } from "@/lib/env";

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
 *
 * **Gate S6: `import "server-only"`.** The header above already SAID
 * "SERVER-ONLY", but that was prose only — unlike its siblings
 * (`src/lib/ai/client.ts`, `src/lib/ai/tinyfish.ts`,
 * `src/lib/face/server/insightface-client.ts`) the module carried no runtime
 * guard, so a stray client-component import would have bundled the
 * service-role key instead of failing the build. `server-only` resolves to a
 * throwing module outside the RSC/server layer (Next aliases it per layer —
 * `WEBPACK_LAYERS.GROUP.serverOnly` allows it), making the claim enforceable.
 * `src/test/setup.ts` mocks the package globally, so unit tests that import
 * this module (route tests mock it anyway) are unaffected.
 *
 * audit-3 A-F5: the key is REQUIRED for the app's privileged features (face
 * verify, incident clips, media cleanup, notifications), but the pre-checks
 * that merely improve an error message must not depend on it — an unset key
 * used to turn the advisory duplicate-matric lookup into a hard crash that
 * blocked student signup entirely (and wedged SSO students on the matric gate),
 * contradicting the documented "optional, fails closed per feature" posture.
 * Privileged writes keep using `createAdminClient()` and still fail loudly;
 * advisory lookups use `tryCreateAdminClient()` and degrade.
 */
let adminClient: SupabaseClient<Database> | null = null;

export function createAdminClient(): SupabaseClient<Database> {
  if (adminClient) return adminClient;

  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!serviceRoleKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY must be set to use the admin client.",
    );
  }

  adminClient = createClient<Database>(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return adminClient;
}

/**
 * Null-returning variant for ADVISORY calls (audit-3 A-F5). Returns null when
 * SUPABASE_SERVICE_ROLE_KEY is unset instead of throwing, so a friendly-error
 * pre-check cannot become an outage. Callers MUST have a correct fallback: the
 * DB constraint is the authority, so skipping the pre-check degrades the error
 * message, never the invariant.
 */
export function tryCreateAdminClient(): SupabaseClient<Database> | null {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn(
      "[admin] SUPABASE_SERVICE_ROLE_KEY is unset: skipping an advisory service-role " +
        "lookup. Privileged features (face verify, incident clips, media) will fail.",
    );
    return null;
  }
  return createAdminClient();
}
