"use client";

import { useEffect, useRef } from "react";
import { isIntegrityHardeningEnabled } from "@/lib/integrity/hardening-gate";

/**
 * A fullscreen EXIT while a session-pause POST was sent within this window is
 * a DUPLICATE of the same app switch (window.blur → focus_lost fires from the
 * same gesture ~900ms later) — the shared stamp suppresses the second POST so
 * focus_pause_count advances once per user action and the incident recorder
 * flushes once. Deliberately NOT the 900ms blur debounce: a fullscreen exit
 * is not transient — re-entry requires a user gesture.
 */
export const FULLSCREEN_PAUSE_DEDUPE_MS = 2_000;

export type FullscreenGuardOptions = {
  /** Assessment mode + face envelope present (hardening never runs in practice). */
  enabled: boolean;
  /** True while the quiz is live and un-submitted (question/locked/feedback). */
  active: boolean;
  /**
   * True while fullscreen SHOULD be held (armed at the gate Begin click, until
   * a terminal phase). Only the true→false edge acts: a deliberate
   * exitFullscreen so the student never rides fullscreen onto the results
   * page. There is deliberately NO auto-enter on this edge — requestFullscreen
   * needs transient user activation, which the async gate verify (blink wait)
   * would outlive; entry happens ONLY via `request()` inside click handlers.
   */
  holdFullscreen: boolean;
  /**
   * Called on a fullscreen EXIT while `active` + held. The caller POSTs pause
   * reason 'fullscreen_exit'.
   */
  onFullscreenExit: () => void;
  /**
   * SHARED pause stamp (millis epoch) — the same ref useFacePipeline's
   * focusLossPause checks-and-stamps. Both directions of the app-switch
   * double-fire dedupe through it: fullscreen-first (guard stamps → blur
   * skips the POST) AND blur-first (focusLossPause stamps → this guard's
   * onFsChange sees the fresh stamp and stays silent). Owning two refs would
   * dedupe only one direction.
   */
  sharedPauseStampRef: React.RefObject<number>;
};

/**
 * useFullscreenGuard — assessment-mode fullscreen lockdown (integrity
 * hardening, Feature C; env-off via hardening-gate).
 *
 * - `request()` MUST be called inside a user-gesture handler (the gate's
 *   Begin click, the Recover click — the Esc exit consumes the old gesture,
 *   so re-entry is only possible from the recovery click). Feature-detected:
 *   iOS Safari has no documentElement fullscreen and no-ops (mobile
 *   split-screen stays unhardened — accepted, deterrence-only).
 * - No auto re-request on Esc: the browser consumes the Escape gesture.
 */
export function useFullscreenGuard({
  enabled,
  active,
  holdFullscreen,
  onFullscreenExit,
  sharedPauseStampRef,
}: FullscreenGuardOptions): {
  /** Gesture-scoped enter (Begin / Recover clicks). No-op when disabled. */
  request: () => void;
} {
  const onExitRef = useRef(onFullscreenExit);
  const activeRef = useRef(active);
  const holdRef = useRef(holdFullscreen);
  const stampRef = useRef(sharedPauseStampRef);

  // Mirror refs every render (house convention — React Compiler-safe).
  useEffect(() => {
    onExitRef.current = onFullscreenExit;
    activeRef.current = active;
    holdRef.current = holdFullscreen;
    stampRef.current = sharedPauseStampRef;
  });

  // Deliberate exit on the held→released edge (terminal phase): the student
  // must not carry fullscreen onto the results/dead screen.
  const prevHoldRef = useRef(holdFullscreen);
  useEffect(() => {
    if (!enabled || !isIntegrityHardeningEnabled()) {
      prevHoldRef.current = holdFullscreen;
      return;
    }
    if (!holdFullscreen && prevHoldRef.current && document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => {});
    }
    prevHoldRef.current = holdFullscreen;
  }, [enabled, holdFullscreen]);

  useEffect(() => {
    if (!enabled || !isIntegrityHardeningEnabled()) return;
    const onFsChange = () => {
      if (document.fullscreenElement) return; // entered, not exited
      if (!activeRef.current || !holdRef.current) return;
      const now = Date.now();
      // Shared-stamp check: a pause POST (focus_lost or fullscreen_exit) for
      // the SAME app switch went out <2s ago — this exit is the duplicate.
      if (now - (stampRef.current?.current ?? 0) < FULLSCREEN_PAUSE_DEDUPE_MS) return;
      if (stampRef.current) stampRef.current.current = now;
      onExitRef.current?.();
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, [enabled]);

  return {
    request: () => {
      if (
        !enabled ||
        !isIntegrityHardeningEnabled() ||
        typeof document === "undefined" ||
        document.fullscreenElement ||
        !document.documentElement.requestFullscreen
      ) {
        return;
      }
      void document.documentElement.requestFullscreen().catch(() => {
        // Rejected (permission/gesture/pending request) — deterrence-only.
      });
    },
  };
}
