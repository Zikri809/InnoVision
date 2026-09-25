/**
 * Demo-mode gate for the exhibition kiosk (docs/plans/PLAN_DEMO_MODE.md).
 *
 * `NEXT_PUBLIC_DEMO_MODE=1` arms a walk-up flow: anonymous visitors who scan
 * the demo class QR get an auto-provisioned guest student account already
 * enrolled in the demo class (POST /api/demo/guest), plus the presenter-led
 * showcase surfaces. UNSET in every real deployment — the default-off posture
 * is loud in prod-guards.ts's KILL_SWITCHES, the CI kill-switch assertion, the
 * Dockerfile ARG and deploy/build-images.sh, so an accidental carry is a
 * reviewable build input rather than a silent runtime surprise.
 *
 * WHY `NEXT_PUBLIC_` (and not a plain `DEMO_MODE`): the middleware branch
 * (src/lib/supabase/middleware.ts) runs in the Edge sandbox, where
 * non-`NEXT_PUBLIC_` env reads are inlined at BUILD time. A runtime-only
 * `DEMO_MODE=1` would therefore be invisible to the middleware under
 * `next start` (the demo branch silently dead) while a build with it set would
 * bake it permanently. `NEXT_PUBLIC_` makes the build-time nature explicit and
 * matches the established harness-flag precedent (`NEXT_PUBLIC_E2E_FAKE_SEAM`,
 * src/lib/face/seam-gate.ts). Consequence: the flag must be present at
 * `next build` AND at runtime.
 *
 * EXPLICIT-ONLY: unlike `isDevPlaygroundEnabled()`, this does NOT auto-enable
 * in development. A dev shell must export `NEXT_PUBLIC_DEMO_MODE=1` to opt in,
 * so the demo surfaces can never leak into a normal local session by accident.
 */

/**
 * The join code of the seeded demo class. Exported from this pure module so
 * BOTH the Edge middleware and the Node-runtime page can compare against the
 * same constant without importing a server-only module into the Edge bundle.
 *
 * `SCAN23` is 6 chars from the legal alphabet
 * (`^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$` — no O/0/1/I/L). Do not pick a
 * "prettier" code containing an excluded character: the DB CHECK would reject
 * the seed insert and `normalizeJoinCode` would render /join/<code> invalid.
 */
export const DEMO_JOIN_CODE = "SCAN23";

/**
 * True only when the booth build explicitly opted in.
 *
 * The comparison is exact-`"1"` (the kill-switch convention): `"0"`, `""`,
 * `"true"` and a typo are all inert, which is what prod-guards.ts and the CI
 * assertion normalize against.
 */
export function isDemoModeEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE === "1";
}

/**
 * Email domain of demo guest accounts. Lives here (pure, Edge-safe) so the
 * /join page and the browser island can classify an existing session without
 * importing the server-only guests module (which pulls in node:crypto + the
 * service-role client).
 */
export const DEMO_GUEST_EMAIL_DOMAIN = "demo.innovision.test";

/** True when an email belongs to a demo guest account. */
export function isGuestEmail(email: string | null | undefined): boolean {
  return Boolean(email && email.endsWith(`@${DEMO_GUEST_EMAIL_DOMAIN}`));
}
