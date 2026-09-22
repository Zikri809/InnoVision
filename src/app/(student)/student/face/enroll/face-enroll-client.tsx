"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CircleAlert, CircleCheck, Loader2, VideoOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { useWakeLock } from "@/hooks/use-wake-lock";
import { useFaceTracker } from "@/components/face/use-face-tracker";
import type { LivePose } from "@/lib/face/types";
import type { EnrollAngle } from "@/lib/face/pose-gate";
import {
  ENROLL_ANGLES,
  ENROLL_CAPTURE_MAX_ATTEMPTS,
  ENROLL_CAPTURE_MAX_MS,
  LIVENESS_TIMEOUT_MS,
} from "@/lib/face/constants";
import { checkEnrollPose, isPoseInBand } from "@/lib/face/pose-gate";

type CaptureState =
  | "idle"
  | "blink"
  | "capturing"
  | "processing"
  | "done"
  | "failed"
  | "pending_review";

export function FaceEnrollClient({
  consentGiven,
  enrolled,
  pendingReview = false,
}: {
  consentGiven: boolean;
  enrolled: boolean;
  /** The duplicate scan held this student's enrollment for lecturer review —
   * the CTA must not re-run the capture loop (it would re-POST and re-trigger
   * the duplicate scan on every visit); show an awaiting-review card instead. */
  pendingReview?: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("student.face");
  const tCommon = useTranslations("common");
  const [consent, setConsent] = useState(consentGiven);

  // Camera boots ONLY after biometric consent — the webcam light must never
  // turn on while the consent card is still pending. Revoking consent flips
  // `enabled` back to false and the hook's cleanup releases the stream.
  const { videoRef, trackerRef, available, booting, failureReason, start } = useFaceTracker({
    enabled: consent,
  });

  const [captureState, setCaptureState] = useState<CaptureState>(
    consentGiven && (enrolled || pendingReview)
      ? enrolled
        ? "done"
        : "pending_review"
      : "idle",
  );
  // Screen wake lock (plan W4): the capture flow (blink liveness + 3 angles)
  // must not fight the OS screen-lock mid-capture.
  useWakeLock({
    enabled: captureState === "blink" || captureState === "capturing" || captureState === "processing",
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [currentAngle, setCurrentAngle] = useState<number>(0);
  const [pose, setPose] = useState<LivePose>({
    yaw: 0,
    centered: false,
    faceDetected: false,
    lighting: "good",
  });

  const framesRef = useRef<string[]>([]);
  // Per-frame yaw the capture gate accepted (parallel to framesRef; null when
  // the tracker does not expose `lastAcceptedPose`). Shipped to the route so
  // the server can judge the SAME reading the student was guided by.
  const yawReadingsRef = useRef<(number | null)[]>([]);
  const attemptsRef = useRef(0);
  const captureStartRef = useRef(0);
  const disposedRef = useRef(false);
  // Re-entrancy lock: a fast double-click on Start/Recapture must not boot two
  // concurrent capture loops (they would interleave frames across angles and
  // double-POST the enroll endpoint). Same pattern as the builder/editor locks.
  const captureLockRef = useRef(false);

  useEffect(() => {
    disposedRef.current = false;
    const unsub = trackerRef.current?.onPoseChange?.(setPose);
    return () => {
      disposedRef.current = true;
      unsub?.();
    };
  }, [trackerRef, available]);

  function getAngleLabel(index: number): string {
    if (index === 0) return t("angleFront");
    if (index === 1) return t("angleLeft");
    return t("angleRight");
  }

  // Single source of truth for the "what to do now" instruction — reused by
  // BOTH the big video overlay and the bottom status chip so they can never
  // drift apart. The yaw bands come from `lib/face/pose-gate.ts`, which is the
  // SAME module the capture gate and the server check use — the wizard's copy
  // can no longer promise a range the gate rejects (prod incident 2026-09-21).
  function currentInstruction(): string | null {
    if (captureState !== "blink") return null;
    if (!pose.faceDetected) return null;
    const angle = ENROLL_ANGLES[currentAngle];
    const verdict = checkEnrollPose(angle, pose.yaw);
    if (verdict.ok) return t("goodBlink");
    switch (verdict.reason) {
      case "wrong_way":
        return angle === "left" ? t("turnLeft") : t("turnRight");
      case "turn_more":
        return angle === "left" ? t("turnLeft") : t("turnRight");
      case "turn_less":
        return t("turnLess");
      case "not_straight":
      default:
        return t("lookStraight");
    }
  }

  function getLightingText(lighting?: "good" | "too_dark" | "too_bright") {
    try {
      const key = lighting === "too_dark" ? ("lightingTooDark" as const) : lighting === "too_bright" ? ("lightingTooBright" as const) : ("lightingGood" as const);
      const val = t(key);
      if (typeof val === "string" && !val.includes("student.face.")) return val;
    } catch {
      // fallback
    }
    if (lighting === "too_dark") return "Too dark — increase lighting";
    if (lighting === "too_bright") return "Too bright — avoid backlight glare";
    return "Lighting: Good ✓";
  }

  function getLightingTipText() {
    try {
      const val = t("lightingTip" as const);
      if (typeof val === "string" && !val.includes("student.face.")) return val;
    } catch {
      // fallback
    }
    return "Ensure your face is evenly lit with no heavy shadows for highest accuracy.";
  }

  /**
   * Map an enroll failure to actionable copy.
   *
   * Prod incident 2026-09-21: the route returned the raw `pose_invalid` code in
   * production (the friendly message was dev-only), so a student who failed the
   * pose gate saw a bare machine token and had no idea what to change. The
   * route now sends `pose_<reason>` in every mode; this turns each reason into
   * an instruction the student can act on. Unknown shapes fall back to the
   * route's own message, then to the generic failure copy.
   */
  function enrollErrorMessage(body: { error?: string; message?: string }): string {
    const code = body.error;
    if (code === "spoof_detected") return t("poseSpoof");
    const reason = typeof body.message === "string" && body.message.startsWith("pose_")
      ? body.message.slice("pose_".length)
      : code === "pose_invalid"
      ? "no_face"
      : null;
    switch (reason) {
      case "no_face":
        return t("poseNoFace");
      case "not_straight":
        return t("poseNotStraight");
      case "wrong_way":
        return t("poseWrongWay");
      case "turn_more":
        return t("poseTurnMore");
      case "turn_less":
        return t("poseTurnLess");
      case "duplicate_detected":
        return t("pendingBody");
      default:
        // Known route codes get actionable copy; only UNKNOWN codes fall
        // through to the raw server message (which may be untranslated
        // English a ms-locale student can't read). Machine tokens are never
        // shown as-is.
        if (code === "rate_limited") return tCommon("errorGeneric");
        if (code === "invalid_frame" || code === "payload_too_large") return t("poseNoFace");
        return body.message && !/^[a-z0-9_]+$/.test(body.message)
          ? body.message
          : t("statusFailed");
    }
  }

  async function handleConsent() {
    setError(null);
    try {
      const res = await fetch("/api/face/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ consent: true }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message ?? body.error ?? tCommon("errorGeneric"));
        return;
      }
      setConsent(true);
      setCaptureState("idle");
    } catch {
      setError(tCommon("errorGeneric"));
    }
  }

  async function handleRevoke() {
    setError(null);
    setRevoking(true);
    try {
      const res = await fetch("/api/face/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ consent: false }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message ?? body.error ?? tCommon("errorGeneric"));
        return;
      }
      setConsent(false);
      setCaptureState("idle");
      toast.success(tCommon("ok"));
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      setRevoking(false);
    }
  }

  async function captureOneAngle(angle: EnrollAngle): Promise<string | null> {
    if (disposedRef.current) return null;
    const tracker = trackerRef.current;
    if (!tracker) return null;
    const blink = await tracker.waitForBlink(LIVENESS_TIMEOUT_MS);
    if (blink !== "passed") return null;
    // Allow eyes to fully reopen and pose to stabilize after the blink
    await new Promise((resolve) => setTimeout(resolve, 450));
    if (disposedRef.current) return null;
    if (typeof tracker.captureBestFrame === "function") {
      // `angle` is the FIX for the prod incident: the blended quality score
      // accepts a mid-turn frame (yaw contributes 0 points past 45°, and 95 of
      // 120 still clears the ≥90 bar), so the per-angle band must gate the
      // capture explicitly. Returns null when the band is never satisfied —
      // the caller's attempt budget then retries instead of submitting a frame
      // the server is guaranteed to reject.
      return tracker.captureBestFrame({
        maxWaitMs: 2000,
        requireCentered: true,
        requireOpenEyes: true,
        requireIdealLighting: true,
        angle,
      });
    }
    return tracker.captureFrame();
  }

  async function runCapture() {
    if (disposedRef.current || captureLockRef.current) return;
    const tracker = trackerRef.current;
    if (!tracker) return;
    captureLockRef.current = true;
    setError(null);
    setNotice(null);
    setCaptureState("capturing");
    framesRef.current = [];
    yawReadingsRef.current = [];
    attemptsRef.current = 0;
    captureStartRef.current = Date.now();
    // audit-4 P1-3: the 45s wall clock only counts while a capture is
    // actually POSSIBLE — blink waits (8s each) and out-of-band pose spins
    // used to burn it, so a student who took ~25s to reach the first pose
    // had ~20s for two more angles and a generic failure. Elapsed time
    // accumulates only while the loop is mid-attempt.
    let elapsedMs = 0;

    try {
      // Per-user calibration: the yaw proxy measures nose position relative
      // to the cheeks, so "straight" is not a universal zero (webcam offset
      // alone can read ~15-20 units). Sample ~1s of the user looking
      // straight and make all thresholds RELATIVE to their neutral pose.
      // A failed sample window (face not yet tracked — camera still settling)
      // retries once with a longer window instead of silently measuring yaw
      // against the geometric midpoint, which can make the front band
      // unreachable and burn the whole capture budget on guidance the
      // student is actually satisfying.
      setNotice(t("lookStraight"));
      let calibrated = await tracker.calibrateNeutral?.(900);
      if (disposedRef.current) return;
      if (calibrated === false) {
        setNotice(t("lookStraight"));
        calibrated = await tracker.calibrateNeutral?.(1800);
        if (disposedRef.current) return;
      }
      setNotice(null);

      for (let i = 0; i < ENROLL_ANGLES.length; i++) {
        if (disposedRef.current) return;
        setCurrentAngle(i);
        const angle = ENROLL_ANGLES[i];
        let frame: string | null = null;
        while (frame === null) {
          attemptsRef.current++;
          if (disposedRef.current) return;
          // elapsedMs accumulates ONLY time spent inside capture attempts
          // (attemptStart→capture finish); the wall-clock between attempts —
          // the student repositioning while guidance runs — is free. Adding
          // the raw wall delta here instead would re-count idle time on
          // every later attempt and fail honest students early.
          if (elapsedMs > ENROLL_CAPTURE_MAX_MS) {
            setCaptureState("failed");
            setError(t("captureTimeout"));
            return;
          }
          if (attemptsRef.current > ENROLL_CAPTURE_MAX_ATTEMPTS) {
            setCaptureState("failed");
            setError(t("captureAttempts"));
            return;
          }
          setCaptureState("blink");
          const attemptStart = Date.now();
          frame = await captureOneAngle(angle);
          elapsedMs += Date.now() - attemptStart;
        }
        // The pose the CAPTURE GATE accepted for this angle. The server judges
        // the same reading (see the route's `checkEnrollPoseServer`) instead of
        // re-deriving yaw in a different space and rejecting an honest capture
        // (prod incident 2026-09-21). Read BEFORE the next capture overwrites it.
        const accepted = trackerRef.current?.lastAcceptedPose;
        yawReadingsRef.current.push(
          accepted && accepted.angle === angle ? accepted.yaw : null,
        );
        framesRef.current.push(frame);
      }

      // All three frames are in — the remaining ~1.4s is server-side work
      // (pose check + duplicate recognize ×3 + example upload ×3 + RPC).
      // Surface it honestly: open the dialog as "Processing…" and let the
      // content swap to the result when the response lands.
      setCaptureState("processing");
      setResultOpen(true);
      const res = await fetch("/api/face/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          frames: framesRef.current,
          yawReadings: yawReadingsRef.current,
        }),
      });
      if (disposedRef.current) return;
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCaptureState("failed");
        setResultOpen(false);
        setError(enrollErrorMessage(body));
        return;
      }
      if (body.status === "pending_review") {
        setCaptureState("pending_review");
        setResultOpen(true);
        return;
      }
      setCaptureState("done");
      setResultOpen(true);
      router.refresh();
    } catch {
      if (disposedRef.current) return;
      setCaptureState("failed");
      setError(tCommon("errorGeneric"));
    } finally {
      captureLockRef.current = false;
    }
  }

  return (
    <div className="space-y-6">
      <div aria-live="polite">
        {error && (
          <p className="rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-2xl border-[3px] border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800" role="status">
            {notice}
          </p>
        )}
      </div>

      <div className="relative mx-auto aspect-[3/4] max-w-xl overflow-hidden rounded-[28px] border-[3px] border-border bg-[#1c0f08] shadow-[var(--shadow-clay)] sm:aspect-[4/3]">
        <video
          ref={videoRef}
          playsInline
          muted
          aria-label={t("cameraPreview")}
          className="h-full w-full object-contain scale-x-[-1]"
        />

        {available && (
          <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-between p-4">
            {/* Angle progress chips — desktop restores the original in-frame
                HUD (W2 C7 kept the merged below-video line for mobile only).
                hidden sm:flex keeps it out of the mobile layout entirely. */}
            <div className="hidden sm:flex gap-2 rounded-full bg-[#7c2d12]/75 px-3 py-1.5">
              {([
                { label: t("angleFront"), index: 0 },
                { label: t("angleLeft"), index: 1 },
                { label: t("angleRight"), index: 2 },
              ] as const).map(({ label, index }) => {
                // Completed = flow finished (incl. pending_review) or already
                // past this angle; active = currently being captured.
                const complete =
                  captureState === "done" || captureState === "pending_review" || currentAngle > index;
                const active = !complete && currentAngle === index;
                return (
                  <span
                    key={index}
                    className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                      complete
                        ? "bg-emerald-500 text-white"
                        : active
                        ? "bg-amber-400 text-black"
                        : "bg-white/20 text-white/70"
                    }`}
                  >
                    {index + 1}. {label} {complete && "✓"}
                  </span>
                );
              })}
            </div>

            {/* BIG instruction overlay — mirrors currentInstruction() so the
                prompt is readable at arm's length. aria-hidden: the status
                line under the video stays the live region so screen readers
                announce it exactly once. */}
            {currentInstruction() && (
              <div
                aria-hidden
                className="absolute left-1/2 top-[18%] max-w-[92%] -translate-x-1/2 rounded-full bg-[#7c2d12]/85 px-4 py-2 text-center text-base font-extrabold text-white shadow-[0_2px_0_rgba(124,45,18,0.4)] sm:top-[4.5rem] sm:text-lg"
              >
                <span
                  className={
                    currentInstruction() === t("goodBlink")
                      ? "text-emerald-400"
                      : currentInstruction() === t("turnLess")
                      ? "text-rose-300"
                      : "text-white"
                  }
                >
                  {currentInstruction()}
                </span>
              </div>
            )}

            {/* Absolute-centered (same pattern as face-verifier): on mobile
                the top/bottom HUD chips are hidden, so flex flow would pin
                the oval to the top of the frame. */}
            <div
              className={`absolute inset-0 m-auto h-40 w-32 sm:h-48 sm:w-36 rounded-[50%] border-4 transition-[border-color,border-style,background-color,box-shadow,transform] duration-300 ${
                !pose.faceDetected
                  ? "border-dashed border-white/50"
                  : isPoseInBand(ENROLL_ANGLES[currentAngle], pose.yaw) && pose.centered
                  ? "scale-105 border-emerald-400 bg-emerald-500/10 shadow-[0_0_20px_rgba(52,211,153,0.5)]"
                  : "border-amber-400/80 bg-amber-400/5 shadow-[0_0_15px_rgba(251,191,36,0.3)]"
              }`}
            />

            {/* Pose/lighting status chip — desktop-only in-frame HUD, original
                design. hidden below sm: the merged below-video line covers
                mobile (W2 C7). */}
            <div className="hidden sm:flex max-w-[92%] flex-wrap items-center justify-center gap-1.5 rounded-full bg-[#7c2d12]/75 px-3 py-1.5 text-xs font-bold text-white text-center">
              {!pose.faceDetected ? (
                <span className="text-amber-300">{t("posNotCentered")}</span>
              ) : (
                <>
                  <span className={pose.centered ? "text-emerald-400" : "text-amber-300"}>
                    {pose.centered ? t("posCentered") : t("posNotCentered")}
                  </span>
                  <span className="text-white/40">|</span>
                  <span className={pose.lighting === "good" ? "text-emerald-400" : "text-amber-300"}>
                    {getLightingText(pose.lighting)}
                  </span>
                  <span className="text-white/40">|</span>
                  <span>{t("angleStatus", { deg: Math.abs(pose.yaw) })}</span>
                  {currentInstruction() && (
                    <span className="text-emerald-300">{currentInstruction()}</span>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {!consent && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#7c2d12]/85 px-6 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl border-[3px] border-white/25 bg-white/10">
              <VideoOff className="h-7 w-7 text-white/80" aria-hidden />
            </span>
            <p className="max-w-[28ch] text-sm font-semibold text-white/80">{t("cameraOffHint")}</p>
          </div>
        )}

        {consent && booting && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted/80 text-sm font-semibold text-muted-foreground">
            {t("statusBooting")}
          </div>
        )}
      </div>

      {/* Polish round (W2 C7): the angle chips, pose/lighting chip, and the
          lighting tip line collapse into ONE status line under the video —
          mobile-only since the desktop restore brought back the in-frame
          HUD. This line is the mobile live region (aria-live) so AT
          announces it once; on desktop the status card (role="status")
          plays that role, as before. */}
      {available && (
        <div
          aria-live="polite"
          className="mt-3 flex flex-wrap items-center justify-center gap-1.5 rounded-2xl border-[3px] border-border bg-card px-3 py-2 text-2xs font-bold text-muted-foreground shadow-[var(--shadow-clay-sm)] sm:hidden sm:text-xs"
        >
          <span className="flex items-center gap-1.5">
            {([
              { label: t("angleFront"), index: 0 },
              { label: t("angleLeft"), index: 1 },
              { label: t("angleRight"), index: 2 },
            ] as const).map(({ label, index }) => {
              const complete =
                captureState === "done" || captureState === "pending_review" || currentAngle > index;
              const active = !complete && currentAngle === index;
              return (
                <span
                  key={index}
                  className={`rounded-full px-2 py-0.5 ${
                    complete
                      ? "bg-emerald-500 text-white"
                      : active
                      ? "bg-amber-400 text-black"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {index + 1}. {label} {complete && "✓"}
                </span>
              );
            })}
          </span>
          <span className="text-white/0" aria-hidden>|</span>
          {!pose.faceDetected ? (
            <span className="text-amber-600 dark:text-amber-400">{t("posNotCentered")}</span>
          ) : (
            <>
              <span className={pose.centered ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>
                {pose.centered ? t("posCentered") : t("posNotCentered")}
              </span>
              <span className="text-border" aria-hidden>|</span>
              <span className={pose.lighting === "good" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>
                {getLightingText(pose.lighting)}
              </span>
              <span className="text-border" aria-hidden>|</span>
              <span>{t("angleStatus", { deg: Math.abs(pose.yaw) })}</span>
            </>
          )}
          <span className="text-border" aria-hidden>|</span>
          <span>💡 {getLightingTipText()}</span>
        </div>
      )}

      {/* Desktop tip line — restored original, pairs with the in-frame HUD. */}
      {available && (
        <p className="hidden text-center text-xs font-bold text-muted-foreground sm:block">
          💡 {getLightingTipText()}
        </p>
      )}

      {!consent ? (
        <div className="rounded-[28px] border-[3px] border-border bg-card p-7 shadow-[var(--shadow-clay)] md:p-8">
          <h2 className="font-heading text-xl font-semibold">{t("consentTitle")}</h2>
          <p className="mt-2 text-sm font-semibold text-muted-foreground">
            {t("consentBody")}
          </p>
          <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-2xl border-[3px] border-border bg-orange-50/60 p-4 dark:border-amber-500/40 dark:bg-amber-500/10">
            <Checkbox
              checked={consent}
              onCheckedChange={(v) => {
                if (v === true) void handleConsent();
              }}
              className="mt-0.5"
            />
            <span className="text-sm font-bold">
              {t("consentCheckbox")}
            </span>
          </label>
        </div>
      ) : !available && !booting ? (
        <div className="rounded-[28px] border-[3px] border-border bg-card p-8 shadow-[var(--shadow-clay)]">
          <h2 className="font-heading text-xl font-semibold">{t("enrollTitle")}</h2>
          <p className="mt-2 text-sm font-semibold text-muted-foreground">
            {t(`cameraFailure.${failureReason}.body`)}
          </p>
          {failureReason === "permission" && (
            <p className="mt-3 rounded-2xl border-[3px] border-border bg-muted/60 px-4 py-3 text-sm font-semibold text-muted-foreground">
              {t("cameraFailure.permission.hint")}
            </p>
          )}
          {failureReason === "no_device" && (
            <p className="mt-3 rounded-2xl border-[3px] border-border bg-muted/60 px-4 py-3 text-sm font-semibold text-muted-foreground">
              {t("cameraFailure.no_device.hint")}
            </p>
          )}
          {failureReason === "device_busy" && (
            <p className="mt-3 rounded-2xl border-[3px] border-border bg-muted/60 px-4 py-3 text-sm font-semibold text-muted-foreground">
              {t("cameraFailure.device_busy.hint")}
            </p>
          )}
          {failureReason === "security" && (
            <p className="mt-3 rounded-2xl border-[3px] border-border bg-muted/60 px-4 py-3 text-sm font-semibold text-muted-foreground">
              {t("cameraFailure.security.hint")}
            </p>
          )}
          <div className="mt-5">
            <Button variant="outline" size="lg" onClick={start}>
              {tCommon("retry")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-[28px] border-[3px] border-border bg-card p-7 shadow-[var(--shadow-clay)] md:p-8">
          <h2 className="font-heading text-xl font-semibold">
            {pendingReview
              ? t("pendingTitle")
              : enrolled
                ? t("alreadyEnrolledTitle")
                : t("notEnrolledTitle")}
          </h2>
          <p className="mt-2 text-sm font-semibold text-muted-foreground">
            {pendingReview
              ? t("statusPendingReview")
              : enrolled
                ? t("alreadyEnrolledSubtitle")
                : t("notEnrolledSubtitle")}
          </p>

          {pendingReview && (
            <div className="mt-5 rounded-2xl border-[3px] border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/40 dark:bg-amber-500/10" role="status">
              <p className="text-sm font-bold text-amber-900 dark:text-amber-300">
                {t("pendingTitle")}
              </p>
              <p className="mt-1 text-xs font-semibold text-amber-800 dark:text-amber-200/80">
                {t("pendingBody")}
              </p>
            </div>
          )}

          {!pendingReview && (
            <>
              <div className="mt-5 rounded-2xl border-[3px] border-border bg-muted/50 p-5" role="status">
                <p className="font-heading text-base font-semibold">{t("statusLabel")}</p>
                <p className="mt-1.5 text-sm font-bold text-muted-foreground">
                  {booting && t("statusBooting")}
                  {!booting && captureState === "idle" && t("statusReady")}
                  {!booting && captureState === "blink" && t("statusBlink", { angle: getAngleLabel(currentAngle) })}
                  {!booting && captureState === "capturing" &&
                    t("statusCapturing", { current: currentAngle + 1, total: ENROLL_ANGLES.length, angle: getAngleLabel(currentAngle) })}
                  {!booting && captureState === "processing" && t("statusProcessing")}
                  {!booting && captureState === "done" && t("statusDone")}
                  {!booting && captureState === "pending_review" && t("statusPendingReview")}
                  {!booting && captureState === "failed" && t("statusFailed")}
                </p>
              </div>

              <div className="mt-6 flex flex-wrap items-center gap-3">
                {(captureState === "idle" || captureState === "failed") && (
                  <Button size="lg" onClick={() => void runCapture()}>
                    {captureState === "failed" ? t("tryAgainBtn") : t("startCaptureBtn")}
                  </Button>
                )}
                {captureState === "done" && (
                  <Button size="lg" onClick={() => void runCapture()}>
                    {t("recaptureBtn")}
                  </Button>
                )}
              </div>
            </>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              size="lg"
              onClick={() => void handleRevoke()}
              disabled={revoking || captureState === "capturing" || captureState === "blink" || captureState === "processing"}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              {revoking ? t("revokingConsent") : t("revokeConsentBtn")}
            </Button>
          </div>
        </div>
      )}

      {/* Result popup — opens as "Processing…" the moment frames are in,
          then transitions in place to success / pending-review. */}
      <ResponsiveModal open={resultOpen} onOpenChange={setResultOpen}>
        <ResponsiveModalContent className="sm:max-w-sm">
          <ResponsiveModalHeader>
            {captureState === "processing" ? (
              <>
                <div className="mb-1 grid h-12 w-12 place-items-center rounded-2xl bg-primary/15 text-primary">
                  <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
                </div>
                <ResponsiveModalTitle className="text-base">{t("processingTitle")}</ResponsiveModalTitle>
                <ResponsiveModalDescription>{t("processingBody")}</ResponsiveModalDescription>
              </>
            ) : captureState === "pending_review" ? (
              <>
                <div className="mb-1 grid h-12 w-12 place-items-center rounded-2xl bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400">
                  <CircleAlert className="h-6 w-6" aria-hidden />
                </div>
                <ResponsiveModalTitle className="text-base">{t("pendingTitle")}</ResponsiveModalTitle>
                <ResponsiveModalDescription>{t("pendingBody")}</ResponsiveModalDescription>
              </>
            ) : (
              <>
                <div className="mb-1 grid h-12 w-12 place-items-center rounded-2xl bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
                  <CircleCheck className="h-6 w-6" aria-hidden />
                </div>
                <ResponsiveModalTitle className="text-base">{t("successTitle")}</ResponsiveModalTitle>
                <ResponsiveModalDescription>{t("successBody")}</ResponsiveModalDescription>
              </>
            )}
          </ResponsiveModalHeader>
          <Button
            onClick={() => setResultOpen(false)}
            className="w-full"
            disabled={captureState === "processing"}
          >
            {captureState === "processing" ? tCommon("loading") : tCommon("ok")}
          </Button>
        </ResponsiveModalContent>
      </ResponsiveModal>
    </div>
  );
}
