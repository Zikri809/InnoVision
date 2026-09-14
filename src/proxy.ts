import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

/**
 * POSITIVE allowlist (audit-3 H-F2 / R2-TOP-F2).
 *
 * The matcher used to be an extension DENYLIST that caught every path except
 * `/api`, `/sb`, `/mediapipe`, `/models`, `/_next/static`, `/_next/image`,
 * `favicon.ico` and a handful of image/asset extensions. That intercepted
 * public infrastructure the browser fetches ANONYMOUSLY — most importantly
 * `/manifest.webmanifest` (linked from `src/app/layout.tsx`), which was 307'd
 * to `/login`, so the manifest parser received login HTML and PWA install was
 * broken. `/robots.txt`, `/sitemap.xml`, `/sw.js` and `/.well-known/*` were
 * in the same blast radius.
 *
 * The fix inverts the rule: list ONLY the app routes that need session
 * handling. Static assets, the PWA manifest/service worker, well-known files,
 * vendored MediaPipe/model payloads, `/api/*` (every route self-authenticates)
 * and the `/sb/*` Supabase rewrite prefix never reach `updateSession()` at all.
 *
 * MAINTENANCE: a NEW top-level app route prefix must be added here, or it will
 * serve without the middleware's login redirect. The in-page guards
 * (`requireUser` / `requireLecturer` / `requireStudent`) remain the security
 * boundary — this middleware is the UX redirect + session refresh, so a missed
 * entry degrades the redirect, never the authorization.
 *
 * Note on `PUBLIC_ROUTES` (src/lib/supabase/middleware.ts): it intentionally
 * lists only in-middleware app routes. Static infrastructure is excluded HERE,
 * at the matcher, because `PUBLIC_ROUTES` has the opposite side effect — an
 * authenticated visitor to a "public" route is bounced to `/dashboard`, which
 * would break the manifest for signed-in users. See the comment there.
 */
export const config = {
  matcher: [
    // Public/auth surfaces that still need session handling: an authenticated
    // visitor to `/`, `/login`, etc. is bounced to `/dashboard`, and
    // `/auth/callback` must be reachable to complete a recovery/SSO exchange.
    "/",
    "/login",
    "/register",
    "/forgot-password",
    "/reset-password/:path*",
    "/auth/callback",
    // Authenticated app surfaces (login redirect when anonymous).
    "/dashboard/:path*",
    "/lecturer/:path*",
    "/student/:path*",
    "/play/:path*",
    "/join/:path*",
    "/s/:path*",
    "/matric-capture/:path*",
    "/dev/:path*",
    // NOTE: `/api/*` and `/sb/*` stay OUT of this list. Every route handler
    // self-authenticates (requireUser / requireLecturer / explicit getUser)
    // and returns JSON 401 itself — running the middleware's `getUser()` there
    // too would add a redundant auth round-trip to every mutation for zero
    // security benefit, and its unauthenticated redirect to /login would break
    // the browser client's REST polling.
    // `/mediapipe/*` and `/models/*` are STATIC-ONLY prefixes (P6 vendored
    // MediaPipe runtime + hand-landmarker model) — excluded to avoid an
    // `updateSession()` round-trip per file (~8 per student) on the
    // gesture-boot critical path. Any future ROUTE under these prefixes must
    // self-authenticate — do not rely on the middleware to protect it.
  ],
};
