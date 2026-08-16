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

  const framesRef = useRef<string[]>([]);
  const attemptsRef = useRef(0);
  const captureStartRef = useRef(0);
  const disposedRef = useRef(false);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);

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

  if (!available && !booting) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <div className="rounded-xl border bg-card p-6">
          <h1 className="text-xl font-semibold">Face enrollment</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Camera or face service unavailable — face enrollment needs a working webcam and the face service online.
          </p>
        </div>
      </div>
    );
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
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Face enrollment</h1>
        {consent && (
          <Button variant="outline" onClick={() => void handleRevoke()} disabled={revoking}>
            {revoking ? "Revoking…" : "Revoke consent"}
          </Button>
        )}
      </div>

      {/* Persistent hidden video node (never conditionally mounted). */}
      <video
        ref={videoRef}
        className="hidden"
        autoPlay
        playsInline
        muted
        aria-hidden
      />

      {error && (
        <p className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="mb-4 rounded-lg border border-amber-300/40 bg-amber-50 p-3 text-sm text-amber-800" role="status">
          {notice}
        </p>
      )}

      {!consent ? (
        <div className="rounded-xl border bg-card p-6">
          <h2 className="text-lg font-semibold">Biometric consent</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            InnoVision uses your webcam for face verification during assessments.
            Face data is processed by a self-hosted recognition service; face
            images are never stored in the quiz database. You can revoke consent
            at any time — note that revoking mid-assessment flags in-progress
            sessions for a lecturer.
          </p>
          <label className="mt-4 flex items-start gap-3 rounded-lg border p-3">
            <Checkbox
              checked={consent}
              onCheckedChange={(v) => {
                if (v === true) void handleConsent();
              }}
              className="mt-0.5"
            />
            <span className="text-sm">
              I consent to face verification.
            </span>
          </label>
        </div>
      ) : (
        <div className="rounded-xl border bg-card p-6">
          <h2 className="text-lg font-semibold">
            {enrolled ? "Face already enrolled" : "Enroll your face"}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {enrolled
              ? "Your face is already enrolled. You can re-enroll by running the capture again."
              : "We'll capture 3 angles (front, left, right). Look at the camera, blink when prompted, and hold still for each angle."}
          </p>

          <div className="mt-4 rounded-lg border p-4" role="status">
            <p className="text-sm font-medium">Status</p>
            <p className="mt-1 text-xs text-muted-foreground">
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
            <Button className="mt-4" onClick={() => void runCapture()}>
              {captureState === "failed" ? "Try again" : "Start capture"}
            </Button>
          )}
          {captureState === "done" && (
            <Button className="mt-4" onClick={() => void runCapture()}>
              Re-capture
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
