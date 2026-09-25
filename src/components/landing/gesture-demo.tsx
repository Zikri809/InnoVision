"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Hand } from "lucide-react";

const OPTION_KEYS = ["demoOption1", "demoOption2", "demoOption3", "demoOption4"] as const;
const LETTERS = ["A", "B", "C", "D"] as const;

export function GestureDemo() {
  const t = useTranslations("landing");
  const [selected, setSelected] = useState(1);
  const [revision, setRevision] = useState(0);
  const options = OPTION_KEYS.map((key) => t(key));

  function choose(index: number) {
    setSelected(index);
    setRevision((current) => current + 1);
  }

  return (
    <div className="w-full max-w-xl lg:ml-auto">
      <div className="rounded-[32px] border-[3px] border-accent-deep bg-accent p-4 text-accent-foreground shadow-[8px_9px_0_rgba(29,78,216,0.18)] sm:p-5">
        <div className="flex items-center justify-between gap-3 px-1 pb-4">
          <span className="flex items-center gap-2.5 text-xs font-extrabold uppercase tracking-[0.12em] sm:text-sm">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[12px] bg-primary text-primary-foreground shadow-[0_3px_0_var(--primary-deep)]">
              <Hand className="h-5 w-5" aria-hidden />
            </span>
            {t("demoBadge")}
          </span>
          <span className="shrink-0 rounded-full border-2 border-current px-3 py-1 text-xs font-extrabold">
            {t("demoProgress")}
          </span>
        </div>

        <div className="rounded-[22px] border-[3px] border-orange-200 bg-orange-50 p-4 text-orange-950 shadow-[0_5px_0_rgba(29,78,216,0.16)] sm:p-5">
          <p className="text-xs font-extrabold uppercase tracking-[0.12em] text-orange-700">
            {t("demoQuestionLabel")}
          </p>
          <p className="mt-2 font-heading text-lg font-semibold leading-snug [text-wrap:balance] sm:text-xl">
            {t("demoQ")}
          </p>
          <div className="mt-5 grid grid-cols-2 gap-2.5">
            {options.map((option, index) => {
              const isSelected = selected === index;
              return (
                <button
                  key={OPTION_KEYS[index]}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => choose(index)}
                  className={"flex min-h-14 cursor-pointer items-center gap-2 rounded-[15px] border-[3px] px-2.5 py-2 text-left text-sm font-extrabold transition-[border-color,background-color,color,box-shadow] duration-200 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] sm:px-3 " +
                    (isSelected
                      ? "border-accent bg-blue-50 text-blue-900 shadow-[0_3px_0_#bfdbfe]"
                      : "border-orange-200 bg-white text-orange-950 shadow-[0_3px_0_#fed7aa] hover:border-primary")}
                >
                  <span className={"grid h-8 w-8 shrink-0 place-items-center rounded-[10px] font-heading " +
                    (isSelected ? "bg-accent text-accent-foreground" : "bg-orange-100 text-orange-950")}>
                    {LETTERS[index]}
                  </span>
                  <span className="min-w-0 flex-1 break-words">{option}</span>
                  {isSelected && <Check className="hidden h-4 w-4 shrink-0 sm:block" aria-hidden />}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-4 rounded-[22px] border-[3px] border-accent-foreground/25 bg-accent-foreground/10 p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-1 text-xs font-extrabold uppercase tracking-[0.1em]">
            <span>{t("demoTryLabel")}</span>
            <span className="font-bold normal-case tracking-normal">{t("demoNoCamera")}</span>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] gap-3">
            <div
              className="aspect-square overflow-hidden rounded-[16px] border-2 border-blue-300/50 bg-blue-900 bg-[image:url('/landing/gesture-hands.webp')] bg-[length:200%_200%]"
              style={{ backgroundPosition: `${(selected % 2) * 100}% ${Math.floor(selected / 2) * 100}%` }}
              aria-hidden="true"
            >
            </div>
            <div className="grid grid-cols-2 gap-2">
              {[1, 2, 3, 4].map((count) => {
                const isSelected = selected === count - 1;
                return (
                  <button
                    key={count}
                    type="button"
                    aria-label={t("demoFingerButton", { count })}
                    aria-pressed={isSelected}
                    onClick={() => choose(count - 1)}
                    className={"grid min-h-[72px] cursor-pointer place-items-center rounded-[15px] border-[3px] font-heading text-2xl font-bold transition-[transform,background-color,box-shadow] duration-200 hover:-translate-y-0.5 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] active:translate-y-0.5 " +
                      (isSelected
                        ? "border-primary-deep bg-primary text-primary-foreground shadow-[0_4px_0_var(--primary-deep)]"
                        : "border-border bg-card text-foreground shadow-[0_4px_0_var(--accent-deep)]")}
                  >
                    {count}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3 rounded-[16px] bg-card px-4 py-3 text-sm font-extrabold text-foreground">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground">
            <Check className="h-4 w-4" aria-hidden />
          </span>
          <span key={revision} aria-live="polite" className={revision > 0 ? "gesture-lock" : undefined}>
            {t("demoSelected", {
              count: selected + 1,
              letter: LETTERS[selected],
              option: options[selected],
            })}
          </span>
        </div>
      </div>
      <p className="mt-4 text-center text-xs font-bold text-muted-foreground">{t("demoDisclosure")}</p>
    </div>
  );
}
