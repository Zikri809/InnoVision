"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useFaceTracker } from "@/components/face/use-face-tracker";
import {
  ENROLL_ANGLES,
  ENROLL_CAPTURE_MAX_ATTEMPTS,
  ENROLL_CAPTURE_MAX_MS,
  LIVENESS_TIMEOUT_MS,
} from "@/lib/face/constants";

type CaptureState = "idle" | "blink" | "capturing" | "done" | "failed" | "pending_review";

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
  const { videoRef, trackerRef, available, booting } = useFaceTracker();

  const [consent, setConsent] = useState(consentGiven);
  const [captureState, setCaptureState] = useState<CaptureState>(consentGiven && enrolled ? "done" : "idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [currentAngle, setCurrentAngle] = useState<number>(0);
  const [pose, setPose] = useState<{ yaw: number; centered: boolean; faceDetected: boolean }>({
    yaw: 0,
    centered: false,
    faceDetected: false,
  });

  const framesRef = useRef<string[]>([]);
  const attemptsRef = useRef(0);
  const captureStartRef = useRef(0);
  const disposedRef = useRef(false);

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

  async function handleConsent() {
    setError(null);
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
      setNotice(tCommon("ok"));
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
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (disposedRef.current) return null;
    return tracker.captureFrame();
  }

  async function runCapture() {
    if (disposedRef.current) return;
    const tracker = trackerRef.current;
    if (!tracker) return;
    setError(null);
    setNotice(null);
    setCaptureState("capturing");
    framesRef.current = [];
    attemptsRef.current = 0;
    captureStartRef.current = Date.now();

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

    setCaptureState("capturing");
    try {
      const res = await fetch("/api/face/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ frames: framesRef.current }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCaptureState("failed");
        setError(body.message ?? body.error ?? t("statusFailed"));
        return;
      }
      if (body.status === "pending_review") {
        setCaptureState("pending_review");
        return;
      }
      setCaptureState("done");
      router.refresh();
    } catch {
      setCaptureState("failed");
      setError(tCommon("errorGeneric"));
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
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                  currentAngle === 0
                    ? "bg-amber-400 text-black"
                    : currentAngle > 0
                    ? "bg-emerald-500 text-white"
                    : "bg-white/20 text-white/70"
                }`}
              >
                1. {t("angleFront")} {currentAngle > 0 && "✓"}
              </span>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                  currentAngle === 1
                    ? "bg-amber-400 text-black"
                    : currentAngle > 1
                    ? "bg-emerald-500 text-white"
                    : "bg-white/20 text-white/70"
                }`}
              >
                2. {t("angleLeft")} {currentAngle > 1 && "✓"}
              </span>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                  currentAngle === 2
                    ? "bg-amber-400 text-black"
                    : captureState === "done"
                    ? "bg-emerald-500 text-white"
                    : "bg-white/20 text-white/70"
                }`}
              >
                3. {t("angleRight")} {captureState === "done" && "✓"}
              </span>
            </div>

            <div
              className={`h-40 w-32 sm:h-48 sm:w-36 rounded-[50%] border-4 transition-all duration-300 ${
                !pose.faceDetected
                  ? "border-dashed border-white/50"
                  : (currentAngle === 0 && Math.abs(pose.yaw) <= 15 && pose.centered) ||
                    (currentAngle === 1 && pose.yaw >= 10) ||
                    (currentAngle === 2 && pose.yaw <= -10)
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
                  <span>{t("angleStatus", { deg: Math.abs(pose.yaw) })}</span>
                  <span className="text-white/40">|</span>
                  <span className="text-emerald-300">
                    {currentAngle === 0 && (Math.abs(pose.yaw) <= 15 ? t("goodBlink") : t("lookStraight"))}
                    {currentAngle === 1 && (pose.yaw >= 10 ? t("goodBlink") : t("turnLeft"))}
                    {currentAngle === 2 && (pose.yaw <= -10 ? t("goodBlink") : t("turnRight"))}
                  </span>
                </>
              )}
            </div>
          </div>
        )}

        {booting && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted/80 text-sm font-semibold text-muted-foreground">
            {t("statusBooting")}
          </div>
        )}
      </div>

      {!available && !booting ? (
        <div className="rounded-[28px] border-[3px] border-border bg-card p-8 shadow-[var(--shadow-clay)]">
          <h2 className="font-heading text-xl font-semibold">{t("enrollTitle")}</h2>
          <p className="mt-2 text-sm font-semibold text-muted-foreground">
            {t("statusFailed")}
          </p>
        </div>
      ) : !consent ? (
        <div className="rounded-[28px] border-[3px] border-border bg-card p-7 shadow-[var(--shadow-clay)] md:p-8">
          <h2 className="font-heading text-xl font-semibold">{t("consentTitle")}</h2>
          <p className="mt-2 text-sm font-semibold text-muted-foreground">
            {t("consentBody")}
          </p>
          <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-2xl border-[3px] border-border bg-orange-50/60 p-4">
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
              {!booting && captureState === "done" && t("statusDone")}
              {!booting && captureState === "pending_review" && t("statusPendingReview")}
              {!booting && captureState === "failed" && t("statusFailed")}
            </p>
          </div>

          {(captureState === "idle" || captureState === "failed") && (
            <Button size="lg" className="mt-5" onClick={() => void runCapture()}>
              {captureState === "failed" ? t("tryAgainBtn") : t("startCaptureBtn")}
            </Button>
          )}
          {captureState === "done" && (
            <Button size="lg" className="mt-5" onClick={() => void runCapture()}>
              {t("recaptureBtn")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
