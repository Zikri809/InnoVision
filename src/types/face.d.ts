/**
 * Ambient type declarations for the E2E fake-face-tracker test seam (Phase 7).
 *
 * The fake tracker is installed by Playwright via `addInitScript` BEFORE the
 * student navigates to `/play` (see `e2e/fake-face-tracker.ts` and
 * `e2e/helpers.ts`). App code never reads these globals directly — it goes
 * through the typed accessors in `lib/face/fake-seam.ts`; the component only
 * sees them when the harness seam flag is on (`NEXT_PUBLIC_E2E_FAKE_SEAM ===
 * "1"` — see `lib/face/seam-gate.ts`).
 *
 * Both surfaces are declared so `window.__INNOVISION_FAKE_FACE_TRACKER__`
 * (how E2E writes) and `globalThis.__INNOVISION_FAKE_FACE_TRACKER__` (how the
 * accessor reads) typecheck. The values are `unknown` on purpose — shape
 * validation lives in `fake-seam.ts`, never in components.
 */
declare global {
  interface Window {
    __INNOVISION_FAKE_FACE_TRACKER__?: unknown;
    __INNOVISION_FAKE_FACE_CONTROL__?: unknown;
  }

  var __INNOVISION_FAKE_FACE_TRACKER__: unknown;
  var __INNOVISION_FAKE_FACE_CONTROL__: unknown;
}

export {};
