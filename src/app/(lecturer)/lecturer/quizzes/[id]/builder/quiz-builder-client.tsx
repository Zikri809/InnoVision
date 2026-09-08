"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowDown, ArrowLeft, ArrowUp, CalendarClock, Check, ChevronDown, CopyPlus, Image as ImageIcon, Lightbulb, ListPlus, MoreVertical, Pencil, Plus, Settings2, Timer, Trash2, Wand2, X } from "lucide-react";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { GenerateFromFileDialog } from "@/components/extract/GenerateFromFileDialog";
import { QuizSourcesCard } from "@/components/quiz/sources-card";
import { EditQuestionDialog } from "@/components/quiz/edit-question-dialog";
import { RegenerateQuestionDialog } from "@/components/quiz/regenerate-question-dialog";
import { EditQuizDialog } from "@/components/quiz/edit-quiz-dialog";
import { BulkImportDialog } from "@/components/quiz/bulk-import-dialog";
import { DuplicateQuizDialog } from "@/components/quiz/duplicate-quiz-dialog";
import { QuestionImageField } from "@/components/media/question-image-field";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useKeyboardOcclusion } from "@/hooks/use-keyboard-occlusion";
import type { OcrConfig } from "@/lib/extract/types";
import type { QuizSourceRow } from "@/lib/quizzes/sources";

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
  sources = [],
  hasWebSearch = false,
}: {
  quiz: QuizInfo;
  questions: QuestionRow[];
  userId: string;
  /** AP-2: owned, unarchived classes — duplicate destination options. */
  classes: Array<{ id: string; title: string }>;
  /** QC-2: completed assessment sessions with hidden results (close-dialog warning). */
  unrevealedCompleted?: number;
  ocrConfig: OcrConfig;
  /** Source provenance (mixed-shape parser output; grounded-search.md §7). */
  sources?: QuizSourceRow[];
  /** TinyFish flag from the server env — gates the dialog's Web-topic mode. */
  hasWebSearch?: boolean;
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
  const [mobileAddOpen, setMobileAddOpen] = useState(false);
  const [reordering, setReordering] = useState(false);

  // ── Mobile review composition (builder-m1) ──────────────────────────────
  // The desktop list stays fully-expanded card-by-card — the desktop e2e
  // suite (e23/e2b) pins per-row buttons and visible option text, so the
  // accordion composition below renders ONLY below the sm breakpoint.
  const isMobile = useMediaQuery("(max-width: 639px)");
  // Accordion: which question card is expanded (single at a time — the list
  // is for SCANNING, the expansion is for WORKING). Desktop ignores this.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // "Reviewed" checklist (drafts only): which question ids the lecturer has
  // verified. Session-scoped + device-local (localStorage) on purpose —
  // verification is a working state, not quiz data; no schema/API surface.
  const [reviewedIds, setReviewedIds] = useState<Set<string>>(new Set());
  const reviewedLoaded = useRef(false);
  const [unreviewedOnly, setUnreviewedOnly] = useState(false);
  useKeyboardOcclusion();

  const reviewedKey = `builder-reviewed-${quiz.id}`;
  // Read-once hydration from device-local storage — lazy useState init is
  // wrong here (runs on the server too, and localStorage only exists once
  // isMobile is true client-side). localStorage is a genuine external system
  // and the read must not re-run — later toggles own the state.
  useEffect(() => {
    if (!isDraft || !isMobile) return;
    try {
      const raw = window.localStorage.getItem(reviewedKey);
      if (raw)
        // eslint-disable-next-line react-hooks/set-state-in-effect -- read-once external init
        setReviewedIds(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* corrupted storage → start clean */
    }
    reviewedLoaded.current = true;
  }, [isDraft, isMobile, reviewedKey]);

  function markReviewed(id: string, next: boolean) {
    setReviewedIds((prev) => {
      const set = new Set(prev);
      if (next) set.add(id);
      else set.delete(id);
      try {
        window.localStorage.setItem(reviewedKey, JSON.stringify([...set]));
      } catch {
        /* private mode / quota — in-session state still works */
      }
      return set;
    });
  }

  // Stale reviewed ids (post-delete / post-refresh) never inflate the count:
  // intersect with the live question ids at render instead of via an effect.
  const liveSet = useMemo(() => new Set(questions.map((q) => q.id)), [questions]);
  const liveReviewedIds = useMemo(
    () => new Set([...reviewedIds].filter((id) => liveSet.has(id))),
    [reviewedIds, liveSet],
  );
  const reviewedCount = liveReviewedIds.size;
  const visibleQuestions = unreviewedOnly
    ? questions.filter((q) => !liveReviewedIds.has(q.id))
    : questions;

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

  function renderQuestionForm(inSheet: boolean = false) {
    const idPrefix = inSheet ? "sheet-" : "";
    return (
      <form onSubmit={handleSave} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}q-type`}>{t("questionTypeLabel")}</Label>
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
              <SelectTrigger id={`${idPrefix}q-type`} className="w-full">
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
              <div className="flex flex-wrap gap-1.5 pt-1">
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
              <Label htmlFor={`${idPrefix}q-correct`}>{t("correctAnswerLabel")}</Label>
              <Select
                value={String((draft.correctIndex ?? 0) + 1)}
                onValueChange={(v) =>
                  setDraft((d) => ({ ...d, correctIndex: Number(v) - 1 }))
                }
              >
                <SelectTrigger id={`${idPrefix}q-correct`} className="w-full">
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
          <Label htmlFor={`${idPrefix}q-prompt`}>{t("promptLabel")}</Label>
          <Textarea
            id={`${idPrefix}q-prompt`}
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
          <Label className="font-extrabold">{t("optionsLabel")}</Label>
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
                  className={`flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-xl font-heading text-xs font-extrabold transition-[transform,border-color,background-color] hover:scale-105 active:scale-95 shadow-xs ${
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
          <Label htmlFor={`${idPrefix}q-explanation`} className="font-extrabold">{t("explanationLabel")}</Label>
          <Textarea
            id={`${idPrefix}q-explanation`}
            value={draft.explanation}
            onChange={(e) =>
              setDraft((d) => ({ ...d, explanation: e.target.value }))
            }
            rows={2}
            maxLength={2000}
            placeholder={t("explanationPlaceholder")}
          />
        </div>

        <div className="flex items-center gap-3 pt-2">
          <Button type="submit" disabled={saving || !draft.prompt.trim()}>
            {saving ? tCommon("loading") : t("addQuestionSubmitBtn")}
          </Button>
          {inSheet && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setMobileAddOpen(false)}
            >
              {tCommon("done")}
            </Button>
          )}
        </div>
      </form>
    );
  }

  /** Option list for the mobile accordion's expanded panel — the same
   * player-mirroring rows the desktop card renders (single source for the
   * "green = correct" visual so both compositions stay in sync). */
  function mobileOptionsFor(q: QuestionRow) {
    const correctSet = q.type === "multi_select" ? (q.correct_indices ?? []) : null;
    return (
      <ul className="mt-2.5 space-y-1.5">
        {q.options.map((opt, i) => {
          const isCorrect = correctSet
            ? correctSet.includes(i)
            : (q.correct_index ?? 0) === i;
          return (
            <li
              key={i}
              className={`flex items-start gap-2 rounded-xl border-2 px-2.5 py-1.5 text-sm font-semibold transition-colors ${
                isCorrect
                  ? "border-emerald-500/70 bg-emerald-100/70 text-emerald-950 dark:border-emerald-400/40 dark:bg-emerald-950/40 dark:text-emerald-100"
                  : "border-transparent bg-card/70 text-foreground dark:bg-card/50"
              }`}
            >
              <span
                aria-hidden
                className="font-heading text-xs font-bold text-muted-foreground"
              >
                {String.fromCharCode(65 + i)}
              </span>
              <span className="min-w-0 flex-1 break-words">{opt}</span>
              {isCorrect && (
                <Check
                  className="mt-0.5 size-4 shrink-0 text-emerald-700 dark:text-emerald-300"
                  aria-hidden
                />
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="space-y-3.5 sm:space-y-6">
      {/* ── Hero band ── */}
      <section className="relative overflow-hidden rounded-[24px] sm:rounded-[28px] border-2 sm:border-[3px] border-border bg-gradient-to-br from-orange-100 via-orange-50 to-blue-50 dark:from-orange-950/40 dark:via-card dark:to-blue-950/40 shadow-[var(--shadow-clay-sm)] sm:shadow-[var(--shadow-clay)]">
        {/* Content area (padded) */}
        <div className="relative p-4 pb-3.5 sm:p-7 md:p-8">
          <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-32 w-32 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/40 dark:bg-white/5" />

          {/* Top row: Back link + Settings button */}
          <div className="flex items-center justify-between gap-3">
            <Link
              href={`/lecturer/classes/${quiz.class_id}`}
              className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-extrabold text-muted-foreground transition-colors hover:text-primary truncate"
            >
              <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />
              <span className="truncate">{quiz.class_title}</span>
            </Link>
            {isDraft && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                ref={settingsBtnRef}
                onClick={() => {
                  cancelTitleEdit();
                  setSettingsOpen(true);
                }}
                disabled={savingTitle || publishing}
                aria-haspopup="dialog"
                aria-expanded={settingsOpen}
                aria-label={t("editSettings")}
                className="size-8 shrink-0 rounded-lg text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/10"
              >
                <Settings2 className="size-4" />
              </Button>
            )}
          </div>

          {/* Title */}
          <div className="mt-3 min-w-0">
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
                  className="h-11 sm:h-12 w-full max-w-xl min-w-0 rounded-xl sm:rounded-2xl border-2 sm:border-[3px] border-primary/40 bg-card px-3 sm:px-4 font-heading text-lg sm:text-2xl font-semibold shadow-[var(--shadow-clay-in)] focus-visible:ring-primary/30"
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
              <h1
                ref={headingRef}
                tabIndex={-1}
                onDoubleClick={isDraft ? startTitleEdit : undefined}
                className={`font-heading text-2xl sm:text-3xl font-semibold leading-tight [text-wrap:balance] focus:outline-none ${isDraft ? "cursor-text" : ""}`}
              >
                {quiz.title}
              </h1>
            )}
          </div>

          {/* Status and Mode Chips */}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 sm:gap-2">
            <span className={`inline-flex items-center justify-center h-7 sm:h-8 rounded-full border-2 sm:border-[3px] px-2.5 sm:px-3.5 text-2xs sm:text-xs font-extrabold select-none cursor-default ${STATUS_CLASS[quiz.status]}`}>
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
                className={`relative inline-flex items-center justify-center gap-1.5 h-7 sm:h-8 rounded-full border-2 sm:border-[3px] px-2.5 sm:px-3.5 text-2xs sm:text-xs font-extrabold cursor-pointer transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-[var(--shadow-clay-sm)] active:translate-y-0 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/70 disabled:pointer-events-none disabled:opacity-60 before:absolute before:-inset-1.5 before:content-[''] ${MODE_CLASS[quiz.mode]}`}
              >
                <span>{getModeLabel(quiz.mode, locale)}</span>
              </button>
            ) : (
              <span className={`inline-flex items-center justify-center h-7 sm:h-8 rounded-full border-2 sm:border-[3px] px-2.5 sm:px-3.5 text-2xs sm:text-xs font-extrabold select-none cursor-default ${MODE_CLASS[quiz.mode]}`}>
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
                  className="relative inline-flex items-center justify-center gap-1.5 h-7 sm:h-8 rounded-full border-2 sm:border-[3px] border-border bg-muted px-2.5 sm:px-3.5 text-2xs sm:text-xs font-extrabold tabular-nums text-muted-foreground cursor-pointer transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-[var(--shadow-clay-sm)] active:translate-y-0 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/70 disabled:pointer-events-none disabled:opacity-60 before:absolute before:-inset-1.5 before:content-['']"
                >
                  <Timer className="size-3 sm:size-3.5" aria-hidden="true" />
                  <span>{formatDuration(quiz.time_limit_sec, locale)}</span>
                </button>
              ) : (
                <span className="inline-flex items-center justify-center gap-1.5 h-7 sm:h-8 rounded-full border-2 sm:border-[3px] border-border bg-muted px-2.5 sm:px-3.5 text-2xs sm:text-xs font-extrabold tabular-nums text-muted-foreground select-none cursor-default">
                  <Timer className="size-3 sm:size-3.5" aria-hidden="true" />
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
                aria-label={
                  quiz.opens_at || quiz.closes_at
                    ? t("scheduleChip", {
                        window: formatWindow(quiz.opens_at, quiz.closes_at, locale),
                      })
                    : t("editSettings")
                }
                className="relative inline-flex items-center justify-center gap-1.5 h-7 sm:h-8 rounded-full border-2 sm:border-[3px] border-border bg-muted px-2.5 sm:px-3.5 text-2xs sm:text-xs font-extrabold text-muted-foreground cursor-pointer transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-[var(--shadow-clay-sm)] active:translate-y-0 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/70 disabled:pointer-events-none disabled:opacity-60 before:absolute before:-inset-1.5 before:content-['']"
              >
                <CalendarClock className="size-3 sm:size-3.5" aria-hidden="true" />
                {(quiz.opens_at || quiz.closes_at)
                  ? formatWindow(quiz.opens_at, quiz.closes_at, locale)
                  : t("editSettings")}
              </button>
            ) : null}

            <span className="inline-flex items-center justify-center h-7 sm:h-8 rounded-full border-2 sm:border-[3px] border-border bg-muted px-2.5 sm:px-3.5 text-2xs sm:text-xs font-extrabold text-muted-foreground select-none cursor-default">
              {t("questionCount", { count: questions.length })}
            </span>
          </div>

          {/* Desktop action cluster (sm+) — sits below chips on desktop */}
          <div className="mt-4 hidden items-center gap-3 sm:flex">
            {isDraft && (
              <Button
                variant="accent"
                onClick={() => setGenerateOpen(true)}
                className="h-11 rounded-2xl px-4 text-sm font-extrabold gap-1.5 shadow-[var(--shadow-clay-sm)]"
              >
                <Wand2 className="size-4 shrink-0" />
                <span>{t("generateFromFile")}</span>
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
                <Button variant="accent" className="h-11 rounded-2xl px-4 text-sm font-extrabold">{t("viewResults")}</Button>
              </Link>
            )}
          </div>
        </div>

        {/* ── Mobile action strip — anchored at card bottom, full-width ──
            Draft job changes with content: EMPTY quiz → Generate is the
            primary action; once questions exist the job is verify & publish,
            so Add question leads and Generate demotes into the ⋯ menu. */}
        <div className="flex items-center gap-2 border-t-2 border-border/50 bg-white/25 px-4 py-3 dark:bg-black/10 sm:hidden">
          {isDraft && questions.length === 0 && (
            <Button
              variant="accent"
              onClick={() => setGenerateOpen(true)}
              className="h-10 flex-1 rounded-xl px-3 text-xs font-extrabold gap-1.5 shadow-[var(--shadow-clay-sm)]"
            >
              <Wand2 className="size-4 shrink-0" />
              <span>{t("generateFromFile")}</span>
            </Button>
          )}
          {isDraft && questions.length > 0 && (
            <Button
              onClick={() => setMobileAddOpen(true)}
              className="h-10 flex-1 rounded-xl px-3 text-xs font-extrabold gap-1.5 shadow-[var(--shadow-clay-sm)]"
            >
              <Plus className="size-4 shrink-0" />
              <span>{t("addQuestionBtn")}</span>
            </Button>
          )}
          {!isDraft && (
            <Link href={`/lecturer/quizzes/${quiz.id}/results`} className="flex-1">
              <Button variant="accent" className="h-10 w-full rounded-xl px-3 text-xs font-extrabold">
                {t("viewResults")}
              </Button>
            </Link>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  className="h-10 w-10 shrink-0 rounded-xl border-2 border-border bg-card/80 text-foreground shadow-[var(--shadow-clay-sm)] hover:bg-muted active:translate-y-0.5"
                  aria-label={t("moreActions")}
                >
                  <MoreVertical className="size-4" aria-hidden="true" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-48 shadow-[var(--shadow-clay)]">
              {isDraft && questions.length > 0 && (
                <DropdownMenuItem
                  onClick={() => setGenerateOpen(true)}
                  className="flex items-center gap-2 cursor-pointer font-bold"
                >
                  <Wand2 className="size-4 text-primary" />
                  <span>{t("generateFromFile")}</span>
                </DropdownMenuItem>
              )}
              {isDraft && questions.length === 0 && (
                <DropdownMenuItem
                  onClick={() => setMobileAddOpen(true)}
                  className="flex items-center gap-2 cursor-pointer font-bold"
                >
                  <Plus className="size-4 text-muted-foreground" />
                  <span>{t("addQuestionBtn")}</span>
                </DropdownMenuItem>
              )}
              {isDraft && (
                <DropdownMenuItem
                  onClick={() => setImportOpen(true)}
                  className="flex items-center gap-2 cursor-pointer font-bold"
                >
                  <ListPlus className="size-4 text-muted-foreground" />
                  <span>{t("importQuestions")}</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => setDuplicateOpen(true)}
                className="flex items-center gap-2 cursor-pointer font-bold"
              >
                <CopyPlus className="size-4 text-muted-foreground" />
                <span>{t("duplicateQuiz")}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </section>

      <QuizSourcesCard sources={sources} text={quiz.source_text} />

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
        hasWebSearch={hasWebSearch}
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
        <>
          {/* Mobile Add-Question Bottom Sheet (won't auto-close on submit for continuous batch authoring) */}
          <Sheet open={mobileAddOpen} onOpenChange={setMobileAddOpen}>
            <SheetContent
              side="bottom"
              className="max-h-[92dvh] overflow-hidden flex flex-col rounded-t-[28px] border-t-[3px] border-x-[3px] border-border bg-card p-0 shadow-[var(--shadow-clay-up)]"
            >
              <SheetHeader className="p-4 sm:p-5 pb-3 pr-12 border-b-2 sm:border-b-[3px] border-border/40 shrink-0">
                <SheetTitle className="text-lg sm:text-xl font-bold font-heading">{t("addQuestionTitle")}</SheetTitle>
                <SheetDescription className="text-xs sm:text-sm font-semibold text-muted-foreground">{t("addQuestionSubtitle")}</SheetDescription>
              </SheetHeader>
              <div className="flex-1 overflow-y-auto p-4 sm:p-5 pb-8">
                {renderQuestionForm(true)}
              </div>
            </SheetContent>
          </Sheet>

          {/* Desktop Inline Card (md+) */}
          <Card className="hidden md:block mb-6">
            <CardHeader>
              <CardTitle>{t("addQuestionTitle")}</CardTitle>
              <CardDescription>
                {t("addQuestionSubtitle")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {renderQuestionForm(false)}
            </CardContent>
          </Card>
        </>
      )}

      <section
        aria-labelledby="questions-heading"
        className="overflow-hidden rounded-[24px] sm:rounded-[28px] border-2 sm:border-[3px] border-border bg-card shadow-[var(--shadow-clay-sm)] sm:shadow-[var(--shadow-clay)]"
      >
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2.5 p-4 sm:p-6 sm:pb-4">
          <div className="min-w-0">
            <h2
              id="questions-heading"
              className="font-heading text-xl font-bold sm:text-2xl"
            >
              {t("questionsHeader")}
            </h2>
            <p className="text-xs font-bold text-muted-foreground sm:text-sm sm:font-semibold">
              {t("questionCount", { count: questions.length })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Tablet-only (sm–md) add chip: the sheet below md, hidden on
                desktop where the inline add card renders. Mobile gets Add in
                the hero strip / sticky bar instead. */}
            {isDraft && !isMobile && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setMobileAddOpen(true)}
                className="md:hidden h-9 rounded-xl border-2 border-primary/40 bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary font-extrabold shadow-[var(--shadow-sm)] gap-1 px-3 text-xs"
              >
                <Plus className="size-3.5" />
                <span>{t("addQuestionBtn")}</span>
              </Button>
            )}
            {isDraft && !isMobile && (
              <Button
                size="sm"
                onClick={handlePublish}
                disabled={publishing || questions.length === 0}
                className="h-9 sm:h-10 rounded-xl sm:rounded-2xl px-3.5 sm:px-5 text-xs sm:text-sm font-extrabold shadow-[var(--shadow-clay-sm)]"
              >
                {publishing ? t("publishingBtn") : t("publishBtn")}
              </Button>
            )}
            {quiz.status === "live" && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setCloseCooled(false);
                  setCloseOpen(true);
                }}
                disabled={closing}
                className="h-9 sm:h-10 rounded-xl sm:rounded-2xl px-3.5 sm:px-5 text-xs sm:text-sm font-extrabold"
              >
                {closing ? t("closing") : t("closeQuiz")}
              </Button>
            )}
          </div>
        </div>
        {/* Mobile review toolbar (drafts only): the verified-checklist filter.
            Desktop renders no filter — its fully-expanded cards ARE the review
            surface, and the desktop e2e suite asserts this header bare. */}
        {isDraft && isMobile && questions.length > 0 && (
          <div className="flex items-center gap-2 px-4 pb-3 sm:px-6">
            <div
              role="group"
              aria-label={t("reviewFilterLabel")}
              className="flex items-center gap-1.5"
            >
              <button
                type="button"
                aria-pressed={!unreviewedOnly}
                onClick={() => setUnreviewedOnly(false)}
                className={`rounded-full border-2 px-3 py-1 text-xs font-extrabold transition-colors ${
                  !unreviewedOnly
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-muted/60 text-muted-foreground"
                }`}
              >
                {t("filterAll")} {questions.length}
              </button>
              <button
                type="button"
                aria-pressed={unreviewedOnly}
                onClick={() => setUnreviewedOnly(true)}
                className={`rounded-full border-2 px-3 py-1 text-xs font-extrabold transition-colors ${
                  unreviewedOnly
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-muted/60 text-muted-foreground"
                }`}
              >
                {t("filterUnreviewed")} {questions.length - reviewedCount}
              </button>
            </div>
            <p
              className="ml-auto text-2xs font-extrabold tabular-nums text-muted-foreground"
              aria-live="polite"
            >
              {t("reviewedProgress", { done: reviewedCount, total: questions.length })}
            </p>
          </div>
        )}
        <div className="px-4 pb-4 sm:px-6 sm:pb-6">
          {questions.length === 0 ? (
            <div className="rounded-[20px] border-[3px] border-dashed border-border bg-muted/40 px-6 py-8 text-center sm:py-10">
              <span
                aria-hidden
                className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl border-[3px] border-border bg-card text-muted-foreground shadow-[var(--shadow-clay-sm)]"
              >
                <ListPlus className="size-6" />
              </span>
              <p className="font-heading text-base font-semibold text-foreground">
                {t("noQuestionsTitle")}
              </p>
              <p className="mx-auto mt-1 max-w-sm text-sm font-semibold text-muted-foreground">
                {t("noQuestionsSubtitle")}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border/40 sm:space-y-4 sm:divide-y-0">
              {visibleQuestions.map((q, idx) => {
                const correctSet =
                  q.type === "multi_select" ? (q.correct_indices ?? []) : null;
                // Mobile composition (below sm): accordion rows + ⋯ menu +
                // reviewed toggle. The aria label carries the position in the
                // FILTERED list for the desktop parity branch (m-is the
                // mobile variant, which always renders the full list).
                const globalIdx = questions.indexOf(q);
                const correctChip = correctSet
                  ? `${t("correctAnswersLabel")}: ${(correctSet).map((i) => t("optionLabel", { index: i + 1 })).join(", ") || "—"}`
                  : q.type === "true_false"
                    ? `${t("correctAnswerLabel")}: ${q.options[q.correct_index ?? 0] ?? (q.correct_index === 0 ? "True" : "False")}`
                    : `${t("correctAnswerLabel")}: ${t("optionLabel", { index: (q.correct_index ?? 0) + 1 })}`;
                return (
                  <li key={q.id}>
                    {isMobile ? (
                      /* ── Mobile list row (below sm) — minimal: check circle,
                          number, 2-line prompt, chevron. No metadata chips —
                          type and answer key live in the expansion where the
                          green option highlight is the single key indicator. ── */
                      <div>
                        <div className="flex items-start gap-1 px-1 py-2.5">
                          {/* Reviewed toggle — DRAFT-ONLY: ticking off AI
                              questions before publish is a draft workflow, so
                              live/closed rows drop the circle entirely (it
                              read like a radio "select" with nothing to do).
                              40px hit area keeps it thumb-friendly. */}
                          {isDraft && (
                            <button
                              type="button"
                              aria-pressed={liveReviewedIds.has(q.id)}
                              onClick={() => markReviewed(q.id, !liveReviewedIds.has(q.id))}
                              aria-label={`${liveReviewedIds.has(q.id) ? t("markUnreviewed") : t("markReviewed")} — ${globalIdx + 1}`}
                              className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-full focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring"
                            >
                              <span
                                className={`grid size-6 place-items-center rounded-full border-2 transition-colors ${
                                  liveReviewedIds.has(q.id)
                                    ? "border-emerald-600 bg-emerald-500 text-white"
                                    : "border-muted-foreground/40 text-transparent"
                                }`}
                              >
                                <Check className="size-4" aria-hidden />
                              </span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setExpandedId(expandedId === q.id ? null : q.id)}
                            aria-expanded={expandedId === q.id}
                            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-xl py-0.5 pl-1 text-left hover:bg-muted/30 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="flex items-start gap-1.5">
                                <span className={`font-heading text-sm font-semibold leading-6 tabular-nums ${liveReviewedIds.has(q.id) ? "text-muted-foreground/60" : "text-muted-foreground"}`}>
                                  {globalIdx + 1}.
                                </span>
                                <span className={`min-w-0 flex-1 font-heading text-sm font-semibold leading-6 line-clamp-2 ${liveReviewedIds.has(q.id) ? "text-muted-foreground" : "text-foreground"}`}>
                                  {q.prompt}
                                </span>
                                {hasImageFor(q.id) && (
                                  <ImageIcon className="mt-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                                )}
                              </span>
                            </span>
                            <ChevronDown
                              aria-hidden
                              className={`mt-1 size-4 shrink-0 text-muted-foreground transition-transform duration-200 ${expandedId === q.id ? "rotate-180" : ""}`}
                            />
                          </button>
                        </div>
                        {expandedId === q.id && (
                          <div className={`mr-1 border-t-2 border-border/40 pb-3.5 pt-2.5 ${isDraft ? "ml-[44px]" : "ml-1"}`}>
                            {/* Type label only — the answer key itself is
                                already shown by the green option highlight
                                below; a "Correct answer" pill would repeat
                                it twice in one panel. */}
                            <div className="flex flex-wrap items-center gap-1.5 px-1">
                              <span className="text-2xs font-extrabold uppercase tracking-wide text-muted-foreground">
                                {q.type === "mcq"
                                  ? tCommon("mcq")
                                  : q.type === "multi_select"
                                    ? tCommon("multiSelect")
                                    : tCommon("trueFalse")}
                              </span>
                            </div>
                            {mobileOptionsFor(q)}
                            {q.explanation && (
                              <div className="mt-2.5 flex items-start gap-2 rounded-xl border-2 border-border/60 bg-muted/50 px-3 py-2 dark:border-border/40 dark:bg-muted/30">
                                <Lightbulb
                                  className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
                                  aria-hidden
                                />
                                <p className="text-xs font-semibold leading-relaxed text-muted-foreground">
                                  {q.explanation}
                                </p>
                              </div>
                            )}
                            {isDraft && (
                              <div className="mt-3 flex items-center gap-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => startEdit(q, globalIdx)}
                                  className="h-9 gap-1.5 rounded-xl px-3 text-xs font-extrabold"
                                >
                                  <Pencil className="size-3.5" />
                                  {t("editBtn")}
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    setRegeneratingQuestion(q);
                                    setRegeneratingIndex(globalIdx);
                                  }}
                                  className="h-9 gap-1.5 rounded-xl px-3 text-xs font-extrabold"
                                >
                                  <Wand2 className="size-3.5 text-primary" />
                                  {t("regenerateBtn")}
                                </Button>
                                <DropdownMenu>
                                  <DropdownMenuTrigger
                                    render={
                                      <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={t("moreActions")}
                                        className="ml-auto size-9"
                                      >
                                        <MoreVertical className="size-4" />
                                      </Button>
                                    }
                                  />
                                  <DropdownMenuContent align="end" className="w-44 shadow-[var(--shadow-clay)]">
                                    <DropdownMenuItem
                                      onClick={() => handleMove(q, "up")}
                                      disabled={globalIdx === 0 || reordering}
                                      className="flex items-center gap-2 cursor-pointer font-bold"
                                    >
                                      <ArrowUp className="size-4 text-muted-foreground" />
                                      <span>{t("moveUp")}</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() => handleMove(q, "down")}
                                      disabled={globalIdx === questions.length - 1 || reordering}
                                      className="flex items-center gap-2 cursor-pointer font-bold"
                                    >
                                      <ArrowDown className="size-4 text-muted-foreground" />
                                      <span>{t("moveDown")}</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() => handleDelete(q)}
                                      className="flex items-center gap-2 cursor-pointer font-bold text-destructive focus:text-destructive"
                                    >
                                      <Trash2 className="size-4" />
                                      <span>{t("deleteBtn")}</span>
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      /* ── Desktop card (sm+) — byte-identical structure to
                          the pre-redesign list; the desktop e2e suite (e23,
                          e2b) pins per-row buttons and visible option text
                          here, so mobile-only composition stays below sm. ── */
                      <article
                        className="overflow-hidden rounded-[20px] border-2 sm:border-[3px] border-border bg-background/60 dark:bg-background/30 shadow-[var(--shadow-clay-sm)]"
                      >
                        {/* Meta row: index + type + answer key */}
                        <div className="flex flex-wrap items-center gap-1.5 px-3.5 py-3 sm:px-4">
                          <span className="font-heading text-sm font-semibold text-muted-foreground tabular-nums">
                            {globalIdx + 1}.
                          </span>
                          <span className="rounded-full border-2 border-border bg-muted px-2.5 py-0.5 text-xs font-extrabold text-foreground">
                            {q.type === "mcq"
                              ? tCommon("mcq")
                              : q.type === "multi_select"
                                ? tCommon("multiSelect")
                                : tCommon("trueFalse")}
                          </span>
                          {hasImageFor(q.id) && (
                            <span className="inline-flex items-center gap-1 rounded-full border-2 border-border bg-muted px-2.5 py-0.5 text-xs font-extrabold text-foreground">
                              <ImageIcon className="size-3" aria-hidden />
                              {tMedia("imageBadge")}
                            </span>
                          )}
                          {/* Answer-key chip — the key grading fact, styled as such */}
                          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border-2 border-emerald-600/40 bg-emerald-100/80 px-2.5 py-0.5 text-xs font-extrabold text-emerald-900 dark:border-emerald-400/30 dark:bg-emerald-950/40 dark:text-emerald-200">
                            <Check className="size-3 shrink-0" aria-hidden />
                            {correctChip}
                          </span>
                        </div>

                        <div className="px-3.5 pb-3.5 sm:px-4 sm:pb-4">
                          <p className="font-heading text-base font-semibold leading-snug">
                            {q.prompt}
                          </p>

                          {/* Per-option rows (A/B/C/D) with the key highlighted —
                              mirrors the player's answer list (WYSIWYG). */}
                          <ul className="mt-2.5 space-y-1.5">
                            {q.options.map((opt, i) => {
                              const isCorrect = correctSet
                                ? correctSet.includes(i)
                                : (q.correct_index ?? 0) === i;
                              return (
                                <li
                                  key={i}
                                  className={`flex items-start gap-2 rounded-xl border-2 px-2.5 py-1.5 text-sm font-semibold transition-colors ${
                                    isCorrect
                                      ? "border-emerald-500/70 bg-emerald-100/70 text-emerald-950 dark:border-emerald-400/40 dark:bg-emerald-950/40 dark:text-emerald-100"
                                      : "border-transparent bg-card/70 text-foreground dark:bg-card/50"
                                  }`}
                                >
                                  <span
                                    aria-hidden
                                    className="font-heading text-xs font-bold text-muted-foreground"
                                  >
                                    {String.fromCharCode(65 + i)}
                                  </span>
                                  <span className="min-w-0 flex-1 break-words">{opt}</span>
                                  {isCorrect && (
                                    <Check
                                      className="mt-0.5 size-4 shrink-0 text-emerald-700 dark:text-emerald-300"
                                      aria-hidden
                                    />
                                  )}
                                </li>
                              );
                            })}
                          </ul>

                          {q.explanation && (
                            <div className="mt-2.5 flex items-start gap-2 rounded-xl border-2 border-border/60 bg-muted/50 px-3 py-2 dark:border-border/40 dark:bg-muted/30">
                              <Lightbulb
                                className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
                                aria-hidden
                              />
                              <p className="text-xs font-semibold leading-relaxed text-muted-foreground">
                                {q.explanation}
                              </p>
                            </div>
                          )}
                        </div>

                        {isDraft && (
                          <div className="flex flex-wrap items-center gap-1 border-t-2 border-border/50 bg-muted/30 px-2.5 py-2 dark:bg-black/10">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setRegeneratingQuestion(q);
                                setRegeneratingIndex(globalIdx);
                              }}
                              aria-label={t("regenerateBtn")}
                              className="h-8 gap-1.5 px-2.5 text-xs font-bold"
                            >
                              <Wand2 className="size-3.5 text-primary" />
                              {t("regenerateBtn")}
                            </Button>
                            <span className="ml-auto flex items-center gap-1">
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <Button
                                      variant="ghost"
                                      size="icon-sm"
                                      onClick={() => startEdit(q, globalIdx)}
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
                            </span>
                          </div>
                        )}
                      </article>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* ── Card footer (mobile, drafts with questions) — publish lives at
            the END of the verify workflow instead of floating over the dock.
            Hidden on desktop, whose header keeps its Publish button. ── */}
        {isDraft && isMobile && questions.length > 0 && (
          <div className="flex items-center gap-3 border-t-2 border-border/50 bg-muted/30 px-4 py-3 dark:bg-black/10">
            <p
              className="min-w-0 flex-1 text-xs font-extrabold tabular-nums text-muted-foreground"
              aria-live="polite"
            >
              {t("reviewedProgress", { done: reviewedCount, total: questions.length })}
            </p>
            <Button
              size="sm"
              onClick={handlePublish}
              disabled={publishing}
              className="h-10 shrink-0 rounded-xl px-4 text-xs font-extrabold shadow-[var(--shadow-clay-sm)]"
            >
              {publishing ? t("publishingBtn") : t("publishBtn")}
            </Button>
          </div>
        )}
      </section>

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
