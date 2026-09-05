"use client";

import { useTranslations } from "next-intl";

/** Time (ms) below which the remaining-time display turns red. Exported as
 * the AX-3 assertive-milestone twin (timer-milestones.ts asserts equality). */
export const WARNING_THRESHOLD_MS = 30_000;

/**
 * "Question n/N" + time remaining as a chunky clay progress bar. Time is
 * formatted mm:ss from a monotonic countdown seeded server-side.
 *
 * Two variants (mobile redesign plan W3):
 *  - "block" (desktop): the w-44 sidebar block, title row + bar.
 *  - "strip" (mobile): compact two-row sticky-header strip — the timer chip
 *    markup is IDENTICAL (role="timer", aria-live="off", tabular-nums,
 *    destructive classes) and stays the FIRST span.tabular-nums in DOM order
 *    (e10 selects it with .first()); the n/N counter deliberately does NOT
 *    carry tabular-nums.
 */
export function ProgressHud({
  current,
  total,
  remainingMs,
  camStatus = null,
  variant = "block",
}: {
  current: number;
  total: number;
  remainingMs: number | null;
  camStatus?: "aligned" | "reposition" | null;
  variant?: "block" | "strip";
}) {
  const t = useTranslations("play.hud");
  const pct = total <= 0 ? 0 : Math.min(100, Math.round((current / total) * 100));

  function formatMs(ms: number): string {
    if (ms <= 0) return "0:00";
    const totalSec = Math.ceil(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  const warning = remainingMs !== null && remainingMs <= WARNING_THRESHOLD_MS;

  const camDot = camStatus && (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full transition-colors duration-300 ${
        camStatus === "aligned" ? "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.7)]" : "bg-amber-400 animate-pulse"
      }`}
      title={camStatus === "aligned" ? t("camAligned") : t("camReposition")}
      role="status"
      aria-label={camStatus === "aligned" ? t("camAligned") : t("camReposition")}
    />
  );

  const timerChip =
    remainingMs !== null && (
      <span
        // AX-3: role="timer" with explicit aria-live="off" — the ticking
        // value must NEVER be announced per-second (face-verifier.tsx:69
        // precedent); discrete milestones fire via the sibling announcer.
        role="timer"
        aria-live="off"
        aria-label={t("timeRemaining")}
        className={
          warning
            ? "rounded-lg bg-destructive/15 px-2 py-0.5 tabular-nums text-red-700 dark:text-destructive"
            : "rounded-lg bg-muted px-2 py-0.5 tabular-nums text-muted-foreground"
        }
      >
        {formatMs(remainingMs)}
      </span>
    );

  if (variant === "strip") {
    return (
      <div className="w-full space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 font-heading text-base font-semibold text-foreground">
            {t("questionOf", { current: Math.min(current, total), total })}
            {camDot}
          </span>
          {timerChip}
        </div>
        <div className="h-2.5 w-full overflow-hidden rounded-full border-[3px] border-border bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="w-44 sm:w-48 space-y-2">
      <div className="flex items-center justify-between text-sm font-extrabold">
        <span className="text-foreground flex items-center gap-1.5">
          {t("questionOf", { current: Math.min(current, total), total })}
          {camDot}
        </span>
        {timerChip}
      </div>
      <div className="h-3 w-full overflow-hidden rounded-full border-[3px] border-border bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
