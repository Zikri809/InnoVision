import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/types/database";
import { env } from "@/lib/env";

/**
 * The public Supabase URL is baked into the client bundle. When it points at
 * THIS machine's loopback (the local-supabase demo setup), a remote browser
 * would resolve 127.0.0.1 to itself and every browser-direct call would fail.
 * Re-point those at the same-origin /sb prefix, which next.config.ts rewrites
 * to the local Kong gateway. Hosted (https://*.supabase.co) URLs pass through
 * unchanged.
 */
function publicSupabaseUrl(): string {
  const raw = env.NEXT_PUBLIC_SUPABASE_URL;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i.test(raw)) {
    return `${typeof window === "undefined" ? "http://localhost" : window.location.origin}/sb`;
  }
  return raw;
}

export function createClient() {
  return createBrowserClient<Database>(
    publicSupabaseUrl(),
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
