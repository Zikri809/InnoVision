import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/lib/types/database";
import { env } from "@/lib/env";

const PUBLIC_ROUTES = ["/", "/login", "/register", "/auth/callback", "/forgot-password", "/reset-password"];

// The recovery-confirm surface must stay reachable by a session that has JUST
// completed a password-recovery code exchange. GoTrue grants that callback a
// REAL (authenticated) session, so the generic "authenticated users leave auth
// pages" bounce below would otherwise strand them on /dashboard before they
// can choose a new password. Exempting this one path from the bounce is safe:
// a normally signed-in user hitting the URL sees the form and would be
// changing their own password.
const AUTH_BOUNCE_EXEMPT = ["/reset-password/confirm"];

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
}

function shouldBounceAuthenticated(pathname: string): boolean {
  if (!isPublicRoute(pathname)) return false;
  return !AUTH_BOUNCE_EXEMPT.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // Redirect authenticated users away from auth pages (recovery-confirm exempt)
  if (user && shouldBounceAuthenticated(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  // NOTE: `/api/*` is intentionally NOT handled here — the proxy matcher
  // excludes it (see proxy.ts). Every route handler self-authenticates and
  // returns JSON 401 on its own, so no HTML-login redirect can reach an API
  // caller.

  // Redirect unauthenticated users to login (except public routes)
  if (!user && !isPublicRoute(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", pathname);
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
