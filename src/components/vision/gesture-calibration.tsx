"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

const FINGER_GUIDE = ["1", "2", "3", "4", "5"];

const PRACTICE_LETTERS = ["A", "B", "C", "D"];

export function GestureCalibration({
  fingerCount,
  handDetected,
  lighting = "good",
  notice,
  onContinue,
  onSkip,
  continueDisabled,
  multiPractice = false,
}: {
  fingerCount: number;
  handDetected: boolean;
  lighting?: "good" | "too_dark" | "too_bright";
  notice: string;
  onContinue: () => void;
  onSkip: () => void;
  continueDisabled: boolean;
  /** QT-1: when the quiz contains multi-select questions, render an
   * interactive practice card teaching the toggle/commit vocabulary
   * (hold N fingers toggles "option" N, an open palm commits) BEFORE the
   * first multi question. Purely calibration-local state — nothing here
   * touches the quiz. */
  multiPractice?: boolean;
}) {
  const t = useTranslations("vision");

  // Practice-card state: which of the 4 mock options are toggled on, and
  // whether the palm has committed at least once (drives the success chip).
  const [practiceSet, setPracticeSet] = useState<number[]>([]);
  const [practiceCommitted, setPracticeCommitted] = useState(false);
  const [practiceCleared, setPracticeCleared] = useState(false);

  // Live frame → practice semantics. The calibration readout streams every
  // frame, so holding N fingers re-fires the same toggle (idempotent union —
  // pressing "on" repeatedly is a no-op) and a present 5-finger pose commits.
  // Toggling OFF is taught by the copy (hold again after changing your hand —
  // the real latch re-arms on a pose change); a streaming frame cannot
  // distinguish a fresh hold from a sustained one, so frames only ever ADD.
  if (multiPractice && handDetected && fingerCount >= 1 && fingerCount <= 4) {
    const index = fingerCount - 1;
    setPracticeSet((prev) => (prev.includes(index) ? prev : [...prev, index].sort((a, b) => a - b)));
    setPracticeCommitted(false);
  } else if (multiPractice && handDetected && fingerCount === 5 && practiceSet.length > 0) {
    setPracticeCommitted(true);
  } else if (multiPractice && !handDetected && practiceSet.length > 0) {
    setPracticeCleared(true);
  }

  const getLightingText = (l?: "good" | "too_dark" | "too_bright") => {
    try {
      const key = l === "too_dark" ? "lightingTooDark" : l === "too_bright" ? "lightingTooBright" : "lightingGood";
      const val = t(key as "lightingGood" | "lightingTooDark" | "lightingTooBright");
      if (typeof val === "string" && !val.includes("vision.")) return val;
    } catch {
      // fallback
    }
    if (l === "too_dark") return "Too dark — increase lighting";
    if (l === "too_bright") return "Too bright — avoid glare";
    return "Lighting: Good ✓";
  };

  return (
    <div className="w-full flex flex-col pb-8">
      <div className="mb-6">
        <h1 className="font-heading text-2xl font-semibold">{t("calibrationTitle")}</h1>
        <p className="mt-1 text-sm font-semibold text-muted-foreground">
          {t("calibrationSubtitle")}
        </p>
      </div>

      <div className="overflow-hidden rounded-[22px] border-[3px] border-border bg-card shadow-[var(--shadow-clay-sm)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b-[3px] border-border px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
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
              {handDetected ? t("handDetected", { fingers: fingerCount }) : t("noHand")}
            </span>

            {handDetected && (
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border-[2px] px-3 py-1 text-xs font-bold ${
                  lighting === "good"
                    ? "border-emerald-400 bg-emerald-100 text-emerald-800 dark:border-emerald-700/50 dark:bg-emerald-500/15 dark:text-emerald-300"
                    : "border-amber-400 bg-amber-100 text-amber-900 dark:border-amber-500/50 dark:bg-amber-500/15 dark:text-amber-300"
                }`}
                role="status"
              >
                <span>{lighting === "good" ? "💡" : lighting === "too_dark" ? "🌙" : "☀️"}</span>
                {getLightingText(lighting)}
              </span>
            )}
          </div>
        </div>

        {handDetected && lighting !== "good" && (
          <div className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs font-bold text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
            ⚠️ {t("lightingWarning")}
          </div>
        )}

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

      {multiPractice && (
        <div className="mt-4 overflow-hidden rounded-[22px] border-[3px] border-border bg-card shadow-[var(--shadow-clay-sm)]">
          <div className="border-b-[3px] border-border px-4 py-3">
            <p className="text-sm font-extrabold">{t("multiPracticeTitle")}</p>
            <p className="mt-0.5 text-xs font-semibold text-muted-foreground">
              {t("multiPracticeSubtitle")}
            </p>
          </div>
          <div className="space-y-2 px-4 py-3.5">
            <div className="flex flex-wrap gap-2.5">
              {PRACTICE_LETTERS.map((letter, i) => {
                const on = practiceSet.includes(i);
                return (
                  <span
                    key={letter}
                    aria-hidden
                    className={`inline-flex items-center gap-1.5 rounded-xl border-[3px] px-3 py-1.5 text-xs font-extrabold transition-all duration-150 ${
                      on
                        ? "border-accent bg-blue-50 text-accent dark:border-accent/60 dark:bg-blue-950/30"
                        : "border-border bg-muted text-muted-foreground"
                    }`}
                  >
                    {letter} {t("multiPracticeOption", { index: i + 1 })}
                  </span>
                );
              })}
            </div>
            <p aria-live="polite" className="text-xs font-semibold text-muted-foreground">
              {practiceCommitted
                ? t("multiPracticeCommitted", { count: practiceSet.length })
                : practiceSet.length > 0
                  ? t("multiPracticeHolding", { count: practiceSet.length })
                  : t("multiPracticeIdle")}
            </p>
            {practiceCommitted && (
              <p className="rounded-xl border-[2px] border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-300" role="status">
                ✓ {t("multiPracticeSuccess")}
              </p>
            )}
            {practiceCleared && !practiceCommitted && (
              <p className="text-xs font-semibold text-muted-foreground">
                {t("multiPracticeCleared")}
              </p>
            )}
          </div>
        </div>
      )}

      <p role="note" className="mt-4 text-xs font-semibold text-muted-foreground">
        {notice}
      </p>

      <div className="mt-6 flex gap-3">
        <Button onClick={onContinue} disabled={continueDisabled}>
          {t("continueBtn")}
        </Button>
        <Button variant="outline" onClick={onSkip}>
          {t("skipBtn")}
        </Button>
      </div>
      {continueDisabled && (
        <p className="mt-2 text-xs font-semibold text-muted-foreground" role="status">
          {t("waitingHand")}
        </p>
      )}
    </div>
  );
}
