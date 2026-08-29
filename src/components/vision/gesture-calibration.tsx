"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

const FINGER_GUIDE = ["1", "2", "3", "4", "5"];

export function GestureCalibration({
  fingerCount,
  handDetected,
  lighting = "good",
  notice,
  onContinue,
  onSkip,
  continueDisabled,
}: {
  fingerCount: number;
  handDetected: boolean;
  lighting?: "good" | "too_dark" | "too_bright";
  notice: string;
  onContinue: () => void;
  onSkip: () => void;
  continueDisabled: boolean;
}) {
  const t = useTranslations("vision");

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
