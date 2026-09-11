/**
 * Gate for the client integrity hardening (clipboard + fullscreen, assessment
 * mode) — mirrors seam-gate.ts's env-only pattern.
 *
 * Why env-only (no localStorage runtime toggle): a student-flippable kill
 * switch would defeat the feature. The seam-gate precedent documents the same
 * posture ("a stray localStorage/global injection without the flag is still
 * inert").
 *
 * Dev bypass: set NEXT_PUBLIC_INTEGRITY_HARDENING_OFF=1 (build-time inlined —
 * restart the dev server after changing it) and the clipboard/fullscreen
 * hardening never mounts, so normal debugging (copying prompts for fixtures,
 * testing overlays, headless e2e) is unaffected. The Playwright webServer env
 * sets this for the whole suite; one opt-in spec exercises the hardened path.
 */
export function isIntegrityHardeningEnabled(): boolean {
  return process.env.NEXT_PUBLIC_INTEGRITY_HARDENING_OFF !== "1";
}
