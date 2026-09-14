import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { sanitizeRedirect } from "@/lib/auth/redirect";
import { resolveSiteOrigin } from "@/lib/auth/site-url";
import { rateLimit } from "@/lib/classes/rate-limit";
import { clientIpFromHeaders } from "@/lib/request-ip";
import { env, SUPABASE_AUTH_COOKIE } from "@/lib/env";
import {
  institutionalDomains,
  isAllowedInstitutionalEmail,
} from "@/lib/auth/institutional";

// audit-2 M-18: the code-exchange endpoint is the one unauthenticated
// auth endpoint with no budget. Codes are high-entropy and single-use (so
// brute force stays Low), but the endpoint still enables login-CSRF
// (exchange the ATTACKER's own code in a victim browser) and unbounded
// probe traffic toward GoTrue — a per-IP budget mirrors the SSO-start limiter.
const CALLBACK_RATE = { limit: 30, windowMs: 60_000 };

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);

  // audit-3 A-F2: post-auth redirects must land on a PUBLIC origin. The old
  // form used `new URL(request.url).origin`, which Next builds from the Host it
  // sees — behind the documented cloudflare tunnel that is the INTERNAL host
  // (next.config.ts records the ops incident proving it), so a successful
  // SSO/confirm exchange 307'd the browser to an unreachable address and the
  // user dead-ended immediately after authenticating. `resolveSiteOrigin` is
  // the same authority the reset/register link flows already use, so there is
  // ONE answer to "what is this deployment's public origin". It falls back to
  // the request origin when SITE_URL is unset, preserving local dev.
  const siteOrigin = resolveSiteOrigin(request.headers) ?? origin;

  const ip = clientIpFromHeaders(request.headers);
  if (!rateLimit(`auth-callback:${ip}`, CALLBACK_RATE)) {
    return NextResponse.redirect(`${siteOrigin}/login?message=sso-error`);
  }

  const code = searchParams.get("code");
  // Anti-open-redirect: only allow same-origin local paths (shared helper with
  // the login page). Handles protocol-relative, absolute, and backslash
  // variants. The middleware sets this param from pathname, which is always a
  // local path, so this only rejects attacker-supplied values.
  const redirect = sanitizeRedirect(searchParams.get("redirect"), siteOrigin);

  // GoTrue error round-trips (OAuth provider denials, misconfigurations) land
  // here WITHOUT a code and WITH error params — surface the generic auth
  // error rather than silently bouncing to the login form.
  const oauthError = searchParams.get("error_description") ?? searchParams.get("error");
  if (!code) {
    const target = oauthError
      ? `${siteOrigin}/login?message=sso-error`
      : `${siteOrigin}/login`;
    return NextResponse.redirect(target);
  }

  const supabaseResponse = NextResponse.redirect(`${siteOrigin}${redirect}`);

  //developer note: seperate this so that it can be reused
  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
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

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data?.user) {
    // Failed exchange: clear any partial cookies by signing out and reusing
    // THIS response — signOut writes the cookie deletions through the same
    // setAll hook bound to supabaseResponse, so the browser actually
    // receives them (returning a fresh redirect would DISCARD them).
    await supabase.auth.signOut({ scope: "local" });
    supabaseResponse.headers.set("Location", `${siteOrigin}/login?message=sso-error`);
    return supabaseResponse;
  }

  // ── AU-2: institutional domain allowlist (SECOND trust layer) ──
  // Runs for EVERY code exchange (recovery sessions carry no OAuth provider
  // identity and pass through untouched — their identity has no azure row).
  // Read ONCE: a single env snapshot can't diverge between the gate check
  // and the verdict.
  const allowedDomains = institutionalDomains();
  if (allowedDomains.length > 0) {
    const identities = data.user.identities ?? [];
    const azureIdentity = identities.find((i) => i.provider === "azure");
    if (azureIdentity) {
      // audit-2 M-16: the `?? data.user.email` fallback used to attest the
      // GoTrue PRIMARY email (attacker-registerable password email) when the
      // azure identity carried no email claim — the domain gate judged the
      // WRONG address. Fail closed instead: no claim → reject (sso-domain).
      const email =
        (azureIdentity.identity_data?.email as string | undefined) ?? null;
      if (!email) {
        await supabase.auth.signOut({ scope: "local" });
        supabaseResponse.headers.set("Location", `${siteOrigin}/login?message=sso-domain`);
        return supabaseResponse;
      }
      const verdict = isAllowedInstitutionalEmail(email, allowedDomains);
      if (!verdict.ok) {
        // Personal Microsoft account (or a non-university tenant): the user
        // must leave with NO usable session. signOut(scope:"local") clears
        // the cookies on THIS response (same hook reuse as above). The
        // profile row GoTrue's trigger already created is inert (RLS, role
        // student, null matric — it can never pass the matric gate);
        // pre-creation rejection is not achievable app-side (documented
        // deviation, AU-2 pre-flight log).
        await supabase.auth.signOut({ scope: "local" });
        supabaseResponse.headers.set("Location", `${siteOrigin}/login?message=sso-domain`);
        return supabaseResponse;
      }
    }
  }

  return supabaseResponse;
}
