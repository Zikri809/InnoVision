"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  applyOptionDraftOp,
  type OptionDraftOp,
  type OptionDraftState,
} from "@/lib/quizzes/question-draft";
import { QuestionInputSchema } from "@/lib/quizzes/validation";
import { GenerateFromFileDialog } from "@/components/extract/GenerateFromFileDialog";
import { QuestionImageField } from "@/components/media/question-image-field";
import { EmptyState } from "@/components/ui/empty-state";
import { QuizQuestionMarkIllustration } from "@/components/illustrations/quiz-question-mark";
import { CircleCheckIllustration } from "@/components/illustrations/circle-check";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useKeyboardOcclusion } from "@/hooks/use-keyboard-occlusion";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  Image as ImageIcon,
  Lightbulb,
  Loader2,
  MoreVertical,
  Pencil,
  Play,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

export type EditorQuestion = {
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

type QuizMeta = { id: string; title: string; description: string | null };

const QUESTION_CAP = 50;

/** Add-question draft — lecturer-builder shape, minus multi_select (the
 * student schema refuses it). The type is explicit rather than sniffed from
 * a "True/False" option pair. */
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

/**
 * Builder for one own practice quiz. Every operation hits the API IMMEDIATELY
 * (append/PATCH/DELETE/reorder RPCs) and reconciles local state from the
 * response — no save-all diffing, matching the lecturer builder's interaction
 * model while staying a fresh, student-scoped component (PLAN §5: zero blast
 * radius on lecturer UI).
 *
 * Visual composition mirrors the lecturer quiz builder: hero band (back link,
 * settings gear, chips, action strip), single "questions paper" section with
 * mobile accordion / desktop paper rows, bottom-sheet add form on mobile and
 * an inline card on desktop. Quiz settings are CONSTRAINED to title +
 * description — everything the lecturer settings dialog controls (mode,
 * timing, windows, retakes, shuffle) does not exist for practice quizzes.
 */
export function QuizEditorClient({
  quiz,
  initialQuestions,
  userId,
  ocrConfig,
}: {
  quiz: QuizMeta;
  initialQuestions: EditorQuestion[];
  userId: string;
  ocrConfig: { defaultEngine: "tesseract" | "glm" };
}) {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("quizEditor");
  const tMy = useTranslations("myQuizzes");
  const tCommon = useTranslations("common");
  const tMedia = useTranslations("media");

  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  // Local meta mirror — the settings sheet updates this so the hero shows the
  // saved title/description immediately, even before router.refresh lands.
  const [meta, setMeta] = useState<QuizMeta>(quiz);
  const [questions, setQuestions] = useState<EditorQuestion[]>(initialQuestions);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<EditorQuestion | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Add-question form state (lecturer-style draft).
  const [draft, setDraft] = useState<QuestionDraft>(emptyDraft);
  const [adding, setAdding] = useState(false);
  // Image staged in the add-question dropzone — uploaded AFTER the question
  // exists (the POST returns the new id). Cleared on every submit outcome so
  // it can never silently attach to a LATER question.
  const [pendingImage, setPendingImage] = useState<File | null>(null);
  const [mobileAddOpen, setMobileAddOpen] = useState(false);

  // Edit dialog state.
  const [editing, setEditing] = useState<EditorQuestion | null>(null);
  const [editDraft, setEditDraft] = useState<OptionDraftState>({
    options: [],
    correctIndex: 0,
  });
  const [savingEdit, setSavingEdit] = useState(false);
  // ResponsiveModal-local error state: the page banner sits BEHIND the modal overlay,
  // so edit failures must render inside <ResponsiveModalContent> to be visible.
  const [editError, setEditError] = useState<string | null>(null);
  const [editExplanation, setEditExplanation] = useState("");

  // Image ops commit immediately from the edit dialog (endpoint parity with
  // the old attach row); failures surface inline AND via toast — the toast
  // survives a mid-upload dialog close, the inline text does not.
  const [editImageBusy, setEditImageBusy] = useState(false);
  const [editImageError, setEditImageError] = useState<string | null>(null);

  // AI generation (student mode): dialog reports generated rows here.
  const [generateOpen, setGenerateOpen] = useState(false);

  // ── Mobile review composition (mirrors the lecturer builder) ──
  const isMobile = useMediaQuery("(max-width: 639px)");
  // Accordion: which question card is expanded (single at a time — the list
  // is for SCANNING, the expansion is for WORKING). Desktop ignores this.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // "Reviewed" checklist: which question ids the student has verified.
  // Session-scoped + device-local (localStorage) on purpose — verification is
  // a working state, not quiz data; no schema/API surface.
  const [reviewedIds, setReviewedIds] = useState<Set<string>>(new Set());
  const [unreviewedOnly, setUnreviewedOnly] = useState(false);
  useKeyboardOcclusion();

  const reviewedKey = `student-editor-reviewed-${quiz.id}`;
  // Read-once hydration from device-local storage — the read must not re-run;
  // later toggles own the state.
  useEffect(() => {
    if (!isMobile) return;
    try {
      const raw = window.localStorage.getItem(reviewedKey);
      if (raw)
        // eslint-disable-next-line react-hooks/set-state-in-effect -- read-once external init
        setReviewedIds(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* corrupted storage → start clean */
    }
  }, [isMobile, reviewedKey]);

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

  // Per-question image presence: BASE derived from the live questions state
  // (stays honest across router.refresh / AI replace / appends), overlaid by
  // optimistic local flags set at attach/remove time.
  const [imageFlags, setImageFlags] = useState<Record<string, boolean>>({});

  function hasImageFor(id: string): boolean {
    if (id in imageFlags) return imageFlags[id];
    return Boolean(questions.find((q) => q.id === id)?.image_path);
  }

  function setImageFlag(id: string, has: boolean) {
    setImageFlags((prev) => ({ ...prev, [id]: has }));
  }

  function handleGenerated(rows: unknown[], info: { capped: boolean }) {
    const before = questions.length;
    const next = rows as EditorQuestion[];
    setQuestions((prev) => [...prev, ...next].slice(0, QUESTION_CAP));
    if (info.capped || questions.length + next.length > QUESTION_CAP) {
      toast.info(t("capNotice", { count: QUESTION_CAP - before, max: QUESTION_CAP }));
    }
  }

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

  /** Local Zod pre-validation shared by add + edit paths. Raw Zod messages are
   * English-only, so issue paths map to the localized quizEditor keys before
   * display (raw text is never surfaced to users). */
  function buildCandidate(input: QuestionDraft): { value: Record<string, unknown> } | { error: string } {
    const cleaned = input.options.map((o) => o.trim());
    const parsed = QuestionInputSchema.safeParse({
      type: input.type,
      prompt: input.prompt,
      options: cleaned,
      correctIndex: input.correctIndex,
      explanation: input.explanation,
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

  // Shared pure reducers (see quiz-builder-client) — the answer key follows
  // its option on remove/move; no drifted inline copies.
  function applyOptions(d: QuestionDraft, op: OptionDraftOp): QuestionDraft {
    const next = applyOptionDraftOp(
      { options: d.options, correctIndex: d.correctIndex },
      op,
    );
    return { ...d, ...next };
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

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (lock.current) return;
    if (questions.length >= QUESTION_CAP) {
      fail(t("questionCapReached", { count: QUESTION_CAP }));
      return;
    }
    const candidate = buildCandidate(draft);
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
      const created = body.question as EditorQuestion;
      setQuestions((prev) => [...prev, created]);

      // Image phase — its failure never loses the created question; the user
      // retries via the question's edit dialog.
      if (pendingImage && created?.id) {
        try {
          const form = new FormData();
          form.append("image", pendingImage, pendingImage.name);
          const imgRes = await fetch(
            `/api/student-quizzes/${quiz.id}/questions/${created.id}/image`,
            { method: "POST", body: form },
          );
          if (!imgRes.ok) toast.error(tMedia("addedImageFailed"));
          else setImageFlag(created.id, true);
        } catch {
          toast.error(tMedia("addedImageFailed"));
        }
      }

      setPendingImage(null);
      setDraft(emptyDraft);
      // Stay in the sheet for continuous batch authoring (lecturer parity).
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
    // Don't bleed the previous question's inline image error into this one.
    setEditImageError(null);
  }

  async function runEditImageOp(
    questionId: string,
    op: () => Promise<Response>,
    nextHasImage: boolean,
    failureKey: "uploadFailed" | "removeFailed",
  ) {
    if (editImageBusy) return;
    setEditImageBusy(true);
    setEditImageError(null);
    let ok = false;
    try {
      const res = await op();
      if (res.ok) {
        ok = true;
        setImageFlag(questionId, nextHasImage);
      }
    } catch {
      // Network-level throw — surfaced like an HTTP failure below.
    }
    setEditImageBusy(false);
    if (!ok) {
      // Inline AND toast: the toast survives a mid-upload dialog close, the
      // inline text does not. Localized copy only (server messages are
      // English-only and would leak under the ms locale).
      const message = tMedia(failureKey);
      setEditImageError(message);
      toast.error(message);
      // Rejection contract for the field's await: resolve only on success.
      throw new Error("image_op_failed");
    }
  }

  async function handleSaveEdit() {
    if (lock.current || !editing) return;
    const candidate = buildCandidate({
      type: editing.type,
      prompt: editing.prompt,
      options: editDraft.options,
      correctIndex: editDraft.correctIndex ?? 0,
      explanation: editExplanation,
    });
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
    setDeleteTarget(q);
  }

  async function confirmDelete() {
    const q = deleteTarget;
    if (!q || lock.current) return;
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
      setDeleteTarget(null);
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

  function openSettings() {
    clearBanners();
    setSettingsOpen(true);
  }

  const defaultTrueFalseOptions = locale === "ms" ? ["Betul", "Salah"] : ["True", "False"];

  function typeLabel(type: EditorQuestion["type"]) {
    return type === "true_false" ? t("typeTrueFalse") : t("typeMcq");
  }

  /** Option list for the mobile accordion's expanded panel — the same
   * player-mirroring rows the desktop card renders (single source for the
   * "green = correct" visual so both compositions stay in sync). */
  function optionsFor(q: EditorQuestion) {
    return (
      <ul className="mt-2.5 space-y-1.5">
        {q.options.map((opt, i) => {
          const isCorrect = (q.correct_index ?? 0) === i;
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

  function renderQuestionForm(inSheet: boolean = false) {
    const idPrefix = inSheet ? "sheet-" : "";
    return (
      <form onSubmit={handleAdd} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}q-type`} className="text-xs font-extrabold text-foreground">
              {t("questionTypeLabel")}
            </Label>
            <Select
              value={draft.type}
              onValueChange={(v) => {
                const type = v as "mcq" | "true_false";
                setDraft((d) => {
                  if (type === "true_false") {
                    return { ...d, type, options: defaultTrueFalseOptions, correctIndex: 0 };
                  }
                  return {
                    ...d,
                    type,
                    options: d.options.length >= 2 ? d.options : ["", ""],
                  };
                });
              }}
            >
              <SelectTrigger id={`${idPrefix}q-type`} className="w-full">
                <SelectValue placeholder={t("questionTypeLabel")}>
                  {(v) => (v === "true_false" ? t("typeTrueFalse") : t("typeMcq"))}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mcq">{t("typeMcq")}</SelectItem>
                <SelectItem value="true_false">{t("typeTrueFalse")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}q-correct`} className="text-xs font-extrabold text-foreground">
              {t("correctAnswerLabel")}
            </Label>
            <Select
              value={String((draft.correctIndex ?? 0) + 1)}
              onValueChange={(v) =>
                setDraft((d) => ({ ...d, correctIndex: Number(v) - 1 }))
              }
            >
              <SelectTrigger id={`${idPrefix}q-correct`} className="w-full">
                <SelectValue placeholder={t("correctAnswerLabel")}>
                  {(v) => (v ? t("optionLabel", { index: v }) : t("correctAnswerLabel"))}
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

        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}q-prompt`} className="text-xs font-extrabold text-foreground">
            {t("promptLabel")}
          </Label>
          <Textarea
            id={`${idPrefix}q-prompt`}
            aria-label={t("promptLabel")}
            value={draft.prompt}
            onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
            rows={3}
            maxLength={2000}
            required
            placeholder={t("promptPlaceholder")}
            className="resize-y"
          />
        </div>

        {/* Image sits between prompt and options — mirroring where the
            player renders it above the options (WYSIWYG authoring). */}
        <QuestionImageField
          variant="staged"
          file={pendingImage}
          onFileChange={setPendingImage}
          altPrompt={draft.prompt}
          disabled={adding || busy}
        />

        <div className="space-y-2">
          <Label className="font-extrabold">{t("optionsLabel")}</Label>
          {draft.options.map((opt, i) => {
            const isCorrect = draft.correctIndex === i;
            return (
              <div key={i} className="flex items-center gap-2">
                <button
                  type="button"
                  title={t("correctAnswerLabel")}
                  aria-label={`${t("correctAnswerLabel")}: ${t("optionLabel", { index: i + 1 })}`}
                  aria-pressed={isCorrect}
                  onClick={() => setDraft((d) => ({ ...d, correctIndex: i }))}
                  className={cn(
                    "flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-xl font-heading text-xs font-extrabold transition-[transform,border-color,background-color] hover:scale-105 active:scale-95 shadow-xs",
                    isCorrect
                      ? "border-[2px] border-emerald-500 bg-emerald-100 text-emerald-900 dark:border-emerald-400/60 dark:bg-emerald-950/50 dark:text-emerald-200"
                      : "border-[2px] border-border bg-muted/60 text-muted-foreground hover:border-emerald-300",
                  )}
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
                    <div className="flex items-center gap-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => moveOption(i, "up")}
                        disabled={i === 0}
                        aria-label={`${t("moveUpA11y")} ${i + 1}`}
                      >
                        <ArrowUp className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => moveOption(i, "down")}
                        disabled={i === draft.options.length - 1}
                        aria-label={`${t("moveDownA11y")} ${i + 1}`}
                      >
                        <ArrowDown className="h-4 w-4" aria-hidden />
                      </Button>
                    </div>
                    {draft.options.length > 2 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="text-destructive hover:text-destructive"
                        onClick={() => removeOption(i)}
                        aria-label={t("removeOptionA11y", { index: i + 1 })}
                      >
                        <X className="h-4 w-4" aria-hidden />
                      </Button>
                    )}
                  </>
                )}
              </div>
            );
          })}
          {draft.options.length < 5 && (
            <Button type="button" variant="outline" size="sm" onClick={addOption}>
              <Plus className="h-4 w-4" aria-hidden /> {t("addOption")}
            </Button>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}q-explanation`} className="text-xs font-extrabold text-foreground">
            {t("explanationLabel")}
          </Label>
          <Textarea
            id={`${idPrefix}q-explanation`}
            value={draft.explanation}
            onChange={(e) => setDraft((d) => ({ ...d, explanation: e.target.value }))}
            rows={2}
            maxLength={2000}
            placeholder={t("explanationPlaceholder")}
            className="resize-y"
          />
        </div>

        <div className="flex items-center gap-3 pt-2">
          <Button type="submit" disabled={adding || busy || !draft.prompt.trim()}>
            {adding ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Plus className="h-4 w-4" aria-hidden />
            )}
            {t("addQuestionSubmit")}
          </Button>
          {inSheet && (
            <Button type="button" variant="outline" onClick={() => setMobileAddOpen(false)}>
              {tCommon("done")}
            </Button>
          )}
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-3.5 sm:space-y-6">
      {/* ── Hero band ── */}
      <section className="relative overflow-hidden rounded-[24px] sm:rounded-[28px] border-2 sm:border-[3px] border-border bg-gradient-to-br from-orange-100 via-orange-50 to-blue-50 dark:from-orange-950/40 dark:via-card dark:to-blue-950/40 shadow-[var(--shadow-clay-sm)] sm:shadow-[var(--shadow-clay)]">
        {/* Content area (padded) */}
        <div className="relative p-4 pb-3.5 sm:p-7 md:p-8">
          <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-32 w-32 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/40 dark:bg-white/5" />

          {/* Top row: Back link. Quiz details lives in the mobile ⋯ menu, the
              description chip, and the title double-click — no card-level
              gear (redundant with the menu entry). */}
          <div className="flex items-center justify-between gap-3">
            <Link
              href="/student/my-quizzes"
              className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-extrabold text-muted-foreground transition-colors hover:text-primary truncate"
            >
              <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />
              <span className="truncate">{tMy("heroTitle")}</span>
            </Link>
          </div>

          {/* Title — edited through the settings sheet only */}
          <h1
            className="mt-3 cursor-default font-heading text-2xl sm:text-3xl font-semibold leading-tight [text-wrap:balance]"
            onDoubleClick={openSettings}
            title={t("editSettings")}
          >
            {meta.title}
          </h1>

          {/* Chips — Practice mode + description + question count. The
              description chip doubles as the settings entry point (what the
              lecturer's mode/timer/schedule chips do). */}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 sm:gap-2">
            <span className="inline-flex items-center justify-center h-7 sm:h-8 rounded-full border-2 sm:border-[3px] px-2.5 sm:px-3.5 text-2xs sm:text-xs font-extrabold select-none cursor-default border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-700/50 dark:bg-emerald-950/40 dark:text-emerald-300">
              {t("practiceChip")}
            </span>

            <button
              type="button"
              onClick={openSettings}
              aria-haspopup="dialog"
              className="inline-flex max-w-full items-center justify-center gap-1.5 h-7 sm:h-8 rounded-full border-2 sm:border-[3px] px-2.5 sm:px-3.5 text-2xs sm:text-xs font-extrabold cursor-pointer transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-[var(--shadow-clay-sm)] active:translate-y-0 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/70 border-border bg-muted text-muted-foreground"
            >
              {meta.description ? (
                <span className="max-w-[14rem] sm:max-w-[18rem] truncate">{meta.description}</span>
              ) : (
                <>
                  <Plus className="size-3 sm:size-3.5" aria-hidden />
                  <span>{t("addDescription")}</span>
                </>
              )}
            </button>

            <span className="inline-flex items-center justify-center h-7 sm:h-8 rounded-full border-2 sm:border-[3px] px-2.5 sm:px-3.5 text-2xs sm:text-xs font-extrabold text-muted-foreground select-none cursor-default border-border bg-muted">
              {t("questionCount", { count: questions.length })}
            </span>
          </div>

          {/* Desktop action cluster (sm+) — sits below chips on desktop */}
          <div className="mt-4 hidden items-center gap-3 sm:flex">
            <Button
              variant="accent"
              onClick={() => setGenerateOpen(true)}
              disabled={questions.length >= QUESTION_CAP}
              className="h-11 rounded-2xl px-4 text-sm font-extrabold gap-1.5 shadow-[var(--shadow-clay-sm)]"
            >
              <Sparkles className="size-4 shrink-0" />
              <span>{t("generateWithAi")}</span>
            </Button>
            <Link href={`/play/student/${quiz.id}`}>
              <Button variant="outline">
                <Play className="h-4 w-4" aria-hidden /> {t("previewQuiz")}
              </Button>
            </Link>
          </div>
        </div>

        {/* ── Mobile action strip — anchored at card bottom, full-width ──
            Draft job changes with content: EMPTY quiz → Generate is the
            primary action; once questions exist the job is verify & play,
            so Add question leads and Generate demotes into the ⋯ menu. */}
        <div className="flex items-center gap-2 border-t-2 border-border/50 bg-white/25 px-4 py-3 dark:bg-black/10 sm:hidden">
          {questions.length === 0 ? (
            <Button
              variant="accent"
              onClick={() => setGenerateOpen(true)}
              className="h-10 flex-1 rounded-xl px-3 text-xs font-extrabold gap-1.5 shadow-[var(--shadow-clay-sm)]"
            >
              <Sparkles className="size-4 shrink-0" />
              <span>{t("generateWithAi")}</span>
            </Button>
          ) : (
            <Button
              onClick={() => setMobileAddOpen(true)}
              className="h-10 flex-1 rounded-xl px-3 text-xs font-extrabold gap-1.5 shadow-[var(--shadow-clay-sm)]"
            >
              <Plus className="size-4 shrink-0" />
              <span>{t("addQuestion")}</span>
            </Button>
          )}
          <Link href={`/play/student/${quiz.id}`} className="flex-1">
            <Button
              variant="outline"
              className="h-10 w-full rounded-xl px-3 text-xs font-extrabold gap-1.5"
            >
              <Play className="size-4 shrink-0" />
              <span>{t("previewQuiz")}</span>
            </Button>
          </Link>
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
              {questions.length === 0 && (
                <DropdownMenuItem
                  onClick={() => setMobileAddOpen(true)}
                  className="flex items-center gap-2 cursor-pointer font-bold"
                >
                  <Plus className="size-4 text-muted-foreground" />
                  <span>{t("addQuestion")}</span>
                </DropdownMenuItem>
              )}
              {questions.length > 0 && (
                <DropdownMenuItem
                  onClick={() => setGenerateOpen(true)}
                  className="flex items-center gap-2 cursor-pointer font-bold"
                >
                  <Sparkles className="size-4 text-primary" />
                  <span>{t("generateWithAi")}</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={openSettings}
                className="flex items-center gap-2 cursor-pointer font-bold"
              >
                <Settings2 className="size-4 text-muted-foreground" />
                <span>{t("editSettings")}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </section>

      {/* ── Constrained settings sheet (title + description ONLY) ── */}
      <ResponsiveModal open={settingsOpen} onOpenChange={setSettingsOpen}>
        <QuizSettingsForm
          quiz={meta}
          onClose={() => setSettingsOpen(false)}
          onSaved={(next) => {
            setMeta(next);
            setSettingsOpen(false);
            toast.success(tMy("updatedNotice"));
            router.refresh();
          }}
        />
      </ResponsiveModal>

      <GenerateFromFileDialog
        quizId={quiz.id}
        userId={userId}
        config={ocrConfig}
        open={generateOpen}
        onOpenChange={setGenerateOpen}
        hasQuestions={questions.length > 0}
        mode="student"
        endpoint={`/api/student-quizzes/${quiz.id}/generate`}
        onGenerated={handleGenerated}
      />

      <div aria-live="polite">
        {error && (
          <div
            className="flex items-center justify-between gap-3 rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-2 text-sm font-bold text-destructive"
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

      {/* ── Questions paper (single section, lecturer parity) ── */}
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
            {/* Add lives in the mobile hero strip / ⋯ menu (lecturer parity);
                the header keeps only the terminal action per breakpoint:
                Preview on desktop. */}
            {!isMobile && (
              <Link href={`/play/student/${quiz.id}`}>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-10 rounded-2xl px-5 text-sm font-extrabold"
                >
                  <Play className="size-4" aria-hidden /> {t("previewQuiz")}
                </Button>
              </Link>
            )}
          </div>
        </div>
        {/* Mobile review toolbar: the reviewed-checklist filter. Desktop
            renders no filter — its fully-expanded cards ARE the review
            surface. */}
        {isMobile && questions.length > 0 && (
          <div className="flex items-center gap-2 px-4 pb-3">
            <div
              role="group"
              aria-label={t("reviewFilterLabel")}
              className="flex items-center gap-1.5"
            >
              <button
                type="button"
                aria-pressed={!unreviewedOnly}
                onClick={() => setUnreviewedOnly(false)}
                className={`rounded-full border-2 px-3 py-1 text-xs font-extrabold transition-colors cursor-pointer ${
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
                className={`rounded-full border-2 px-3 py-1 text-xs font-extrabold transition-colors cursor-pointer ${
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
            <EmptyState
              illustration={QuizQuestionMarkIllustration}
              title={t("noQuestionsTitle")}
              subtitle={t("noQuestionsSubtitle")}
              className="rounded-[20px] border-[3px] border-dashed bg-muted/40 px-6 py-8 sm:py-10"
              iconClassName="h-20"
            />
          ) : visibleQuestions.length === 0 ? (
            /* "To review" filter with everything checked — celebrate the
                finished checklist instead of rendering a blank list. */
            <EmptyState
              illustration={CircleCheckIllustration}
              title={t("allReviewedTitle")}
              subtitle={t("allReviewedSubtitle")}
              className="rounded-[20px] border-[3px] border-dashed bg-muted/40 px-6 py-8 sm:py-10"
              iconClassName="h-16 text-emerald-600 dark:text-emerald-400"
            />
          ) : (
            <ul className="divide-y divide-border/40 sm:divide-y-[3px] sm:divide-border/60">
              {visibleQuestions.map((q, idx) => {
                // Mobile composition (below sm): accordion rows + ⋯ menu +
                // reviewed toggle. The aria label carries the position in the
                // list for the desktop parity branch.
                const globalIdx = questions.indexOf(q);
                return (
                  <li key={q.id}>
                    {isMobile ? (
                      /* ── Mobile list row (below sm) — minimal: check circle,
                          number, 2-line prompt, chevron. No metadata chips —
                          type lives in the expansion where the green option
                          highlight is the single key indicator. ── */
                      <div>
                        <div className="flex items-start gap-1 px-1 py-2.5">
                          {/* Reviewed toggle — ticking off questions is the
                              verify workflow. 40px hit area keeps it
                              thumb-friendly. */}
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
                          <div className="mr-1 ml-[44px] border-t-2 border-border/40 pb-3.5 pt-2.5">
                            {/* Type label only — the answer key itself is
                                already shown by the green option highlight
                                below; a "Correct answer" pill would repeat
                                it twice in one panel. */}
                            <div className="flex flex-wrap items-center gap-1.5 px-1">
                              <span className="text-2xs font-extrabold uppercase tracking-wide text-muted-foreground">
                                {typeLabel(q.type)}
                              </span>
                            </div>
                            {optionsFor(q)}
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
                            <div className="mt-3 flex items-center gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => openEdit(q)}
                                className="h-9 gap-1.5 rounded-xl px-3 text-xs font-extrabold"
                              >
                                <Pencil className="size-3.5" />
                                {tCommon("edit")}
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
                                    onClick={() => handleMove(globalIdx, -1)}
                                    disabled={globalIdx === 0 || busy}
                                    className="flex items-center gap-2 cursor-pointer font-bold"
                                  >
                                    <ArrowUp className="size-4 text-muted-foreground" />
                                    <span>{t("moveUp")}</span>
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => handleMove(globalIdx, 1)}
                                    disabled={globalIdx === questions.length - 1 || busy}
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
                                    <span>{tCommon("delete")}</span>
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      /* ── Desktop paper row (sm+) — questions flow as one
                          continuous paper on the section card. Actions
                          collapse into a right gutter of quiet icons, and
                          the green option row is the single answer-key
                          indicator (mobile parity). ── */
                      <article className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-1 py-5 sm:px-3">
                        <div className="min-w-0 max-w-[860px]">
                          <span className="grid size-10 place-items-center rounded-[13px] border-2 border-border bg-muted font-heading text-[17px] font-semibold tabular-nums text-foreground/80">
                            {globalIdx + 1}.
                          </span>
                          <p className="mt-2.5 font-heading text-base font-semibold leading-snug">
                            {q.prompt}
                          </p>
                          <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs font-extrabold uppercase tracking-wide text-muted-foreground">
                            {typeLabel(q.type)}
                            {hasImageFor(q.id) && (
                              <span className="inline-flex items-center gap-1">
                                <ImageIcon className="size-3" aria-hidden />
                                {tMedia("imageBadge")}
                              </span>
                            )}
                          </p>

                          {/* Per-option rows (A/B/C/D) with the key highlighted —
                              mirrors the player's answer list (WYSIWYG). */}
                          {optionsFor(q)}

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

                        {/* Margin gutter: quiet action icons; labels surface
                            via tooltip on hover AND keyboard focus. */}
                        <div className="flex flex-col items-center gap-1 pt-1">
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => openEdit(q)}
                                  aria-label={t("editQuestion")}
                                  className="size-8"
                                >
                                  <Pencil className="size-4" />
                                </Button>
                              }
                            />
                            <TooltipContent>{t("editQuestion")}</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => handleMove(globalIdx, -1)}
                                  disabled={idx === 0 || busy}
                                  aria-label={t("moveUpA11y")}
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
                                  onClick={() => handleMove(globalIdx, 1)}
                                  disabled={idx === questions.length - 1 || busy}
                                  aria-label={t("moveDownA11y")}
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
                                  aria-label={tCommon("delete")}
                                  className="size-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
                                >
                                  <Trash2 className="size-4" />
                                </Button>
                              }
                            />
                            <TooltipContent>{tCommon("delete")}</TooltipContent>
                          </Tooltip>
                        </div>
                      </article>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* ── Add-question: bottom sheet (mobile) / inline card (desktop) ── */}
      <Sheet open={mobileAddOpen} onOpenChange={setMobileAddOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[92dvh] overflow-hidden flex flex-col rounded-t-[28px] border-t-[3px] border-x-[3px] border-border bg-card p-0 shadow-[var(--shadow-clay-up)]"
        >
          <SheetHeader className="p-4 sm:p-5 pb-3 pr-12 border-b-2 sm:border-b-[3px] border-border/40 shrink-0">
            <SheetTitle className="text-lg sm:text-xl font-bold font-heading">{t("addQuestion")}</SheetTitle>
            <SheetDescription className="text-xs sm:text-sm font-semibold text-muted-foreground">{t("addQuestionSubtitle")}</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-4 sm:p-5 pb-8">
            {renderQuestionForm(true)}
          </div>
        </SheetContent>
      </Sheet>

      <Card className="hidden sm:block rounded-[28px] border-[3px] shadow-[var(--shadow-clay)]">
        <CardHeader>
          <CardTitle className="text-lg sm:text-xl">{t("addQuestion")}</CardTitle>
          <CardDescription>{t("addQuestionSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          {renderQuestionForm(false)}
        </CardContent>
      </Card>

      {/* ── Edit dialog ── */}
      <ResponsiveModal open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <ResponsiveModalContent className="sm:max-w-lg">
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>{t("editQuestion")}</ResponsiveModalTitle>
            <ResponsiveModalDescription>{t("editQuestionHint")}</ResponsiveModalDescription>
          </ResponsiveModalHeader>
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

              {/* Image (commits immediately — independent of Save below). */}
              <QuestionImageField
                variant="committed"
                questionId={editing.id}
                // Live flag (overlay) — editing.image_path is the row
                // captured at open time and goes stale after in-dialog ops.
                hasImage={hasImageFor(editing.id)}
                altPrompt={editing.prompt}
                busy={editImageBusy}
                errorText={editImageError}
                disabled={savingEdit}
                onFile={(file) => {
                  const form = new FormData();
                  form.append("image", file, file.name);
                  return runEditImageOp(
                    editing.id,
                    () =>
                      fetch(
                        `/api/student-quizzes/${quiz.id}/questions/${editing.id}/image`,
                        { method: "POST", body: form },
                      ),
                    true,
                    "uploadFailed",
                  );
                }}
                onRemove={() =>
                  runEditImageOp(
                    editing.id,
                    () =>
                      fetch(
                        `/api/student-quizzes/${quiz.id}/questions/${editing.id}/image`,
                        { method: "DELETE" },
                      ),
                    false,
                    "removeFailed",
                  )
                }
              />
            </div>
          )}
          <ResponsiveModalFooter className="gap-2">
            <Button variant="outline" onClick={() => setEditing(null)}>
              <X className="h-4 w-4" aria-hidden /> {tCommon("cancel")}
            </Button>
            <Button onClick={() => void handleSaveEdit()} disabled={savingEdit}>
              {savingEdit ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              {t("saveQuestion")}
            </Button>
          </ResponsiveModalFooter>
        </ResponsiveModalContent>
      </ResponsiveModal>

      {/* ── Delete-question confirmation (replaces window.confirm) ── */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && busy) return;
          setDeleteTarget(open ? deleteTarget : null);
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
            <AlertDialogCancel disabled={busy}>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => void confirmDelete()}
            >
              {busy ? tCommon("loading") : tCommon("confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Constrained quiz-details sheet — the student counterpart of the lecturer's
 * EditQuizDialog with everything a practice quiz does not have stripped out:
 * title + description only (no mode, timing, availability windows, retakes,
 * or shuffling). Same ResponsiveModal shell: pull-up drawer with a pinned CTA
 * footer on mobile, centered dialog on desktop.
 */
function QuizSettingsForm({
  quiz,
  onClose,
  onSaved,
}: {
  quiz: QuizMeta;
  onClose: () => void;
  onSaved: (next: QuizMeta) => void;
}) {
  const t = useTranslations("quizEditor");
  const tCommon = useTranslations("common");

  const [title, setTitle] = useState(quiz.title);
  const [description, setDescription] = useState(quiz.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitLock = useRef(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitLock.current || saving) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError(t("needTitle"));
      return;
    }

    submitLock.current = true;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/student-quizzes/${quiz.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: trimmedTitle,
          description: description.trim() ? description.trim() : null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message ?? tCommon("errorGeneric"));
        return;
      }
      onSaved({ id: quiz.id, title: trimmedTitle, description: description.trim() || null });
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      submitLock.current = false;
      setSaving(false);
    }
  }

  const actionButtons = (
    <>
      <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
        {tCommon("cancel")}
      </Button>
      <Button
        type="submit"
        form="student-quiz-settings-form"
        disabled={saving || !title.trim()}
        className="flex-1 font-extrabold sm:flex-none"
      >
        {saving ? tCommon("saving") : t("metaSave")}
      </Button>
    </>
  );

  return (
    <ResponsiveModalContent
      className="sm:max-w-lg"
      footer={
        /* Pinned drawer footer (mobile): Save stays reachable while the body
           scrolls; submits via form association. */
        <div className="flex items-center justify-end gap-2 pb-[max(0.25rem,var(--safe-bottom))]">
          {actionButtons}
        </div>
      }
    >
      <ResponsiveModalHeader>
        <ResponsiveModalTitle className="font-heading text-xl font-bold">
          {t("settingsTitle")}
        </ResponsiveModalTitle>
        <ResponsiveModalDescription>{t("settingsSubtitle")}</ResponsiveModalDescription>
      </ResponsiveModalHeader>

      <form id="student-quiz-settings-form" onSubmit={handleSubmit} className="space-y-4 pt-2">
        {error && (
          <p
            className="rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive"
            role="alert"
          >
            {error}
          </p>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="student-quiz-title" className="text-xs font-extrabold text-foreground">
            {t("titleLabel")}
          </Label>
          <Input
            id="student-quiz-title"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (error) setError(null);
            }}
            required
            maxLength={200}
            placeholder={t("titlePlaceholder")}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="student-quiz-desc" className="text-xs font-extrabold text-foreground">
            {t("descriptionLabel")}
          </Label>
          <Input
            id="student-quiz-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("descriptionPlaceholder")}
            maxLength={500}
          />
        </div>
      </form>

      {/* Desktop dialog footer (≥640px): the pinned `footer` prop above is
          drawer-only, so dialog mode submits from here instead. */}
      <ResponsiveModalFooter className="max-sm:hidden pt-2">{actionButtons}</ResponsiveModalFooter>
    </ResponsiveModalContent>
  );
}

/**
 * Option-array editor for the EDIT dialog, driven by the PURE reducers in
 * lib/quizzes/question-draft.ts (set/add/remove/move; correctIndex follows
 * its option). Radio picks only change WHICH option is marked correct.
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
