"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowDown, ArrowUp, Pencil, RefreshCw, Trash2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import type { OcrConfig } from "@/lib/extract/types";

type QuizInfo = {
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

const STATUS_LABEL: Record<QuizInfo["status"], string> = {
  draft: "Draft",
  live: "Live",
  closed: "Closed",
};

const STATUS_CLASS: Record<QuizInfo["status"], string> = {
  draft: "bg-muted text-muted-foreground",
  live: "bg-emerald-100 text-emerald-800",
  closed: "bg-destructive/10 text-destructive",
};

const MODE_LABEL: Record<QuizInfo["mode"], string> = {
  practice: "Practice",
  assessment: "Assessment",
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

  // Question form state.
  const [draft, setDraft] = useState<QuestionDraft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [regenerateInstruction, setRegenerateInstruction] = useState("");

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

  function startEdit(q: QuestionRow) {
    setEditingId(q.id);
    setDraft({
      type: q.type,
      prompt: q.prompt,
      options: [...q.options],
      correctIndex: q.correct_index,
      explanation: q.explanation ?? "",
    });
    setError(null);
    setNotice(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function resetForm() {
    setEditingId(null);
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
      const url = editingId
        ? `/api/quizzes/${quiz.id}/questions/${editingId}`
        : `/api/quizzes/${quiz.id}/questions`;
      const res = await fetch(url, {
        method: editingId ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? body.error ?? "Could not save the question.");
        return;
      }
      resetForm();
      setNotice(editingId ? "Question updated." : "Question added.");
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
      if (editingId === q.id) resetForm();
      setNotice("Question deleted.");
      router.refresh();
    } catch {
      setError("Network error deleting question.");
    }
  }

  async function handleMove(q: QuestionRow, direction: "up" | "down") {
    const index = questions.findIndex((x) => x.id === q.id);
    const target =
      direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= questions.length) return;

    const ordered = questions.map((x) => x.id);
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];

    setError(null);
    setNotice(null);
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
      const body = await res.json();
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

  async function handleRegenerate(q: QuestionRow) {
    if (regeneratingId) return;
    if (!window.confirm("Regenerate this question with AI? The current version will be replaced.")) return;
    setRegeneratingId(q.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/ai/regenerate-question", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          questionId: q.id,
          ...(regenerateInstruction.trim() ? { instruction: regenerateInstruction.trim() } : {}),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? body.error ?? "Could not regenerate the question.");
        return;
      }
      setNotice("Question regenerated.");
      setRegenerateInstruction("");
      router.refresh();
    } catch {
      setError("Network error regenerating the question.");
    } finally {
      setRegeneratingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6">
        <Link
          href={`/lecturer/classes/${quiz.class_id}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {quiz.class_title}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{quiz.title}</h1>
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[quiz.status]}`}>
            {STATUS_LABEL[quiz.status]}
          </span>
          <span className="rounded bg-muted px-2 py-0.5 text-xs">{MODE_LABEL[quiz.mode]}</span>
          {quiz.mode === "assessment" && quiz.time_limit_sec != null && (
            <span className="text-xs text-muted-foreground">
              {quiz.time_limit_sec}s time limit
            </span>
          )}
          {isDraft && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setGenerateOpen(true)}
              className="ml-auto"
            >
              <Wand2 className="mr-1.5 size-4" />
              Generate from file
            </Button>
          )}
        </div>
      </div>

      <SourceTextPreview text={quiz.source_text} />

      <GenerateFromFileDialog
        quizId={quiz.id}
        userId={userId}
        config={ocrConfig}
        open={generateOpen}
        onOpenChange={setGenerateOpen}
        hasQuestions={questions.length > 0}
      />

      {!isDraft && (
        <div
          role="alert"
          className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
        >
          This quiz is <strong>{STATUS_LABEL[quiz.status].toLowerCase()}</strong>.
          Questions can no longer be edited. {quiz.status === "live"
            ? "Students can see and take it."
            : "It is closed to new attempts."}
        </div>
      )}

      {notice && (
        <p className="mb-4 text-sm text-emerald-600" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="mb-4 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {isDraft && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>{editingId ? "Edit question" : "Add question"}</CardTitle>
            <CardDescription>
              Multiple choice: 2–5 options (fingers 1–5). True/False: exactly 2.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSave} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
                <div className="space-y-1">
                  <Label htmlFor="q-type">Type</Label>
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
                    <SelectTrigger id="q-type" className="w-40">
                      <SelectValue placeholder="Type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mcq">Multiple choice</SelectItem>
                      <SelectItem value="true_false">True / False</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="q-correct">Correct answer</Label>
                  <Select
                    value={String(draft.correctIndex)}
                    onValueChange={(v) =>
                      setDraft((d) => ({ ...d, correctIndex: Number(v) }))
                    }
                  >
                    <SelectTrigger id="q-correct" className="w-24">
                      <SelectValue placeholder="Answer" />
                    </SelectTrigger>
                    <SelectContent>
                      {draft.options.map((_, i) => (
                        <SelectItem key={i} value={String(i)}>
                          {i + 1}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1">
                <Label htmlFor="q-prompt">Question</Label>
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
                    <span className="w-8 text-center text-sm text-muted-foreground">
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
                    {draft.type === "mcq" && draft.options.length > 2 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeOption(i)}
                        aria-label={`Remove option ${i + 1}`}
                      >
                        <Trash2 className="size-4" />
                      </Button>
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
                <Label htmlFor="q-explanation">Explanation (optional)</Label>
                <Textarea
                  id="q-explanation"
                  value={draft.explanation}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, explanation: e.target.value }))
                  }
                  rows={2}
                  maxLength={2000}
                  placeholder="Explain why this is correct (shown after answering)…"
                />
              </div>

              <div className="flex items-center gap-3">
                <Button type="submit" disabled={saving || !draft.prompt.trim()}>
                  {saving ? "Saving…" : editingId ? "Save changes" : "Add question"}
                </Button>
                {editingId && (
                  <Button type="button" variant="ghost" onClick={resetForm}>
                    Cancel
                  </Button>
                )}
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
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No questions yet. Add one above — you need at least one to publish.
            </p>
          ) : (
            <ul className="divide-y">
              {questions.map((q, idx) => (
                <li key={q.id} className="flex items-start justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{idx + 1}.</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {q.type === "mcq" ? "MCQ" : "T/F"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Answer: {q.correct_index + 1}
                      </span>
                    </div>
                    <p className="mt-1 font-medium">{q.prompt}</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {q.options.join(" · ")}
                    </p>
                    {q.explanation && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {q.explanation}
                      </p>
                    )}
                  </div>
                  {isDraft && (
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => startEdit(q)}
                          aria-label="Edit question"
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleMove(q, "up")}
                          disabled={idx === 0}
                          aria-label="Move up"
                        >
                          <ArrowUp className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleMove(q, "down")}
                          disabled={idx === questions.length - 1}
                          aria-label="Move down"
                        >
                          <ArrowDown className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(q)}
                          aria-label="Delete question"
                        >
                        <Trash2 className="size-4" />
                      </Button>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRegenerate(q)}
                        disabled={regeneratingId === q.id}
                        aria-label="Regenerate question"
                      >
                        <RefreshCw className={`size-3.5 ${regeneratingId === q.id ? "animate-spin" : ""} mr-1`} />
                        {regeneratingId === q.id ? "Regenerating…" : "Regenerate"}
                      </Button>
                      {regenerateInstruction && regeneratingId === q.id && (
                        <p className="max-w-[200px] truncate text-[10px] text-muted-foreground">
                          {regenerateInstruction}
                        </p>
                      )}
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
