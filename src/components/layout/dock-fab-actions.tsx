"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Plus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Dock FAB quick actions (lecturer): New class / New quiz. Shared by the
 * classes page (mobile sheet) and the dock FAB — one implementation so both
 * entries stay behaviorally identical (rate limits, error copy, i18n).
 */

type LecturerClassOption = { id: string; title: string };

/**
 * New class: title-only inline form (POST /api/classes). On success the
 * server list refreshes and the sheet closes.
 */
export function CreateClassAction({
  onDone,
  className,
  inputId = "fab-class-title",
}: {
  /** Called after a successful create (parent closes the sheet). */
  onDone: () => void;
  className?: string;
  /** Unique input id — the sheet and any inline embedding must not collide. */
  inputId?: string;
}) {
  const router = useRouter();
  const t = useTranslations("lecturer.classes");
  const tCommon = useTranslations("common");

  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitLock = useRef(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (submitLock.current) return;
    setError(null);
    submitLock.current = true;
    setCreating(true);
    try {
      const res = await fetch("/api/classes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message ?? body.error ?? tCommon("errorGeneric"));
        return;
      }
      setTitle("");
      toast.success(t("createdToast"));
      router.refresh();
      onDone();
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      submitLock.current = false;
      setCreating(false);
    }
  }

  return (
    <form onSubmit={handleCreate} className={cn("space-y-3", className)}>
      <div>
        <Label htmlFor={inputId} className="sr-only">
          {t("classTitleLabel")}
        </Label>
        <Input
          id={inputId}
          placeholder={t("classTitlePlaceholder")}
          value={title}
          disabled={creating}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={200}
        />
      </div>
      <div aria-live="polite">
        {error && (
          <p
            role="alert"
            className="rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-3 py-2 text-xs font-bold text-destructive"
          >
            {error}
          </p>
        )}
      </div>
      <Button
        type="submit"
        className="w-full font-bold"
        disabled={creating || !title.trim()}
      >
        {creating ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            {t("creatingBtn")}
          </>
        ) : (
          <>
            <Plus className="mr-1 h-4 w-4" aria-hidden />
            {t("createBtn")}
          </>
        )}
      </Button>
    </form>
  );
}

/**
 * New quiz: class picker (fetched once when the parent sheet opens) then the
 * full create form on the chosen class's page. Quiz creation stays
 * class-scoped (POST /api/classes/[id]/quizzes) — the picker routes there via
 * `?newQuiz=1`, which ClassDetailClient consumes to auto-open its form.
 */
export function CreateQuizAction({
  classes,
  onPick,
}: {
  /** Owner's active classes (id + title), fetched by the parent. */
  classes: LecturerClassOption[];
  /** Called with the class page URL to navigate to. */
  onPick: (url: string) => void;
}) {
  const tNav = useTranslations("nav");

  const [classId, setClassId] = useState("");

  if (classes.length === 0) {
    return (
      <p className="rounded-xl border-[3px] border-dashed border-border bg-card/60 px-3 py-3 text-center text-xs font-bold text-muted-foreground">
        {tNav("createNewQuizHint")}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-bold text-foreground">
          {tNav("createNewQuiz")}
        </legend>
        <div className="max-h-44 space-y-1.5 overflow-y-auto pr-0.5">
          {classes.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={classId === c.id}
              onClick={() => setClassId(c.id)}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2.5 rounded-xl border-[3px] px-3 py-2 text-left text-sm font-extrabold transition-all duration-150",
                classId === c.id
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-card text-foreground shadow-[0_2px_0_var(--border)] hover:border-primary/40",
              )}
            >
              <Users
                className={cn(
                  "h-4 w-4 shrink-0",
                  classId === c.id ? "text-primary" : "text-muted-foreground",
                )}
                aria-hidden
              />
              <span className="truncate">{c.title}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <Button
        className="w-full font-bold"
        disabled={!classId}
        onClick={() => onPick(`/lecturer/classes/${classId}?newQuiz=1`)}
      >
        <Plus className="mr-1 h-4 w-4" aria-hidden />
        {tNav("createNewQuiz")}
      </Button>
    </div>
  );
}
