import { createServerClient } from "@supabase/ssr";
import type { SetAllCookies } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/lib/types/database";
import { env } from "@/lib/env";

const COOKIE_HANDLERS = (cookieStore: Awaited<ReturnType<typeof cookies>>) => ({
  getAll() {
    return cookieStore.getAll();
  },
  // Cast: SetAllCookies also carries a `headers` field used by the ssr lib to
  // set anti-caching Cache-Control on auth-cookie writes. We intentionally
  // don't forward it here — Next's cookieStore.set handles the write and the
  // middleware refreshes auth on navigation, so dropping `headers` is a safe
  // simplification. If auth cookies start getting cached, revisit this.
  setAll: ((cookiesToSet) => {
    try {
      cookiesToSet.forEach(({ name, value, options }) =>
        cookieStore.set(name, value, options),
      );
    } catch {
      // The `setAll` method was called from a Server Component or a server
      // action that can't write cookies. During SSR this happens when the auth
      // token refreshes — the middleware (proxy.ts) handles the actual write.
    }
  }) as SetAllCookies,
});

/** Server client for pages and route handlers (reads the request cookies). */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { cookies: COOKIE_HANDLERS(cookieStore) },
  );
}

/** Server client for server actions (same cookie handling as createClient). */
export async function createServerActionClient() {
  const cookieStore = await cookies();
  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { cookies: COOKIE_HANDLERS(cookieStore) },
  );
}
