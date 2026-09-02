"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CircleAlert, CircleCheck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFaceTracker } from "@/components/face/use-face-tracker";
import type { LivePose } from "@/lib/face/types";
import {
  ENROLL_ANGLES,
  ENROLL_CAPTURE_MAX_ATTEMPTS,
  ENROLL_CAPTURE_MAX_MS,
  LIVENESS_TIMEOUT_MS,
} from "@/lib/face/constants";

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
}: {
  consentGiven: boolean;
  enrolled: boolean;
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

  const [captureState, setCaptureState] = useState<CaptureState>(consentGiven && enrolled ? "done" : "idle");
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
  // drift apart.
  function currentInstruction(): string | null {
    if (captureState !== "blink") return null;
    if (!pose.faceDetected) return null;
    if (currentAngle === 0)
      return Math.abs(pose.yaw) <= 15 ? t("goodBlink") : t("lookStraight");
    if (currentAngle === 1)
      return pose.yaw > 45 ? t("turnLess") : pose.yaw >= 10 ? t("goodBlink") : t("turnLeft");
    return pose.yaw < -45 ? t("turnLess") : pose.yaw <= -10 ? t("goodBlink") : t("turnRight");
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

  async function captureOneAngle(): Promise<string | null> {
    if (disposedRef.current) return null;
    const tracker = trackerRef.current;
    if (!tracker) return null;
    const blink = await tracker.waitForBlink(LIVENESS_TIMEOUT_MS);
    if (blink !== "passed") return null;
    // Allow eyes to fully reopen and pose to stabilize after the blink
    await new Promise((resolve) => setTimeout(resolve, 450));
    if (disposedRef.current) return null;
    if (typeof tracker.captureBestFrame === "function") {
      return tracker.captureBestFrame({
        maxWaitMs: 2000,
        requireCentered: true,
        requireOpenEyes: true,
        requireIdealLighting: true,
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
    attemptsRef.current = 0;
    captureStartRef.current = Date.now();

    try {
      // Per-user calibration: the yaw proxy measures nose position relative
      // to the cheeks, so "straight" is not a universal zero (webcam offset
      // alone can read ~15-20 units). Sample ~1s of the user looking
      // straight and make all thresholds RELATIVE to their neutral pose.
      setNotice(t("lookStraight"));
      await tracker.calibrateNeutral?.(900);
      if (disposedRef.current) return;
      setNotice(null);

      for (let i = 0; i < ENROLL_ANGLES.length; i++) {
        if (disposedRef.current) return;
        setCurrentAngle(i);
        let frame: string | null = null;
        while (frame === null) {
          attemptsRef.current++;
          if (disposedRef.current) return;
          if (Date.now() - captureStartRef.current > ENROLL_CAPTURE_MAX_MS) {
            setCaptureState("failed");
            setError(t("statusFailed"));
            return;
          }
          if (attemptsRef.current > ENROLL_CAPTURE_MAX_ATTEMPTS) {
            setCaptureState("failed");
            setError(t("statusFailed"));
            return;
          }
          setCaptureState("blink");
          frame = await captureOneAngle();
        }
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
        body: JSON.stringify({ frames: framesRef.current }),
      });
      if (disposedRef.current) return;
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCaptureState("failed");
        setResultOpen(false);
        setError(body.message ?? body.error ?? t("statusFailed"));
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

      <div className="relative mx-auto aspect-[4/3] max-w-xl overflow-hidden rounded-[28px] border-[3px] border-border bg-black shadow-[var(--shadow-clay)]">
        <video
          ref={videoRef}
          playsInline
          muted
          className="h-full w-full object-cover scale-x-[-1]"
        />

        {available && (
          <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-between p-4">
            <div className="flex gap-2 rounded-full bg-black/60 px-3 py-1.5 backdrop-blur-md">
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
                prompt is readable at arm's length, not just in the tiny
                bottom chip. aria-hidden: the bottom chip stays the live
                region so screen readers announce it exactly once. */}
            {currentInstruction() && (
              <div
                aria-hidden
                className="absolute left-1/2 top-[4.5rem] -translate-x-1/2 rounded-full bg-black/80 px-5 py-2.5 text-base sm:text-lg font-extrabold text-white shadow-lg backdrop-blur-md"
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

            <div
              className={`h-40 w-32 sm:h-48 sm:w-36 rounded-[50%] border-4 transition-all duration-300 ${
                !pose.faceDetected
                  ? "border-dashed border-white/50"
                  : (currentAngle === 0 && Math.abs(pose.yaw) <= 15 && pose.centered) ||
                    (currentAngle === 1 && pose.yaw >= 10 && pose.yaw <= 45) ||
                    (currentAngle === 2 && pose.yaw <= -10 && pose.yaw >= -45)
                  ? "scale-105 border-emerald-400 bg-emerald-500/10 shadow-[0_0_20px_rgba(52,211,153,0.5)]"
                  : "border-amber-400/80 bg-amber-400/5 shadow-[0_0_15px_rgba(251,191,36,0.3)]"
              }`}
            />

            <div className="max-w-[92%] flex flex-wrap items-center justify-center gap-1.5 rounded-2xl sm:rounded-full bg-black/75 px-3 py-1.5 text-[11px] sm:text-xs font-bold text-white text-center backdrop-blur-md">
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
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/90 px-6 text-center">
            <p className="text-sm font-semibold text-white/80">{t("cameraOffHint")}</p>
          </div>
        )}

        {consent && booting && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted/80 text-sm font-semibold text-muted-foreground">
            {t("statusBooting")}
          </div>
        )}
      </div>

      {available && (
        <p className="text-center text-xs font-bold text-muted-foreground">
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
            {enrolled ? t("alreadyEnrolledTitle") : t("notEnrolledTitle")}
          </h2>
          <p className="mt-2 text-sm font-semibold text-muted-foreground">
            {enrolled
              ? t("alreadyEnrolledSubtitle")
              : t("notEnrolledSubtitle")}
          </p>

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
      <Dialog open={resultOpen} onOpenChange={setResultOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            {captureState === "processing" ? (
              <>
                <div className="mb-1 grid h-12 w-12 place-items-center rounded-2xl bg-primary/15 text-primary">
                  <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
                </div>
                <DialogTitle className="text-base">{t("processingTitle")}</DialogTitle>
                <DialogDescription>{t("processingBody")}</DialogDescription>
              </>
            ) : captureState === "pending_review" ? (
              <>
                <div className="mb-1 grid h-12 w-12 place-items-center rounded-2xl bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400">
                  <CircleAlert className="h-6 w-6" aria-hidden />
                </div>
                <DialogTitle className="text-base">{t("pendingTitle")}</DialogTitle>
                <DialogDescription>{t("pendingBody")}</DialogDescription>
              </>
            ) : (
              <>
                <div className="mb-1 grid h-12 w-12 place-items-center rounded-2xl bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
                  <CircleCheck className="h-6 w-6" aria-hidden />
                </div>
                <DialogTitle className="text-base">{t("successTitle")}</DialogTitle>
                <DialogDescription>{t("successBody")}</DialogDescription>
              </>
            )}
          </DialogHeader>
          <Button
            onClick={() => setResultOpen(false)}
            className="w-full"
            disabled={captureState === "processing"}
          >
            {captureState === "processing" ? tCommon("loading") : tCommon("ok")}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
