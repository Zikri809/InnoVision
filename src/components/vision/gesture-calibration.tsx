"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

const FINGER_GUIDE = ["1", "2", "3", "4", "5"];

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
  const t = useTranslations("vision");

  return (
    <div className="mx-auto max-w-2xl px-4 pb-8">
      <div className="mb-6">
        <h1 className="font-heading text-2xl font-semibold">{t("calibrationTitle")}</h1>
        <p className="mt-1 text-sm font-semibold text-muted-foreground">
          {t("calibrationSubtitle")}
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
              {handDetected ? t("handDetected", { fingers: fingerCount }) : t("noHand")}
            </span>
            <span className="text-xs font-bold text-muted-foreground">
              {t("handDetected", { fingers: fingerCount })}
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
