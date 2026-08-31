import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { sanitizeRedirect } from "@/lib/auth/redirect";
import { env } from "@/lib/env";
import {
  institutionalDomains,
  isAllowedInstitutionalEmail,
} from "@/lib/auth/institutional";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // Anti-open-redirect: only allow same-origin local paths (shared helper with
  // the login page). Handles protocol-relative, absolute, and backslash
  // variants. The middleware sets this param from pathname, which is always a
  // local path, so this only rejects attacker-supplied values.
  const redirect = sanitizeRedirect(searchParams.get("redirect"), origin);

  // GoTrue error round-trips (OAuth provider denials, misconfigurations) land
  // here WITHOUT a code and WITH error params — surface the generic auth
  // error rather than silently bouncing to the login form.
  const oauthError = searchParams.get("error_description") ?? searchParams.get("error");
  if (!code) {
    const target = oauthError
      ? `${origin}/login?message=sso-error`
      : `${origin}/login`;
    return NextResponse.redirect(target);
  }

  const supabaseResponse = NextResponse.redirect(`${origin}${redirect}`);

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
    },
  );

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data?.user) {
    // Failed exchange: clear any partial cookies by signing out and reusing
    // THIS response — signOut writes the cookie deletions through the same
    // setAll hook bound to supabaseResponse, so the browser actually
    // receives them (returning a fresh redirect would DISCARD them).
    await supabase.auth.signOut({ scope: "local" });
    supabaseResponse.headers.set("Location", `${origin}/login?message=sso-error`);
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
      const email =
        (azureIdentity.identity_data?.email as string | undefined) ??
        data.user.email ??
        null;
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
        supabaseResponse.headers.set("Location", `${origin}/login?message=sso-domain`);
        return supabaseResponse;
      }
    }
  }

  return supabaseResponse;
}
