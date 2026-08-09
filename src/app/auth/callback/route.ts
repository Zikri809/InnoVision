import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { sanitizeRedirect } from "@/lib/auth/redirect";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // Anti-open-redirect: only allow same-origin local paths (shared helper with
  // the login page). Handles protocol-relative, absolute, and backslash
  // variants. The middleware sets this param from pathname, which is always a
  // local path, so this only rejects attacker-supplied values.
  const redirect = sanitizeRedirect(searchParams.get("redirect"), origin);

  if (code) {
    const supabaseResponse = NextResponse.redirect(`${origin}${redirect}`);

    //developer note: seperate this so that it can be reused
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
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

    await supabase.auth.exchangeCodeForSession(code);
    return supabaseResponse;
  }

  return NextResponse.redirect(`${origin}/login`);
}
