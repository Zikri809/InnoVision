"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDuration } from "@/lib/format/duration";
import { ArrowLeft, BarChart3, Check, ChevronDown, FileSpreadsheet, Megaphone } from "lucide-react";
import type { QuestionInsightsModel } from "@/lib/results/insights";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

const STATUS_CLASS: Record<DisplayStatus, string> = {
  abandoned: "border-destructive/40 bg-destructive/10 text-destructive",
  in_progress: "border-sky-300 bg-sky-100 text-sky-800",
  flagged: "border-amber-300 bg-amber-100 text-amber-800",
  completed: "border-emerald-300 bg-emerald-100 text-emerald-800",
};

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
  incidentClips = {},
  questionInsights = null,
  insightsTruncated = false,
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
  /** Signed (1h) playback URLs per session — empty for clean sessions. */
  incidentClips?: Record<
    string,
    { id: string; url: string; reason: string; durationMs: number; recordedFrom: string | null }[]
  >;
  /** RA-2: on-screen item analysis (separate prop type — ResultsSessionRow must never widen with key fields). */
  questionInsights?: QuestionInsightsModel | null;
  /** RA-2: the answers read hit its 20k cap — percentages may under-report. */
  insightsTruncated?: boolean;
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
  // RA-2: the "Question insights" section starts collapsed (rows are the
  // primary surface; insights are a drill-down).
  const [insightsOpen, setInsightsOpen] = useState(false);

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

  /** QC-2 prevention CTA: reveal (idempotent), then close (CAS) — both
   * safe in either order, so a partial sequence never strands results. */
  async function handleRevealThenClose() {
    if (closing || revealing) return;
    setCloseCooled(true);
    setClosing(true);
    setCloseError(null);
    try {
      const revealRes = await fetch(`/api/quizzes/${quizId}/reveal`, {
        method: "POST",
      });
      if (!revealRes.ok) {
        const body = await revealRes.json().catch(() => ({}));
        setCloseError(body.message ?? body.error ?? tCommon("errorGeneric"));
        return;
      }
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

  const completed = rows.filter((r) => r.displayStatus === "completed").length;
  const flagged = rows.filter((r) => r.displayStatus === "flagged").length;
  const abandoned = rows.filter((r) => r.displayStatus === "abandoned").length;
  const inProgress = rows.filter((r) => r.displayStatus === "in_progress").length;

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
      {/* ── Hero band ── */}
      <section className="relative overflow-hidden rounded-[28px] border-[3px] border-border bg-gradient-to-br from-orange-100 via-orange-50 to-blue-50 dark:from-orange-950/40 dark:via-card dark:to-blue-950/40 p-7 shadow-[var(--shadow-clay)] md:p-8">
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-36 w-36 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/50 dark:bg-white/5" />
        <div className="relative">
          <div className="flex items-start justify-between gap-3">
            <Link
              href={`/lecturer/quizzes/${quizId}/builder`}
              className="inline-flex items-center gap-1.5 text-sm font-extrabold text-muted-foreground transition-colors hover:text-primary"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden /> {t("backToQuizzes")}
            </Link>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleExport}
                disabled={exporting}
              >
                <FileSpreadsheet className="h-4 w-4" aria-hidden />
                {exporting ? t("exporting") : t("exportButton")}
              </Button>
              {status === "live" && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    setCloseCooled(false);
                    setCloseError(null);
                    setCloseOpen(true);
                  }}
                  disabled={closing}
                >
                  {closing ? tBuilder("closing") : tBuilder("closeQuiz")}
                </Button>
              )}
            </div>
          </div>
          <h1 className="mt-3 font-heading text-3xl font-semibold [text-wrap:balance]">{quizTitle}</h1>
          <p className="mt-2 text-sm font-semibold text-muted-foreground">
            {mode === "assessment" ? tCommon("assessment") : tCommon("practice")} · {status === "live" ? tCommon("active") : status === "closed" ? tCommon("closed") : tCommon("draft")}
            {timeLimitSec != null ? ` · ${formatDuration(timeLimitSec, locale)}` : ""} · {tBuilder("questionCount", { count: totalQuestions })}
          </p>


          {/* summary stat tiles */}
          <div className="mt-6 grid max-w-2xl grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-2xl border-[3px] border-border bg-card px-4 py-3.5 shadow-[var(--shadow-clay-sm)]">
              <span className="font-heading text-2xl font-bold text-emerald-600">{completed}</span>
              <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">{t("statCompleted")}</p>
            </div>
            <div className="rounded-2xl border-[3px] border-border bg-card px-4 py-3.5 shadow-[var(--shadow-clay-sm)]">
              <span className="font-heading text-2xl font-bold text-amber-600">{flagged}</span>
              <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">{t("statFlagged")}</p>
            </div>
            <div className="rounded-2xl border-[3px] border-border bg-card px-4 py-3.5 shadow-[var(--shadow-clay-sm)]">
              <span className="font-heading text-2xl font-bold text-destructive">{abandoned}</span>
              <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">{t("statAbandoned")}</p>
            </div>
            <div className="rounded-2xl border-[3px] border-border bg-card px-4 py-3.5 shadow-[var(--shadow-clay-sm)]">
              <span className="font-heading text-2xl font-bold text-sky-600">{inProgress}</span>
              <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">{t("statInProgress")}</p>
            </div>
          </div>

          {exportError && (
            <p role="alert" className="mt-4 rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm font-bold text-destructive">
              {exportError}
            </p>
          )}
        </div>
      </section>

      {isAssessment && status !== "draft" && (
        <Card className="mb-6">
          <CardContent>
            {revealed ? (
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center gap-2 rounded-full border-[3px] border-emerald-300 bg-emerald-100 px-3.5 py-1 text-xs font-extrabold text-emerald-800">
                  <Check className="size-3.5" aria-hidden />
                  {t("revealedTitle")}
                </span>
                <p className="text-sm font-semibold text-muted-foreground">
                  {t("revealedSubtitle")}
                </p>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary">
                    <Megaphone className="size-5" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <p className="font-heading text-base font-semibold">{t("hiddenTitle")}</p>
                    <p className="mt-0.5 text-sm font-semibold text-muted-foreground">
                      {t("hiddenSubtitle")}
                    </p>
                    {/* Static status line, not a control — auto-release is the
                        configured default; no toggle in the banner. */}
                    {autoRevealOnComplete && (
                      <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border-[2px] border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-700">
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
            )}
            {revealError && (
              <p className="mt-3 rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm font-bold text-destructive" role="alert">
                {revealError}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── RA-2: Question insights (collapsible item analysis) ── */}
      {questionInsights && questionInsights.questions.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <button
              type="button"
              className="flex w-full cursor-pointer items-center justify-between gap-3 text-left"
              onClick={() => setInsightsOpen((p) => !p)}
              aria-expanded={insightsOpen}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-violet-100 text-violet-700">
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
              <ChevronDown
                className={`size-5 shrink-0 text-muted-foreground transition-transform duration-200 ${insightsOpen ? "rotate-180" : ""}`}
                aria-hidden
              />
            </button>
          </CardHeader>
          {insightsOpen && (
            <CardContent>
              {insightsTruncated && (
                <p role="status" className="mb-3 rounded-xl border-[3px] border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-bold text-amber-800">
                  {t("insightsTruncated")}
                </p>
              )}
              <ul className="space-y-3">
                {questionInsights.questions.map((qi) => {
                  const degenerate = qi.lowCorrect || qi.hasNeverPickedDistractor;
                  return (
                    <li
                      key={qi.index}
                      className={`rounded-[22px] border-2 bg-card p-4 shadow-[var(--shadow-clay-sm)] ${
                        degenerate ? "border-amber-300" : "border-border"
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2.5">
                        <p className="min-w-0 font-heading text-sm font-bold text-foreground">
                          <span className="text-muted-foreground">Q{qi.index}.</span> {qi.prompt}
                        </p>
                        <div className="flex shrink-0 items-center gap-2">
                          {qi.lowCorrect && (
                            <span className="rounded-full border-2 border-amber-300 bg-amber-50 px-2.5 py-0.5 text-2xs font-extrabold uppercase tracking-wide text-amber-800">
                              {t("insightsLowCorrect", { percent: qi.percentCorrect })}
                            </span>
                          )}
                          {qi.hasNeverPickedDistractor && (
                            <span className="rounded-full border-2 border-sky-300 bg-sky-50 px-2.5 py-0.5 text-2xs font-extrabold uppercase tracking-wide text-sky-800">
                              {t("insightsNeverPicked")}
                            </span>
                          )}
                          <span className="rounded-full border-2 border-border bg-muted px-2.5 py-0.5 text-2xs font-extrabold tabular-nums text-muted-foreground">
                            {t("insightsCorrectStat", { percent: qi.percentCorrect, answered: qi.timesAnswered })}
                          </span>
                        </div>
                      </div>
                      {/* Per-option pick distribution — inline bars, no chart lib. */}
                      <ul className="mt-3 space-y-1.5">
                        {qi.distribution.map((d) => {
                          const onKey =
                            qi.correctIndices?.includes(d.optionIndex) ??
                            qi.correctIndex === d.optionIndex;
                          return (
                            <li key={d.optionIndex} className="flex items-center gap-2.5 text-xs font-semibold">
                              <span
                                className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-2xs font-extrabold ${
                                  onKey
                                    ? "bg-emerald-600 text-white"
                                    : "border border-border bg-muted text-muted-foreground"
                                }`}
                              >
                                {String.fromCharCode(65 + d.optionIndex)}
                              </span>
                              <span className="min-w-[70px] max-w-[200px] truncate text-muted-foreground" title={qi.options[d.optionIndex]}>
                                {qi.options[d.optionIndex]}
                              </span>
                              <span className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                                <span
                                  className={`block h-full rounded-full ${onKey ? "bg-emerald-500" : "bg-sky-400"}`}
                                  style={{ width: `${Math.min(100, d.chosenPercent)}%` }}
                                />
                              </span>
                              <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                                {t("insightsPickStat", { percent: d.chosenPercent, count: d.chosenCount })}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          )}
        </Card>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t("attendanceTitle")}</CardTitle>
          <CardDescription>
            {t("heroSubtitle")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="rounded-2xl border-[3px] border-dashed border-border bg-card p-6 text-center text-sm font-semibold text-muted-foreground">
              {t("noSessionsTitle")}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((row) => (
                <li key={row.id}>
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2.5 sm:gap-3 py-3.5">
                    <div className="min-w-0">
                      <button
                        type="button"
                        translate="no"
                        className="block cursor-pointer text-left font-heading text-base font-semibold hover:text-primary hover:underline"
                        onClick={() => setExpanded((p) => ({ ...p, [row.id]: !p[row.id] }))}
                        aria-expanded={Boolean(expanded[row.id])}
                      >
                        {row.studentName ?? t("tableHeaderStudent")}
                      </button>
                      <p className="mt-0.5 text-xs font-semibold text-muted-foreground">
                        {t("startedAt", { time: formatTime(row.started_at) })}
                        {row.submitted_at ? ` · ${t("submittedAt", { time: formatTime(row.submitted_at) })}` : ""}
                      </p>
                      {row.faceSummary.lastAt != null && (
                        <p className="text-xs font-semibold text-muted-foreground">
                          {t("faceChecksSummary", { fails: row.faceSummary.fails, replays: row.faceSummary.replays })}
                        </p>
                      )}
                      {(row.advisorySummary.secondFace > 0 ||
                        row.advisorySummary.lookedAway > 0 ||
                        row.advisorySummary.voiceActivity > 0 ||
                        row.advisorySummary.headsetActive > 0) && (
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {row.advisorySummary.secondFace > 0 && (
                            <span className="rounded-full border-[2px] border-amber-300 bg-amber-50 px-2 py-0.5 text-2xs font-extrabold text-amber-800">
                              {t("advisorySecondFace", { count: row.advisorySummary.secondFace })}
                            </span>
                          )}
                          {row.advisorySummary.lookedAway > 0 && (
                            <span className="rounded-full border-[2px] border-sky-300 bg-sky-50 px-2 py-0.5 text-2xs font-extrabold text-sky-800">
                              {t("advisoryLookedAway", { count: row.advisorySummary.lookedAway })}
                            </span>
                          )}
                          {row.advisorySummary.voiceActivity > 0 && (
                            <span className="rounded-full border-[2px] border-violet-300 bg-violet-50 px-2 py-0.5 text-2xs font-extrabold text-violet-800">
                              {t("advisoryVoice", { count: row.advisorySummary.voiceActivity })}
                            </span>
                          )}
                          {row.advisorySummary.headsetActive > 0 && (
                            <span className="rounded-full border-[2px] border-border bg-muted px-2 py-0.5 text-2xs font-extrabold text-muted-foreground">
                              {t("advisoryHeadset")}
                            </span>
                          )}
                        </div>
                      )}
                      {(row.focus_pause_count ?? 0) > 0 && (
                        <p className="text-xs font-semibold text-muted-foreground">
                          {t("focusPauses", { count: row.focus_pause_count ?? 0 })}
                        </p>
                      )}
                      {row.face_unavailable_at && (
                        <p className="text-xs font-semibold text-muted-foreground">
                          {t("cameraUnavailable")} ({formatTime(row.face_unavailable_at)})
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap shrink-0 items-center gap-2.5 self-start sm:self-auto">
                      <Link
                        href={`/lecturer/quizzes/${row.quiz_id}/results/${row.id}`}
                        className="rounded-full border-2 border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-extrabold text-primary transition-colors hover:bg-primary hover:text-primary-foreground"
                        aria-label={`Actions - ${row.studentName ?? "Student"}`}
                      >
                        {locale === "ms" ? "Lihat Jawapan" : "View Answers"}
                      </Link>
                      <span className={`rounded-full border-[3px] px-2.5 py-0.5 text-xs font-extrabold ${STATUS_CLASS[row.displayStatus]}`}>
                        {getStatusLabel(row.displayStatus)}
                      </span>
                      {(row.attempt ?? 1) > 1 && (
                        <span className="rounded-full border-[2px] border-border bg-muted px-2 py-0.5 text-2xs font-extrabold text-muted-foreground">
                          {t("attemptChip", { count: row.attempt ?? 1 })}
                        </span>
                      )}
                      <span className="font-heading text-base font-semibold tabular-nums">
                        {row.score === null ? "—" : `${row.score} / ${row.total}`}
                      </span>
                    </div>
                  </div>

                  {row.displayStatus === "flagged" && row.mode === "assessment" && (
                    <div className="flex flex-wrap gap-2 pb-3">
                      <Button size="sm" variant="outline" disabled={busyRows.has(row.id)} onClick={() => void handleUnlock(row)}>
                        {busyRows.has(row.id) ? tCommon("loading") : t("unlockBtn")}
                      </Button>
                      <Button size="sm" variant="outline" disabled={busyRows.has(row.id)} onClick={() => setExemptRow(row.id)}>
                        {t("exemptBtn")}
                      </Button>
                      <Button size="sm" variant="destructive" disabled={busyRows.has(row.id)} onClick={() => { setResetRow(row.id); setResetCooled(false); }}>
                        {t("resetBtn")}
                      </Button>
                    </div>
                  )}
                  {row.mode === "assessment" && row.displayStatus !== "flagged" && (
                    <div className="flex flex-wrap gap-2 pb-3">
                      <Button size="sm" variant="outline" className="text-xs" disabled={busyRows.has(row.id)} onClick={() => setExemptRow(row.id)}>
                        {t("exemptBtn")}
                      </Button>
                      <Button size="sm" variant="ghost" className="text-xs text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={busyRows.has(row.id)} onClick={() => { setResetRow(row.id); setResetCooled(false); }}>
                        {t("resetBtn")}
                      </Button>
                    </div>
                  )}

                  {(incidentClips[row.id]?.length ?? 0) > 0 && expanded[row.id] && (
                    <div className="mb-3 space-y-2">
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
                    <p className="mb-3 rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm font-bold text-destructive" role="alert">
                      {rowErrors[row.id]}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

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
