import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // `/api/*` is intentionally excluded: every route handler self-authenticates
    // (requireUser / requireLecturer / explicit getUser) and returns JSON 401
    // itself. Running the middleware's `getUser()` there too would add a
    // redundant auth round-trip to every mutation for zero security benefit.
    "/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
