"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowDown, ArrowLeft, ArrowUp, Check, Image as ImageIcon, Pencil, Settings2, Timer, Trash2, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDuration } from "@/lib/format/duration";
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
import { GenerateFromFileDialog } from "@/components/extract/GenerateFromFileDialog";
import { SourceTextPreview } from "@/components/extract/SourceTextPreview";
import { EditQuestionDialog } from "@/components/quiz/edit-question-dialog";
import { RegenerateQuestionDialog } from "@/components/quiz/regenerate-question-dialog";
import { EditQuizDialog } from "@/components/quiz/edit-quiz-dialog";
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
  created_at: string;
  source_file_url: string | null;
  source_text: string | null;
};

export type QuestionRow = {
  id: string;
  quiz_id: string;
  order_index: number;
  type: "mcq" | "true_false";
  prompt: string;
  options: string[];
  correct_index: number;
  explanation: string | null;
  image_path?: string | null;
};

type QuestionDraft = {
  type: "mcq" | "true_false";
  prompt: string;
  options: string[];
  correctIndex: number;
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
  ocrConfig,
}: {
  quiz: QuizInfo;
  questions: QuestionRow[];
  userId: string;
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
  const [reordering, setReordering] = useState(false);

  // Option-array mutations ride the SHARED pure reducers
  // (lib/quizzes/question-draft.ts) so the answer key follows its option on
  // remove/move — the old inline copies drifted (deleting an option ABOVE the
  // key left correctIndex pointing at the wrong option).
  function applyOptions(draft: QuestionDraft, op: OptionDraftOp): QuestionDraft {
    const next = applyOptionDraftOp(
      { options: draft.options, correctIndex: draft.correctIndex },
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
      correctIndex: draft.correctIndex,
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

  async function handleDelete(q: QuestionRow) {
    // Irreversible — confirm like the student editor does, and lock against
    // double-clicks (the second DELETE would 404 and mask the success).
    if (deletingId.current) return;
    if (!window.confirm(t("deleteQuestionConfirm"))) return;
    deletingId.current = q.id;
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
      router.refresh();
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      deletingId.current = null;
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

  const defaultTrueFalseOptions = locale === "ms" ? ["Betul", "Salah"] : ["True", "False"];

  return (
    <div className="space-y-6">
      {/* ── Hero band ── */}
      <section className="relative overflow-hidden rounded-[28px] border-[3px] border-border bg-gradient-to-br from-orange-100 via-orange-50 to-blue-50 p-7 shadow-[var(--shadow-clay)] md:p-8">
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-36 w-36 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/50" />
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

                <span className="inline-flex items-center justify-center h-8 rounded-full border-[3px] border-border bg-muted px-3.5 text-xs font-extrabold text-muted-foreground select-none cursor-default">
                  {t("questionCount", { count: questions.length })}
                </span>
              </div>
            </div>
            {isDraft && (
              <Button
                variant="outline"
                onClick={() => setGenerateOpen(true)}
              >
                <Wand2 className="mr-1.5 size-4" />
                {t("generateFromFile")}
              </Button>
            )}
            {!isDraft && (
              <Link href={`/lecturer/quizzes/${quiz.id}/results`}>
                <Button variant="accent">{t("viewResults")}</Button>
              </Link>
            )}
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
                      const type = v as "mcq" | "true_false";
                      setDraft((d) =>
                        type === "true_false"
                          ? {
                              ...d,
                              type,
                              options: defaultTrueFalseOptions,
                              correctIndex: 0,
                            }
                          : { ...d, type, options: d.options.length >= 2 ? d.options : ["", ""] },
                      );
                    }}
                  >
                    <SelectTrigger id="q-type" className="w-full sm:w-auto sm:min-w-[11rem]">
                      <SelectValue placeholder={t("questionTypeLabel")}>
                        {(v) => (v === "true_false" ? tCommon("trueFalse") : tCommon("mcq"))}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mcq">{tCommon("mcq")}</SelectItem>
                      <SelectItem value="true_false">{tCommon("trueFalse")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="q-correct">{t("correctAnswerLabel")}</Label>
                  <Select
                    value={String(draft.correctIndex + 1)}
                    onValueChange={(v) =>
                      setDraft((d) => ({ ...d, correctIndex: Number(v) - 1 }))
                    }
                  >
                    <SelectTrigger id="q-correct" className="w-full sm:w-auto sm:min-w-[10rem]">
                      <SelectValue placeholder={t("correctAnswerLabel")}>
                        {(v) => (v ? `${t("optionLabel", { index: v })}` : t("correctAnswerLabel"))}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {draft.options.map((_, i) => (
                        <SelectItem key={i} value={String(i + 1)}>
                          {t("optionLabel", { index: i + 1 })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
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
                {draft.options.map((opt, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl font-heading text-xs font-extrabold transition-colors shadow-xs ${
                        draft.correctIndex === i
                          ? "border-[2px] border-emerald-500 bg-emerald-100 dark:bg-emerald-950/50 text-emerald-900 dark:text-emerald-200"
                          : "border-[2px] border-border bg-muted/60 text-muted-foreground"
                      }`}
                    >
                      {i + 1}
                    </span>
                    <Input
                      value={opt}
                      onChange={(e) => setOption(i, e.target.value)}
                      maxLength={500}
                      placeholder={t("optionLabel", { index: i + 1 })}
                      aria-label={t("optionLabel", { index: i + 1 })}
                      disabled={draft.type === "true_false"}
                      className="flex-1"
                    />
                    {draft.type === "mcq" && (
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
                ))}
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
                  {saving ? tCommon("loading") : t("addQuestionBtn")}
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
                        {q.type === "mcq" ? tCommon("mcq") : tCommon("trueFalse")}
                      </span>
                      {hasImageFor(q.id) && (
                        <span className="inline-flex items-center gap-1 rounded-full border-[3px] border-border bg-muted px-2.5 py-0.5 text-xs font-extrabold text-foreground">
                          <ImageIcon className="size-3" aria-hidden />
                          {tMedia("imageBadge")}
                        </span>
                      )}
                      <span className="text-xs font-bold text-muted-foreground">
                        {t("correctAnswerLabel")}: {t("optionLabel", { index: q.correct_index + 1 })}
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
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => startEdit(q, idx)}
                        aria-label={t("editBtn")}
                        className="size-8"
                      >
                        <Pencil className="size-4" />
                      </Button>
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
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => handleDelete(q)}
                        aria-label={t("deleteBtn")}
                        className="size-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
