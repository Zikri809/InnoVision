"use client";

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  applyOptionDraftOp,
  type OptionDraftState,
} from "@/lib/quizzes/question-draft";
import { QuestionInputSchema } from "@/lib/quizzes/validation";
import { ArrowDown, ArrowUp, Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";

export type EditorQuestion = {
  id: string;
  quiz_id: string;
  order_index: number;
  type: "mcq" | "true_false";
  prompt: string;
  options: string[];
  correct_index: number;
  explanation: string | null;
};

type QuizMeta = { id: string; title: string; description: string | null };

const QUESTION_CAP = 50;

/**
 * Builder for one own practice quiz. Every operation hits the API IMMEDIATELY
 * (append/PATCH/DELETE/reorder RPCs) and reconciles local state from the
 * response — no save-all diffing, matching the lecturer builder's interaction
 * model while staying a fresh, student-scoped component (PLAN §5: zero blast
 * radius on lecturer UI).
 */
export function QuizEditorClient({
  quiz,
  initialQuestions,
}: {
  quiz: QuizMeta;
  initialQuestions: EditorQuestion[];
}) {
  const router = useRouter();
  const t = useTranslations("quizEditor");
  const tMy = useTranslations("myQuizzes");
  const tCommon = useTranslations("common");

  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(quiz.title);
  const [description, setDescription] = useState(quiz.description ?? "");
  const [questions, setQuestions] = useState<EditorQuestion[]>(initialQuestions);
  const [error, setError] = useState<string | null>(null);
  const [savingMeta, setSavingMeta] = useState(false);

  // Add-question form state.
  const [newPrompt, setNewPrompt] = useState("");
  const [newOptions, setNewOptions] = useState<OptionDraftState>({
    options: ["", ""],
    correctIndex: 0,
  });
  const [adding, setAdding] = useState(false);

  // Edit dialog state.
  const [editing, setEditing] = useState<EditorQuestion | null>(null);
  const [editDraft, setEditDraft] = useState<OptionDraftState>({
    options: [],
    correctIndex: 0,
  });
  const [savingEdit, setSavingEdit] = useState(false);
  // Dialog-local error state: the page banner sits BEHIND the modal overlay,
  // so edit failures must render inside <DialogContent> to be visible.
  const [editError, setEditError] = useState<string | null>(null);
  const [editExplanation, setEditExplanation] = useState("");

  async function api(path: string, init: RequestInit) {
    const res = await fetch(path, init);
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, body };
  }

  function fail(message?: string) {
    setError(message ?? tCommon("errorGeneric"));
  }

  function clearBanners() {
    setError(null);
  }

  async function handleSaveMeta() {
    if (lock.current) return;
    if (!title.trim()) {
      fail(t("needTitle"));
      return;
    }
    clearBanners();
    lock.current = true;
    setBusy(true);
    setSavingMeta(true);
    try {
      const { ok, body } = await api(`/api/student-quizzes/${quiz.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          description: description.trim() ? description.trim() : null,
        }),
      });
      if (!ok) return fail(body.message);
      router.refresh();
    } catch {
      fail();
    } finally {
      lock.current = false;
      setBusy(false);
      setSavingMeta(false);
    }
  }

  /**
   * Local Zod pre-validation shared by add + edit paths. Raw Zod messages are
   * English-only, so issue paths map to the localized quizEditor keys before
   * display (raw text is never surfaced to users).
   */
  function buildCandidate(
    prompt: string,
    draft: OptionDraftState,
    explanation: string,
  ): { value: Record<string, unknown> } | { error: string } {
    const cleaned = draft.options.map((o) => o.trim());
    const parsed = QuestionInputSchema.safeParse({
      type: isTrueFalsePair(cleaned) ? "true_false" : "mcq",
      prompt,
      options: cleaned,
      correctIndex: draft.correctIndex,
      explanation,
    });
    if (!parsed.success) {
      const issues = parsed.error.issues;
      const first = (...paths: string[]) =>
        issues.find((i) => paths.some((p) => i.path.includes(p)));
      const promptIssue = first("prompt");
      const optionsIssue = first("options");
      const correctIssue = first("correctIndex");
      if (promptIssue) return { error: t("promptRequired") };
      if (optionsIssue) {
        const distinct = /distinct/i.test(optionsIssue.message ?? "");
        return { error: distinct ? t("duplicateOptions") : t("minTwoOptions") };
      }
      if (correctIssue) return { error: t("pickCorrect") };
      return { error: tCommon("errorGeneric") };
    }
    return { value: parsed.data };
  }

  function isTrueFalsePair(options: string[]): boolean {
    const norm = options.map((o) => o.trim().toLowerCase());
    return (
      norm.length === 2 &&
      (norm[0] === "true" || norm[0] === "betul") &&
      (norm[1] === "false" || norm[1] === "salah")
    );
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (lock.current) return;
    if (questions.length >= QUESTION_CAP) {
      fail(t("questionCapReached", { count: QUESTION_CAP }));
      return;
    }
    const candidate = buildCandidate(newPrompt, newOptions, "");
    if ("error" in candidate) return fail(candidate.error);

    clearBanners();
    lock.current = true;
    setBusy(true);
    setAdding(true);
    try {
      const { ok, body } = await api(`/api/student-quizzes/${quiz.id}/questions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(candidate.value),
      });
      if (!ok) return fail(body.message);
      setQuestions((prev) => [...prev, body.question as EditorQuestion]);
      setNewPrompt("");
      setNewOptions({ options: ["", ""], correctIndex: 0 });
    } catch {
      fail();
    } finally {
      lock.current = false;
      setBusy(false);
      setAdding(false);
    }
  }

  function openEdit(q: EditorQuestion) {
    setEditing(q);
    setEditDraft({ options: [...q.options], correctIndex: q.correct_index });
    // Preserve the existing explanation — the PATCH payload is a full-row
    // replace, so dropping it here would silently erase it on save.
    setEditExplanation(q.explanation ?? "");
    setEditError(null);
  }

  async function handleSaveEdit() {
    if (lock.current || !editing) return;
    const candidate = buildCandidate(editing.prompt, editDraft, editExplanation);
    if ("error" in candidate) return setEditError(candidate.error);

    clearBanners();
    lock.current = true;
    setBusy(true);
    setSavingEdit(true);
    try {
      const { ok, body } = await api(
        `/api/student-quizzes/${quiz.id}/questions/${editing.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(candidate.value),
        },
      );
      if (!ok) return setEditError(body.message ?? tCommon("errorGeneric"));
      setQuestions((prev) =>
        prev.map((q) =>
          q.id === editing.id ? { ...q, ...(body.question as EditorQuestion) } : q,
        ),
      );
      setEditing(null);
    } catch {
      setEditError(tCommon("errorGeneric"));
    } finally {
      lock.current = false;
      setBusy(false);
      setSavingEdit(false);
    }
  }

  async function handleDelete(q: EditorQuestion) {
    if (lock.current) return;
    if (!window.confirm(t("deleteQuestionConfirm"))) return;
    clearBanners();
    lock.current = true;
    setBusy(true);
    try {
      const { ok, body } = await api(
        `/api/student-quizzes/${quiz.id}/questions/${q.id}`,
        { method: "DELETE" },
      );
      if (!ok) return fail(body.message);
      setQuestions((prev) => prev.filter((x) => x.id !== q.id));
    } catch {
      fail();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function handleMove(index: number, dir: -1 | 1) {
    const to = index + dir;
    if (to < 0 || to >= questions.length || lock.current) return;
    const orderedIds = questions.map((q) => q.id);
    [orderedIds[index], orderedIds[to]] = [orderedIds[to], orderedIds[index]];

    clearBanners();
    lock.current = true;
    setBusy(true);
    try {
      const { ok, body } = await api(`/api/student-quizzes/${quiz.id}/reorder`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questionIds: orderedIds }),
      });
      if (!ok) return fail(body.message);
      setQuestions((prev) => {
        const next = [...prev];
        [next[index], next[to]] = [next[to], next[index]];
        return next.map((q, i) => ({ ...q, order_index: i }));
      });
    } catch {
      fail();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* ── Meta card ── */}
      <Card className="rounded-[28px] border-[3px] shadow-[var(--shadow-clay)]">
        <CardHeader>
          <CardTitle className="text-xl">{title}</CardTitle>
          <CardDescription>
            {tMy("questionCount", { count: questions.length })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="quiz-title">{t("titleLabel")}</Label>
            <Input
              id="quiz-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="quiz-desc">{t("descriptionLabel")}</Label>
            <Input
              id="quiz-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("descriptionPlaceholder")}
              maxLength={500}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void handleSaveMeta()} disabled={savingMeta}>
              {savingMeta ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              {t("metaSave")}
            </Button>
            <Link href={`/play/student/${quiz.id}`}>
              <Button variant="outline">
                <Check className="h-4 w-4" aria-hidden /> {t("openBuilder")}
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>

      <div aria-live="polite">
        {error && (
          <p
            className="rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive"
            role="alert"
          >
            {error}
          </p>
        )}
      </div>

      {/* ── Questions list ── */}
      <ol className="space-y-3">
        {questions.map((q, i) => (
          <li key={q.id}>
            <Card className="rounded-[22px] border-[3px] shadow-[var(--shadow-clay-sm)]">
              <CardContent className="flex items-start justify-between gap-3 px-5 py-4">
                <div className="min-w-0">
                  <p className="text-xs font-extrabold uppercase tracking-wide text-muted-foreground">
                    {t("questionN", { number: i + 1 })} Â·{" "}
                    {q.type === "true_false" ? t("typeTrueFalse") : t("typeMcq")}
                  </p>
                  <p className="mt-1 font-heading text-sm font-semibold">{q.prompt}</p>
                  <p className="mt-1 text-xs font-bold text-emerald-700">
                    <Check className="inline h-3.5 w-3.5" aria-hidden />{" "}
                    {q.options[q.correct_index]}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("moveUpA11y")}
                    disabled={i === 0 || busy}
                    onClick={() => void handleMove(i, -1)}
                  >
                    <ArrowUp className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("moveDownA11y")}
                    disabled={i === questions.length - 1 || busy}
                    onClick={() => void handleMove(i, 1)}
                  >
                    <ArrowDown className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("editQuestion")}
                    onClick={() => openEdit(q)}
                  >
                    <Pencil className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-destructive hover:text-destructive"
                    aria-label={tCommon("delete")}
                    disabled={busy}
                    onClick={() => void handleDelete(q)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ol>

      {/* ── Add-question card ── */}
      <Card className="rounded-[28px] border-[3px] border-dashed shadow-none">
        <CardHeader>
          <CardTitle className="text-lg">
            <Plus className="inline h-5 w-5 text-primary" aria-hidden /> {t("addQuestion")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAdd} className="space-y-4">
            <OptionDraftForm state={newOptions} onState={setNewOptions} />
            <div className="space-y-2">
              <Label htmlFor="new-prompt">{t("promptLabel")}</Label>
              <Input
                id="new-prompt"
                value={newPrompt}
                onChange={(e) => setNewPrompt(e.target.value)}
                placeholder={t("promptPlaceholder")}
                maxLength={2000}
              />
            </div>
            <Button type="submit" disabled={adding || busy}>
              {adding ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Plus className="h-4 w-4" aria-hidden />
              )}
              {t("addQuestion")}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* ── Edit dialog ── */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("editQuestion")}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-4">
              <div aria-live="polite">
                {editError && (
                  <p
                    className="rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive"
                    role="alert"
                  >
                    {editError}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-prompt">{t("promptLabel")}</Label>
                <Input
                  id="edit-prompt"
                  value={editing.prompt}
                  onChange={(e) =>
                    setEditing((prev) =>
                      prev ? { ...prev, prompt: e.target.value } : prev,
                    )
                  }
                  maxLength={2000}
                />
              </div>
              <OptionDraftForm state={editDraft} onState={setEditDraft} />
              <div className="space-y-2">
                <Label htmlFor="edit-explanation">{t("explanationLabel")}</Label>
                <Input
                  id="edit-explanation"
                  value={editExplanation}
                  onChange={(e) => setEditExplanation(e.target.value)}
                  placeholder={t("explanationPlaceholder")}
                  maxLength={2000}
                />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setEditing(null)}>
              <X className="h-4 w-4" aria-hidden /> {tCommon("cancel")}
            </Button>
            <Button onClick={() => void handleSaveEdit()} disabled={savingEdit}>
              {savingEdit ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              {t("saveQuestion")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Option-array editor driven by the PURE reducers in
 * lib/quizzes/question-draft.ts (set/add/remove/move; correctIndex follows its
 * option). Radio picks only change WHICH option is marked correct.
 */
function OptionDraftForm({
  state,
  onState,
}: {
  state: OptionDraftState;
  onState: (s: OptionDraftState) => void;
}) {
  const t = useTranslations("quizEditor");
  const groupId = useId();

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-extrabold">{t("optionsLabel")}</legend>
      <p className="text-xs font-extrabold text-muted-foreground">{t("correctLabel")}</p>
      <ul className="space-y-2">
        {state.options.map((opt, i) => (
          <li key={i} className="flex items-center gap-2">
            <input
              type="radio"
              name={`${groupId}-correct`}
              checked={state.correctIndex === i}
              onChange={() => onState({ ...state, correctIndex: i })}
              aria-label={`${t("correctLabel")}: ${opt.trim() || i + 1}`}
              className="h-4 w-4 accent-emerald-600"
            />
            <Input
              value={opt}
              maxLength={500}
              onChange={(e) =>
                onState(
                  applyOptionDraftOp(state, { kind: "set", index: i, value: e.target.value }),
                )
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("moveUpA11y")}
              disabled={i === 0}
              onClick={() =>
                onState(applyOptionDraftOp(state, { kind: "move", from: i, to: i - 1 }))
              }
            >
              <ArrowUp className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("removeOptionA11y", { index: i + 1 })}
              disabled={state.options.length <= 2}
              onClick={() =>
                onState(applyOptionDraftOp(state, { kind: "remove", index: i }))
              }
            >
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
      {state.options.length < 5 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onState(applyOptionDraftOp(state, { kind: "add" }))}
        >
          <Plus className="h-4 w-4" aria-hidden /> {t("addOption")}
        </Button>
      )}
    </fieldset>
  );
}
