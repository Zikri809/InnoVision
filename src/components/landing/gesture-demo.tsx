"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Hand, ScanFace } from "lucide-react";

const OPTIONS = ["Stack", "Queue", "Tree", "Graph"] as const;
const TARGET = 1; // "Queue" — the answer the auto-play locks in.

/** Hand hover spots, one per option slot (percent of the options box). */
const POS = [
  { left: "7%", top: "26%" },
  { left: "52%", top: "26%" },
  { left: "7%", top: "64%" },
  { left: "52%", top: "64%" },
];
const SCAN_POS = { left: "30%", top: "-12%" };

export function GestureDemo() {
  const t = useTranslations("landing");
  const [locked, setLocked] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const hoveredRef = useRef<number | null>(null);

  // Auto-play: scan → lock "Queue" → hold → reset, forever. Hover is
  // honoured first: every scheduled write is skipped while a finger is
  // on an option, so the visitor's hand steers instead of the demo's.
  useEffect(() => {
    let cancelled = false;
    const timers: number[] = [];
    const later = (fn: () => void, ms: number) => {
      timers.push(window.setTimeout(fn, ms));
    };
    const cycle = () => {
      if (cancelled) return;
      setLocked(null);
      later(() => {
        if (!cancelled && hoveredRef.current === null) setLocked(TARGET);
      }, 2100);
      later(() => {
        if (!cancelled && hoveredRef.current === null) cycle();
      }, 6800);
    };
    cycle();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, []);

  // Pinning: park the pointer on an option and the hand drifts over,
  // then the answer stamps in — the real product's lock-in moment.
  useEffect(() => {
    hoveredRef.current = hovered;
    if (hovered === null) return;
    const timer = window.setTimeout(() => setLocked(hovered), 650);
    return () => clearTimeout(timer);
  }, [hovered]);

  const overAnOption = hovered !== null || locked !== null;
  const spot = hovered ?? locked ?? null;
  const handPos = spot !== null ? POS[spot] : SCAN_POS;

  return (
    <div className="clay-card relative p-3 text-left" style={{ boxShadow: "var(--shadow-clay), var(--shadow-clay-in)" }}>
      {/* window chrome */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex gap-1.5" aria-hidden>
          {[true, true, true, false, false, false].map((on, i) => (
            <span key={i} className={`h-2.5 w-7 rounded-full transition-colors duration-500 ${on ? "bg-primary" : "bg-muted"}`} />
          ))}
        </div>
        {/* The mock reads as a screenshot of the quiz UI, so its ink is pinned
            to fixed dark values instead of theme-flipping tokens — text-primary
            (#fb923c) on cream is 2.1:1, invisible in dark mode. */}
        <span className="font-heading text-sm font-semibold text-orange-700 dark:text-primary">{t("demoProgress")}</span>
      </div>

      <div className="m-2 rounded-[20px] border-[3px] border-border bg-gradient-to-b from-orange-50 to-orange-100 p-5 md:p-6">
        <div className="font-heading text-sm font-semibold tracking-wide text-orange-700">{t("demoBadge")}</div>
        <div className="mt-2 min-h-14 font-heading text-lg font-semibold text-orange-950 md:text-xl [text-wrap:balance]">
          {t("demoQ")}
        </div>

        {/* options + roaming hand */}
        <div className="relative mt-5">
          <div
            aria-hidden
            className="pointer-events-none absolute z-10 transition-all duration-700 ease-out"
            style={{ left: handPos.left, top: handPos.top }}
          >
            <span
              className={`inline-grid h-12 w-12 place-items-center rounded-2xl border-[3px] border-border bg-card shadow-[0_4px_0_var(--border)] ${
                overAnOption ? "" : "landing-wave"
              }`}
            >
              <Hand className={`h-6 w-6 ${locked !== null ? "text-green-600" : "text-primary"}`} />
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {OPTIONS.map((opt, i) => {
              const isLocked = locked === i;
              const isHovered = hovered === i && !isLocked;
              return (
                <button
                  key={opt}
                  type="button"
                  onMouseEnter={() => setHovered(i)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(i)}
                  onBlur={() => setHovered(null)}
                  onClick={() => {
                    setHovered(i);
                    setLocked(i);
                  }}
                  className={`flex cursor-pointer items-center gap-3 rounded-2xl border-[3px] px-4 py-3.5 text-left font-extrabold transition-[border-color,background-color,color,box-shadow] duration-300 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] ${
                    isLocked
                      ? "border-accent bg-blue-50 text-blue-600 shadow-[0_4px_0_#bfdbfe]"
                      : isHovered
                        ? "border-primary bg-orange-50 text-orange-700 shadow-[0_4px_0_rgba(249,115,22,0.25)]"
                        : "border-border bg-card text-muted-foreground shadow-[0_4px_0_var(--border)]"
                  }`}
                >
                  <span
                    className={`grid h-9 w-9 shrink-0 place-items-center rounded-[11px] font-heading font-semibold ${
                      isLocked ? "bg-accent text-accent-foreground" : isHovered ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
                    }`}
                  >
                    {isLocked ? <Check className="h-5 w-5 landing-stamp" aria-hidden /> : String.fromCharCode(65 + i)}
                  </span>
                  <span>{opt}</span>
                </button>
              );
            })}
          </div>

          <span className="mt-3 hidden text-xs font-bold text-orange-700 lg:block">{t("demoHoverHint")}</span>
        </div>
      </div>

      {/* status bar: identity check crossfade + lock-in callout */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 pb-2 pt-3 text-sm font-bold text-muted-foreground">
        <span className="relative inline-grid h-7 items-center overflow-hidden align-middle">
          <span className="landing-face-a inline-flex items-center gap-1.5">
            <ScanFace className="h-4 w-4 text-green-600" aria-hidden />
            {t("demoFaceA")}
          </span>
          <span className="landing-face-b absolute inset-0 inline-flex items-center gap-1.5">
            <ScanFace className="h-4 w-4 text-green-600" aria-hidden />
            {t("demoFaceB")}
          </span>
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-full bg-green-200 text-green-700">
            <Check className="h-3.5 w-3.5" aria-hidden />
          </span>
          {t("demoWave")}
        </span>
      </div>
    </div>
  );
}
