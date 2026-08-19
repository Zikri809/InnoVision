"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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

/**
 * FaceEnrollClient — the CompreFace 3-angle enrollment flow:
 *  1. Consent recap + checkbox when consent is null (POST /api/face/consent).
 *  2. Blink liveness (waitForBlink) — once per angle.
 *  3. 3-angle capture (front → left → right), one FRAME per angle. Each frame
 *     is validated server-side (CompreFace /detect pose + duplicate check).
 *     POST /api/face/enroll with `{ frames: [front, left, right] }`.
 *  4. Redirect to /student/quizzes (or show the pending-review surface).
 *
 * "Revoke consent" copy states the mid-assessment consequence.
 */
export function FaceEnrollClient({
  consentGiven,
  enrolled,
}: {
  consentGiven: boolean;
  enrolled: boolean;
}) {
  const router = useRouter();
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

  async function handleConsent() {
    setError(null);
    const res = await fetch("/api/face/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consent: true }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.message ?? body.error ?? "Could not update consent.");
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
        setError(body.message ?? body.error ?? "Could not revoke consent.");
        return;
      }
      setConsent(false);
      setCaptureState("idle");
      setNotice(
        "Consent revoked. In-progress assessments were flagged for a lecturer to review; re-consenting will NOT un-flag them.",
      );
    } finally {
      setRevoking(false);
    }
  }

  /** Capture one frame for the current angle (after a blink liveness pass). */
  async function captureOneAngle(): Promise<string | null> {
    if (disposedRef.current) return null;
    const tracker = trackerRef.current;
    if (!tracker) return null;
    const blink = await tracker.waitForBlink(LIVENESS_TIMEOUT_MS);
    if (blink !== "passed") return null;
    // Allow 350ms for eyes to fully reopen after the blink before snapping the photo
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
    // eslint-disable-next-line react-hooks/purity
    captureStartRef.current = Date.now();

    // Guided 3-angle capture: front → left → right, one blink per angle.
    for (let i = 0; i < ENROLL_ANGLES.length; i++) {
      if (disposedRef.current) return;
      setCurrentAngle(i);
      let frame: string | null = null;
      while (frame === null) {
        attemptsRef.current++;
        if (disposedRef.current) return;
        // Caps from constants.ts — the same limits the schemas/UI advertise.
        // eslint-disable-next-line react-hooks/purity
        if (Date.now() - captureStartRef.current > ENROLL_CAPTURE_MAX_MS) {
          setCaptureState("failed");
          setError("Capture timed out. Please try again.");
          return;
        }
        if (attemptsRef.current > ENROLL_CAPTURE_MAX_ATTEMPTS) {
          setCaptureState("failed");
          setError("Could not capture enough frames. Please try again.");
          return;
        }
        setCaptureState("blink");
        frame = await captureOneAngle();
      }
      framesRef.current.push(frame);
    }

    await enroll(framesRef.current);
  }

  async function enroll(frames: string[]) {
    setError(null);
    const res = await fetch("/api/face/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ frames }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (body.error === "pose_invalid") {
        setCaptureState("failed");
        setError("Please center your face and follow the angle prompts. Try again.");
        return;
      }
      setCaptureState("failed");
      setError(body.message ?? body.error ?? "Could not enroll your face.");
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { status?: string };
    if (body.status === "pending_review") {
      setCaptureState("pending_review");
      setNotice("Enrollment is pending lecturer review (a similar face was detected).");
      return;
    }
    setCaptureState("done");
    setNotice("Face enrolled successfully.");
    router.push("/student/quizzes");
    router.refresh();
  }

  const angleLabel = (idx: number) => {
    switch (idx) {
      case 0:
        return "Look straight at the camera";
      case 1:
        return "Turn your head LEFT (~30°)";
      case 2:
        return "Turn your head RIGHT (~30°)";
      default:
        return "";
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-heading text-2xl font-semibold">Face enrollment</h1>
        {consent && (
          <Button variant="outline" onClick={() => void handleRevoke()} disabled={revoking}>
            {revoking ? "Revoking…" : "Revoke consent"}
          </Button>
        )}
      </div>

      <div aria-live="polite">
        {error && (
          <p className="mb-4 rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="mb-4 rounded-2xl border-[3px] border-amber-300 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800" role="status">
            {notice}
          </p>
        )}
      </div>

      {/* The ONE single persistent video element — never conditionally unmounted */}
      <div
        className={
          consent && (available || booting)
            ? "relative mx-auto mb-5 aspect-[4/3] w-full max-w-md overflow-hidden rounded-3xl border-[3px] border-border bg-muted/40 shadow-[var(--shadow-clay)]"
            : "fixed -top-[9999px] left-0 pointer-events-none opacity-0"
        }
      >
        <video
          ref={videoRef}
          className="h-full w-full object-cover -scale-x-100"
          autoPlay
          playsInline
          muted
        />

        {/* Live Face Guide & Balance Overlay */}
        {!booting && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-between p-4">
            {/* Steps Progress Header */}
            <div className="flex items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 backdrop-blur-md">
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                  currentAngle === 0
                    ? "bg-amber-400 text-black"
                    : currentAngle > 0
                    ? "bg-emerald-500 text-white"
                    : "bg-white/20 text-white/70"
                }`}
              >
                1. Front {currentAngle > 0 && "✓"}
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
                2. Left {currentAngle > 1 && "✓"}
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
                3. Right {captureState === "done" && "✓"}
              </span>
            </div>

            {/* Centered Face Oval Guide */}
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

            {/* Live Angle & Balance HUD */}
            <div className="flex items-center gap-2 rounded-full bg-black/70 px-4 py-1.5 text-xs font-bold text-white backdrop-blur-md">
              {!pose.faceDetected ? (
                <span className="text-amber-300">Position face in frame</span>
              ) : (
                <>
                  <span className={pose.centered ? "text-emerald-400" : "text-amber-300"}>
                    {pose.centered ? "Centered ✓" : "Center Face"}
                  </span>
                  <span className="text-white/40">|</span>
                  <span>Angle: {Math.abs(pose.yaw)}°</span>
                  <span className="text-white/40">|</span>
                  <span className="text-emerald-300">
                    {currentAngle === 0 && (Math.abs(pose.yaw) <= 15 ? "Good! Blink now" : "Look Straight")}
                    {currentAngle === 1 && (pose.yaw >= 10 ? "Good! Blink now" : "Turn Left ⟵")}
                    {currentAngle === 2 && (pose.yaw <= -10 ? "Good! Blink now" : "Turn Right ⟶")}
                  </span>
                </>
              )}
            </div>
          </div>
        )}

        {booting && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted/80 text-sm font-semibold text-muted-foreground">
            Starting camera…
          </div>
        )}
      </div>

      {!available && !booting ? (
        <div className="rounded-[28px] border-[3px] border-border bg-card p-8 shadow-[var(--shadow-clay)]">
          <h2 className="font-heading text-xl font-semibold">Camera or service unavailable</h2>
          <p className="mt-2 text-sm font-semibold text-muted-foreground">
            Camera or face service unavailable — face enrollment needs a working webcam and the face service online.
          </p>
        </div>
      ) : !consent ? (
        <div className="rounded-[28px] border-[3px] border-border bg-card p-7 shadow-[var(--shadow-clay)] md:p-8">
          <h2 className="font-heading text-xl font-semibold">Biometric consent</h2>
          <p className="mt-2 text-sm font-semibold text-muted-foreground">
            InnoVision uses your webcam for face verification during assessments.
            Face data is processed by a self-hosted recognition service; face
            images are never stored in the quiz database. You can revoke consent
            at any time — note that revoking mid-assessment flags in-progress
            sessions for a lecturer.
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
              I consent to face verification.
            </span>
          </label>
        </div>
      ) : (
        <div className="rounded-[28px] border-[3px] border-border bg-card p-7 shadow-[var(--shadow-clay)] md:p-8">
          <h2 className="font-heading text-xl font-semibold">
            {enrolled ? "Face already enrolled" : "Enroll your face"}
          </h2>
          <p className="mt-2 text-sm font-semibold text-muted-foreground">
            {enrolled
              ? "Your face is already enrolled. You can re-enroll by running the capture again."
              : "We'll capture 3 angles (front, left, right). Look at the camera, blink when prompted, and hold still for each angle."}
          </p>

          <div className="mt-5 rounded-2xl border-[3px] border-border bg-muted/50 p-5" role="status">
            <p className="font-heading text-base font-semibold">Status</p>
            <p className="mt-1.5 text-sm font-bold text-muted-foreground">
              {booting && "Starting camera…"}
              {!booting && captureState === "idle" && "Ready. Press start below."}
              {!booting && captureState === "blink" && `Blink now — ${angleLabel(currentAngle)}`}
              {!booting && captureState === "capturing" &&
                `Capturing ${currentAngle + 1}/${ENROLL_ANGLES.length} — ${angleLabel(currentAngle)}`}
              {!booting && captureState === "done" && "Enrolled."}
              {!booting && captureState === "pending_review" && "Pending lecturer review."}
              {!booting && captureState === "failed" && "Capture failed — try again."}
            </p>
          </div>

          {(captureState === "idle" || captureState === "failed") && (
            <Button size="lg" className="mt-5" onClick={() => void runCapture()}>
              {captureState === "failed" ? "Try again" : "Start capture"}
            </Button>
          )}
          {captureState === "done" && (
            <Button size="lg" className="mt-5" onClick={() => void runCapture()}>
              Re-capture
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
