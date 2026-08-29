/**
 * Gate for the E2E fake tracker seams (face + hand).
 *
 * History: the gate was `process.env.NODE_ENV !== "production"`, which worked
 * while the Playwright suite ran `next dev`. Since 5f6b1da the suite runs the
 * PRODUCTION build (`npm run build && npm run start` — see the webServer
 * comment in playwright.config.ts and the eslint guard), where NODE_ENV is
 * "production" and the seams were dead: every face/hand E2E spec silently
 * degraded (enroll capture "failed", overlays never appeared).
 *
 * The seam must therefore be an EXPLICIT harness-only opt-in that survives
 * production builds: NEXT_PUBLIC_E2E_FAKE_SEAM=1, set ONLY in
 * playwright.config.ts's webServer env. A production deployment never sets it
 * — the default-off posture is unchanged, and a stray localStorage/global
 * injection without the flag is still inert (shape-validated accessor never
 * runs).
 */
export function isFakeFaceSeamEnabled(): boolean {
  return process.env.NEXT_PUBLIC_E2E_FAKE_SEAM === "1";
}

/**
 * Gate for the dev-only playground pages (/dev/error, /dev/bot). Same story as
 * the fake seam above: they were gated on NODE_ENV === "development" and 404'd
 * under the production-build E2E harness, killing the error-boundary specs.
 * Reachable in dev OR under the harness flag; never in a real deployment.
 */
export function isDevPlaygroundEnabled(): boolean {
  return process.env.NODE_ENV === "development" || isFakeFaceSeamEnabled();
}
