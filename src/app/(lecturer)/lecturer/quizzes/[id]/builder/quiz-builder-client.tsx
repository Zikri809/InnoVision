"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowDown, ArrowLeft, ArrowUp, Check, Pencil, Settings2, Timer, Trash2, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDuration } from "@/lib/format/duration";
import { TITLE_MAX } from "@/lib/quizzes/validation";
import { MODE_CLASS, MODE_LABEL, STATUS_CLASS, STATUS_LABEL } from "@/lib/quizzes/labels";
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
  const isDraft = quiz.status === "draft";

  // Title editing state
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(quiz.title);
  const [savingTitle, setSavingTitle] = useState(false);
  const editTitleBtnRef = useRef<HTMLButtonElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleSubmitLock = useRef(false);

  // Settings dialog state & refs
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

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
    setNotice(null);
  }

  function cancelTitleEdit() {
    setEditingTitle(false);
    setTitleDraft(quiz.title);
    setError(null);
    editTitleBtnRef.current?.focus();
  }

  async function handleTitleSave(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (savingTitle || titleSubmitLock.current) return;

    const trimmed = titleDraft.trim();
    if (!trimmed) {
      setError("Quiz title is required.");
      return;
    }
    if (trimmed.length > TITLE_MAX) {
      setError(`Quiz title must be at most ${TITLE_MAX} characters.`);
      return;
    }
    if (trimmed === quiz.title) {
      cancelTitleEdit();
      return;
    }

    titleSubmitLock.current = true;
    setSavingTitle(true);
    setError(null);
    setNotice(null);

    try {
      const res = await fetch(`/api/quizzes/${quiz.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message ?? body.error ?? "Could not update quiz title.");
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
      setNotice("Quiz title updated.");
      router.refresh();
      editTitleBtnRef.current?.focus();
    } catch {
      setError("Network error updating quiz title.");
    } finally {
      titleSubmitLock.current = false;
      setSavingTitle(false);
    }
  }

  // Question form state (top card: adding new questions).
  const [draft, setDraft] = useState<QuestionDraft>(emptyDraft);
  const [editingQuestion, setEditingQuestion] = useState<QuestionRow | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [regeneratingQuestion, setRegeneratingQuestion] = useState<QuestionRow | null>(null);
  const [regeneratingIndex, setRegeneratingIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [reordering, setReordering] = useState(false);

  function setOption(index: number, value: string) {
    setDraft((d) => {
      const options = [...d.options];
      options[index] = value;
      return { ...d, options };
    });
  }

  function addOption() {
    setDraft((d) => {
      if (d.options.length >= 5) return d;
      return { ...d, options: [...d.options, ""] };
    });
  }

  function removeOption(index: number) {
    setDraft((d) => {
      if (d.options.length <= 2) return d;
      const options = d.options.filter((_, i) => i !== index);
      const correctIndex = Math.min(d.correctIndex, options.length - 1);
      return { ...d, options, correctIndex };
    });
  }

  function moveOption(index: number, direction: "up" | "down") {
    setDraft((d) => {
      const target = direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= d.options.length) return d;
      const options = [...d.options];
      [options[index], options[target]] = [options[target], options[index]];
      // Follow the correct answer through the swap so it keeps pointing at
      // the same option text.
      let correctIndex = d.correctIndex;
      if (correctIndex === index) correctIndex = target;
      else if (correctIndex === target) correctIndex = index;
      return { ...d, options, correctIndex };
    });
  }

  function startEdit(q: QuestionRow, index: number) {
    setEditingQuestion(q);
    setEditingIndex(index);
    setError(null);
    setNotice(null);
  }

  function resetForm() {
    setDraft(emptyDraft);
    setError(null);
    setNotice(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);

    const payload = {
      type: draft.type,
      prompt: draft.prompt,
      options: draft.options,
      correctIndex: draft.correctIndex,
      // Send the explanation as-is; the route normalizes null (Zod allows "").
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
        setError(body.message ?? body.error ?? "Could not save the question.");
        return;
      }
      resetForm();
      setNotice("Question added.");
      router.refresh();
    } catch {
      setError("Network error saving question.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(q: QuestionRow) {
    if (!window.confirm("Delete this question?")) return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/quizzes/${quiz.id}/questions/${q.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message ?? body.error ?? "Could not delete the question.");
        return;
      }
      if (editingQuestion?.id === q.id) {
        setEditingQuestion(null);
        setEditingIndex(null);
      }
      setNotice("Question deleted.");
      router.refresh();
    } catch {
      setError("Network error deleting question.");
    }
  }

  async function handleMove(q: QuestionRow, direction: "up" | "down") {
    if (reordering) return;
    const index = questions.findIndex((x) => x.id === q.id);
    const target =
      direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= questions.length) return;

    const ordered = questions.map((x) => x.id);
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];

    setError(null);
    setNotice(null);
    setReordering(true);
    try {
      const res = await fetch(`/api/quizzes/${quiz.id}/reorder`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questionIds: ordered }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message ?? body.error ?? "Could not reorder.");
        return;
      }
      router.refresh();
    } catch {
      setError("Network error reordering questions.");
    } finally {
      setReordering(false);
    }
  }

  async function handlePublish() {
    if (publishing) return;
    setPublishing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/quizzes/${quiz.id}/publish`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message ?? body.error ?? "Could not publish the quiz.");
        return;
      }
      setNotice("Quiz published — students can now see it.");
      router.refresh();
    } catch {
      setError("Network error publishing quiz.");
    } finally {
      setPublishing(false);
    }
  }

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
          <div className="mt-3 flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              {editingTitle && isDraft ? (
                <form
                  onSubmit={handleTitleSave}
                  className="space-y-2"
                  aria-label="Edit quiz title"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative min-w-[240px] max-w-lg flex-1">
                      <Input
                        ref={titleInputRef}
                        value={titleDraft}
                        onChange={(e) => setTitleDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.preventDefault();
                            cancelTitleEdit();
                          }
                        }}
                        maxLength={TITLE_MAX}
                        disabled={savingTitle}
                        placeholder="Quiz title…"
                        aria-label="Quiz title"
                        aria-required="true"
                        aria-invalid={Boolean(error && !titleDraft.trim())}
                        className="h-11 font-heading text-lg font-semibold pr-16 bg-white/90 dark:bg-card/90"
                      />
                      <span
                        aria-hidden
                        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-bold text-muted-foreground"
                      >
                        {titleDraft.length}/{TITLE_MAX}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button
                        type="submit"
                        size="sm"
                        disabled={savingTitle || !titleDraft.trim()}
                        className="h-10 px-3.5 gap-1.5 font-bold"
                      >
                        {savingTitle ? (
                          "Saving…"
                        ) : (
                          <>
                            <Check className="size-4" aria-hidden />
                            Save
                          </>
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={cancelTitleEdit}
                        disabled={savingTitle}
                        className="h-10 px-3"
                      >
                        <X className="size-4 mr-1" aria-hidden />
                        Cancel
                      </Button>
                    </div>
                  </div>
                  <p className="text-xs font-semibold text-muted-foreground">
                    Press <kbd className="rounded-lg border-[2px] border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] font-bold shadow-[0_2px_0_var(--border)]">Enter</kbd> to save, <kbd className="rounded-lg border-[2px] border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] font-bold shadow-[0_2px_0_var(--border)]">Esc</kbd> to cancel.
                  </p>
                </form>
              ) : (
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h1
                    ref={headingRef}
                    tabIndex={-1}
                    className="font-heading text-3xl font-semibold outline-none [text-wrap:balance]"
                  >
                    {quiz.title}
                  </h1>
                  {isDraft && (
                    <div className="flex items-center gap-1">
                      <Button
                        ref={editTitleBtnRef}
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={startTitleEdit}
                        disabled={savingTitle || publishing || settingsOpen}
                        aria-label={`Rename quiz: ${quiz.title}`}
                        title="Rename title (inline)"
                        className="relative size-9 rounded-xl text-muted-foreground hover:text-primary hover:bg-white/60 dark:hover:bg-card/60 transition-colors before:absolute before:-inset-1 before:content-['']"
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </Button>
                      <Button
                        ref={settingsBtnRef}
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => {
                          cancelTitleEdit();
                          setSettingsOpen(true);
                        }}
                        disabled={savingTitle || publishing}
                        aria-label="Edit quiz settings"
                        title="Edit title, mode, and time limit"
                        aria-haspopup="dialog"
                        aria-expanded={settingsOpen}
                        className="relative size-9 rounded-xl text-muted-foreground hover:text-primary hover:bg-white/60 dark:hover:bg-card/60 transition-colors before:absolute before:-inset-1 before:content-['']"
                      >
                        <Settings2 className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                  )}
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2.5">
                <span className={`inline-flex items-center justify-center h-8 rounded-full border-[3px] px-3.5 text-xs font-extrabold select-none cursor-default ${STATUS_CLASS[quiz.status]}`}>
                  {STATUS_LABEL[quiz.status]}
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
                    aria-label={`Quiz mode: ${MODE_LABEL[quiz.mode]}. Click to edit settings.`}
                    className={`relative inline-flex items-center justify-center gap-1.5 h-8 rounded-full border-[3px] px-3.5 text-xs font-extrabold cursor-pointer transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-[var(--shadow-clay-sm)] active:translate-y-0 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/70 disabled:pointer-events-none disabled:opacity-60 before:absolute before:-inset-1.5 before:content-[''] ${MODE_CLASS[quiz.mode]}`}
                  >
                    <span>{MODE_LABEL[quiz.mode]}</span>
                    <Pencil className="size-3 opacity-60" aria-hidden="true" />
                  </button>
                ) : (
                  <span className={`inline-flex items-center justify-center h-8 rounded-full border-[3px] px-3.5 text-xs font-extrabold select-none cursor-default ${MODE_CLASS[quiz.mode]}`}>
                    {MODE_LABEL[quiz.mode]}
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
                      aria-label={`Time limit: ${formatDuration(quiz.time_limit_sec)}. Click to edit settings.`}
                      className="relative inline-flex items-center justify-center gap-1.5 h-8 rounded-full border-[3px] border-border bg-muted px-3.5 text-xs font-extrabold tabular-nums text-muted-foreground cursor-pointer transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-[var(--shadow-clay-sm)] active:translate-y-0 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/70 disabled:pointer-events-none disabled:opacity-60 before:absolute before:-inset-1.5 before:content-['']"
                    >
                      <Timer className="size-3.5" aria-hidden="true" />
                      <span>{formatDuration(quiz.time_limit_sec)} limit</span>
                      <Pencil className="size-3 opacity-60" aria-hidden="true" />
                    </button>
                  ) : (
                    <span className="inline-flex items-center justify-center gap-1.5 h-8 rounded-full border-[3px] border-border bg-muted px-3.5 text-xs font-extrabold tabular-nums text-muted-foreground select-none cursor-default">
                      <Timer className="size-3.5" aria-hidden="true" />
                      {formatDuration(quiz.time_limit_sec)} limit
                    </span>
                  )
                )}

                <span className="inline-flex items-center justify-center h-8 rounded-full border-[3px] border-border bg-muted px-3.5 text-xs font-extrabold text-muted-foreground select-none cursor-default">
                  {questions.length} {questions.length === 1 ? "question" : "questions"}
                </span>
              </div>
            </div>
            {isDraft && (
              <Button
                variant="outline"
                onClick={() => setGenerateOpen(true)}
              >
                <Wand2 className="mr-1.5 size-4" />
                Generate from file
              </Button>
            )}
            {!isDraft && (
              <Link href={`/lecturer/quizzes/${quiz.id}/results`}>
                <Button variant="accent">View results</Button>
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
          setNotice("Quiz settings updated.");
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
        onSuccess={() => {
          setNotice("Question updated.");
          router.refresh();
        }}
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
          setNotice("Question regenerated.");
          router.refresh();
        }}
      />

      {!isDraft && (
        <div
          role="alert"
          className="mb-6 rounded-2xl border-[3px] border-amber-300 bg-amber-50 p-4 text-sm font-semibold text-amber-900"
        >
          This quiz is <strong className="font-extrabold">{STATUS_LABEL[quiz.status].toLowerCase()}</strong>.
          Questions can no longer be edited. {quiz.status === "live"
            ? "Students can see and take it."
            : "It is closed to new attempts."}
        </div>
      )}

      <div aria-live="polite">
        {notice && (
          <p className="mb-4 rounded-2xl border-[3px] border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="mb-4 rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>

      {isDraft && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Add question</CardTitle>
            <CardDescription>
              Multiple choice: 2–5 options (fingers 1–5). True/False: exactly 2.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSave} className="space-y-4">
              <div className="flex flex-wrap items-center gap-4 sm:gap-6">
                <div className="space-y-1">
                  <Label htmlFor="q-type">Question Type</Label>
                  <Select
                    value={draft.type}
                    onValueChange={(v) => {
                      const type = v as "mcq" | "true_false";
                      setDraft((d) =>
                        type === "true_false"
                          ? {
                              ...d,
                              type,
                              options: ["True", "False"],
                              correctIndex: 0,
                            }
                          : { ...d, type, options: d.options.length >= 2 ? d.options : ["", ""] },
                      );
                    }}
                  >
                    <SelectTrigger id="q-type" className="w-full sm:w-44">
                      <SelectValue placeholder="Select type">
                        {(v) => (v === "true_false" ? "True / False" : "Multiple Choice")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mcq">Multiple Choice</SelectItem>
                      <SelectItem value="true_false">True / False</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="q-correct">Correct Answer</Label>
                  <Select
                    value={String(draft.correctIndex + 1)}
                    onValueChange={(v) =>
                      setDraft((d) => ({ ...d, correctIndex: Number(v) - 1 }))
                    }
                  >
                    <SelectTrigger id="q-correct" className="w-full sm:w-36">
                      <SelectValue placeholder="Select answer">
                        {(v) => (v ? `Option ${v}` : "Select answer")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {draft.options.map((_, i) => (
                        <SelectItem key={i} value={String(i + 1)}>
                          Option {i + 1}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1">
                <Label htmlFor="q-prompt">Question Prompt</Label>
                <Textarea
                  id="q-prompt"
                  value={draft.prompt}
                  onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
                  rows={3}
                  maxLength={2000}
                  required
                  placeholder="Type the question…"
                />
              </div>

              <div className="space-y-2">
                <Label>Options</Label>
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
                      placeholder={`Option ${i + 1}`}
                      aria-label={`Option ${i + 1}`}
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
                              aria-label={`Move option ${i + 1} up`}
                            >
                              <ArrowUp className="size-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => moveOption(i, "down")}
                              disabled={i === draft.options.length - 1}
                              aria-label={`Move option ${i + 1} down`}
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
                            aria-label={`Remove option ${i + 1}`}
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
                    Add option
                  </Button>
                )}
                {draft.type === "true_false" && (
                  <p className="text-xs text-muted-foreground">
                    True/False questions always have exactly two options.
                  </p>
                )}
              </div>

              <div className="space-y-1">
                <Label htmlFor="q-explanation" className="font-extrabold">Explanation (Optional)</Label>
                <p className="text-xs font-semibold text-muted-foreground">
                  Shown to students after they answer — explain why the correct
                  option is right.
                </p>
                <Textarea
                  id="q-explanation"
                  value={draft.explanation}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, explanation: e.target.value }))
                  }
                  rows={2}
                  maxLength={2000}
                  placeholder="Explain why the correct answer is right (shown after answering)…"
                />
              </div>

              <div className="flex items-center gap-3">
                <Button type="submit" disabled={saving || !draft.prompt.trim()}>
                  {saving ? "Adding…" : "Add question"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Questions</CardTitle>
            <CardDescription>
              {questions.length} question{questions.length === 1 ? "" : "s"} —
              answered with {questions.length === 0 ? "gestures" : "1–5 fingers"}
            </CardDescription>
          </div>
          {isDraft && (
            <Button
              onClick={handlePublish}
              disabled={publishing || questions.length === 0}
            >
              {publishing ? "Publishing…" : "Publish"}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {questions.length === 0 ? (
            <p className="rounded-2xl border-[3px] border-dashed border-border bg-card p-6 text-center text-sm font-semibold text-muted-foreground">
              No questions yet. Add one above — you need at least one to publish.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {questions.map((q, idx) => (
                <li key={q.id} className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-heading text-sm font-semibold text-muted-foreground">{idx + 1}.</span>
                      <span className="rounded-full border-[3px] border-border bg-muted px-2.5 py-0.5 text-xs font-extrabold text-foreground">
                        {q.type === "mcq" ? "MCQ" : "True / False"}
                      </span>
                      <span className="text-xs font-bold text-muted-foreground">
                        Answer: Option {q.correct_index + 1}
                      </span>
                    </div>
                    <p className="mt-1.5 font-heading text-base font-semibold">{q.prompt}</p>
                    <p className="mt-1 text-sm font-semibold text-muted-foreground">
                      {q.options.join(" · ")}
                    </p>
                    {q.explanation && (
                      <p className="mt-1.5 text-xs font-semibold text-muted-foreground">
                        <strong className="font-extrabold text-foreground">Explanation:</strong> {q.explanation}
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
                        aria-label="Regenerate question"
                        className="h-8 gap-1.5 px-2.5 text-xs font-bold"
                      >
                        <Wand2 className="size-3.5 text-primary" />
                        Regenerate
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => startEdit(q, idx)}
                        aria-label="Edit question"
                        className="size-8"
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => handleMove(q, "up")}
                        disabled={idx === 0 || reordering}
                        aria-label="Move up"
                        className="size-8"
                      >
                        <ArrowUp className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => handleMove(q, "down")}
                        disabled={idx === questions.length - 1 || reordering}
                        aria-label="Move down"
                        className="size-8"
                      >
                        <ArrowDown className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => handleDelete(q)}
                        aria-label="Delete question"
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
