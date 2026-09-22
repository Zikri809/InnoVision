"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Hand, Lightbulb, Moon, ShieldCheck, Sun, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

const FINGER_GUIDE = ["1", "2", "3", "4", "5"];

const PRACTICE_LETTERS = ["A", "B", "C", "D"];

/**
 * CalibrationHud — the camera-surface furniture for the MOBILE calibration
 * hero: live status chip (top-left), lighting chip (top-right), and the
 * 1–5 finger tray docked at the viewfinder's bottom edge like a game HUD.
 * Purely presentational (pointer-events-none surface); gesture-layer mounts
 * it INSIDE the video container so it hugs the live frame. `booting`
 * swaps the status chip for the waiting line while the tracker boots.
 */
export function CalibrationHud({
  fingerCount,
  handDetected,
  lighting = "good",
  booting = false,
}: {
  fingerCount: number;
  handDetected: boolean;
  lighting?: "good" | "too_dark" | "too_bright";
  booting?: boolean;
}) {
  const t = useTranslations("vision");

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-3">
      {/* Top row: status left, lighting right. */}
      <div className="flex items-start justify-between gap-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border-[2.5px] px-3 py-1.5 text-xs font-extrabold shadow-[0_2px_0_var(--border)] backdrop-blur-sm transition-colors duration-200 ${
            booting
              ? "border-border bg-background/95 text-muted-foreground"
              : handDetected
                ? "border-emerald-600 bg-emerald-100 text-emerald-900 dark:border-emerald-700/50 dark:bg-emerald-500/15 dark:text-emerald-300"
                : "border-border bg-background/95 text-muted-foreground"
          }`}
          role="status"
        >
          <span
            className={`size-2.5 rounded-full transition-colors duration-200 ${
              !booting && handDetected ? "bg-emerald-500" : "bg-muted-foreground/50"
            }`}
            aria-hidden
          />
          {booting ? t("waitingHand") : handDetected ? t("handDetected", { fingers: fingerCount }) : t("noHand")}
        </span>

        {!booting && handDetected && (
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border-[2.5px] px-3 py-1.5 text-xs font-extrabold shadow-[0_2px_0_var(--border)] backdrop-blur-sm ${
              lighting === "good"
                ? "border-emerald-600 bg-emerald-100 text-emerald-900 dark:border-emerald-700/50 dark:bg-emerald-500/15 dark:text-emerald-300"
                : "border-amber-500 bg-amber-100 text-amber-900 dark:border-amber-500/50 dark:bg-amber-500/15 dark:text-amber-300"
            }`}
            role="status"
          >
            {lighting === "good" ? (
              <Lightbulb className="size-3.5" aria-hidden />
            ) : lighting === "too_dark" ? (
              <Moon className="size-3.5" aria-hidden />
            ) : (
              <Sun className="size-3.5" aria-hidden />
            )}
            {lighting === "good"
              ? t("lightingGood")
              : lighting === "too_dark"
                ? t("lightingTooDark")
                : t("lightingTooBright")}
          </span>
        )}
      </div>

      {/* Coach guidance: optimal hand position */}
      <div className="flex justify-center px-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border-[2px] border-border/60 bg-background/90 px-3 py-1 text-center text-xs font-extrabold shadow-[var(--shadow-clay-sm)] backdrop-blur-sm">
          {t("handPositionCoach")}
        </span>
      </div>

      {/* Bottom edge: the 1–5 finger tray, clay caps on a frosted tray.
          The live pose's pill lights orange and springs up. */}
      <div className="flex justify-center">
        <div className="rounded-[20px] border-[3px] border-border bg-background/90 p-2 shadow-[var(--shadow-clay-sm)] backdrop-blur-sm" aria-hidden>
          <div className="flex gap-2">
            {FINGER_GUIDE.map((n) => {
              const active = !booting && fingerCount === Number(n);
              return (
                <span
                  key={n}
                  className={`inline-flex size-10 items-center justify-center rounded-[14px] border-[3px] font-heading text-sm font-extrabold transition-[border-color,background-color,color,transform,box-shadow] duration-150 ${
                    active
                      ? "-translate-y-1 scale-110 border-primary bg-primary text-primary-foreground shadow-[0_4px_0_var(--primary-deep)]"
                      : "border-border bg-muted text-muted-foreground shadow-[0_2px_0_var(--border)]"
                  }`}
                >
                  {n}
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * GestureCalibration — the pre-quiz "how to answer" screen content.
 *
 * Mobile-first redesign (2026-09): the camera is the hero (HUD lives in
 * `CalibrationHud`, mounted by gesture-layer inside the video container);
 * this component renders the coach copy, multi-select practice, lighting
 * warning and a thumb-zone action dock whose primary button fills the
 * width and skips the visual clutter of the old side-by-side card stack.
 * ≥lg keeps the original card composition (chips + finger guide in a
 * bordered card). The `Hand gestures` heading text and the Continue/Skip
 * button names are e2e contracts (helpers.ts, e9c) — preserved verbatim.
 */
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
  // Effect (not render scope) + microtask-deferred setState (cascading-render
  // rule, same idiom as FlaggedWaitTicker): the render-phase version converged
  // only through idempotent bail-outs — any non-idempotent edit would have
  // become an infinite render loop.
  useEffect(() => {
    if (!multiPractice) return;
    void Promise.resolve().then(() => {
      if (handDetected && fingerCount >= 1 && fingerCount <= 4) {
        const index = fingerCount - 1;
        setPracticeSet((prev) => (prev.includes(index) ? prev : [...prev, index].sort((a, b) => a - b)));
        setPracticeCommitted(false);
      } else if (handDetected && fingerCount === 5 && practiceSet.length > 0) {
        setPracticeCommitted(true);
      } else if (!handDetected && practiceSet.length > 0) {
        setPracticeCleared(true);
      }
    });
  }, [multiPractice, handDetected, fingerCount, practiceSet.length]);

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

  const multiPracticeCard = (
    <div className="overflow-hidden rounded-[22px] border-[3px] border-border bg-card shadow-[var(--shadow-clay-sm)]">
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
                className={`inline-flex items-center gap-1.5 rounded-xl border-[3px] px-3 py-1.5 text-xs font-extrabold transition-[border-color,background-color] duration-150 ${
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
  );

  const lightingWarningBand = handDetected && lighting !== "good" && (
    <div className="flex items-center gap-2 rounded-[16px] border-[3px] border-amber-500/60 bg-amber-100 px-3 py-2 text-xs font-bold text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
      <TriangleAlert className="size-4 shrink-0" aria-hidden />
      {t("lightingWarning")}
    </div>
  );

  // ══════════════════════════ MOBILE (<lg default) ══════════════════════════
  // Coach copy under the camera hero, then a FIXED thumb-zone action dock —
  // the same bottom-bar grammar the quiz action bar uses (plan W3): a fixed
  // sticky element as the last child of its container would never stick.
  // During calibration the quiz action bar is not mounted, so this is the
  // only bottom layer. Full-width Continue; quiet text Skip beneath it
  // (onboarding must never trap the user). Content above clears the dock
  // with a 152px+safe-bottom bottom pad, matching play-client's offset.
  const mobileLayout = (
    <div className="flex flex-col gap-3 pb-[calc(152px+var(--safe-bottom))]">
      <div className="flex flex-col items-center gap-1 px-2 text-center">
        <h1 className="font-heading text-xl font-semibold">{t("calibrationTitle")}</h1>
        <p className="inline-flex items-center gap-1.5 text-sm font-extrabold text-foreground">
          <Hand className="size-4 shrink-0 text-primary" aria-hidden />
          {t("calibrationSubtitle")}
        </p>
        <p className="mt-0.5 inline-flex max-w-sm items-start justify-center gap-1 text-xs font-semibold text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {notice}
        </p>
      </div>

      {multiPractice && <div className="px-1">{multiPracticeCard}</div>}

      {lightingWarningBand && <div className="px-1">{lightingWarningBand}</div>}

      <div className="fixed inset-x-4 bottom-0 z-30 flex flex-col items-stretch gap-2 rounded-t-[22px] border-x-[3px] border-t-[3px] border-border bg-background/95 pb-[max(0.75rem,var(--safe-bottom))] pt-3 shadow-[var(--shadow-clay-up)] backdrop-blur-sm">
        <Button
          onClick={onContinue}
          disabled={continueDisabled}
          className="h-12 w-full text-base max-sm:h-14 max-sm:text-lg"
        >
          {t("continueBtn")}
        </Button>
        <button
          type="button"
          onClick={onSkip}
          className="mx-auto min-h-11 w-full cursor-pointer rounded-xl px-3 text-sm font-extrabold text-muted-foreground underline decoration-border decoration-2 underline-offset-4 transition-colors duration-150 hover:text-foreground focus-visible:outline-[3px] focus-visible:outline-ring focus-visible:outline-offset-2"
        >
          {t("skipBtn")}
        </button>
        {continueDisabled && (
          <p className="text-center text-xs font-semibold text-muted-foreground" role="status">
            {t("waitingHand")}
          </p>
        )}
      </div>
    </div>
  );

  // ══════════════════════════ WIDE (≥lg) ══════════════════════════
  // The proven card composition: status/lighting chips + finger guide in a
  // bordered card under the landscape camera panel, buttons side-by-side.
  const wideLayout = (
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
                <Lightbulb className="size-3.5 shrink-0" aria-hidden />
                {getLightingText(lighting)}
              </span>
            )}
          </div>

          <span className="inline-flex items-center gap-1.5 rounded-full border-[2px] border-border bg-muted/60 px-3 py-1 text-xs font-bold text-muted-foreground">
            <Hand className="size-3.5 text-primary" aria-hidden />
            {t("handPositionCoach")}
          </span>
        </div>

        {handDetected && lighting !== "good" && (
          <div className="flex items-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs font-bold text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
            {t("lightingWarning")}
          </div>
        )}

        <div className="flex flex-wrap gap-2.5 px-4 py-3.5">
          {FINGER_GUIDE.map((n) => {
            const active = fingerCount === Number(n);
            return (
              <span
                key={n}
                className={`inline-flex size-9 items-center justify-center rounded-xl border-[3px] font-heading text-sm font-extrabold transition-[border-color,background-color] duration-150 ${
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

      {multiPractice && <div className="mt-4">{multiPracticeCard}</div>}

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

  return (
    <>
      <div className="lg:hidden">{mobileLayout}</div>
      <div className="hidden lg:block">{wideLayout}</div>
    </>
  );
}
