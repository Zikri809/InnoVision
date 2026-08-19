"use client";

import { Button } from "@/components/ui/button";

const FINGER_GUIDE = ["1", "2", "3", "4", "5"];

/**
 * Calibration panel shown once before the quiz starts (Phase 6). Non-gated and
 * always skippable: Continue is enabled only when the tracker is ready
 * (`trackerReady`); Skip is always enabled and turns gestures off.
 *
 * The live webcam/canvas is rendered ABOVE this panel by `GestureLayer` as a
 * persistent node (never remounted between calibration and the PIP), so this
 * component only renders the status readout, finger guide, privacy notice, and
 * the Continue/Skip actions.
 *
 * The `notice` is the honest webcam-consent line: MediaPipe runs locally and
 * only the selected option index is POSTed (exactly as a click would) — video
 * never leaves the device.
 */
export function GestureCalibration({
  fingerCount,
  handDetected,
  notice,
  onContinue,
  onSkip,
  continueDisabled,
}: {
  fingerCount: number;
  handDetected: boolean;
  notice: string;
  onContinue: () => void;
  onSkip: () => void;
  continueDisabled: boolean;
}) {
  return (
    <div className="mx-auto max-w-2xl px-4 pb-8">
      <div className="mb-6">
        <h1 className="font-heading text-2xl font-semibold">Hand gestures</h1>
        <p className="mt-1 text-sm font-semibold text-muted-foreground">
          Hold up one to five fingers and keep them steady to answer. Raise all
          five (open palm) to continue between questions.
        </p>
      </div>

      <div className="overflow-hidden rounded-[22px] border-[3px] border-border bg-card shadow-[var(--shadow-clay-sm)]">
        <div className="flex items-center justify-between border-b-[3px] border-border px-4 py-3">
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border-[2px] px-3 py-1 text-xs font-bold ${
                handDetected ? "border-emerald-400 bg-emerald-100 text-emerald-800" : "border-border bg-muted text-muted-foreground"
              }`}
              role="status"
            >
              <span
                className={`size-2 rounded-full ${handDetected ? "bg-emerald-500" : "bg-muted-foreground/50"}`}
                aria-hidden
              />
              {handDetected ? "Hand detected" : "No hand"}
            </span>
            <span className="text-xs font-bold text-muted-foreground">
              Fingers: {fingerCount}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2.5 px-4 py-3.5">
          {FINGER_GUIDE.map((n) => {
            const active = fingerCount === Number(n);
            return (
              <span
                key={n}
                className={`inline-flex size-9 items-center justify-center rounded-xl border-[3px] font-heading text-sm font-extrabold transition-all duration-150 ${
                  active
                    ? "border-primary bg-primary text-primary-foreground shadow-[0_3px_0_var(--primary-deep)] scale-105"
                    : "border-border bg-muted text-muted-foreground"
                }`}
                aria-hidden
              >
                {n}
              </span>
            );
          })}
        </div>
      </div>

      <p role="note" className="mt-4 text-xs font-semibold text-muted-foreground">
        {notice}
      </p>

      <div className="mt-6 flex gap-3">
        <Button onClick={onContinue} disabled={continueDisabled}>
          Continue
        </Button>
        <Button variant="outline" onClick={onSkip}>
          Skip — click to answer
        </Button>
      </div>
      {continueDisabled && (
        <p className="mt-2 text-xs font-semibold text-muted-foreground" role="status">
          Waiting for hand tracking to be ready…
        </p>
      )}
    </div>
  );
}
