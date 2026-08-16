"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
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

const STATUS_LABEL: Record<DisplayStatus, string> = {
  abandoned: "Abandoned",
  in_progress: "In progress",
  flagged: "Flagged",
  completed: "Completed",
};

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

const DATE_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : DATE_FMT.format(d);
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Lecturer results dashboard (Phase 8) — PRESENTATION ONLY.
 *
 * All display logic (abandonment, ordering, timeline attribution) lives in the
 * pure `lib/results/` module; this component renders the assembled rows. After
 * any action (unlock/exempt/reset) it calls the API route then
 * `router.refresh()` — no optimistic state, no client cache. Reset 404s are
 * treated as success (the goal — row gone — is achieved); the confirm button
 * cools off after the first success.
 */
export function ResultsDashboardClient({
  quizId,
  quizTitle,
  mode,
  status,
  timeLimitSec,
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
  totalQuestions: number;
  truncated: boolean;
  rows: ResultsSessionRow[];
  roster: { student_id: string; full_name: string | null; enrolled_at: string }[];
}) {
  const router = useRouter();

  // Per-row in-flight actions. A SET (not a single id) so two different rows
  // can run actions concurrently without one's `finally` clearing the other's
  // busy indicator (each button gates on its OWN row's membership).
  const [busyRows, setBusyRows] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Exempt dialog (per-row reason).
  const [exemptRow, setExemptRow] = useState<string | null>(null);
  const [exemptReason, setExemptReason] = useState("");

  // Reset confirm dialog.
  const [resetRow, setResetRow] = useState<string | null>(null);
  const [resetCooled, setResetCooled] = useState(false);

  const attempted = rows.length;
  const summary = rows.reduce(
    (acc, r) => {
      acc[r.displayStatus] = (acc[r.displayStatus] ?? 0) + 1;
      return acc;
    },
    {} as Partial<Record<DisplayStatus, number>>,
  );
  const completed = summary.completed ?? 0;
  const flagged = summary.flagged ?? 0;
  const abandoned = summary.abandoned ?? 0;
  const inProgress = summary.in_progress ?? 0;

  const sessionStudentIds = new Set(rows.map((r) => r.student_id));
  const notAttempted = roster.filter((s) => !sessionStudentIds.has(s.student_id));

  function setRowError(rowId: string, message: string) {
    setRowErrors((prev) => ({ ...prev, [rowId]: message }));
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
        setRowError(rowId, body.message ?? body.error ?? "Action failed.");
        return;
      }
      router.refresh();
    } catch {
      setRowError(rowId, "Network error. Try again.");
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
        // Reset idempotency (D7): a 404 means the row is ALREADY gone — the
        // goal is achieved, treat it as success.
        if (res.status === 404) return new Response(null, { status: 200 });
        return res;
      }),
    );
    setResetRow(null);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <Link
          href={`/lecturer/quizzes/${quizId}/builder`}
          className="text-sm font-bold text-muted-foreground hover:text-primary hover:underline"
        >
          ← Back to builder
        </Link>
        <h1 className="mt-2 font-heading text-2xl font-semibold">{quizTitle}</h1>
        <p className="mt-1 text-sm font-semibold text-muted-foreground">
          {mode === "assessment" ? "Assessment" : "Practice"} · {status === "live" ? "Live" : status === "closed" ? "Closed" : "Draft"}
          {timeLimitSec != null ? ` · ${timeLimitSec}s limit` : ""} · {totalQuestions} questions
        </p>
      </div>

      {truncated && (
        <p className="mb-4 rounded-2xl border-[3px] border-dashed border-border bg-card px-4 py-3 text-sm font-semibold text-muted-foreground" role="status">
          Showing the most recent 200 sessions.
        </p>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Attendance</CardTitle>
          <CardDescription>
            Sessions started by enrolled students for this quiz.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="rounded-2xl border-[3px] border-dashed border-border bg-card p-6 text-center text-sm font-semibold text-muted-foreground">
              No sessions yet.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((row) => (
                <li key={row.id}>
                  <div className="flex items-start justify-between gap-3 py-3.5">
                    <div className="min-w-0">
                      <button
                        type="button"
                        translate="no"
                        className="block cursor-pointer text-left font-heading text-base font-semibold hover:text-primary hover:underline"
                        onClick={() => setExpanded((p) => ({ ...p, [row.id]: !p[row.id] }))}
                        aria-expanded={Boolean(expanded[row.id])}
                      >
                        {row.studentName ?? "Removed student"}
                      </button>
                      <p className="mt-0.5 text-xs font-semibold text-muted-foreground">
                        Started {formatTime(row.started_at)}
                        {row.submitted_at ? ` · Submitted ${formatTime(row.submitted_at)}` : ""}
                      </p>
                      {row.faceSummary.lastAt != null && (
                        <p className="text-xs font-semibold text-muted-foreground">
                          Face checks: {row.faceSummary.fails} fail
                          {row.faceSummary.fails === 1 ? "" : "s"},{" "}
                          {row.faceSummary.replays} replay
                          {row.faceSummary.replays === 1 ? "" : "s"}
                        </p>
                      )}
                      {row.face_unavailable_at && (
                        <p className="text-xs font-semibold text-muted-foreground">
                          Camera unavailable (reported {formatTime(row.face_unavailable_at)})
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2.5">
                      <span className={`rounded-full border-[3px] px-2.5 py-0.5 text-xs font-extrabold ${STATUS_CLASS[row.displayStatus]}`}>
                        {STATUS_LABEL[row.displayStatus]}
                      </span>
                      <span className="font-heading text-base font-semibold tabular-nums">
                        {row.score === null ? "—" : `${row.score} / ${row.total}`}
                      </span>
                    </div>
                  </div>

                  {row.displayStatus === "flagged" && row.mode === "assessment" && (
                    <div className="flex gap-2 pb-3">
                      <Button size="sm" variant="outline" disabled={busyRows.has(row.id)} onClick={() => void handleUnlock(row)}>
                        {busyRows.has(row.id) ? "Working…" : "Unlock"}
                      </Button>
                      <Button size="sm" variant="outline" disabled={busyRows.has(row.id)} onClick={() => setExemptRow(row.id)}>
                        Face-exempt
                      </Button>
                      <Button size="sm" variant="destructive" disabled={busyRows.has(row.id)} onClick={() => { setResetRow(row.id); setResetCooled(false); }}>
                        Reset
                      </Button>
                    </div>
                  )}
                  {row.mode === "assessment" && row.displayStatus !== "flagged" && (
                    <div className="flex gap-2 pb-3">
                      <Button size="sm" variant="outline" disabled={busyRows.has(row.id)} onClick={() => setExemptRow(row.id)}>
                        Face-exempt
                      </Button>
                      <Button size="sm" variant="destructive" disabled={busyRows.has(row.id)} onClick={() => { setResetRow(row.id); setResetCooled(false); }}>
                        Reset
                      </Button>
                    </div>
                  )}

                  {rowErrors[row.id] && (
                    <p className="mb-3 rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm font-bold text-destructive" role="alert">
                      {rowErrors[row.id]}
                    </p>
                  )}

                  {expanded[row.id] && (
                    <div className="mb-3 rounded-2xl border-[3px] border-border bg-muted/40 p-4">
                      {row.integrityTimeline.length === 0 && row.legacyHistory.length === 0 && (
                        <p className="text-sm font-semibold text-muted-foreground">No integrity events recorded.</p>
                      )}
                      {row.integrityTimeline.length > 0 && (
                        <TimelineEvents events={row.integrityTimeline} />
                      )}
                      {row.legacyHistory.length > 0 && (
                        <>
                          <Separator className="my-2" />
                          <p className="mb-1 text-xs font-bold text-muted-foreground">
                            Student history (origin not tied to this session)
                          </p>
                          <TimelineEvents events={row.legacyHistory} />
                        </>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {notAttempted.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Not attempted</CardTitle>
            <CardDescription>
              {notAttempted.length} enrolled student{notAttempted.length === 1 ? "" : "s"} with no session
              {truncated
                ? " among the 200 most recent sessions shown."
                : " in this quiz."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {notAttempted.map((s) => (
                <li key={s.student_id} className="flex items-center justify-between py-2.5">
                  <span translate="no" className="font-heading text-base font-semibold">{s.full_name ?? "Unnamed student"}</span>
                  <span className="text-xs font-bold text-muted-foreground">
                    Joined {formatDate(s.enrolled_at)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {attempted > 0 && (
        <p className="mt-6 text-xs font-bold text-muted-foreground">
          {completed} completed · {flagged} flagged · {abandoned} abandoned · {inProgress} in progress
        </p>
      )}

      {/* Face-exempt dialog */}
      <Dialog open={exemptRow !== null} onOpenChange={(open) => { if (!open) { setExemptRow(null); setExemptReason(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Face-exempt this session</DialogTitle>
            <DialogDescription>
              The student will no longer be face-checked. A reason is required for the audit trail.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="exempt-reason" className="sr-only">
              Reason
            </Label>
            <Input
              id="exempt-reason"
              placeholder="e.g. webcam broken"
              value={exemptReason}
              onChange={(e) => setExemptReason(e.target.value)}
              maxLength={500}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setExemptRow(null); setExemptReason(""); }}>
              Cancel
            </Button>
            <Button
              disabled={!exemptReason.trim() || busyRows.has(exemptRow ?? '')}
              onClick={() => {
                const row = rows.find((r) => r.id === exemptRow);
                if (row) void handleExempt(row);
              }}
            >
              Exempt
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset confirm dialog */}
      <Dialog open={resetRow !== null} onOpenChange={(open) => { if (!open) { setResetRow(null); setResetCooled(false); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset this attempt?</DialogTitle>
            <DialogDescription>
              This permanently deletes the session and its answers. The student can attempt the assessment again. This action is audited.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setResetRow(null); setResetCooled(false); }}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={resetCooled || busyRows.has(resetRow ?? '')}
              onClick={() => {
                const row = rows.find((r) => r.id === resetRow);
                if (row) void handleReset(row);
              }}
            >
              {busyRows.has(resetRow ?? '') ? "Resetting…" : "Reset attempt"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TimelineEvents({ events }: { events: IntegrityEvent[] }) {
  return (
    <ul className="space-y-1">
      {events.map((e) => {
        if (e.kind === "face_check") {
          return (
            <li key={`${e.kind}-${e.at}-${e.id}`} className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                {formatTime(new Date(e.at).toISOString())} · Face check ({TRIGGER_LABEL[e.trigger] ?? e.trigger})
                {e.suspectedReplay ? " · replay" : ""}
                {e.tooFrequent ? " · too frequent" : ""}
              </span>
              <span className={e.matched ? "text-emerald-700" : "text-destructive"}>
                {e.matched ? "Matched" : "Mismatch"}
                {typeof e.distance === "number" ? ` (${e.distance.toFixed(2)})` : ""}
              </span>
            </li>
          );
        }
        if (e.kind === "unavailable") {
          return (
            <li key={`${e.kind}-${e.at}-${e.id}`} className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{formatTime(new Date(e.at).toISOString())}</span>
              <span className="text-amber-700">Camera unavailable</span>
            </li>
          );
        }
        return (
          <li key={`${e.kind}-${e.at}-${e.id}`} className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{formatTime(new Date(e.at).toISOString())}</span>
            <span className="text-destructive">{ACTION_LABEL[e.action] ?? e.action}</span>
          </li>
        );
      })}
    </ul>
  );
}
