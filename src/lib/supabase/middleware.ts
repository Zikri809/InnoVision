import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/lib/types/database";

const PUBLIC_ROUTES = ["/login", "/register", "/auth/callback"];

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
}

function isApiRoute(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
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

  // Redirect authenticated users away from auth pages
  if (user && isPublicRoute(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  // Unauthenticated API requests: return JSON 401, never an HTML login redirect.
  // Route handlers own their own authz (they can be hit directly); the middleware
  // just keeps unauthenticated callers from getting a confusing HTML page.
  if (!user && isApiRoute(pathname)) {
    return NextResponse.json(
      { error: "unauthorized", message: "Authentication required" },
      { status: 401 },
    );
  }

  // Redirect unauthenticated users to login (except public routes)
  if (!user && !isPublicRoute(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", pathname);
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
