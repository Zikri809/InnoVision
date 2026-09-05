"use client";

/**
 * Haptics (plan W3, mode-split): Android-only via navigator.vibrate — a no-op
 * on iOS/Safari. Assessment mode deliberately drops the per-commit buzz
 * (repeated haptics in a recorded exam hall; a desk-lying phone can
 * micro-shake the camera into spurious re-verify) — hold-confirm and timeUp
 * fire in both modes. Collapses under prefers-reduced-motion as the
 * "calm mode" proxy; no settings UI.
 */
export const HAPTIC = {
  /** Practice answer commit only. */
  commit: 8,
  /** Hold-confirm completion (both modes). */
  holdConfirm: 24,
  /** Time expired (both modes). */
  timeUp: [16, 60, 16] as [number, number, number],
} as const;

export function haptic(pattern: number | number[]): void {
  if (typeof navigator === "undefined" || typeof window === "undefined") return;
  if (!("vibrate" in navigator)) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // Vibration denied/unsupported — silently skip.
  }
}
