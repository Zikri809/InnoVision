"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { QuestionImage } from "@/components/media/question-image";
import { coerceScore } from "@/lib/results/derive";
import type { DisplayStatus } from "@/lib/results/types";

type SessionInfo = {
  id: string;
  student_id: string;
  mode: string;
  status: string;
  score: number | null;
  started_at: string | null;
};

export type QuestionRow = {
  id: string;
  type: string;
  prompt: string;
  options: string[];
  order_index: number;
  /** v4.9: short_text rubric (M2 — the owner-predicated view exposes it). */
  answer_key: string | null;
  explanation: string | null;
  image_path: string | null;
  /** D7: locked to 1 today; the override dialog's ceiling. */
  max_score: number | null;
};

type MarkMetadata = {
  rationale?: unknown;
  confidence?: unknown;
  model?: unknown;
} | null;

export type AnswerRow = {
  question_id: string;
  selected_index: number | null;
  /** QT-1: multi-select rows carry the canonical selection set instead. */
  selected_indices: number[] | null;
  is_correct: boolean;
  answered_at: string | null;
  /** v4.9: the student's typed short_text answer. */
  answer_text: string | null;
  /** v4.9: a deliberate non-answer — never rendered as a red ✗. */
  skipped: boolean;
  /** v4.9: pending | marked | needs_review | failed. */
  mark_status: string;
  /** v4.9: the resolved 0/0.5/1 mark (coerced at the RSC boundary). */
  mark_score: number | null;
  mark_metadata: MarkMetadata;
  marked_at: string | null;
  /** L8: the override epoch — invalidates any in-flight AI mark. */
  attempt_version: number;
};

const CHIP_CORRECT = "border-[2px] border-emerald-300 dark:border-emerald-700/60 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300";
const CHIP_WRONG = "border-[2px] border-destructive/30 bg-destructive/10 text-destructive";
const CHIP_NEUTRAL = "border-[2px] border-border bg-muted text-muted-foreground";
const ROW_CORRECT = "bg-emerald-600 text-white";
const ROW_WRONG = "bg-destructive text-white";
const PICK_CORRECT = "border-emerald-300 dark:border-emerald-700/60 bg-emerald-50 dark:bg-emerald-950/30";
const PICK_WRONG = "bg-destructive/10 border-destructive/30";

/** Status-pill tab colors — mirror the dashboard's STATUS_CLASS/STATUS_DOT chips. */
const STATUS_PILL: Record<Exclude<DisplayStatus, "completed">, { dot: string; text: string }> = {
  abandoned: { dot: "bg-destructive", text: "text-destructive" },
  in_progress: { dot: "bg-sky-500", text: "text-sky-800 dark:text-sky-300" },
  flagged: { dot: "bg-amber-500", text: "text-amber-800 dark:text-amber-300" },
};

/**
 * The neutral marking states. A pending / needs-review / failed / skipped row
 * is NEVER rendered with the red ✗: `is_correct` is false for all four, but
 * none of them is a wrong answer (end-screen.tsx's wide-row precedent).
 */
type MarkState = "pending" | "needsReview" | "failed" | "skipped" | null;

/**
 * audit-4 round-3: `mark_score` is NUMERIC over PostgREST — it arrives as a
 * STRING ("0.5"), so a bare `=== 0.5` preset check would leave the override
 * dialog's ladder unselected when re-adjudicating. Coerce at every read.
 */
function coerceMarkScore(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function markStateOf(a: AnswerRow | undefined): MarkState {
  if (!a) return null;
  if (a.skipped) return "skipped";
  if (a.mark_status === "pending") return "pending";
  if (a.mark_status === "needs_review") return "needsReview";
  if (a.mark_status === "failed") return "failed";
  return null;
}

/** `mark_metadata.rationale` as plain text — never HTML (S7). */
function rationaleOf(meta: MarkMetadata): string | null {
  if (!meta || typeof meta !== "object") return null;
  const value = (meta as { rationale?: unknown }).rationale;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function SessionDetailClient({
  quizId,
  quizTitle,
  session,
  displayStatus,
  questions,
  answers,
  resultsRevealed,
  studentName,
}: {
  quizId: string;
  quizTitle: string;
  session: SessionInfo;
  /** D5 derivation (dashboard parity): completed/flagged/abandoned/in_progress. */
  displayStatus: DisplayStatus;
  questions: QuestionRow[];
  answers: AnswerRow[];
  /** C6/L1: an override on a revealed quiz un-publishes it (re-reveal needed). */
  resultsRevealed: boolean;
  studentName: string | null;
}) {
  const locale = useLocale();
  const router = useRouter();
  const t = useTranslations("lecturer.results");
  const tCommon = useTranslations("common");
  const answerByQuestion = new Map(answers.map((a) => [a.question_id, a]));

  function formatTime(iso: string | null | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat(locale === "ms" ? "ms-MY" : "en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "Asia/Kuala_Lumpur",
    }).format(d);
  }

  function formatOptionText(text: string, type: string): string {
    if (type === "true_false") {
      const lower = text.trim().toLowerCase();
      if (lower === "true" || lower === "betul") {
        return tCommon("trueOption");
      }
      if (lower === "false" || lower === "salah") {
        return tCommon("falseOption");
      }
    }
    return text;
  }

  const total = questions.length;
  // The arc renders only when a score exists — flagged-mid-run and abandoned
  // sessions have none (dashboard parity: they show "—" too).
  // audit-4 D8: the RSC coerces the NUMERIC-over-the-wire string, but this
  // island is also fed by tests/other callers — coerce defensively so a raw
  // "1.5" cannot concatenate or compare as a string here.
  const coerced = coerceScore(session.score);
  const hasScore = coerced !== null;
  const score = coerced ?? 0;
  const frac = total > 0 ? score / total : 0;
  // Status pill (dot + word) on the ring's bottom edge; completed → the
  // "/ N" fraction stays inside instead, with no pill.
  const statusPill =
    displayStatus === "completed"
      ? null
      : {
          label:
            displayStatus === "flagged"
              ? t("statFlagged")
              : displayStatus === "abandoned"
                ? t("statAbandoned")
                : t("statInProgress"),
          ...STATUS_PILL[displayStatus],
        };
  // Clay score badge geometry: r=30 in a 72-box, rounded cap, starts at 12
  // o'clock via -rotate-90.
  const RING_R = 30;
  const RING_C = 2 * Math.PI * RING_R;

  /** Row verdict chip — mark-state aware, never a red ✗ for unresolved rows. */
  const verdictChip = (a: AnswerRow | undefined) => {
    const markState = markStateOf(a);
    if (markState) {
      const word =
        markState === "pending"
          ? t("override.pendingChip")
          : markState === "needsReview"
            ? t("override.needsReviewChip")
            : markState === "failed"
              ? t("failedChip")
              : t("skippedChip");
      return { cls: CHIP_NEUTRAL, glyph: markState === "pending" ? "…" : "—", word };
    }
    if (!a) return { cls: CHIP_NEUTRAL, glyph: "—", word: t("skippedChip") };
    return a.is_correct
      ? { cls: CHIP_CORRECT, glyph: "✓", word: t("correctChip") }
      : { cls: CHIP_WRONG, glyph: "✗", word: t("wrongChip") };
  };

  // ── Override dialog (M2/D-30) ─────────────────────────────────────────
  // One dialog instance, driven by the row that opened it. The RPC permits
  // adjudicating ANY answered row (it bumps the epoch and recomputes the
  // D10 SUM), so the button is offered on every row with an answer — except
  // skipped rows, where the skip chip would keep masking the new mark.
  const [overrideFor, setOverrideFor] = useState<{
    question: QuestionRow;
    answer: AnswerRow;
  } | null>(null);
  const [mark, setMark] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);

  function openOverride(question: QuestionRow, answer: AnswerRow) {
    setOverrideFor({ question, answer });
    const preset = coerceMarkScore(answer.mark_score);
    setMark(preset === 0 || preset === 0.5 || preset === 1 ? preset : null);
    setReason("");
    setFormError(null);
  }

  function closeOverride() {
    if (submitting) return;
    setOverrideFor(null);
    setFormError(null);
  }

  function mapOverrideError(body: { error?: unknown; message?: unknown }): string {
    switch (body.error) {
      case "invalid_mark":
        return t("override.invalidMark");
      case "reason_required":
        return t("override.reasonTooShort");
      case "mark_exceeds_max":
        return t("override.markExceedsMax");
      case "not_found":
        return t("override.notFound");
      case "rate_limited":
        return t("override.rateLimited");
      default:
        return typeof body.message === "string" && body.message
          ? body.message
          : tCommon("errorGeneric");
    }
  }

  async function handleSubmit() {
    if (!overrideFor || submitting || submitLock.current) return;
    if (mark !== 0 && mark !== 0.5 && mark !== 1) {
      setFormError(t("override.invalidMark"));
      return;
    }
    const trimmed = reason.trim();
    if (trimmed.length < 5) {
      setFormError(t("override.reasonTooShort"));
      return;
    }

    submitLock.current = true;
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch(`/api/sessions/${session.id}/override`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          questionId: overrideFor.question.id,
          mark,
          reason: trimmed,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: unknown;
        message?: unknown;
      };
      if (!res.ok) {
        setFormError(mapOverrideError(body));
        return;
      }
      toast.success(t("override.saved"));
      setOverrideFor(null);
      router.refresh();
    } catch {
      setFormError(tCommon("errorGeneric"));
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5 md:space-y-7">
      {/* <sm: NO hero container — plain native header block directly on the
          page background (block flow: back row, then name|badge row); sm+:
          the floating gradient hero card. The badge sits on the name/meta
          row (items-center), not pinned to the top bar. */}
      <section className="relative mt-1 sm:overflow-hidden sm:rounded-[28px] sm:border-[3px] sm:border-border sm:bg-gradient-to-br sm:from-orange-100 sm:via-orange-50 sm:to-blue-50 sm:p-6 sm:shadow-[var(--shadow-clay)] sm:dark:from-orange-950/40 sm:dark:via-card sm:dark:to-blue-950/40 md:p-8">
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 hidden h-36 w-36 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/50 sm:block dark:bg-white/5" />
        <div className="relative">
          <Link
            href={`/lecturer/quizzes/${quizId}/results`}
            className="inline-flex min-h-[36px] items-center gap-1.5 text-sm font-extrabold text-muted-foreground transition-colors hover:text-primary"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden /> {tCommon("back")}
          </Link>
        </div>
        <div className="relative mt-0.5 flex items-center justify-between gap-3 sm:mt-2 sm:gap-4">
          <div className="min-w-0">
            {/* Very long names clamp at 2 lines (visual only — the full name
                stays in the DOM for screen readers, plus a title tooltip). */}
            <h1
              title={studentName ?? undefined}
              className="line-clamp-2 break-words font-heading text-[26px] font-semibold leading-tight md:text-4xl"
            >
              {studentName ?? t("tableHeaderStudent")}
            </h1>
            <p className="mt-0.5 text-[13px] font-semibold text-muted-foreground md:mt-2 md:text-sm">
              {quizTitle} · {formatTime(session.started_at)}
            </p>
          </div>

          {/* ONE score representation: a clay badge with the fraction,
              vertically centered on the name/meta row. No bar, no % —
              nothing is stated twice. The bare number keeps the
              span.font-heading.text-[26px] shape; e2e (e25) reads it, and
              the "/ N" must stay visible too. */}
          <div
            role="img"
            aria-label={
              statusPill
                ? `${statusPill.label}${hasScore ? ` — ${t("tableHeaderScore")} ${session.score}/${total}` : ""}`
                : `${t("tableHeaderScore")} ${session.score}/${total}`
            }
            className="relative grid h-[88px] w-[88px] shrink-0 place-items-center rounded-full border-[3px] border-border bg-card shadow-[var(--shadow-clay-sm)] md:h-[108px] md:w-[108px]"
          >
            <svg viewBox="0 0 72 72" className="absolute h-[74px] w-[74px] -rotate-90 md:h-[92px] md:w-[92px]" aria-hidden>
              <circle cx="36" cy="36" r={RING_R} fill="none" strokeWidth="8" className="stroke-border/80 dark:stroke-white/10" />
              {hasScore && (
                <circle
                  cx="36"
                  cy="36"
                  r={RING_R}
                  fill="none"
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeDasharray={RING_C}
                  strokeDashoffset={RING_C * (1 - frac)}
                  className="stroke-primary transition-[stroke-dashoffset] duration-700 ease-out"
                />
              )}
            </svg>
            {/* Number/dash alone when the status lives on the pill tab below;
                completed shows the "/ N" fraction inside instead. */}
            <div className="relative flex flex-col items-center leading-none">
              <span className="font-heading text-[26px] font-bold md:text-3xl">
                {session.score ?? "—"}
              </span>
              {!statusPill && (
                <span className="mt-1 text-xs font-extrabold text-muted-foreground">
                  / {total}
                </span>
              )}
            </div>
            {/* Status pill straddles the ring's bottom edge — a solid tab
                (card bg + border) so long labels (EN "Abandoned", MS "Sedang
                berjalan") can never collide with the ring stroke. */}
            {statusPill && (
              <span
                className={`absolute -bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full border-2 border-border bg-card px-2 py-0.5 text-[10px] font-extrabold md:text-[11px] ${statusPill.text}`}
              >
                <span aria-hidden className={`size-1.5 rounded-full ${statusPill.dot}`} />
                {statusPill.label}
              </span>
            )}
          </div>
        </div>
      </section>

      {/* Heading straight on the page; each question one flat card — no
          wrapper card, no filler subtitle. */}
      <section aria-labelledby="breakdown-heading" className="space-y-3 md:space-y-4">
        <h2
          id="breakdown-heading"
          className="px-1 font-heading text-xl font-semibold md:text-2xl"
        >
          {t("breakdownTitle")}
        </h2>
        {total === 0 ? (
          <p className="rounded-2xl border-[3px] border-dashed border-border bg-card p-6 text-center text-sm font-semibold text-muted-foreground">
            {tCommon("notFound")}
          </p>
        ) : (
          <ol className="space-y-3 md:space-y-4">
            {questions.map((q) => {
              const a = answerByQuestion.get(q.id);
              const isCorrect = a != null && a.is_correct;
              const chip = verdictChip(a);
              const isShortText = q.type === "short_text";
              const rationale = a ? rationaleOf(a.mark_metadata) : null;
              const coercedMark = coerceMarkScore(a?.mark_score);
              const showMarkValue =
                isShortText && a != null && a.mark_status === "marked" && coercedMark != null;
              return (
                <li
                  key={q.id}
                  className="rounded-[22px] border-[3px] border-border bg-card px-4 py-4 shadow-[var(--shadow-clay-sm)] md:px-5"
                >
                  <div className="flex items-start gap-3">
                    <span
                      aria-hidden
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-full border-2 border-border bg-muted font-heading text-[13px] font-bold text-muted-foreground"
                    >
                      {q.order_index + 1}
                    </span>
                    <p className="min-w-0 flex-1 pt-0.5 font-heading text-[15px] font-semibold leading-snug text-foreground">
                      {q.prompt}
                    </p>
                    {/* n17: the adjudicated 0/0.5/1 value, shown where the
                        ✓/✗ chip cannot convey a half mark (short_text). */}
                    {showMarkValue && (
                      <span className="shrink-0 rounded-full border-2 border-border bg-muted px-2.5 py-1 font-heading text-[11px] font-bold text-muted-foreground">
                        {coercedMark} / {q.max_score ?? 1}
                      </span>
                    )}
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wide ${chip.cls}`}
                    >
                      {chip.glyph} {chip.word}
                    </span>
                  </div>

                  {q.image_path != null && (
                    <div className="mt-2.5 pl-10">
                      <QuestionImage questionId={q.id} prompt={q.prompt} compact />
                    </div>
                  )}

                  {isShortText ? (
                    <div className="mt-2.5 space-y-2 pl-10">
                      <div className="rounded-xl border-2 border-border bg-muted/40 px-3.5 py-2.5">
                        <p className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">
                          {tCommon("aria.yourAnswer")}
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-sm font-semibold text-foreground">
                          {(a?.answer_text ?? "").trim() || "—"}
                        </p>
                      </div>
                      {q.answer_key && (
                        <div className="rounded-xl border-2 border-emerald-300 dark:border-emerald-700/60 bg-emerald-50/50 dark:bg-emerald-950/15 px-3.5 py-2.5">
                          <p className="text-[11px] font-extrabold uppercase tracking-wide text-emerald-800 dark:text-emerald-300">
                            {t("rubricLabel")}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap text-sm font-semibold text-foreground">
                            {q.answer_key}
                          </p>
                        </div>
                      )}
                    </div>
                  ) : (
                    <ul className="mt-2.5 space-y-1 pl-10">
                      {q.options.map((opt, i) => {
                        // QT-1: multi questions may select SEVERAL options —
                        // every committed selection gets the highlight (the
                        // chip carries the single is_correct verdict).
                        const selected =
                          a != null &&
                          (q.type === "multi_select"
                            ? (a.selected_indices?.includes(i) ?? false)
                            : i === a.selected_index);
                        const letter = String.fromCharCode(65 + i);
                        return (
                          <li
                            key={i}
                            className={`flex items-center gap-2.5 text-sm ${
                              selected
                                ? `rounded-xl border-2 px-3 py-2 ${
                                    isCorrect
                                      ? `${PICK_CORRECT} text-foreground`
                                      : `${PICK_WRONG} text-foreground`
                                  }`
                                : "px-3 py-1.5 text-muted-foreground"
                            }`}
                          >
                            <span
                              aria-hidden
                              className="w-4 shrink-0 text-xs font-extrabold text-muted-foreground/80"
                            >
                              {letter}
                            </span>
                            <span
                              className={`min-w-0 ${
                                selected ? "font-bold" : "font-semibold"
                              }`}
                            >
                              {formatOptionText(opt, q.type)}
                            </span>
                            {selected && (
                              <span
                                className={`ml-auto grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-extrabold ${
                                  isCorrect ? ROW_CORRECT : ROW_WRONG
                                }`}
                              >
                                {isCorrect ? "\u2713" : "\u2715"}
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  {/* S7: AI rationale as PLAIN TEXT only — never HTML. The
                      view exposes mark_metadata to the quiz owner (0060 §3). */}
                  {rationale && (
                    <div className="mt-2.5 pl-10">
                      <div className="rounded-xl border-2 border-border bg-muted/40 px-3.5 py-2.5">
                        <p className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">
                          {t("override.aiRationale")}
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-sm font-semibold text-foreground">
                          {rationale}
                        </p>
                      </div>
                    </div>
                  )}

                  {q.explanation && (
                    <div className="mt-2.5 pl-10">
                      <p className="rounded-xl border-2 border-border/60 bg-muted/40 px-3.5 py-2.5 text-sm font-semibold text-muted-foreground">
                        <strong className="font-extrabold text-foreground">
                          {t("explanationLabel")}
                        </strong>{" "}
                        {q.explanation}
                      </p>
                    </div>
                  )}

                  {/* Override affordance: every row that HAS an answer row and
                      is not a deliberate skip. Pending / needs_review / failed
                      are the primary use case; a marked row is overridable too
                      (the RPC permits it and bumps the epoch). */}
                  {a != null && !a.skipped && (
                    <div className="mt-3 flex justify-end border-t-2 border-border/60 pt-3">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => openOverride(q, a)}
                      >
                        {t("override.openBtn")}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* ── Override dialog (D-30) — frozen testid `override-mark-dialog` ── */}
      <Dialog
        open={overrideFor != null}
        onOpenChange={(open) => {
          if (!open) closeOverride();
        }}
      >
        <DialogContent data-testid="override-mark-dialog" className="sm:max-w-md p-6 sm:p-7">
          {overrideFor && (
            <>
              <DialogHeader>
                <DialogTitle className="text-xl font-bold font-heading">
                  {t("override.title")}
                </DialogTitle>
                <DialogDescription className="text-xs font-semibold text-muted-foreground mt-0.5 break-words">
                  {overrideFor.question.prompt}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-2" aria-live="polite">
                {formError && (
                  <p
                    className="rounded-xl border-[3px] border-destructive/40 bg-destructive/10 px-4 py-2.5 text-xs font-bold text-destructive"
                    role="alert"
                  >
                    {formError}
                  </p>
                )}

                <div className="space-y-2">
                  <Label className="text-xs font-extrabold text-foreground">
                    {t("override.markLabel")}
                  </Label>
                  <RadioGroup
                    aria-label={t("override.markLabel")}
                    value={mark}
                    onValueChange={(value) => {
                      setMark(typeof value === "number" ? value : null);
                      setFormError(null);
                    }}
                    disabled={submitting}
                    className="flex gap-5"
                  >
                    {[0, 0.5, 1].map((value) => (
                      <div key={value} className="flex items-center gap-2.5">
                        <RadioGroupItem value={value} id={`override-mark-${value}`} />
                        <Label
                          htmlFor={`override-mark-${value}`}
                          className="cursor-pointer font-bold"
                        >
                          {value}
                        </Label>
                      </div>
                    ))}
                  </RadioGroup>
                </div>

                <div className="space-y-2">
                  <Label
                    htmlFor="override-reason"
                    className="text-xs font-extrabold text-foreground"
                  >
                    {t("override.reason")}
                  </Label>
                  <Textarea
                    id="override-reason"
                    value={reason}
                    onChange={(e) => {
                      setReason(e.target.value);
                      setFormError(null);
                    }}
                    maxLength={500}
                    rows={4}
                    placeholder={t("override.reasonPlaceholder")}
                    disabled={submitting}
                  />
                </div>

                {resultsRevealed && (
                  <p
                    className="rounded-xl border-[3px] border-amber-300 bg-amber-50 px-4 py-2.5 text-xs font-bold text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
                    role="note"
                  >
                    {t("override.republish")}
                  </p>
                )}
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeOverride}
                  disabled={submitting}
                >
                  {tCommon("cancel")}
                </Button>
                <Button type="button" onClick={() => void handleSubmit()} disabled={submitting}>
                  {submitting ? tCommon("saving") : tCommon("save")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
