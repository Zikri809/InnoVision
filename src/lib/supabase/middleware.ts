import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/lib/types/database";
import { env, SUPABASE_AUTH_COOKIE } from "@/lib/env";
import { isDemoModeEnabled, DEMO_JOIN_CODE } from "@/lib/demo/gate";
import { normalizeJoinCode } from "@/lib/classes/join-code";

const PUBLIC_ROUTES = ["/", "/login", "/register", "/auth/callback", "/forgot-password", "/reset-password"];

// The recovery-confirm surface must stay reachable by a session that has JUST
// completed a password-recovery code exchange. GoTrue grants that callback a
// REAL (authenticated) session, so the generic "authenticated users leave auth
// pages" bounce below would otherwise strand them on /dashboard before they
// can choose a new password. Exempting this one path from the bounce is safe:
// a normally signed-in user hitting the URL sees the form and would be
// changing their own password.
const AUTH_BOUNCE_EXEMPT = ["/reset-password/confirm"];

/**
 * Static infrastructure the browser fetches ANONYMOUSLY (audit-3 H-F2 /
 * R2-TOP-F2). These are NOT part of `PUBLIC_ROUTES` on purpose: `PUBLIC_ROUTES`
 * feeds `shouldBounceAuthenticated`, which redirects a SIGNED-IN visitor to
 * `/dashboard` — adding the manifest there would break it for authenticated
 * users. The authoritative fix is the positive matcher allowlist in
 * `src/proxy.ts`, so these paths never reach `updateSession()` at all. This
 * list is defence-in-depth for the anonymous case (and documents the split so
 * a future matcher regression cannot silently 307 the PWA manifest to /login).
 */
const STATIC_ASSET_ROUTES = ["/manifest.webmanifest", "/robots.txt", "/sitemap.xml", "/sw.js", "/.well-known"];

function isStaticAssetRoute(pathname: string): boolean {
  return STATIC_ASSET_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
}

function isPublicRoute(pathname: string): boolean {
  if (isStaticAssetRoute(pathname)) return true;
  return PUBLIC_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
}

function shouldBounceAuthenticated(pathname: string): boolean {
  // Never bounce static infrastructure: a signed-in user's manifest/service
  // worker/robots fetch must return the file, not a 307 to /dashboard.
  if (isStaticAssetRoute(pathname)) return false;
  if (!isPublicRoute(pathname)) return false;
  return !AUTH_BOUNCE_EXEMPT.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
}

/**
 * Demo-mode exemption (PLAN_DEMO_MODE.md D3).
 *
 * `/join` is deliberately NOT in PUBLIC_ROUTES, so an anonymous scanner is
 * bounced to `/login?redirect=…` here. Under `NEXT_PUBLIC_DEMO_MODE=1` the
 * seeded demo class's code is exempted from that bounce so /join/[code] can
 * render the walk-up "Join the demo" card instead of the login wall.
 *
 * This function's ONLY job is to NOT bounce. It renders nothing (middleware
 * cannot) and passes no state — the page re-derives the same predicate
 * server-side (Node runtime) and is the authoritative branch, so a stale
 * build-time middleware env degrades to the login bounce, never a broken kiosk.
 *
 * Comparison is NORMALIZED (the DB/RPC world upper-cases and strips
 * spaces/dashes): a raw `=== DEMO_JOIN_CODE` would miss `/join/scan23` and
 * produce an inconsistent branch. `normalizeJoinCode` returns null for a
 * malformed segment, which correctly falls through to the ordinary bounce.
 * Exact equality against the normalized constant means no other code can ever
 * take this branch; with the flag off this is dead code.
 */
function isDemoJoinSkip(pathname: string): boolean {
  if (!isDemoModeEnabled()) return false;
  const segment = pathname.split("/")[2];
  return normalizeJoinCode(segment) === DEMO_JOIN_CODE;
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  // audit-3 A-F7: a redirect response is built fresh, so any auth cookies the
  // refresh above wrote onto `supabaseResponse` were DROPPED — the browser
  // kept its expired token, and the next request refreshed again (flicker,
  // repeated GoTrue refreshes, and a lost refresh when the redirect target
  // itself is a public route). Record every refreshed cookie here and replay
  // it onto whichever response we return.
  let refreshedCookies: { name: string; value: string; options?: Record<string, unknown> }[] = [];

  const supabase = createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // ACCUMULATE, don't overwrite: @supabase/ssr may invoke setAll more
          // than once in a single getUser() (e.g. a chunked-cookie refresh
          // followed by a clear). Overwriting would replay only the last batch
          // onto a redirect and drop the earlier cookies (audit-3 adversarial
          // review). Deduped by name, last write winning — matching the
          // browser's own cookie semantics.
          for (const c of cookiesToSet) {
            refreshedCookies = refreshedCookies.filter((p) => p.name !== c.name);
            refreshedCookies.push(c);
          }
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
      // Pinned session-cookie name — must equal the browser client's (see
      // SUPABASE_AUTH_COOKIE); the ssr default derives it from the URL.
      cookieOptions: { name: SUPABASE_AUTH_COOKIE },
    },
  );

  /** Replay refreshed auth cookies onto a redirect so the refresh survives. */
  const withRefreshedCookies = (response: NextResponse): NextResponse => {
    for (const { name, value, options } of refreshedCookies) {
      response.cookies.set(name, value, options);
    }
    return response;
  };

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // Redirect authenticated users away from auth pages (recovery-confirm exempt)
  if (user && shouldBounceAuthenticated(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return withRefreshedCookies(NextResponse.redirect(url));
  }

  // NOTE: `/api/*` is intentionally NOT handled here — the proxy matcher
  // excludes it (see proxy.ts). Every route handler self-authenticates and
  // returns JSON 401 on its own, so no HTML-login redirect can reach an API
  // caller.

  // Redirect unauthenticated users to login (except public routes)
  if (!user && !isPublicRoute(pathname)) {
    // Demo mode: the seeded demo class QR must reach /join/[code] anonymously
    // so the walk-up guest flow can render. See isDemoJoinSkip.
    if (pathname.startsWith("/join/") && isDemoJoinSkip(pathname)) {
      return supabaseResponse;
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // audit-3 A-F8: preserve the QUERY STRING too. The old form stored only
    // `pathname`, so an expired session on a query-carrying URL (e.g. the
    // student quiz list's `?class=…` link) lost its params after re-login.
    url.searchParams.set("redirect", `${pathname}${request.nextUrl.search}`);
    return withRefreshedCookies(NextResponse.redirect(url));
  }

  return supabaseResponse;
}
