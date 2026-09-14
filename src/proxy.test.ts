import { describe, expect, it, vi } from "vitest";
// Next compiles matcher sources with its OWN bundled path-to-regexp (the
// top-level one in node_modules is a different major that rejects the legacy
// `:path*` syntax), so this test uses the same implementation Next does.
// @ts-expect-error — Next's compiled vendored copy ships no type declarations.
import { match } from "next/dist/compiled/path-to-regexp";

// The proxy only imports `updateSession` for the actual request path; mocking it
// keeps this test to the MATCHER contract (audit-3 H-F2 / R2-TOP-F2) without
// pulling the Supabase/next-intl runtime.
vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: vi.fn(async () => new Response(null)),
}));

import { config } from "./proxy";

/**
 * The matcher is a POSITIVE allowlist of app routes needing session handling.
 * A static asset, the PWA manifest, the service worker, well-known files, the
 * vendored MediaPipe/model payloads, `/api/*` (self-authenticating) and the
 * `/sb/*` Supabase rewrite prefix must NOT reach `updateSession()` — otherwise
 * an anonymous fetch is 307'd to /login (the original H-F2 breakage: the
 * manifest parser received login HTML and PWA install was broken).
 */
function matches(pathname: string): boolean {
  return config.matcher.some((source) => {
    const m = match(source, { decode: decodeURIComponent });
    return m(pathname) !== false;
  });
}

describe("proxy matcher (audit-3 H-F2 / R2-TOP-F2)", () => {
  it.each([
    "/manifest.webmanifest",
    "/robots.txt",
    "/sitemap.xml",
    "/sw.js",
    "/.well-known/assetlinks.json",
    "/api/classes",
    "/sb/rest/v1/classes",
    "/mediapipe/vision_wasm_internal.wasm",
    "/models/hand_landmarker.task",
    "/_next/static/chunks/main.js",
    "/_next/image",
    "/favicon.ico",
    "/icon.svg",
    "/next.svg",
  ])("does NOT intercept %s", (pathname) => {
    expect(matches(pathname)).toBe(false);
  });

  it.each([
    "/",
    "/login",
    "/register",
    "/forgot-password",
    "/reset-password/confirm",
    "/auth/callback",
    "/dashboard",
    "/lecturer/classes",
    "/lecturer/classes/abc-123/gradebook",
    "/student/quizzes",
    "/play/session-1",
    "/join/ABC123",
    "/s/SHARE1",
    "/matric-capture",
    "/dev/bot",
  ])("intercepts app route %s", (pathname) => {
    expect(matches(pathname)).toBe(true);
  });
});
