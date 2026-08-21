import { z } from "zod";

/**
 * Fail-fast environment validation.
 *
 * Every process that boots the app (next dev / next start / next build /
 * vitest) imports this module transitively via the Supabase clients, so a
 * missing or malformed variable crashes at STARTUP with a clear message
 * instead of producing per-request 500s (or a silently broken client bundle).
 *
 * Server-only secrets (SUPABASE_SERVICE_ROLE_KEY, AI_API_KEY, ...) are NOT
 * listed here on purpose: they are optional feature flags validated lazily at
 * their point of use (see lib/supabase/admin.ts, lib/ai/client.ts) so the app
 * can boot without them and the affected features fail closed.
 */
const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
});

const parsed = publicEnvSchema.safeParse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
});

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(
    `Invalid/missing environment variables (check .env.local):\n${issues}`,
  );
}

export const env = parsed.data;
