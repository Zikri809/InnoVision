"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDuration } from "@/lib/format/duration";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  BarChart3,
  Check,
  ChevronRight,
  Eye,
  FileSpreadsheet,
  LockOpen,
  Megaphone,
  MoreVertical,
  RotateCcw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { QuestionInsightsModel } from "@/lib/results/insights";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  DisplayStatus,
  ResultsSessionRow,
} from "@/lib/results/types";

/** Status → chip classes. Tint + text only (no border): status is
 *  information, not a control. Both light and dark variants. */
const STATUS_CLASS: Record<DisplayStatus, string> = {
  abandoned: "bg-destructive/10 text-destructive",
  in_progress: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300",
  flagged: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  completed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
};

/** Status → label accent used on the filter chips' count + row dot. */
const STATUS_DOT: Record<StatusFilter, string> = {
  all: "bg-primary",
  abandoned: "bg-destructive",
  in_progress: "bg-sky-500",
  flagged: "bg-amber-500",
  completed: "bg-emerald-500",
};

/** Advisory chips — borderless tints, light + dark. */
const ADVISORY_CLASS = {
  secondFace: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  lookedAway: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300",
  voice: "bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300",
  headset: "bg-muted text-muted-foreground",
} as const;

type StatusFilter = "all" | DisplayStatus;

function initialsOf(name: string | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
}

/**
 * Per-event integrity timeline for one expanded session row (restored after
 * the i18n rewrite dropped it): face checks with verdict + trigger +
 * replay/too-frequent hints, the camera-unavailable marker, and
 * session-attributable audit rows (unlock / exempt / reset / auto-flags).
 * Data is ALREADY on the row (derive.ts buildIntegrityTimeline) — this only
 * renders it, newest first.
 */
function TimelineEvents({ row, formatTime }: { row: ResultsSessionRow; formatTime: (iso: string | null | undefined) => string }) {
  const t = useTranslations("lecturer.results");
  const events = [...row.integrityTimeline].reverse();
  if (events.length === 0) return null;
  return (
    <ul className="space-y-1" data-testid="integrity-timeline">
      {events.map((ev) => {
        const at = formatTime(new Date(ev.at).toISOString());
        if (ev.kind === "face_check") {
          const hints: string[] = [];
          if (ev.suspectedReplay) hints.push(t("hintReplay"));
          if (ev.tooFrequent) hints.push(t("hintTooFrequent"));
          return (
            <li key={ev.id} className="text-xs font-semibold text-muted-foreground">
              <span className={ev.matched ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}>
                {ev.matched ? t("timelineMatched") : t("timelineMismatch")}
              </span>
              {ev.distance !== null && <span> · {(ev.distance * 100).toFixed(0)}%</span>}
              <span> · {t(`triggers.${ev.trigger}`)}</span>
              <span> · {at}</span>
              {hints.length > 0 && <span className="text-amber-700 dark:text-amber-300"> · {hints.join(" · ")}</span>}
            </li>
          );
        }
        if (ev.kind === "unavailable") {
          return (
            <li key={ev.id} className="text-xs font-semibold text-amber-700 dark:text-amber-300">
              {t("cameraUnavailable")} · {at}
            </li>
          );
        }
        return (
          <li key={ev.id} className="text-xs font-semibold text-muted-foreground">
            {/* Every session-timeline action has a key in BOTH locales
                (auto_flag_focus_loss / auto_flag_verify_silence included —
                0044 routes them onto timelines via the metadata fix). next-intl
                has no defaultMessage: a missing key renders the raw path. */}
            {t(`actions.${ev.action}`)}
          </li>
        );
      })}
    </ul>
  );
}

export function ResultsDashboardClient({
  quizId,
  quizTitle,
  mode,
  status,
  timeLimitSec,
  resultsRevealedAt,
  autoRevealOnComplete,
  totalQuestions,
  unrevealedCompleted,
  rows,
  faceChecksTruncated = false,
  incidentClips = {},
  questionInsights = null,
}: {
  quizId: string;
  quizTitle: string;
  mode: string;
  status: string;
  timeLimitSec: number | null;
  resultsRevealedAt: string | null;
  autoRevealOnComplete: boolean;
  totalQuestions: number;
  /** Completed assessment sessions whose results are still hidden (QC-2 close-dialog warning). */
  unrevealedCompleted: number;
  rows: ResultsSessionRow[];
  /**
   * True when the face_checks read hit its cap (RESULTS_AUDIT_LIMIT): the
   * per-row summaries/timelines are newest-wins slices, so the dashboard
   * must say so instead of showing a missing line as "no face checks".
   */
  faceChecksTruncated?: boolean;
  /** Signed (1h) playback URLs per session — empty for clean sessions. */
  incidentClips?: Record<
    string,
    { id: string; url: string; reason: string; durationMs: number; recordedFrom: string | null }[]
  >;
  /** RA-2: on-screen item analysis (separate prop type — ResultsSessionRow must never widen with key fields). */
  questionInsights?: QuestionInsightsModel | null;
}) {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("lecturer.results");
  const tBuilder = useTranslations("lecturer.builder");
  const tCommon = useTranslations("common");


  function getStatusLabel(st: DisplayStatus): string {
    switch (st) {
      case "completed":
        return t("statCompleted");
      case "flagged":
        return t("statFlagged");
      case "abandoned":
        return t("statAbandoned");
      case "in_progress":
        return t("statInProgress");
      default:
        return st;
    }
  }

  function formatTime(iso: string | null | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const tf = new Intl.DateTimeFormat(locale === "ms" ? "ms-MY" : "en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "Asia/Kuala_Lumpur",
    });
    return tf.format(d);
  }

  const [busyRows, setBusyRows] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Mobile-first status filter — the stat strip doubles as the filter.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const [exemptRow, setExemptRow] = useState<string | null>(null);
  const [exemptReason, setExemptReason] = useState("");

  const [resetRow, setResetRow] = useState<string | null>(null);
  const [resetCooled, setResetCooled] = useState(false);

  const [revealOpen, setRevealOpen] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Close flow (QC-1/QC-2): dialog + cool-down + reveal-first CTA when
  // completed sessions exist whose results are still hidden.
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeCooled, setCloseCooled] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  function pickFilename(res: Response): string {
    // Blob URLs ignore Content-Disposition — mirror its filename explicitly.
    const disposition = res.headers.get("content-disposition") ?? "";
    const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    if (utf8) {
      try {
        return decodeURIComponent(utf8[1]);
      } catch {
        /* fall through */
      }
    }
    const plain = /filename="([^"]+)"/i.exec(disposition);
    return plain?.[1] ?? "quiz-results.xlsx";
  }

  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch(`/api/quizzes/${quizId}/export`);
      if (!res.ok) {
        setExportError(t("exportError"));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = pickFilename(res);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportError(t("exportError"));
    } finally {
      setExporting(false);
    }
  }

  const isAssessment = mode === "assessment";
  const revealed = resultsRevealedAt != null;

  async function handleReveal() {
    if (revealing) return;
    setRevealing(true);
    setRevealError(null);
    try {
      const res = await fetch(`/api/quizzes/${quizId}/reveal`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRevealError(body.message ?? body.error ?? tCommon("errorGeneric"));
        return;
      }
      setRevealOpen(false);
      router.refresh();
    } catch {
      setRevealError(tCommon("errorGeneric"));
    } finally {
      setRevealing(false);
    }
  }

  async function handleCloseQuiz() {
    if (closing) return;
    // Cool-down guard (reset-dialog pattern): one attempt per open.
    setCloseCooled(true);
    setClosing(true);
    setCloseError(null);
    try {
      const res = await fetch(`/api/quizzes/${quizId}/close`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCloseError(body.message ?? body.error ?? tCommon("errorGeneric"));
        return;
      }
      setCloseOpen(false);
      router.refresh();
    } catch {
      setCloseError(tCommon("errorGeneric"));
    } finally {
      setClosing(false);
    }
  }

  /** QC-2 prevention CTA. audit-3 H3-ATOM-F5: CLOSE first, then reveal.
   * Closing blocks new starts and hard-stops answering, so the follow-up
   * reveal can never expose correctness to an in-flight student, and a failed
   * close aborts before the irreversible reveal (the old reveal-then-close
   * order could strand a revealed+live quiz). Both calls stay idempotent, so
   * a partial sequence is retryable from the same dialog. */
  async function handleRevealThenClose() {
    if (closing || revealing) return;
    setCloseCooled(true);
    setClosing(true);
    setCloseError(null);
    try {
      const closeRes = await fetch(`/api/quizzes/${quizId}/close`, {
        method: "POST",
      });
      if (!closeRes.ok) {
        const body = await closeRes.json().catch(() => ({}));
        setCloseError(body.message ?? body.error ?? tCommon("errorGeneric"));
        return;
      }
      const revealRes = await fetch(`/api/quizzes/${quizId}/reveal`, {
        method: "POST",
      });
      if (!revealRes.ok) {
        const body = await revealRes.json().catch(() => ({}));
        // The quiz is closed but results are still hidden — a recoverable
        // state the Reveal button on this dashboard handles.
        setCloseError(body.message ?? body.error ?? tCommon("errorGeneric"));
        return;
      }
      setCloseOpen(false);
      router.refresh();
    } catch {
      setCloseError(tCommon("errorGeneric"));
    } finally {
      setClosing(false);
    }
  }

  const completed = rows.filter((r) => r.displayStatus === "completed").length;
  const flagged = rows.filter((r) => r.displayStatus === "flagged").length;
  const abandoned = rows.filter((r) => r.displayStatus === "abandoned").length;
  const inProgress = rows.filter((r) => r.displayStatus === "in_progress").length;

  const visibleRows =
    statusFilter === "all"
      ? rows
      : rows.filter((r) => r.displayStatus === statusFilter);

  const FILTER_COUNTS: Record<StatusFilter, number> = {
    all: rows.length,
    completed,
    flagged,
    abandoned,
    in_progress: inProgress,
  };

  function setRowError(id: string, msg: string) {
    setRowErrors((prev) => ({ ...prev, [id]: msg }));
  }

  async function runAction(rowId: string, fn: () => Promise<Response>) {
    setBusyRows((prev) => new Set(prev).add(rowId));
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[rowId];
      return next;
    });
    try {
      const res = await fn();
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRowError(rowId, body.message ?? body.error ?? tCommon("errorGeneric"));
        return;
      }
      router.refresh();
    } catch {
      setRowError(rowId, tCommon("errorGeneric"));
    } finally {
      setBusyRows((prev) => {
        const next = new Set(prev);
        next.delete(rowId);
        return next;
      });
    }
  }

  async function handleUnlock(row: ResultsSessionRow) {
    await runAction(row.id, () =>
      fetch("/api/face/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: row.id }),
      }),
    );
  }

  async function handleExempt(row: ResultsSessionRow) {
    if (!exemptReason.trim()) return;
    await runAction(row.id, () =>
      fetch(`/api/sessions/${row.id}/exempt-face`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: exemptReason.trim() }),
      }),
    );
    setExemptRow(null);
    setExemptReason("");
  }

  async function handleReset(row: ResultsSessionRow) {
    setResetCooled(true);
    await runAction(row.id, () =>
      fetch(`/api/sessions/${row.id}/reset`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
      }).then((res) => {
        if (res.status === 404) return new Response(null, { status: 200 });
        return res;
      }),
    );
    setResetRow(null);
  }

  return (
    <div className="space-y-6">
      {/* ── Header (flat on the page background — no hero card) ── */}
      <header className="relative">
        <div className="flex items-center justify-between gap-2">
          <Link
            href={`/lecturer/quizzes/${quizId}/builder`}
            className="inline-flex min-w-0 items-center gap-1 text-sm font-extrabold text-muted-foreground transition-colors hover:text-primary"
          >
            <ArrowLeft className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{t("backToQuizzes")}</span>
          </Link>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={exporting}
            >
              <FileSpreadsheet className="size-4" aria-hidden />
              {/* Icon-only under 420px — the sr-only label keeps the
                  accessible name stable for e2e (e18/e39 target it). */}
              <span className="sr-only min-[420px]:not-sr-only">
                {exporting ? t("exporting") : t("exportButton")}
              </span>
            </Button>
            {status === "live" && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      className="hit-slop"
                      aria-label={t("quizMenu")}
                    >
                      <MoreVertical className="size-4" aria-hidden />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>{t("quizMenu")}</DropdownMenuLabel>
                    {status === "live" && (
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => {
                          setCloseCooled(false);
                          setCloseError(null);
                          setCloseOpen(true);
                        }}
                      >
                        <XCircle className="size-4" aria-hidden />
                        {tBuilder("closeQuiz")}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
        <h1 className="mt-3 font-heading text-[26px] leading-tight font-semibold [text-wrap:balance] sm:text-3xl">
          {quizTitle}
        </h1>
        <p className="mt-1.5 text-sm font-semibold text-muted-foreground">
          {mode === "assessment" ? tCommon("assessment") : tCommon("practice")} · {status === "live" ? tCommon("active") : status === "closed" ? tCommon("closed") : tCommon("draft")}
          {timeLimitSec != null ? ` · ${formatDuration(timeLimitSec, locale)}` : ""} · {tBuilder("questionCount", { count: totalQuestions })}
        </p>

        {/* Stat strip = status filter chips (mobile inbox pattern). Zero-count
            chips are hidden — a filter that yields nothing is dead weight — and
            the strip wraps, so a chip is never clipped by the screen edge. */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setStatusFilter("all")}
            aria-pressed={statusFilter === "all"}
            className={cn(
              "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border-[3px] px-3.5 py-1.5 text-xs font-extrabold transition-all duration-150 active:translate-y-0.5",
              statusFilter === "all"
                ? "border-primary bg-primary text-primary-foreground shadow-[0_3px_0_#c2410c]"
                : "border-border bg-card text-muted-foreground shadow-[0_3px_0_var(--border)] hover:text-foreground",
            )}
          >
            {t("filterAll")}
            <span className={cn("tabular-nums", statusFilter !== "all" && "opacity-70")}>
              {rows.length}
            </span>
          </button>
          {(
            [
              ["completed", "text-emerald-700 dark:text-emerald-300"],
              ["flagged", "text-amber-700 dark:text-amber-300"],
              ["abandoned", "text-destructive"],
              ["in_progress", "text-sky-700 dark:text-sky-300"],
            ] as [Exclude<StatusFilter, "all">, string | null][]
          ).map(([key, tint]) => {
            const count = FILTER_COUNTS[key];
            const active = statusFilter === key;
            if (count === 0 && !active) return null;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setStatusFilter(key)}
                aria-pressed={active}
                className={cn(
                  "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border-[3px] px-3.5 py-1.5 text-xs font-extrabold transition-all duration-150 active:translate-y-0.5",
                  active
                    ? "border-primary bg-primary text-primary-foreground shadow-[0_3px_0_#c2410c]"
                    : "border-border bg-card text-muted-foreground shadow-[0_3px_0_var(--border)] hover:text-foreground",
                )}
              >
                {tint && !active && (
                  <span className={cn("size-2 rounded-full", STATUS_DOT[key])} aria-hidden />
                )}
                {getStatusLabel(key)}
                <span className={cn("tabular-nums", !active && "opacity-70")}>{count}</span>
              </button>
            );
          })}
        </div>

        {exportError && (
          <p role="alert" className="mt-3 rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm font-bold text-destructive">
            {exportError}
          </p>
        )}
      </header>

      {isAssessment && status !== "draft" && (
        revealed ? (
          // Revealed state is information, not a panel — one quiet row.
          // Stacks on mobile so the chip never wraps and the caption
          // gets the full line width.
          <div className="flex flex-col items-start gap-1.5 sm:flex-row sm:items-center sm:gap-2.5">
            <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-emerald-100 px-3 py-1 text-xs font-extrabold text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">
              <Check className="size-3.5" aria-hidden />
              {t("revealedTitle")}
            </span>
            <p className="min-w-0 text-sm font-semibold text-muted-foreground">
              {t("revealedSubtitle")}
            </p>
          </div>
        ) : (
          // Unrevealed: the page's one saturated moment — blue clay CTA panel.
          <section
            className="rounded-[22px] border-[3px] border-accent/25 bg-accent/5 p-4 shadow-[var(--shadow-clay-accent)] sm:p-5"
            aria-labelledby="reveal-heading"
          >
            <div className="flex flex-col gap-4">
              <div className="flex min-w-0 items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-accent/15 text-accent">
                  <Megaphone className="size-5" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p id="reveal-heading" className="font-heading text-base font-semibold text-foreground">
                    {t("hiddenTitle")}
                  </p>
                  <p className="mt-0.5 text-sm font-semibold text-muted-foreground">
                    {t("hiddenSubtitle")}
                  </p>
                  {/* Static status line, not a control — auto-release is the
                      configured default; no toggle in the banner. */}
                  {autoRevealOnComplete && (
                    <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">
                      <Check className="size-3" aria-hidden />
                      {t("autoRevealLabel")}
                    </p>
                  )}
                </div>
              </div>
              <Button variant="default" onClick={() => setRevealOpen(true)}>
                {t("revealBtn")}
              </Button>
            </div>
          </section>
        )
      )}
      {isAssessment && status !== "draft" && revealError && (
        <p className="rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm font-bold text-destructive" role="alert">
          {revealError}
        </p>
      )}

      {/* ── RA-2: Question insights — drill-down analytics, its own route
          (/insights) so mobile back gesture returns here. Card is the
          entry point; identical numbers as the Excel export. ── */}
      {questionInsights && questionInsights.questions.length > 0 && (
        <Card>
          <CardHeader>
            <Link
              href={`/lecturer/quizzes/${quizId}/insights`}
              className="flex w-full cursor-pointer items-center justify-between gap-3 text-left"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-muted text-muted-foreground">
                  <BarChart3 className="size-5" aria-hidden />
                </span>
                <span className="min-w-0">
                  <CardTitle>{t("insightsTitle")}</CardTitle>
                  <CardDescription>
                    {questionInsights.hasDegenerate
                      ? t("insightsDegenerateSubtitle")
                      : t("insightsSubtitle")}
                  </CardDescription>
                </span>
              </span>
              <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          </CardHeader>
        </Card>
      )}

      {/* ── Sessions ──
          Mobile: no card chrome — rows are self-contained clay cards under a
          small section label, so the viewport isn't wasted on nested boxes. */}
      <section aria-labelledby="sessions-heading" className="space-y-3">
        <div className="flex flex-col gap-0.5 px-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
          <h2 id="sessions-heading" className="font-heading text-lg font-semibold">
            {t("attendanceTitle")}
          </h2>
          <p className="text-xs font-bold text-muted-foreground sm:text-sm sm:font-semibold">
            {t("heroSubtitle")}
          </p>
        </div>
        {rows.length === 0 ? (
          <p className="rounded-2xl border-[3px] border-dashed border-border bg-card p-6 text-center text-sm font-semibold text-muted-foreground">
            {t("noSessionsTitle")}
          </p>
        ) : (
          <>
            {faceChecksTruncated && (
              <p
                role="note"
                className="rounded-2xl border-[3px] border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
              >
                {t("faceChecksTruncated")}
              </p>
            )}
            <ul className="space-y-3">
              {visibleRows.map((row) => (
                <li
                  key={row.id}
                  className="rounded-[22px] border-[3px] border-border bg-card p-4 shadow-[var(--shadow-clay-sm)]"
                >
                  <div className="flex items-center gap-3">
                    {/* Initials disc — scan anchor for the class list. */}
                    <span
                      aria-hidden
                      className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 font-heading text-sm font-semibold text-primary"
                    >
                      {initialsOf(row.studentName)}
                    </span>
                    <button
                      type="button"
                      translate="no"
                      className="min-w-0 flex-1 cursor-pointer truncate text-left font-heading text-base font-semibold hover:text-primary hover:underline"
                      onClick={() => setExpanded((p) => ({ ...p, [row.id]: !p[row.id] }))}
                      aria-expanded={Boolean(expanded[row.id])}
                    >
                      {row.studentName ?? t("tableHeaderStudent")}
                    </button>
                    {/* Score — fixed top-right slot, the number lecturers scan for. */}
                    <span className="shrink-0 font-heading text-lg font-semibold tabular-nums">
                      {row.score === null ? "—" : `${row.score}`}<span className="text-sm font-bold text-muted-foreground"> / {row.total}</span>
                    </span>
                  </div>

                  {/* Status + time — full-width line under the identity row.
                      It wraps instead of truncating, so submission times are
                      never cut off on narrow screens. */}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-[52px]">
                    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-2xs font-extrabold ${STATUS_CLASS[row.displayStatus]}`}>
                      <span className={cn("size-1.5 rounded-full", STATUS_DOT[row.displayStatus])} aria-hidden />
                      {getStatusLabel(row.displayStatus)}
                    </span>
                    {row.face_exempt && (
                      <span className="inline-flex shrink-0 items-center rounded-full border-2 border-sky-500/40 bg-sky-500/10 px-2.5 py-0.5 text-2xs font-extrabold text-sky-700 dark:text-sky-300">
                        {t("exemptChip")}
                      </span>
                    )}
                    <p className="min-w-0 text-xs font-semibold text-muted-foreground">
                      {t("startedAt", { time: formatTime(row.started_at) })}
                      {row.submitted_at ? ` · ${t("submittedAt", { time: formatTime(row.submitted_at) })}` : ""}
                    </p>
                  </div>

                  {(row.faceSummary.lastAt != null || (row.focus_pause_count ?? 0) > 0 || (row.fullscreen_pause_count ?? 0) > 0 || (row.hand_pause_count ?? 0) > 0 || row.face_unavailable_at) && (
                    <div className="mt-2 space-y-0.5 pl-[52px]">
                      {row.faceSummary.lastAt != null && (
                        <p className="text-xs font-semibold text-muted-foreground">
                          {t("faceChecksSummary", { fails: row.faceSummary.fails, replays: row.faceSummary.replays })}
                          {" · "}
                          {t("lastActivity", { time: formatTime(new Date(row.faceSummary.lastAt).toISOString()) })}
                        </p>
                      )}
                      {(row.focus_pause_count ?? 0) > 0 && (
                        <p className="text-xs font-semibold text-muted-foreground">
                          {t("focusPauses", { count: row.focus_pause_count ?? 0 })}
                        </p>
                      )}
                      {(row.fullscreen_pause_count ?? 0) > 0 && (
                        <p className="text-xs font-semibold text-muted-foreground">
                          {t("fullscreenPauses", { count: row.fullscreen_pause_count ?? 0 })}
                        </p>
                      )}
                      {(row.hand_pause_count ?? 0) > 0 && (
                        <p className="text-xs font-semibold text-muted-foreground">
                          {t("handPauses", { count: row.hand_pause_count ?? 0 })}
                        </p>
                      )}
                      {row.face_unavailable_at && (
                        <p className="text-xs font-semibold text-muted-foreground">
                          {t("cameraUnavailable")} ({formatTime(row.face_unavailable_at)})
                        </p>
                      )}
                    </div>
                  )}

                  {(row.advisorySummary.secondFace > 0 ||
                    row.advisorySummary.lookedAway > 0 ||
                    row.advisorySummary.voiceActivity > 0 ||
                    row.advisorySummary.headsetActive > 0 ||
                    (row.attempt ?? 1) > 1) && (
                    <div className="mt-2 flex flex-wrap gap-1.5 pl-[52px]">
                      {row.advisorySummary.secondFace > 0 && (
                        <span className={`rounded-full px-2 py-0.5 text-2xs font-extrabold ${ADVISORY_CLASS.secondFace}`}>
                          {t("advisorySecondFace", { count: row.advisorySummary.secondFace })}
                        </span>
                      )}
                      {row.advisorySummary.lookedAway > 0 && (
                        <span className={`rounded-full px-2 py-0.5 text-2xs font-extrabold ${ADVISORY_CLASS.lookedAway}`}>
                          {t("advisoryLookedAway", { count: row.advisorySummary.lookedAway })}
                        </span>
                      )}
                      {row.advisorySummary.voiceActivity > 0 && (
                        <span className={`rounded-full px-2 py-0.5 text-2xs font-extrabold ${ADVISORY_CLASS.voice}`}>
                          {t("advisoryVoice", { count: row.advisorySummary.voiceActivity })}
                        </span>
                      )}
                      {row.advisorySummary.headsetActive > 0 && (
                        <span className={`rounded-full px-2 py-0.5 text-2xs font-extrabold ${ADVISORY_CLASS.headset}`}>
                          {t("advisoryHeadset")}
                        </span>
                      )}
                      {(row.attempt ?? 1) > 1 && (
                        <span className={`rounded-full px-2 py-0.5 text-2xs font-extrabold ${ADVISORY_CLASS.headset}`}>
                          {t("attemptChip", { count: row.attempt ?? 1 })}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Row footer: one primary action + overflow for the rare
                      admin actions (exempt/reset/unlock). No free-floating
                      wrap-flex of mixed chips and buttons. */}
                  <div className="mt-3 flex items-center justify-between gap-2 border-t-2 border-border/60 pt-3">
                    <Link
                      href={`/lecturer/quizzes/${row.quiz_id}/results/${row.id}`}
                      className="inline-flex items-center gap-1.5 rounded-full border-2 border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-extrabold text-primary transition-colors hover:bg-primary hover:text-primary-foreground"
                      aria-label={`View answers - ${row.studentName ?? "Student"}`}
                    >
                      <Eye className="size-3.5" aria-hidden />
                      {locale === "ms" ? "Lihat Jawapan" : "View Answers"}
                    </Link>
                    {row.mode === "assessment" && (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="hit-slop text-muted-foreground"
                              aria-label={`${t("actionsMenu")} - ${row.studentName ?? "Student"}`}
                            >
                              <MoreVertical className="size-4" aria-hidden />
                            </Button>
                          }
                        />
                        <DropdownMenuContent align="end">
                          <DropdownMenuGroup>
                            <DropdownMenuLabel>{t("actionsMenu")}</DropdownMenuLabel>
                            {row.displayStatus === "flagged" && (
                              <DropdownMenuItem disabled={busyRows.has(row.id)} onClick={() => void handleUnlock(row)}>
                                <LockOpen className="size-4" aria-hidden />
                                {busyRows.has(row.id) ? tCommon("loading") : t("unlockBtn")}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem disabled={busyRows.has(row.id)} onClick={() => setExemptRow(row.id)}>
                              <ShieldCheck className="size-4" aria-hidden />
                              {t("exemptBtn")}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={busyRows.has(row.id)}
                              onClick={() => { setResetRow(row.id); setResetCooled(false); }}
                            >
                              <RotateCcw className="size-4" aria-hidden />
                              {t("resetBtn")}
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>

                  {expanded[row.id] && row.integrityTimeline.length > 0 && (
                    <div className="mt-3 border-t-2 border-border/60 pt-2">
                      <p className="mb-1 text-xs font-extrabold uppercase tracking-wide text-muted-foreground">
                        {t("timelineTitle")}
                      </p>
                      <TimelineEvents row={row} formatTime={formatTime} />
                    </div>
                  )}

                  {(incidentClips[row.id]?.length ?? 0) > 0 && expanded[row.id] && (
                    <div className="mt-3 space-y-2">
                      <p className="text-xs font-extrabold uppercase tracking-wide text-muted-foreground">
                        {t("incidentClipsTitle")}
                      </p>
                      {incidentClips[row.id]!.map((clip) => (
                        <div key={clip.id} className="rounded-2xl border-[3px] border-border bg-muted/40 p-2.5">
                          <p className="text-xs font-semibold text-muted-foreground">
                            {t("incidentClipMeta", {
                              reason: clip.reason,
                              sec: Math.round(clip.durationMs / 1000),
                              time: formatTime(clip.recordedFrom),
                            })}
                          </p>
                          <video
                            controls
                            preload="none"
                            src={clip.url}
                            className="mt-1.5 max-h-72 w-full rounded-xl bg-black"
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  {rowErrors[row.id] && (
                    <p className="mt-3 rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm font-bold text-destructive" role="alert">
                      {rowErrors[row.id]}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* Face-exempt dialog */}
      <Dialog open={exemptRow !== null} onOpenChange={(open) => { if (!open) { setExemptRow(null); setExemptReason(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("exemptBtn")}</DialogTitle>
            <DialogDescription>
              {t("exemptConfirm", {
                name: rows.find((r) => r.id === exemptRow)?.studentName ?? "—",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="exempt-reason" className="sr-only">
              {t("exemptReasonLabel")}
            </Label>
            <Input
              id="exempt-reason"
              placeholder={t("exemptReasonPlaceholder")}
              value={exemptReason}
              onChange={(e) => setExemptReason(e.target.value)}
              maxLength={500}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setExemptRow(null); setExemptReason(""); }}>
              {tCommon("cancel")}
            </Button>
            <Button
              disabled={!exemptReason.trim() || busyRows.has(exemptRow ?? '')}
              onClick={() => {
                const row = rows.find((r) => r.id === exemptRow);
                if (row) void handleExempt(row);
              }}
            >
              {t("exemptBtn")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset confirm dialog */}
      <Dialog open={resetRow !== null} onOpenChange={(open) => { if (!open) { setResetRow(null); setResetCooled(false); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("resetBtn")}</DialogTitle>
            <DialogDescription>
              {t("resetConfirm", {
                name: rows.find((r) => r.id === resetRow)?.studentName ?? "—",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setResetRow(null); setResetCooled(false); }}>
              {tCommon("cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={resetCooled || busyRows.has(resetRow ?? '')}
              onClick={() => {
                const row = rows.find((r) => r.id === resetRow);
                if (row) void handleReset(row);
              }}
            >
              {busyRows.has(resetRow ?? '') ? tCommon("loading") : t("resetBtn")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reveal confirm dialog */}
      <Dialog open={revealOpen} onOpenChange={(open) => { if (!open) setRevealOpen(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("revealBtn")}</DialogTitle>
            <DialogDescription>
              {t("revealedSubtitle")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevealOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button variant="default" disabled={revealing} onClick={() => void handleReveal()}>
              {revealing ? tCommon("loading") : t("revealBtn")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Close confirm dialog (QC-1/QC-2) — with reveal-first CTA when
          completed-but-unrevealed sessions exist. */}
      <Dialog
        open={closeOpen}
        onOpenChange={(open) => {
          if (!open) {
            setCloseOpen(false);
            setCloseCooled(false);
            setCloseError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tBuilder("closeConfirmTitle")}</DialogTitle>
            <DialogDescription>{tBuilder("closeConfirmBody")}</DialogDescription>
          </DialogHeader>
          {unrevealedCompleted > 0 && (
            <p
              role="status"
              className="rounded-2xl border-[3px] border-amber-400/50 bg-amber-100/70 px-4 py-3 text-sm font-bold text-amber-950 dark:border-amber-600/40 dark:bg-amber-950/40 dark:text-amber-200"
            >
              {tBuilder("closeUnrevealedWarn", { count: unrevealedCompleted })}
            </p>
          )}
          {closeError && (
            <p
              role="alert"
              className="rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm font-bold text-destructive"
            >
              {closeError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCloseOpen(false);
                setCloseCooled(false);
                setCloseError(null);
              }}
            >
              {tCommon("cancel")}
            </Button>
            {unrevealedCompleted > 0 && (
              <Button
                variant="default"
                disabled={closeCooled || closing || revealing}
                onClick={() => void handleRevealThenClose()}
              >
                {closing || revealing ? tCommon("loading") : tBuilder("revealFirstThenClose")}
              </Button>
            )}
            <Button
              variant="destructive"
              disabled={closeCooled || closing}
              onClick={() => void handleCloseQuiz()}
            >
              {closing ? tBuilder("closing") : unrevealedCompleted > 0 ? tBuilder("closeAnyway") : tBuilder("closeQuiz")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
