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
 * sets this for the whole suite; one opt-in spec exercises the hardened path
 * (TESTING §5.2 — CI's integrity-e2e job runs it against a hardening-ON
 * build).
 *
 * Prod warn: the kill switch is dev tooling, so a production deployment that
 * ACCIDENTALLY bakes it (a leaked .env value) silently disables the
 * clipboard/fullscreen hardening with zero other signal. The memoized warn
 * fires once per session when the switch is on in a production build —
 * EXCEPT under the harness seam (NEXT_PUBLIC_E2E_FAKE_SEAM=1, whose prod
 * builds legitimately set the switch; mirrors seam-gate.ts's explicit
 * harness-only opt-in).
 */
let integrityWarned = false;

function warnIfBakedOffInProduction(): void {
  if (integrityWarned) return;
  integrityWarned = true;
  if (process.env.NEXT_PUBLIC_INTEGRITY_HARDENING_OFF !== "1") return;
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.NEXT_PUBLIC_E2E_FAKE_SEAM === "1") return;
  console.warn(
    "[integrity-gate] NEXT_PUBLIC_INTEGRITY_HARDENING_OFF=1 is baked into this production build — clipboard/fullscreen hardening is DISABLED. Remove the variable and rebuild for real deployments.",
  );
}

export function isIntegrityHardeningEnabled(): boolean {
  warnIfBakedOffInProduction();
  return process.env.NEXT_PUBLIC_INTEGRITY_HARDENING_OFF !== "1";
}
