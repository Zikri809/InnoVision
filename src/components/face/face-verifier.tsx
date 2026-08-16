"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { FaceStatus } from "@/lib/face/types";
import { FaceGate } from "@/components/face/face-gate";

/**
 * FaceVerifier — presentational wrapper that owns the face-pipeline UI.
 *
 * Renders:
 *  - the assessment GATE (instead of children) when status is `'gate'`;
 *  - an honest chip when `'unavailable'` (passthrough, click-first);
 *  - a pause overlay (blink recovery) when `'paused'`;
 *  - a recovering overlay while the blink is awaited;
 *  - a flagged overlay (lecturer decision + poll + "Check again") when `'flagged'`;
 *  - children mounted otherwise (EXCEPT in `'gate'` — children stay mounted in
 *    paused/recovering/flagged so the hand model stays warm; overlays sit above
 *    the gesture PIP via explicit z-index).
 *
 * Face overlays are SUPPRESSED when PlayClient's phase is `submitted`/`dead`
 * (the EndScreen must never be covered by a lingering flag/pause overlay).
 *
 * Liveness UI state is DERIVED from `status` (no effect-synced state): a
 * `recovering` status shows "waiting"; `paused` shows "failed" (re-offer);
 * anything else shows "idle". `verifying` is local to the Begin click.
 */
export function FaceVerifier({
  status,
  phase,
  enrolled,
  consentGiven,
  remainingMs,
  onBegin,
  onConsent,
  onRecover,
  onCheckAgain,
  children,
}: {
  status: FaceStatus;
  phase: "question" | "locked" | "feedback" | "submitting" | "submitted" | "timeUp" | "dead";
  enrolled: boolean;
  consentGiven: boolean;
  remainingMs: number | null;
  onBegin: () => void;
  onConsent: () => void;
  onRecover: () => void;
  onCheckAgain: () => void;
  children: ReactNode;
}) {
  // Liveness UI state is DERIVED from `status` (no effect-synced state): a
  // `recovering` status shows "waiting"; `paused` shows "failed" (re-offer);
  // anything else shows "idle". There is deliberately NO local `verifying`
  // state — `beginGate` synchronously flips the pipeline to `recovering` (the
  // gate unmounts; the overlay owns the "Verifying…" UX), so a persisted
  // per-click flag would only survive a failed-blink re-render and permanently
  // disable the Begin button (gate soft-lock).
  const terminal = phase === "submitted" || phase === "dead";

  // Derive the liveness readout from the pipeline status.
  const livenessState: "idle" | "waiting" | "passed" | "failed" =
    status === "recovering" ? "waiting" : status === "paused" ? "failed" : "idle";

  if (terminal) {
    return <>{children}</>;
  }

  if (status === "off") {
    return <>{children}</>;
  }

  if (status === "unavailable") {
    return (
      <div className="relative">
        <div className="mb-2 flex justify-center">
          <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground" role="status">
            Face check unavailable — camera or models offline
          </span>
        </div>
        {children}
      </div>
    );
  }

  if (status === "gate") {
    return (
      <FaceGate
        consentGiven={consentGiven}
        enrolled={enrolled}
        remainingMs={remainingMs}
        livenessState={livenessState}
        status={status}
        onBegin={onBegin}
        onConsent={onConsent}
      />
    );
  }

  // Children stay mounted under overlays for paused/recovering/flagged.
  return (
    <div className="relative">
      {children}

      {(status === "paused" || status === "recovering") && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80 p-4" role="alert">
          <div className="rounded-xl border bg-card p-6 text-center shadow-lg">
            <p className="text-sm font-medium">
              {status === "recovering" ? "Blink to recover" : "Face check paused"}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {status === "recovering"
                ? "Look at the camera and blink."
                : "A face mismatch paused the check. Blink to continue."}
            </p>
            {status === "paused" && (
              <Button className="mt-4" onClick={onRecover}>
                Blink to recover
              </Button>
            )}
          </div>
        </div>
      )}

      {status === "flagged" && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80 p-4" role="alert">
          <div className="rounded-xl border bg-card p-6 text-center shadow-lg">
            <p className="text-sm font-medium text-destructive">Assessment flagged</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Our system detected repeated face mismatches. A lecturer must review
              and unlock your assessment before you can continue.
            </p>
            <div className="mt-4 flex justify-center gap-3">
              <Button variant="outline" onClick={onCheckAgain}>
                Check again
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
