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
    //
    // `/mediapipe/*` and `/models/*` are STATIC-ONLY prefixes (P6 vendored
    // MediaPipe runtime + hand-landmarker model). Excluding them avoids an
    // `updateSession()` auth round-trip per file (~8 per student) on the
    // gesture-boot critical path. Any future ROUTE under these prefixes must
    // self-authenticate — do not rely on the middleware to protect it.
    // `/sb/*` is the same-origin rewrite prefix to the local Supabase Kong
    // gateway (next.config.ts rewrites). Excluded like `/api`: supabase-js
    // attaches the JWT itself and Kong enforces auth, so the middleware's
    // getUser() round-trip is pointless — and worse, its unauthenticated
    // redirect to /login would break the browser client's REST polling.
    "/((?!api/|sb/|mediapipe/|models/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|mjs|wasm|task)$).*)",
  ],
};
