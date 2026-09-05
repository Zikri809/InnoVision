"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowDown, ArrowLeft, ArrowUp, CalendarClock, Check, CopyPlus, Image as ImageIcon, ListPlus, Pencil, Settings2, Timer, Trash2, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDuration } from "@/lib/format/duration";
import { formatWindow } from "@/lib/format/window";
import { TITLE_MAX } from "@/lib/quizzes/validation";
import {
  applyOptionDraftOp,
  type OptionDraftOp,
} from "@/lib/quizzes/question-draft";
import { MODE_CLASS, STATUS_CLASS, getModeLabel, getStatusLabel } from "@/lib/quizzes/labels";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { GenerateFromFileDialog } from "@/components/extract/GenerateFromFileDialog";
import { SourceTextPreview } from "@/components/extract/SourceTextPreview";
import { EditQuestionDialog } from "@/components/quiz/edit-question-dialog";
import { RegenerateQuestionDialog } from "@/components/quiz/regenerate-question-dialog";
import { EditQuizDialog } from "@/components/quiz/edit-quiz-dialog";
import { BulkImportDialog } from "@/components/quiz/bulk-import-dialog";
import { DuplicateQuizDialog } from "@/components/quiz/duplicate-quiz-dialog";
import { QuestionImageField } from "@/components/media/question-image-field";
import type { OcrConfig } from "@/lib/extract/types";

export type QuizInfo = {
  id: string;
  class_id: string;
  class_title: string;
  title: string;
  mode: "practice" | "assessment";
  status: "draft" | "live" | "closed";
  time_limit_sec: number | null;
  opens_at: string | null;
  closes_at: string | null;
  allow_retake: boolean | null;
  max_attempts: number | null;
  shuffle_questions: boolean | null;
  created_at: string;
  source_file_url: string | null;
  source_text: string | null;
};

export type QuestionRow = {
  id: string;
  quiz_id: string;
  order_index: number;
  type: "mcq" | "true_false" | "multi_select";
  prompt: string;
  options: string[];
  correct_index: number | null;
  correct_indices?: number[] | null;
  explanation: string | null;
  image_path?: string | null;
};

type QuestionDraft = {
  type: "mcq" | "true_false" | "multi_select";
  prompt: string;
  options: string[];
  /** Single-answer key (mcq / true_false). Absent on multi drafts. */
  correctIndex?: number;
  /** QT-1: sorted+distinct multi answer key. Absent on single-answer drafts. */
  correctIndices?: number[];
  explanation: string;
};

const emptyDraft: QuestionDraft = {
  type: "mcq",
  prompt: "",
  options: ["", ""],
  correctIndex: 0,
  explanation: "",
};

export function QuizBuilderClient({
  quiz,
  questions,
  userId,
  classes,
  unrevealedCompleted = 0,
  ocrConfig,
}: {
  quiz: QuizInfo;
  questions: QuestionRow[];
  userId: string;
  /** AP-2: owned, unarchived classes — duplicate destination options. */
  classes: Array<{ id: string; title: string }>;
  /** QC-2: completed assessment sessions with hidden results (close-dialog warning). */
  unrevealedCompleted?: number;
  ocrConfig: OcrConfig;
}) {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("lecturer.builder");
  const tCommon = useTranslations("common");
  const tMedia = useTranslations("media");
  const isDraft = quiz.status === "draft";

  // Title editing state
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(quiz.title);
  const [savingTitle, setSavingTitle] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleSubmitLock = useRef(false);

  // Settings dialog state & refs
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Per-question image presence: BASE derived from the live questions state
  // (stays honest across refreshes/replaces), overlaid by optimistic flags
  // set at attach/remove time. The storage path itself never lives client-side.
  const [imageFlags, setImageFlags] = useState<Record<string, boolean>>({});

  function hasImageFor(id: string): boolean {
    if (id in imageFlags) return imageFlags[id];
    return Boolean(questions.find((q) => q.id === id)?.image_path);
  }

  function handleDialogClose(open: boolean) {
    setSettingsOpen(open);
    if (!open) {
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) {
          if (isDraft && settingsBtnRef.current) {
            settingsBtnRef.current.focus();
          } else {
            headingRef.current?.focus();
          }
        }
      });
    }
  }

  // Focus & select input text on edit start
  useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [editingTitle]);

  function startTitleEdit() {
    setTitleDraft(quiz.title);
    setEditingTitle(true);
    setError(null);
  }

  function cancelTitleEdit() {
    setEditingTitle(false);
    setTitleDraft(quiz.title);
    setError(null);
    headingRef.current?.focus();
  }

  async function handleTitleSave(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (savingTitle || titleSubmitLock.current) return;

    const trimmed = titleDraft.trim();
    if (!trimmed) {
      setError(tCommon("errorGeneric"));
      return;
    }
    if (trimmed.length > TITLE_MAX) {
      setError(t("titleMax", { max: TITLE_MAX }));
      return;
    }
    if (trimmed === quiz.title) {
      cancelTitleEdit();
      return;
    }

    titleSubmitLock.current = true;
    setSavingTitle(true);
    setError(null);

    try {
      const res = await fetch(`/api/quizzes/${quiz.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message ?? body.error ?? tCommon("errorGeneric"));
        if (res.status === 409) {
          setEditingTitle(false);
          router.refresh();
        } else if (res.status === 404) {
          setEditingTitle(false);
          router.push(`/lecturer/classes/${quiz.class_id}`);
        }
        return;
      }
      setEditingTitle(false);
      toast.success(t("titleUpdated"));
      router.refresh();
      headingRef.current?.focus();
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      titleSubmitLock.current = false;
      setSavingTitle(false);
    }
  }

  // Question form state (top card: adding new questions).
  const [draft, setDraft] = useState<QuestionDraft>(emptyDraft);
  // Image staged in the add-question dropzone — uploaded AFTER the question
  // exists (the POST returns the new id). Never persists across questions.
  const [pendingImage, setPendingImage] = useState<File | null>(null);
  const [editingQuestion, setEditingQuestion] = useState<QuestionRow | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [regeneratingQuestion, setRegeneratingQuestion] = useState<QuestionRow | null>(null);
  const [regeneratingIndex, setRegeneratingIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  // AP-1/AP-2 authoring-productivity dialogs.
  const [importOpen, setImportOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [reordering, setReordering] = useState(false);

  // Close flow (QC-1): confirm dialog + cool-down guard (reset-pattern
  // discipline — the destructive confirm stays disabled until reopen settles)
  // + submit-lock so double-click yields ONE flip.
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeCooled, setCloseCooled] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  // Option-array mutations ride the SHARED pure reducers
  // (lib/quizzes/question-draft.ts) so the answer key follows its option on
  // remove/move — the old inline copies drifted (deleting an option ABOVE the
  // key left correctIndex pointing at the wrong option). QT-1: multi drafts
  // carry the set-valued key through the same reducer.
  function applyOptions(draft: QuestionDraft, op: OptionDraftOp): QuestionDraft {
    const next = applyOptionDraftOp(
      {
        options: draft.options,
        correctIndex: draft.correctIndex,
        correctIndices: draft.correctIndices,
      },
      op,
    );
    return { ...draft, ...next };
  }

  function setOption(index: number, value: string) {
    setDraft((d) => applyOptions(d, { kind: "set", index, value }));
  }

  function addOption() {
    setDraft((d) => applyOptions(d, { kind: "add" }));
  }

  function removeOption(index: number) {
    setDraft((d) => applyOptions(d, { kind: "remove", index }));
  }

  function moveOption(index: number, direction: "up" | "down") {
    setDraft((d) =>
      applyOptions(d, {
        kind: "move",
        from: index,
        to: direction === "up" ? index - 1 : index + 1,
      }),
    );
  }

  function startEdit(q: QuestionRow, index: number) {
    setEditingQuestion(q);
    setEditingIndex(index);
    setError(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);

    const payload = {
      type: draft.type,
      prompt: draft.prompt,
      options: draft.options,
      // QT-1: strictly one-of by type — multi carries the sorted set and no
      // scalar, singles the reverse (QuestionInputSchema enforces both ways).
      correctIndex: draft.type === "multi_select" ? undefined : draft.correctIndex,
      correctIndices: draft.type === "multi_select" ? draft.correctIndices : undefined,
      explanation: draft.explanation,
    };

    try {
      const res = await fetch(`/api/quizzes/${quiz.id}/questions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message ?? body.error ?? tCommon("errorGeneric"));
        return;
      }

      // Image phase — its failure never loses the created question; the user
      // retries via the question's edit dialog. The staged file is always
      // cleared so it can never silently attach to a LATER question.
      const createdId =
        typeof body.question?.id === "string" ? body.question.id : null;
      if (pendingImage) {
        if (!createdId) {
          // Question created but response lacked its id — say the image was
          // NOT attached instead of dropping it silently.
          toast.error(tMedia("addedImageFailed"));
        } else {
          try {
            const form = new FormData();
            form.append("image", pendingImage, pendingImage.name);
            const imgRes = await fetch(
              `/api/quizzes/${quiz.id}/questions/${createdId}/image`,
              { method: "POST", body: form },
            );
            if (!imgRes.ok) toast.error(tMedia("addedImageFailed"));
          } catch {
            toast.error(tMedia("addedImageFailed"));
          }
        }
      }

      setDraft(emptyDraft);
      setPendingImage(null);
      toast.success(t("questionAdded"));
      // Refresh only AFTER the image phase settles so the fresh payload's
      // image_path (feeding the list badge) is already honest.
      router.refresh();
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      setSaving(false);
    }
  }

  const deletingId = useRef<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<QuestionRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  async function handleDelete(q: QuestionRow) {
    // Irreversible — confirmed through the AlertDialog (deleteTarget), and
    // locked against double-clicks (the second DELETE would 404 and mask
    // the success).
    if (deletingId.current) return;
    setDeleteTarget(q);
  }

  async function confirmDelete() {
    const q = deleteTarget;
    if (!q || deletingId.current) return;
    deletingId.current = q.id;
    setDeleteBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/quizzes/${quiz.id}/questions/${q.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message ?? body.error ?? tCommon("errorGeneric"));
        return;
      }
      toast.success(t("questionDeleted"));
      setDeleteTarget(null);
      router.refresh();
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      deletingId.current = null;
      setDeleteBusy(false);
    }
  }

  async function handleMove(q: QuestionRow, direction: "up" | "down") {
    if (reordering) return;
    const currentIdx = questions.findIndex((x) => x.id === q.id);
    const targetIdx = direction === "up" ? currentIdx - 1 : currentIdx + 1;
    if (targetIdx < 0 || targetIdx >= questions.length) return;

    setReordering(true);
    setError(null);

    const nextQuestions = [...questions];
    const [moved] = nextQuestions.splice(currentIdx, 1);
    nextQuestions.splice(targetIdx, 0, moved);
    const questionIds = nextQuestions.map((x) => x.id);

    try {
      // NOTE: `/reorder`, NOT `/questions/reorder` — the latter is captured by
      // the questions/[questionId] route (questionId="reorder") which has no
      // POST handler → 405, silently breaking every lecturer reorder.
      const res = await fetch(`/api/quizzes/${quiz.id}/reorder`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questionIds }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message ?? body.error ?? tCommon("errorGeneric"));
        return;
      }
      router.refresh();
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      setReordering(false);
    }
  }

  async function handlePublish() {
    setPublishing(true);
    setError(null);
    try {
      const res = await fetch(`/api/quizzes/${quiz.id}/publish`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message ?? body.error ?? tCommon("errorGeneric"));
        return;
      }
      router.refresh();
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      setPublishing(false);
    }
  }

  async function handleCloseQuiz() {
    if (closing) return;
    // Cool-down guard (reset-dialog pattern): after one attempt the confirm
    // stays disabled until the dialog is closed and reopened — no blind
    // re-clicks on a terminal action.
    setCloseCooled(true);
    setClosing(true);
    setCloseError(null);
    try {
      const res = await fetch(`/api/quizzes/${quiz.id}/close`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCloseError(body.message ?? body.error ?? tCommon("errorGeneric"));
        return;
      }
      setCloseOpen(false);
      toast.success(t("quizClosed"));
      router.refresh();
    } catch {
      setCloseError(tCommon("errorGeneric"));
    } finally {
      setClosing(false);
    }
  }

  /** QC-2 prevention CTA: reveal (idempotent), then close (CAS) — both safe
   * in either order, so a partial sequence never strands results. */
  async function handleRevealThenClose() {
    if (closing) return;
    setCloseCooled(true);
    setClosing(true);
    setCloseError(null);
    try {
      const revealRes = await fetch(`/api/quizzes/${quiz.id}/reveal`, {
        method: "POST",
      });
      if (!revealRes.ok) {
        const body = await revealRes.json().catch(() => ({}));
        setCloseError(body.message ?? body.error ?? tCommon("errorGeneric"));
        return;
      }
      const res = await fetch(`/api/quizzes/${quiz.id}/close`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCloseError(body.message ?? body.error ?? tCommon("errorGeneric"));
        return;
      }
      setCloseOpen(false);
      toast.success(t("quizClosed"));
      router.refresh();
    } catch {
      setCloseError(tCommon("errorGeneric"));
    } finally {
      setClosing(false);
    }
  }

  const defaultTrueFalseOptions = locale === "ms" ? ["Betul", "Salah"] : ["True", "False"];

  return (
    <div className="space-y-6">
      {/* ── Hero band ── */}
      <section className="relative overflow-hidden rounded-[28px] border-[3px] border-border bg-gradient-to-br from-orange-100 via-orange-50 to-blue-50 dark:from-orange-950/40 dark:via-card dark:to-blue-950/40 p-7 shadow-[var(--shadow-clay)] md:p-8">
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-36 w-36 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/50 dark:bg-white/5" />
        <div className="relative">
          <Link
            href={`/lecturer/classes/${quiz.class_id}`}
            className="inline-flex items-center gap-1.5 text-sm font-extrabold text-muted-foreground transition-colors hover:text-primary"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden /> {quiz.class_title}
          </Link>
          <div className="mt-3 flex flex-wrap items-end justify-between gap-6">
            <div className="min-w-0">
              {editingTitle ? (
                <form
                  onSubmit={handleTitleSave}
                  className="flex items-center gap-2"
                >
                  <Input
                    ref={titleInputRef}
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") cancelTitleEdit();
                    }}
                    maxLength={TITLE_MAX}
                    disabled={savingTitle}
                    aria-label={t("renameQuiz")}
                    className="h-12 w-full max-w-xl min-w-0 rounded-2xl border-[3px] border-primary/40 bg-card px-4 font-heading text-xl font-semibold shadow-[var(--shadow-clay-in)] focus-visible:ring-primary/30 sm:text-2xl"
                  />
                  <Button
                    type="submit"
                    size="icon-sm"
                    disabled={savingTitle || !titleDraft.trim()}
                    aria-label={tCommon("save")}
                  >
                    <Check className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    onClick={cancelTitleEdit}
                    disabled={savingTitle}
                    aria-label={tCommon("cancel")}
                  >
                    <X className="size-4" />
                  </Button>
                </form>
              ) : (
                <div className="group/title flex items-center gap-2">
                  <h1
                    ref={headingRef}
                    tabIndex={-1}
                    onDoubleClick={isDraft ? startTitleEdit : undefined}
                    className={`font-heading text-3xl font-semibold [text-wrap:balance] focus:outline-none ${isDraft ? "cursor-text" : ""}`}
                  >
                    {quiz.title}
                  </h1>
                  {isDraft && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => {
                        cancelTitleEdit();
                        setSettingsOpen(true);
                      }}
                      disabled={savingTitle || publishing}
                      aria-haspopup="dialog"
                      aria-expanded={settingsOpen}
                      aria-label={t("editSettings")}
                      className="size-8 opacity-40 transition-opacity group-hover/title:opacity-100 hover:opacity-100 focus-visible:opacity-100 rounded-lg"
                    >
                      <Settings2 className="size-4" />
                    </Button>
                  )}
                </div>
              )}

              {/* Status and Mode Chips */}
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <span className={`inline-flex items-center justify-center h-8 rounded-full border-[3px] px-3.5 text-xs font-extrabold select-none cursor-default ${STATUS_CLASS[quiz.status]}`}>
                  {getStatusLabel(quiz.status, locale)}
                </span>

                {isDraft ? (
                  <button
                    type="button"
                    onClick={() => {
                      cancelTitleEdit();
                      setSettingsOpen(true);
                    }}
                    disabled={savingTitle || publishing}
                    aria-haspopup="dialog"
                    aria-expanded={settingsOpen}
                    aria-label={t("modeBadgeLabel", { mode: getModeLabel(quiz.mode, locale) })}
                    className={`relative inline-flex items-center justify-center gap-1.5 h-8 rounded-full border-[3px] px-3.5 text-xs font-extrabold cursor-pointer transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-[var(--shadow-clay-sm)] active:translate-y-0 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/70 disabled:pointer-events-none disabled:opacity-60 before:absolute before:-inset-1.5 before:content-[''] ${MODE_CLASS[quiz.mode]}`}
                  >
                    <span>{getModeLabel(quiz.mode, locale)}</span>
                  </button>
                ) : (
                  <span className={`inline-flex items-center justify-center h-8 rounded-full border-[3px] px-3.5 text-xs font-extrabold select-none cursor-default ${MODE_CLASS[quiz.mode]}`}>
                    {getModeLabel(quiz.mode, locale)}
                  </span>
                )}

                {quiz.mode === "assessment" && quiz.time_limit_sec != null && (
                  isDraft ? (
                    <button
                      type="button"
                      onClick={() => {
                        cancelTitleEdit();
                        setSettingsOpen(true);
                      }}
                      disabled={savingTitle || publishing}
                      aria-haspopup="dialog"
                      aria-expanded={settingsOpen}
                      className="relative inline-flex items-center justify-center gap-1.5 h-8 rounded-full border-[3px] border-border bg-muted px-3.5 text-xs font-extrabold tabular-nums text-muted-foreground cursor-pointer transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-[var(--shadow-clay-sm)] active:translate-y-0 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/70 disabled:pointer-events-none disabled:opacity-60 before:absolute before:-inset-1.5 before:content-['']"
                    >
                      <Timer className="size-3.5" aria-hidden="true" />
                      <span>{formatDuration(quiz.time_limit_sec, locale)}</span>
                    </button>
                  ) : (
                    <span className="inline-flex items-center justify-center gap-1.5 h-8 rounded-full border-[3px] border-border bg-muted px-3.5 text-xs font-extrabold tabular-nums text-muted-foreground select-none cursor-default">
                      <Timer className="size-3.5" aria-hidden="true" />
                      {formatDuration(quiz.time_limit_sec, locale)}
                    </span>
                  )
                )}

                {(quiz.opens_at || quiz.closes_at) || quiz.status === "live" ? (
                  <button
                    type="button"
                    onClick={() => {
                      cancelTitleEdit();
                      setSettingsOpen(true);
                    }}
                    disabled={savingTitle || publishing || closing}
                    aria-haspopup="dialog"
                    aria-expanded={settingsOpen}
                    // Distinct accessible name when a window exists — the
                    // draft settings gear keeps "Quiz settings", so a draft
                    // with a window must not produce two identical names.
                    aria-label={
                      quiz.opens_at || quiz.closes_at
                        ? t("scheduleChip", {
                            window: formatWindow(quiz.opens_at, quiz.closes_at, locale),
                          })
                        : t("editSettings")
                    }
                    className="relative inline-flex items-center justify-center gap-1.5 h-8 rounded-full border-[3px] border-border bg-muted px-3.5 text-xs font-extrabold text-muted-foreground cursor-pointer transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-[var(--shadow-clay-sm)] active:translate-y-0 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/70 disabled:pointer-events-none disabled:opacity-60 before:absolute before:-inset-1.5 before:content-['']"
                  >
                    <CalendarClock className="size-3.5" aria-hidden="true" />
                    {(quiz.opens_at || quiz.closes_at)
                      ? formatWindow(quiz.opens_at, quiz.closes_at, locale)
                      : t("editSettings")}
                  </button>
                ) : null}

                <span className="inline-flex items-center justify-center h-8 rounded-full border-[3px] border-border bg-muted px-3.5 text-xs font-extrabold text-muted-foreground select-none cursor-default">
                  {t("questionCount", { count: questions.length })}
                </span>
              </div>
            </div>
            {/* Action cluster: grouped right so the hero's justify-between
                doesn't spread individual buttons across the row. */}
            <div className="flex flex-wrap items-center gap-3">
              {isDraft && (
                <Button
                  variant="outline"
                  onClick={() => setGenerateOpen(true)}
                >
                  <Wand2 className="mr-1.5 size-4" />
                  {t("generateFromFile")}
                </Button>
              )}
              {isDraft && (
                <Button
                  variant="outline"
                  onClick={() => setImportOpen(true)}
                >
                  <ListPlus className="mr-1.5 size-4" />
                  {t("importQuestions")}
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => setDuplicateOpen(true)}
                aria-haspopup="dialog"
                aria-expanded={duplicateOpen}
                aria-label={t("duplicateQuizAria", { title: quiz.title })}
              >
                <CopyPlus className="mr-1.5 size-4" />
                {t("duplicateQuiz")}
              </Button>
              {!isDraft && (
                <Link href={`/lecturer/quizzes/${quiz.id}/results`}>
                  <Button variant="accent">{t("viewResults")}</Button>
                </Link>
              )}
            </div>
          </div>
        </div>
      </section>

      <SourceTextPreview text={quiz.source_text} />

      <EditQuizDialog
        open={settingsOpen}
        onOpenChange={handleDialogClose}
        quiz={quiz}
        onSuccess={() => {
          toast.success(t("titleUpdated"));
          router.refresh();
        }}
        onError={(status, message) => {
          setError(message);
          if (status === 409) {
            router.refresh();
          } else if (status === 404) {
            router.push(`/lecturer/classes/${quiz.class_id}`);
          }
        }}
      />

      <GenerateFromFileDialog
        quizId={quiz.id}
        userId={userId}
        config={ocrConfig}
        open={generateOpen}
        onOpenChange={setGenerateOpen}
        hasQuestions={questions.length > 0}
      />

      <BulkImportDialog
        quizId={quiz.id}
        open={importOpen}
        onOpenChange={setImportOpen}
        questionCount={questions.length}
      />

      <DuplicateQuizDialog
        quizId={quiz.id}
        quizTitle={quiz.title}
        sourceClassId={quiz.class_id}
        // Unarchived owned classes only — an archived source class is
        // refused server-side, so it is never offered as a destination; the
        // dialog defaults to the first available class in that case.
        classes={classes}
        open={duplicateOpen}
        onOpenChange={setDuplicateOpen}
      />

      <EditQuestionDialog
        open={editingQuestion !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditingQuestion(null);
            setEditingIndex(null);
          }
        }}
        quizId={quiz.id}
        question={editingQuestion}
        questionIndex={editingIndex ?? undefined}
        // Live has-image state (flags overlay) — question.image_path is the
        // row captured at edit-start and goes stale after in-dialog ops.
        hasImageOverride={
          editingQuestion ? hasImageFor(editingQuestion.id) : undefined
        }
        onSuccess={() => {
          toast.success(t("questionUpdated"));
          router.refresh();
        }}
        onImageChanged={(has) =>
          editingQuestion &&
          setImageFlags((prev) => ({ ...prev, [editingQuestion.id]: has }))
        }
      />

      <RegenerateQuestionDialog
        open={regeneratingQuestion !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRegeneratingQuestion(null);
            setRegeneratingIndex(null);
          }
        }}
        question={regeneratingQuestion}
        questionIndex={regeneratingIndex ?? undefined}
        onSuccess={() => {
          toast.success(t("questionRegenerated"));
          router.refresh();
        }}
      />

      <div aria-live="polite">
        {error && (
          <div
            className="mb-4 flex items-center justify-between gap-3 rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-2 text-sm font-bold text-destructive"
            role="alert"
          >
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              aria-label={tCommon("close")}
              className="shrink-0 cursor-pointer rounded-lg p-1.5 transition-colors hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/40"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {isDraft && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>{t("addQuestionTitle")}</CardTitle>
            <CardDescription>
              {t("addQuestionSubtitle")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSave} className="space-y-4">
              <div className="flex flex-wrap items-center gap-4 sm:gap-6">
                <div className="space-y-1">
                  <Label htmlFor="q-type">{t("questionTypeLabel")}</Label>
                  <Select
                    value={draft.type}
                    onValueChange={(v) => {
                      const type = v as "mcq" | "true_false" | "multi_select";
                      setDraft((d) => {
                        if (type === "true_false") {
                          return {
                            ...d,
                            type,
                            options: defaultTrueFalseOptions,
                            correctIndex: 0,
                            correctIndices: undefined,
                          };
                        }
                        if (type === "multi_select") {
                          // QT-1 gesture amendment: multi questions cap at 4
                          // options (palm-commit reserves five fingers) — a
                          // 5-option draft cannot switch; ask the lecturer to
                          // remove one option first.
                          if (d.options.length > 4) {
                            setError(t("multiOptionCap"));
                            return d;
                          }
                          // Seed the set from the current single mark so
                          // the lecturer's answer choice survives the switch.
                          const seed = d.correctIndex ?? 0;
                          return {
                            ...d,
                            type,
                            options: d.options.length >= 2 ? d.options : ["", ""],
                            correctIndex: undefined,
                            correctIndices: [Math.min(seed, Math.max(d.options.length - 1, 0))],
                          };
                        }
                        return {
                          ...d,
                          type,
                          options: d.options.length >= 2 ? d.options : ["", ""],
                          correctIndex: d.correctIndices?.[0] ?? 0,
                          correctIndices: undefined,
                        };
                      });
                    }}
                  >
                    <SelectTrigger id="q-type" className="w-full sm:w-auto sm:min-w-[11rem]">
                      <SelectValue placeholder={t("questionTypeLabel")}>
                        {(v) =>
                          v === "true_false"
                            ? tCommon("trueFalse")
                            : v === "multi_select"
                              ? tCommon("multiSelect")
                              : tCommon("mcq")
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mcq">{tCommon("mcq")}</SelectItem>
                      <SelectItem value="true_false">{tCommon("trueFalse")}</SelectItem>
                      <SelectItem value="multi_select">{tCommon("multiSelect")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {draft.type === "multi_select" ? (
                  // QT-1: a dropdown cannot multi-select — the correct ANSWERS
                  // are a toggle-button group (aria-pressed per option).
                  <div className="space-y-1" role="group" aria-label={t("correctAnswersLabel")}>
                    <Label>{t("correctAnswersLabel")}</Label>
                    <div className="flex flex-wrap gap-1.5">
                      {draft.options.map((_, i) => {
                        const on = draft.correctIndices?.includes(i) ?? false;
                        return (
                          <button
                            key={i}
                            type="button"
                            aria-pressed={on}
                            onClick={() =>
                              setDraft((d) => {
                                const cur = d.correctIndices ?? [];
                                const next = cur.includes(i)
                                  ? cur.filter((x) => x !== i)
                                  : [...cur, i].sort((a, b) => a - b);
                                return { ...d, correctIndices: next };
                              })
                            }
                            className={`rounded-full border-[2px] px-3 py-1 text-xs font-extrabold transition-colors ${
                              on
                                ? "border-emerald-500 bg-emerald-100 dark:bg-emerald-950/50 text-emerald-900 dark:text-emerald-200"
                                : "border-border bg-muted/60 text-muted-foreground hover:border-emerald-300"
                            }`}
                          >
                            {t("optionLabel", { index: i + 1 })}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <Label htmlFor="q-correct">{t("correctAnswerLabel")}</Label>
                    <Select
                      value={String((draft.correctIndex ?? 0) + 1)}
                      onValueChange={(v) =>
                        setDraft((d) => ({ ...d, correctIndex: Number(v) - 1 }))
                      }
                    >
                      <SelectTrigger id="q-correct" className="w-full sm:w-auto sm:min-w-[10rem]">
                        <SelectValue placeholder={t("correctAnswerLabel")}>
                          {(v) => {
                            if (!v) return t("correctAnswerLabel");
                            const idx = Number(v) - 1;
                            if (draft.type === "true_false") {
                              return idx === 0 ? (locale === "ms" ? "Betul (True)" : "True") : (locale === "ms" ? "Salah (False)" : "False");
                            }
                            return t("optionLabel", { index: v });
                          }}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {draft.options.map((_, i) => (
                          <SelectItem key={i} value={String(i + 1)}>
                            {draft.type === "true_false"
                              ? (i === 0 ? (locale === "ms" ? "Betul (True)" : "True") : (locale === "ms" ? "Salah (False)" : "False"))
                              : t("optionLabel", { index: i + 1 })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <Label htmlFor="q-prompt">{t("promptLabel")}</Label>
                <Textarea
                  id="q-prompt"
                  value={draft.prompt}
                  onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
                  rows={3}
                  maxLength={2000}
                  required
                  placeholder={t("promptPlaceholder")}
                />
              </div>

              {/* Image sits between prompt and options — mirroring where the
                  player renders it above the options (WYSIWYG authoring). */}
              <QuestionImageField
                variant="staged"
                file={pendingImage}
                onFileChange={setPendingImage}
                altPrompt={draft.prompt}
                disabled={saving}
              />

              <div className="space-y-2">
                <Label>{t("correctAnswerLabel")}</Label>
                {draft.options.map((opt, i) => {
                  const isCorrect =
                    draft.type === "multi_select"
                      ? (draft.correctIndices?.includes(i) ?? false)
                      : draft.correctIndex === i;

                  return (
                    <div key={i} className="flex items-center gap-2">
                      <button
                        type="button"
                        title={t("correctAnswerLabel")}
                        onClick={() => {
                          if (draft.type === "multi_select") {
                            setDraft((d) => {
                              const cur = d.correctIndices ?? [];
                              const next = cur.includes(i)
                                ? cur.filter((x) => x !== i)
                                : [...cur, i].sort((a, b) => a - b);
                              return { ...d, correctIndices: next };
                            });
                          } else {
                            setDraft((d) => ({ ...d, correctIndex: i }));
                          }
                        }}
                        className={`flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-xl font-heading text-xs font-extrabold transition-all hover:scale-105 active:scale-95 shadow-xs ${
                          isCorrect
                            ? "border-[2px] border-emerald-500 bg-emerald-100 dark:bg-emerald-950/50 text-emerald-900 dark:text-emerald-200"
                            : "border-[2px] border-border bg-muted/60 text-muted-foreground hover:border-emerald-300"
                        }`}
                      >
                        {isCorrect ? "✓" : i + 1}
                      </button>
                      <Input
                        value={opt}
                        onChange={(e) => setOption(i, e.target.value)}
                        maxLength={500}
                        placeholder={t("optionLabel", { index: i + 1 })}
                        aria-label={t("optionLabel", { index: i + 1 })}
                        disabled={draft.type === "true_false"}
                        className="flex-1"
                      />
                    {draft.type !== "true_false" && (
                      <>
                        {draft.options.length > 1 && (
                          <div className="flex items-center gap-0.5">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => moveOption(i, "up")}
                              disabled={i === 0}
                              aria-label={`${t("moveUp")} ${i + 1}`}
                            >
                              <ArrowUp className="size-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => moveOption(i, "down")}
                              disabled={i === draft.options.length - 1}
                              aria-label={`${t("moveDown")} ${i + 1}`}
                            >
                              <ArrowDown className="size-4" />
                            </Button>
                          </div>
                        )}
                        {draft.options.length > 2 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => removeOption(i)}
                            aria-label={`${t("deleteBtn")} ${i + 1}`}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                      </>
                    )}
                    </div>
                  );
                })}
                {draft.type === "mcq" && draft.options.length < 5 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addOption}
                  >
                    {t("addOptionBtn")}
                  </Button>
                )}
                {draft.type === "multi_select" && draft.options.length < 4 && (
                  // QT-1 gesture amendment: multi questions cap at 4 options
                  // (palm-commit reserves five fingers).
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addOption}
                  >
                    {t("addOptionBtn")}
                  </Button>
                )}
              </div>

              <div className="space-y-1">
                <Label htmlFor="q-explanation" className="font-extrabold">{t("explanationLabel")}</Label>
                <Textarea
                  id="q-explanation"
                  value={draft.explanation}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, explanation: e.target.value }))
                  }
                  rows={2}
                  maxLength={2000}
                  placeholder={t("explanationPlaceholder")}
                />
              </div>

              <div className="flex items-center gap-3">
                <Button type="submit" disabled={saving || !draft.prompt.trim()}>
                  {saving ? tCommon("loading") : t("addQuestionSubmitBtn")}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>{t("questionsHeader")}</CardTitle>
            <CardDescription>
              {t("questionCount", { count: questions.length })}
            </CardDescription>
          </div>
          {isDraft && (
            <Button
              onClick={handlePublish}
              disabled={publishing || questions.length === 0}
            >
              {publishing ? t("publishingBtn") : t("publishBtn")}
            </Button>
          )}
          {quiz.status === "live" && (
            <Button
              variant="destructive"
              onClick={() => {
                setCloseCooled(false);
                setCloseOpen(true);
              }}
              disabled={closing}
            >
              {closing ? t("closing") : t("closeQuiz")}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {questions.length === 0 ? (
            <p className="rounded-2xl border-[3px] border-dashed border-border bg-card p-6 text-center text-sm font-semibold text-muted-foreground">
              {t("noQuestionsSubtitle")}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {questions.map((q, idx) => (
                <li key={q.id} className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-heading text-sm font-semibold text-muted-foreground">{idx + 1}.</span>
                      <span className="rounded-full border-[3px] border-border bg-muted px-2.5 py-0.5 text-xs font-extrabold text-foreground">
                        {q.type === "mcq"
                          ? tCommon("mcq")
                          : q.type === "multi_select"
                            ? tCommon("multiSelect")
                            : tCommon("trueFalse")}
                      </span>
                      {hasImageFor(q.id) && (
                        <span className="inline-flex items-center gap-1 rounded-full border-[3px] border-border bg-muted px-2.5 py-0.5 text-xs font-extrabold text-foreground">
                          <ImageIcon className="size-3" aria-hidden />
                          {tMedia("imageBadge")}
                        </span>
                      )}
                      <span className="text-xs font-bold text-muted-foreground">
                        {q.type === "multi_select"
                          ? `${t("correctAnswersLabel")}: ${(q.correct_indices ?? []).map((i) => t("optionLabel", { index: i + 1 })).join(", ") || "—"}`
                          : q.type === "true_false"
                            ? `${t("correctAnswerLabel")}: ${q.options[q.correct_index ?? 0] ?? (q.correct_index === 0 ? "True" : "False")}`
                            : `${t("correctAnswerLabel")}: ${t("optionLabel", { index: (q.correct_index ?? 0) + 1 })}`}
                      </span>
                    </div>
                    <p className="mt-1.5 font-heading text-base font-semibold">{q.prompt}</p>
                    <p className="mt-1 text-sm font-semibold text-muted-foreground">
                      {q.options.join(" · ")}
                    </p>
                    {q.explanation && (
                      <p className="mt-1.5 text-xs font-semibold text-muted-foreground">
                        <strong className="font-extrabold text-foreground">{t("explanationLabel")}:</strong> {q.explanation}
                      </p>
                    )}
                  </div>
                  {isDraft && (
                    <div className="flex flex-wrap items-center gap-1.5 self-end sm:self-start sm:shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setRegeneratingQuestion(q);
                          setRegeneratingIndex(idx);
                        }}
                        aria-label={t("regenerateBtn")}
                        className="h-8 gap-1.5 px-2.5 text-xs font-bold"
                      >
                        <Wand2 className="size-3.5 text-primary" />
                        {t("regenerateBtn")}
                      </Button>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => startEdit(q, idx)}
                              aria-label={t("editBtn")}
                              className="size-8"
                            >
                              <Pencil className="size-4" />
                            </Button>
                          }
                        />
                        <TooltipContent>{t("editBtn")}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => handleMove(q, "up")}
                              disabled={idx === 0 || reordering}
                              aria-label={t("moveUp")}
                              className="size-8"
                            >
                              <ArrowUp className="size-4" />
                            </Button>
                          }
                        />
                        <TooltipContent>{t("moveUp")}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => handleMove(q, "down")}
                              disabled={idx === questions.length - 1 || reordering}
                              aria-label={t("moveDown")}
                              className="size-8"
                            >
                              <ArrowDown className="size-4" />
                            </Button>
                          }
                        />
                        <TooltipContent>{t("moveDown")}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => handleDelete(q)}
                              aria-label={t("deleteBtn")}
                              className="size-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          }
                        />
                        <TooltipContent>{t("deleteBtn")}</TooltipContent>
                      </Tooltip>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Close confirm dialog (QC-1) — terminal action, cool-down + busy lock;
          errors render INSIDE the modal (a page-level band would sit behind it) */}
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
            <DialogTitle>{t("closeConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("closeConfirmBody")}</DialogDescription>
          </DialogHeader>
          {closeError && (
            <p
              role="alert"
              className="rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm font-bold text-destructive"
            >
              {closeError}
            </p>
          )}
          {unrevealedCompleted > 0 && (
            <p
              role="status"
              className="rounded-2xl border-[3px] border-amber-400/50 bg-amber-100/70 px-4 py-3 text-sm font-bold text-amber-950 dark:border-amber-600/40 dark:bg-amber-950/40 dark:text-amber-200"
            >
              {t("closeUnrevealedWarn", { count: unrevealedCompleted })}
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
                disabled={closeCooled || closing}
                onClick={() => void handleRevealThenClose()}
              >
                {closing ? tCommon("loading") : t("revealFirstThenClose")}
              </Button>
            )}
            <Button
              variant="destructive"
              disabled={closeCooled || closing}
              onClick={() => void handleCloseQuiz()}
            >
              {closing ? t("closing") : unrevealedCompleted > 0 ? t("closeAnyway") : t("closeQuiz")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete-question confirmation (replaces window.confirm) ── */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="border-destructive/30 bg-destructive/10 text-destructive">
              <Trash2 className="size-6" aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>{t("deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteConfirmBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>
              {tCommon("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteBusy}
              onClick={() => void confirmDelete()}
            >
              {deleteBusy ? tCommon("loading") : tCommon("confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
