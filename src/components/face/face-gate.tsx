"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { FaceStatus } from "@/lib/face/types";
import { ScanFace, ShieldCheck, UserRound, Timer } from "lucide-react";

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
    <div className="relative mx-auto max-w-2xl px-4 py-10">
      {/* decorative blobs */}
      <div aria-hidden className="pointer-events-none absolute -left-6 top-8 h-24 w-24 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-orange-200/50" />
      <div aria-hidden className="pointer-events-none absolute -right-4 bottom-12 h-20 w-20 rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-blue-200/50" />

      <div className="relative rounded-[28px] border-[3px] border-border bg-card p-7 shadow-[var(--shadow-clay)] md:p-9">
        <div className="mb-4 grid h-14 w-14 place-items-center rounded-[18px] bg-blue-100 text-accent shadow-[0_4px_0_rgba(29,78,216,0.15)]">
          <ScanFace className="h-7 w-7" aria-hidden />
        </div>
        <h1 className="font-heading text-2xl font-semibold">Face verification</h1>
        <p className="mt-2 text-sm font-semibold text-muted-foreground">
          Before you start, we verify it&apos;s really you at the camera. Look at
          the camera and blink when prompted.
        </p>

        {remainingMs !== null && (
          <p className="mt-4 inline-flex items-center gap-2 rounded-full border-[3px] border-amber-300 bg-amber-50 px-3.5 py-1.5 text-sm font-extrabold text-amber-800" role="status">
            <Timer className="h-4 w-4" aria-hidden />
            Time remaining: {Math.max(0, Math.ceil(remainingMs / 1000))}s
          </p>
        )}

        {!consentGiven && (
          <div className="mt-5 rounded-2xl border-[3px] border-border bg-orange-50/60 p-5">
            <div className="flex items-center gap-2.5">
              <ShieldCheck className="h-5 w-5 text-primary" aria-hidden />
              <p className="font-heading text-base font-semibold">Biometric consent required</p>
            </div>
            <p className="mt-2 text-sm font-semibold text-muted-foreground">
              InnoVision uses your webcam for face verification. Face embeddings
              are stored but face images are never saved. You can revoke consent
              at any time.
            </p>
            <Button
              className="mt-4"
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
          <div className="mt-5 rounded-2xl border-[3px] border-border bg-orange-50/60 p-5">
            <div className="flex items-center gap-2.5">
              <UserRound className="h-5 w-5 text-primary" aria-hidden />
              <p className="font-heading text-base font-semibold">Enrollment required</p>
            </div>
            <p className="mt-2 text-sm font-semibold text-muted-foreground">
              You need to enroll your face before taking an assessment.
            </p>
            <Button
              className="mt-4"
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

        <div className="mt-5 rounded-2xl border-[3px] border-border bg-muted/50 p-5" role="status">
          <p className="font-heading text-base font-semibold">Liveness check</p>
          <p className="mt-1.5 text-sm font-semibold text-muted-foreground">
            {livenessState === "idle" && "Blink when the camera is ready."}
            {livenessState === "waiting" && "Waiting for you to blink…"}
            {livenessState === "passed" && "Blink detected."}
            {livenessState === "failed" && "No blink detected — try again."}
            {status === "paused" && "A face mismatch paused the check. Blink to recover."}
          </p>
        </div>

        <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-extrabold text-muted-foreground">
            {readyToBegin ? "Ready to begin." : "Complete the steps above to begin."}
          </p>
          <Button size="lg" onClick={onBegin} disabled={!readyToBegin}>
            Begin assessment
          </Button>
        </div>
      </div>
    </div>
  );
}
