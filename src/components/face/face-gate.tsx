"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { FaceStatus } from "@/lib/face/types";

/**
 * FaceGate — the initial assessment gate (Phase 7).
 *
 * Shown INSTEAD of the quiz when the pipeline is in `'gate'`. Consent recap +
 * blink liveness + the first `'start'` verify. The gate shows the live timer
 * countdown via the `remainingMs` prop (presentational — threaded from
 * PlayClient; the hook governs logic only).
 *
 * Begin: enabled only after a successful blink + a 200 from the `'start'`
 * verify. If the verify fails (paused), the gate re-offers liveness
 * (auto re-runs `'start'` on recovery).
 */
export function FaceGate({
  consentGiven,
  enrolled,
  remainingMs,
  livenessState,
  status,
  onBegin,
  onConsent,
}: {
  consentGiven: boolean;
  enrolled: boolean;
  remainingMs: number | null;
  livenessState: "idle" | "waiting" | "passed" | "failed";
  status: FaceStatus;
  onBegin: () => void;
  onConsent: () => void;
}) {
  // Consent checkbox is a local interaction; the server value is authoritative
  // via `consentGiven` (keyed remount keeps it fresh when consent flips).
  const [consentChecked, setConsentChecked] = useState(consentGiven);
  const router = useRouter();

  // Begin is enabled once the student is consented + enrolled. The `'start'`
  // verify is the authority (it embeds blink liveness); `livenessState` is an
  // informational readout, not a hard gate. The gate is never rendered while a
  // verify is in flight (`beginGate` flips the pipeline to `recovering`
  // synchronously), so no in-flight flag is needed here.
  const readyToBegin = consentChecked && enrolled;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div className="rounded-xl border bg-card p-6">
        <h1 className="text-xl font-semibold">Face verification</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Before you start, we verify it&apos;s really you at the camera. Look at
          the camera and blink when prompted.
        </p>

        {remainingMs !== null && (
          <p className="mt-2 text-sm font-medium text-amber-700" role="status">
            Time remaining: {Math.max(0, Math.ceil(remainingMs / 1000))}s
          </p>
        )}

        {!consentGiven && (
          <div className="mt-4 rounded-lg border p-4">
            <p className="text-sm font-medium">Biometric consent required</p>
            <p className="mt-1 text-xs text-muted-foreground">
              InnoVision uses your webcam for face verification. Face embeddings
              are stored but face images are never saved. You can revoke consent
              at any time.
            </p>
            <Button
              className="mt-3"
              onClick={() => {
                setConsentChecked(true);
                onConsent();
              }}
            >
              I consent
            </Button>
          </div>
        )}

        {!enrolled && consentGiven && (
          <div className="mt-4 rounded-lg border p-4">
            <p className="text-sm font-medium">Enrollment required</p>
            <p className="mt-1 text-xs text-muted-foreground">
              You need to enroll your face before taking an assessment.
            </p>
            <Button
              className="mt-3"
              onClick={() => {
                // Full navigation keeps the session (one-attempt assessment);
                // the enroll page links back to the quiz list.
                router.push("/student/face/enroll");
              }}
            >
              Go to enrollment
            </Button>
          </div>
        )}

        <div className="mt-4 rounded-lg border p-4" role="status">
          <p className="text-sm font-medium">Liveness check</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {livenessState === "idle" && "Blink when the camera is ready."}
            {livenessState === "waiting" && "Waiting for you to blink…"}
            {livenessState === "passed" && "Blink detected."}
            {livenessState === "failed" && "No blink detected — try again."}
            {status === "paused" && "A face mismatch paused the check. Blink to recover."}
          </p>
        </div>

        <div className="mt-6 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {readyToBegin ? "Ready to begin." : "Complete the steps above to begin."}
          </p>
          <Button onClick={onBegin} disabled={!readyToBegin}>
            Begin assessment
          </Button>
        </div>
      </div>
    </div>
  );
}
