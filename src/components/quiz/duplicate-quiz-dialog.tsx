"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CopyPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * AP-2 duplication dialog (PLAN_R_AUTHORING_PRODUCTIVITY). Shared by the
 * builder toolbar and the class-detail quiz rows. The destination class
 * defaults to the source's own (duplicate-in-place); any other class the
 * lecturer owns enables copy-to-class. The server refuses archived
 * destinations, so unarchived classes are the only options offered.
 */
export function DuplicateQuizDialog({
  quizId,
  quizTitle,
  sourceClassId,
  classes,
  open,
  onOpenChange,
}: {
  quizId: string;
  quizTitle: string;
  sourceClassId: string;
  /** Owned, unarchived classes: {id, title}. */
  classes: Array<{ id: string; title: string }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const t = useTranslations("lecturer.dialogs.duplicate");
  const tCommon = useTranslations("common");

  const [destClassId, setDestClassId] = useState(() =>
    // Duplicate-in-place when the source class is selectable (owned +
    // unarchived); otherwise fall back to the first available class — an
    // archived source class is refused server-side, so default somewhere
    // the copy can actually land.
    classes.some((c) => c.id === sourceClassId) ? sourceClassId : classes[0]?.id ?? sourceClassId,
  );
  const [duplicating, setDuplicating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitLock = useRef(false);

  function reset() {
    setDestClassId(
      classes.some((c) => c.id === sourceClassId) ? sourceClassId : classes[0]?.id ?? sourceClassId,
    );
    setError(null);
  }

  async function handleDuplicate() {
    if (duplicating || submitLock.current) return;
    submitLock.current = true;
    setDuplicating(true);
    setError(null);

    try {
      const res = await fetch(`/api/quizzes/${quizId}/duplicate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ destClassId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const codeMap: Record<string, string> = {
          class_archived: t("errArchived"),
          rate_limited: t("errRateLimited"),
        };
        setError(codeMap[body.error as string] ?? body.message ?? tCommon("errorGeneric"));
        return;
      }
      const newQuizId = (body as { quizId?: string }).quizId;
      toast.success(t("duplicatedToast", { title: quizTitle }), {
        ...(newQuizId
          ? {
              action: {
                label: t("openDraftAction"),
                onClick: () => router.push(`/lecturer/quizzes/${newQuizId}/builder`),
              },
            }
          : {}),
      });
      router.refresh();
      onOpenChange(false);
      reset();
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      submitLock.current = false;
      setDuplicating(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md p-6 sm:p-7">
        <DialogHeader>
          <DialogTitle className="text-xl font-bold font-heading flex items-center gap-2">
            <CopyPlus className="size-5 text-primary" aria-hidden="true" />
            {t("dialogTitle")}
          </DialogTitle>
          <DialogDescription className="text-xs font-semibold text-muted-foreground mt-0.5 break-words">
            {t("dialogSubtitle", { title: quizTitle })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2" aria-live="polite">
          {error && (
            <p
              className="rounded-xl border-[3px] border-destructive/40 bg-destructive/10 px-4 py-2.5 text-xs font-bold text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}

          <div className="space-y-2">
            <Label htmlFor="duplicate-dest-class" className="text-xs font-extrabold text-foreground">
              {t("destClassLabel")}
            </Label>
            <Select
              value={destClassId}
              onValueChange={(value) => {
                if (value) setDestClassId(value);
              }}
              disabled={duplicating}
            >
              <SelectTrigger id="duplicate-dest-class" className="w-full">
                {/* Base UI resolves the closed-trigger label from this child
                    (not the mounted items) — without it the raw UUID shows. */}
                <SelectValue placeholder={t("destClassPlaceholder")}>
                  {(value) => classes.find((c) => c.id === (value as string))?.title ?? String(value)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {classes.map((cls) => (
                  <SelectItem key={cls.id} value={cls.id}>
                    {cls.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] font-semibold text-muted-foreground">
              {t("destClassHelper")}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            disabled={duplicating}
          >
            {tCommon("cancel")}
          </Button>
          <Button type="button" onClick={handleDuplicate} disabled={duplicating}>
            <CopyPlus className="mr-1.5 size-4" aria-hidden="true" />
            {duplicating ? t("duplicatingBtn") : t("duplicateBtn")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
