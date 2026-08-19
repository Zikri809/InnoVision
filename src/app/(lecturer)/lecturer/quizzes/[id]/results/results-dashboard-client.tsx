"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { formatDuration } from "@/lib/format/duration";
import { ArrowLeft, Check, Megaphone } from "lucide-react";
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
  IntegrityEvent,
  ResultsSessionRow,
} from "@/lib/results/types";

const STATUS_CLASS: Record<DisplayStatus, string> = {
  abandoned: "border-destructive/40 bg-destructive/10 text-destructive",
  in_progress: "border-sky-300 bg-sky-100 text-sky-800",
  flagged: "border-amber-300 bg-amber-100 text-amber-800",
  completed: "border-emerald-300 bg-emerald-100 text-emerald-800",
};

const ACTION_LABEL: Record<string, string> = {
  session_reset: "Session reset",
  unlock: "Unlocked",
  exempt_face: "Face-exempted",
  consent_revoked: "Consent revoked",
  self_recover: "Self-recovered",
};

const TRIGGER_LABEL: Record<string, string> = {
  start: "Start",
  question: "Question",
  periodic: "Periodic",
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
  truncated,
  rows,
  roster,
}: {
  quizId: string;
  quizTitle: string;
  mode: string;
  status: string;
  timeLimitSec: number | null;
  resultsRevealedAt: string | null;
  autoRevealOnComplete: boolean;
  totalQuestions: number;
  truncated: boolean;
  rows: ResultsSessionRow[];
  roster: { student_id: string; full_name: string | null; enrolled_at: string }[];
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

  function formatDate(iso: string | null | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const df = new Intl.DateTimeFormat(locale === "ms" ? "ms-MY" : "en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    return df.format(d);
  }

  function formatTime(iso: string | null | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString(locale === "ms" ? "ms-MY" : "en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  const [busyRows, setBusyRows] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const [exemptRow, setExemptRow] = useState<string | null>(null);
  const [exemptReason, setExemptReason] = useState("");

  const [resetRow, setResetRow] = useState<string | null>(null);
  const [resetCooled, setResetCooled] = useState(false);

  const [revealOpen, setRevealOpen] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [autoReveal, setAutoReveal] = useState(autoRevealOnComplete);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

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

  async function handleAutoRevealToggle(checked: boolean) {
    setAutoReveal(checked);
    setSettingsSaving(true);
    try {
      await fetch(`/api/quizzes/${quizId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ auto_reveal_on_complete: checked }),
      });
    } finally {
      setSettingsSaving(false);
    }
  }

  const completed = rows.filter((r) => r.displayStatus === "completed").length;
  const flagged = rows.filter((r) => r.displayStatus === "flagged").length;
  const abandoned = rows.filter((r) => r.displayStatus === "abandoned").length;
  const inProgress = rows.filter((r) => r.displayStatus === "in_progress").length;
  const attempted = rows.length;

  const attemptedStudentIds = new Set(rows.map((r) => r.student_id));
  const notAttempted = roster.filter((r) => !attemptedStudentIds.has(r.student_id));

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
      <section className="relative overflow-hidden rounded-[28px] border-[3px] border-border bg-gradient-to-br from-orange-100 via-orange-50 to-blue-50 p-7 shadow-[var(--shadow-clay)] md:p-8">
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-36 w-36 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/50" />
        <div className="relative">
          <Link
            href={`/lecturer/quizzes/${quizId}/builder`}
            className="inline-flex items-center gap-1.5 text-sm font-extrabold text-muted-foreground transition-colors hover:text-primary"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden /> {t("backToQuizzes")}
          </Link>
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
        </div>
      </section>

      {isAssessment && (
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
                    <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm font-semibold text-foreground">
                      <Checkbox
                        checked={autoReveal}
                        disabled={settingsSaving}
                        onCheckedChange={(v: boolean) => void handleAutoRevealToggle(v)}
                      />
                      {t("autoRevealLabel")}
                    </label>
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
                      {row.face_unavailable_at && (
                        <p className="text-xs font-semibold text-muted-foreground">
                          {t("cameraUnavailable")} ({formatTime(row.face_unavailable_at)})
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap shrink-0 items-center gap-2.5 self-start sm:self-auto">
                      <Link
                        href={`/lecturer/quizzes/${row.quiz_id}/results/${row.id}`}
                        className="text-xs font-extrabold text-primary hover:underline"
                      >
                        {tCommon("actions")}
                      </Link>
                      <span className={`rounded-full border-[3px] px-2.5 py-0.5 text-xs font-extrabold ${STATUS_CLASS[row.displayStatus]}`}>
                        {getStatusLabel(row.displayStatus)}
                      </span>
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
                      <Button size="sm" variant="outline" disabled={busyRows.has(row.id)} onClick={() => setExemptRow(row.id)}>
                        {t("exemptBtn")}
                      </Button>
                      <Button size="sm" variant="destructive" disabled={busyRows.has(row.id)} onClick={() => { setResetRow(row.id); setResetCooled(false); }}>
                        {t("resetBtn")}
                      </Button>
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
    </div>
  );
}
