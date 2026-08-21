"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { FaceTracker } from "@/lib/face/face-tracker";
import { getFakeFaceTracker } from "@/lib/face/fake-seam";
import { FACE_BOOT_TIMEOUT_MS } from "@/lib/face/constants";
import type { IFaceTracker } from "@/lib/face/types";

/**
 * useFaceTracker — shared by BOTH the enroll page and the play pipeline.
 *
 * Boots a single persistent `FaceTracker` against one hidden `<video>` (never
 * conditionally mounted — React must not remount the video node and kill the
 * stream). The tracker acquires the SHARED camera stream from `camera.ts`
 * (refcounted; released only on terminal unmount).
 *
 * Availability contract (PLAN_PHASE7 §2 / COMPREFACE_MIGRATION L14): a boot
 * failure / timeout → `{ available: false }` → the caller treats the face
 * pipeline as `'unavailable'` (passthrough, click-first). The CompreFace
 * health probe (`GET /api/face/health`) runs alongside `tracker.start()` —
 * BOTH must succeed within `FACE_BOOT_TIMEOUT_MS` or the pipeline degrades to
 * unavailable. Mid-session CompreFace downtime is NOT detected by a periodic
 * probe — the verify route returns 503 and the pipeline's network-error
 * handling covers it. The fake-tracker seam is read ONLY in non-production
 * (mirrors the P6 hand seam).
 *
 * StrictMode-safe: `disposedRef` + `bootIdRef` guard every post-await
 * continuation; `stop()` is idempotent.
 */
export function useFaceTracker(opts?: {
  enabled?: boolean;
  onUnavailable?: () => void;
}) {
  const enabled = opts?.enabled !== false;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackerRef = useRef<IFaceTracker | null>(null);
  const disposedRef = useRef(false);
  const bootIdRef = useRef(0);
  const onUnavailableRef = useRef(opts?.onUnavailable);

  useEffect(() => {
    onUnavailableRef.current = opts?.onUnavailable;
  });

  const [available, setAvailable] = useState(false);
  // `booting` starts TRUE when the tracker is enabled so the first paint does
  // not flash the "unavailable" panel before the deferred boot setBooting(true)
  // microtask runs (M4 cosmetic). The boot effect flips it to false either way.
  const [booting, setBooting] = useState(enabled);

  const start = useCallback(() => {
    if (!enabled) return;

    const bootId = ++bootIdRef.current;
    disposedRef.current = false;
    // Defer the state flip out of the synchronous effect body (React Compiler
    // lint: no setState synchronously in an effect — mirrors GestureLayer).
    queueMicrotask(() => {
      if (bootId !== bootIdRef.current) return;
      setBooting(true);
    });

    // Stop any prior tracker (a stale real tracker from a prior `enabled`
    // toggle / re-boot must not linger) and clear the ref.
    const prior = trackerRef.current;
    trackerRef.current = null;
    if (prior) {
      try {
        prior.stop();
      } catch {
        // a broken tracker stop must not break the boot
      }
    }

    // Fake seam first (non-prod), else the real boot raced against the timeout.
    const fake = process.env.NODE_ENV === "production" ? undefined : getFakeFaceTracker();
    if (fake) {
      trackerRef.current = fake;
      try {
        fake.start();
      } catch {
        if (bootId === bootIdRef.current && !disposedRef.current) {
          queueMicrotask(() => {
            if (bootId !== bootIdRef.current || disposedRef.current) return;
            setBooting(false);
            setAvailable(false);
            onUnavailableRef.current?.();
          });
        }
        return;
      }
      queueMicrotask(() => {
        if (bootId !== bootIdRef.current || disposedRef.current) {
          // The boot was SUPERSEDED (StrictMode's normal double-mount) or
          // unmounted. A superseded boot is NOT a failure — the newer boot
          // owns availability. Do NOT surface unavailable here (that would
          // stick `faceUnavailable=true` and force the pipeline into
          // passthrough even though the remount boot succeeded).
          return;
        }
        setBooting(false);
        setAvailable(true);
      });
      return;
    }

    async function bootWithRetry() {
      // 1. Wait for video ref if component is mounting
      let video = videoRef.current;
      const refWaitStart = Date.now();
      while (!video && Date.now() - refWaitStart < 800 && !disposedRef.current && bootId === bootIdRef.current) {
        await new Promise((r) => setTimeout(r, 80));
        video = videoRef.current;
      }

      if (!video || disposedRef.current || bootId !== bootIdRef.current) {
        if (bootId === bootIdRef.current && !disposedRef.current) {
          setBooting(false);
          setAvailable(false);
          onUnavailableRef.current?.();
        }
        return;
      }

      const tracker = new FaceTracker(video);
      trackerRef.current = tracker;

      // A detection-loop death after boot must degrade to unavailable
      // (passthrough) instead of silently freezing poses/blinks. stop()
      // releases the shared camera token — nothing consumes the video once
      // the pipeline is unavailable.
      function wireLoopErrors(t: FaceTracker) {
        t.onError(() => {
          t.stop();
          // Drop the dead instance so nothing downstream (e.g. the pipeline
          // effect) can hand a disposed tracker back to consumers.
          if (trackerRef.current === t) trackerRef.current = null;
          if (bootId === bootIdRef.current && !disposedRef.current) {
            queueMicrotask(() => {
              if (bootId !== bootIdRef.current || disposedRef.current) return;
              setBooting(false);
              setAvailable(false);
              onUnavailableRef.current?.();
            });
          }
        });
      }
      wireLoopErrors(tracker);

      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        tracker.stop();
        if (bootId === bootIdRef.current && !disposedRef.current) {
          console.error("[face-boot] timed out after", FACE_BOOT_TIMEOUT_MS, "ms");
          setBooting(false);
          setAvailable(false);
          onUnavailableRef.current?.();
        }
      }, FACE_BOOT_TIMEOUT_MS);

      async function probeHealthWithRetry(): Promise<boolean> {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await fetch("/api/face/health", { method: "GET", cache: "no-store" });
            const data = (res.ok ? await res.json() : { available: false }) as { available?: boolean };
            if (data.available === true) return true;
          } catch {
            // brief retry delay
          }
          if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
        }
        return false;
      }

      try {
        console.info("[face-boot] starting tracker.start() and healthProbe...");
        const [, healthy] = await Promise.all([tracker.start(), probeHealthWithRetry()]);
        clearTimeout(timeout);
        if (bootId !== bootIdRef.current || disposedRef.current || timedOut) {
          console.info("[face-boot] boot was superseded or timed out");
          tracker.stop();
          return;
        }
        if (!healthy) {
          console.info("[face-boot] health check was not healthy -> unavailable");
          tracker.stop();
          setBooting(false);
          setAvailable(false);
          onUnavailableRef.current?.();
          return;
        }
        console.info("[face-boot] boot successful -> available: true");
        setBooting(false);
        setAvailable(true);
      } catch (err) {
        clearTimeout(timeout);
        tracker.stop();
        console.error("[face-boot] primary boot failed, attempting fallback retry:", err);

        // Transient camera/wasm lock fallback retry
        if (bootId === bootIdRef.current && !disposedRef.current && !timedOut) {
          await new Promise((r) => setTimeout(r, 500));
          if (bootId !== bootIdRef.current || disposedRef.current) return;
          try {
            const retryTracker = new FaceTracker(video);
            trackerRef.current = retryTracker;
            wireLoopErrors(retryTracker);
            const [, healthy] = await Promise.all([retryTracker.start(), probeHealthWithRetry()]);
            if (bootId !== bootIdRef.current || disposedRef.current) {
              retryTracker.stop();
              return;
            }
            if (healthy) {
              console.info("[face-boot] retry boot successful -> available: true");
              setBooting(false);
              setAvailable(true);
              return;
            }
          } catch (retryErr) {
            console.error("[face-boot] retry boot also failed:", retryErr);
          }
        }

        if (bootId === bootIdRef.current && !disposedRef.current) {
          setBooting(false);
          setAvailable(false);
          onUnavailableRef.current?.();
        }
      }
    }

    void bootWithRetry();
  }, [enabled]);

  useEffect(() => {
    start();
    const bootIdAtMount = bootIdRef.current;
    return () => {
      disposedRef.current = true;
      bootIdRef.current = bootIdAtMount + 1;
      trackerRef.current?.stop();
      trackerRef.current = null;
    };
  }, [enabled, start]);

  return { videoRef, trackerRef, available, booting, start };
}
