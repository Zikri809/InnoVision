"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ImageIcon, Trash2, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Attach / replace / remove controls for ONE question's image (draft-time
 * authoring surfaces: lecturer builder + practice editor). Uploads ride the
 * API route (multipart POST) — never browser→storage — so the server sniffs
 * the bytes. `onChanged` lets the owning card refresh its has-image flag.
 *
 * Deliberately does NOT mint a signed URL (no useQuestionImage here): the
 * label derives purely from `hasImage`, so a builder with N imaged questions
 * costs zero signing calls against the shared 60/min budget.
 */
export function QuestionImageAttach({
  uploadEndpoint,
  hasImage,
  onChanged,
}: {
  /** e.g. `/api/quizzes/<qid>/questions/<questionId>/image` (POST + DELETE) */
  uploadEndpoint: string;
  hasImage: boolean;
  onChanged: (hasImage: boolean) => void;
}) {
  const t = useTranslations("media");
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File | undefined | null) {
    // Reset FIRST so re-selecting the same rejected file still fires onChange.
    if (inputRef.current) inputRef.current.value = "";
    if (!file || busy) return;
    if (file.size > MAX_BYTES) {
      setError(t("tooLarge"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("image", file, file.name);
      const res = await fetch(uploadEndpoint, { method: "POST", body: form });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setError(body.message ?? t("uploadFailed"));
        return;
      }
      onChanged(true);
    } catch {
      setError(t("uploadFailed"));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleRemove() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(uploadEndpoint, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setError(body.message ?? t("removeFailed"));
        return;
      }
      onChanged(false);
    } catch {
      setError(t("removeFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="h-8 gap-1.5 px-2.5 text-xs font-bold"
        >
          {busy ? (
            <span className="size-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          ) : (
            <UploadCloud className="size-3.5" aria-hidden />
          )}
          {hasImage ? t("replace") : t("attach")}
        </Button>
        {hasImage && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={handleRemove}
            className="h-8 gap-1.5 px-2.5 text-xs font-bold text-destructive hover:text-destructive"
          >
            <Trash2 className="size-3.5" aria-hidden />
            {t("remove")}
          </Button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => void handleFile(e.target.files?.[0])}
      />
      {error && (
        <p role="alert" className="text-xs font-bold text-destructive">
          {error}
        </p>
      )}
      {hasImage && (
        <p className="flex items-center gap-1.5 text-[11px] font-bold text-muted-foreground">
          <ImageIcon className="size-3.5" aria-hidden /> {t("attachedLabel")}
        </p>
      )}
    </div>
  );
}
