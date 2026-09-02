"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Image as ImageIcon, UploadCloud, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MAX_QUESTION_IMAGE_BYTES } from "@/lib/media/validation";
import { formatBytes, validateImageFile } from "@/lib/media/client";
import {
  invalidateQuestionImage,
  useQuestionImage,
} from "@/lib/media/use-question-image";

/**
 * Question-image authoring field (replaces the old per-card Attach buttons).
 * One component, two modes selected by `variant`:
 *
 * - "staged"    — add-question forms: the parent holds the picked File and
 *                 uploads it AFTER question creation (the POST returns the new
 *                 id). Preview rides a local object URL — zero signing cost.
 * - "committed" — edit dialogs: the question already exists, so picks/removals
 *                 commit immediately through the existing image route; the
 *                 preview mints a signed URL via useQuestionImage (cache-aware)
 *                 and the cache is invalidated after every successful op.
 *
 * Client validation is UX-only (server magic-byte sniff stays authoritative).
 */
export function QuestionImageField({
  variant,
  altPrompt,
  disabled = false,
  // staged mode
  file = null,
  onFileChange,
  // committed mode
  questionId,
  hasImage = false,
  busy = false,
  errorText = null,
  onFile,
  onRemove,
}: {
  variant: "staged" | "committed";
  /** Prompt excerpt doubles as the preview's alt text (player parity). */
  altPrompt: string;
  disabled?: boolean;
  /** staged: picked file held by the parent; null renders the dropzone. */
  file?: File | null;
  /** staged: hand the picked file to the parent (null clears the stage). */
  onFileChange?: (file: File | null) => void;
  /** committed: question id feeding the signed-URL cache. */
  questionId?: string;
  /** committed: whether a server-side image exists right now. */
  hasImage?: boolean;
  /** committed: true while the parent's upload/remove request is in flight. */
  busy?: boolean;
  /** committed: parent-owned server error rendered inline (role="alert"). */
  errorText?: string | null;
  /**
   * committed: resolve = committed (component updates state + invalidates the
   * signed-URL cache); reject = failed (parent owns the toast/error UI).
   */
  onFile?: (file: File) => Promise<void>;
  onRemove?: () => Promise<void>;
}) {
  const t = useTranslations("media");
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const zoneRef = useRef<HTMLButtonElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  // Committed-mode state: seeded once (edit dialogs remount per question),
  // then updated locally as ops commit.
  const [hasCommitted, setHasCommitted] = useState(hasImage);
  const [opBusy, setOpBusy] = useState(false);
  const signed = useQuestionImage(
    variant === "committed" && hasCommitted ? (questionId ?? null) : null,
  );

  const isBusy = opBusy || busy;

  // A committed image whose signed-URL mint failed must NOT masquerade as
  // "no image" (the dropzone would invite a needless re-upload) — it gets its
  // own error row with a retry below.
  const signFailed =
    variant === "committed" && hasCommitted && signed.failed;

  // Staged preview: the object URL is assigned imperatively (create on file
  // change, revoke on replace/unmount) — no state, no effect-phase setState.
  const stagedImgRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (variant !== "staged" || !file) return;
    const el = stagedImgRef.current;
    if (!el) return;
    const url = URL.createObjectURL(file);
    el.src = url;
    return () => {
      el.src = "";
      URL.revokeObjectURL(url);
    };
  }, [variant, file]);

  // Focus restoration: removing/replacing the filled state unmounts the
  // focused action button → focus drops to <body>. Pull it back to the zone.
  const filled =
    variant === "staged" ? Boolean(file) : hasCommitted && !signed.failed;
  const prevFilledRef = useRef(filled);
  useEffect(() => {
    if (
      prevFilledRef.current &&
      !filled &&
      typeof document !== "undefined" &&
      document.activeElement === document.body
    ) {
      requestAnimationFrame(() => zoneRef.current?.focus());
    }
    prevFilledRef.current = filled;
  }, [filled]);

  // Browser-default drag behavior navigates to the dropped file and destroys
  // any typed draft. While a field is mounted, swallow window-level drops
  // that miss every dropzone.
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  async function commitOp(op: () => Promise<unknown>, nextHas: boolean) {
    if (!questionId) return;
    setOpBusy(true);
    try {
      await op();
      // Replace (true → true) needs an explicit refetch: invalidating the
      // module cache alone doesn't re-run the hook's effect, so the <img>
      // would keep showing the superseded image.
      const replace = hasCommitted && nextHas;
      setHasCommitted(nextHas);
      invalidateQuestionImage(questionId);
      if (replace) signed.retry();
    } catch {
      // Parent owns failure surfacing (toast survives dialog unmount).
    } finally {
      setOpBusy(false);
    }
  }

  function pick(next: File | undefined | null) {
    // Reset FIRST so re-selecting the same rejected/replaced file still fires.
    if (inputRef.current) inputRef.current.value = "";
    if (!next || isBusy || disabled) return;
    const verdict = validateImageFile(next, MAX_QUESTION_IMAGE_BYTES);
    if (!verdict.ok) {
      setPickError(t(verdict.error));
      return;
    }
    setPickError(null);
    if (variant === "staged") {
      onFileChange?.(next);
      return;
    }
    if (onFile) void commitOp(() => onFile(next), true);
  }

  function handleRemove() {
    if (isBusy || disabled) return;
    if (variant === "staged") {
      onFileChange?.(null);
      return;
    }
    if (onRemove) void commitOp(onRemove, false);
  }

  // Shared by the empty dropzone AND the filled preview (drag-to-replace).
  function handleDragOver(e: React.DragEvent<Element>) {
    e.preventDefault();
    if (disabled || isBusy) return;
    setDragOver(true);
  }

  function handleDragLeave() {
    setDragOver(false);
  }

  function handleDrop(e: React.DragEvent<Element>) {
    e.preventDefault();
    setDragOver(false);
    if (disabled || isBusy) return;
    if (!e.dataTransfer.types.includes("Files")) return;
    // Multi-file drops take the first image only.
    pick(e.dataTransfer.files[0]);
  }

  const shownError =
    pickError ?? (variant === "committed" ? errorText : null);

  const dropzoneClasses = `flex w-full cursor-pointer flex-col items-center justify-center gap-1.5 rounded-2xl border-[3px] border-dashed p-5 py-6 text-center text-sm transition-all duration-150 outline-none focus-visible:ring-4 focus-visible:ring-primary/20 disabled:pointer-events-none disabled:opacity-60 disabled:cursor-not-allowed ${
    dragOver
      ? "border-primary bg-primary/10 scale-[1.01]"
      : "border-border bg-card/60 hover:bg-card shadow-[var(--shadow-clay-sm)]"
  }`;

  const previewAlt = altPrompt.trim()
    ? t("imageAlt", { prompt: altPrompt.slice(0, 80) })
    : t("previewAlt");

  return (
    <div className="space-y-1.5" aria-busy={isBusy}>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
        className="hidden"
        data-testid="question-image-input"
        aria-label={t("inputAria")}
        disabled={disabled}
        onChange={(e) => pick(e.target.files?.[0])}
      />

      {signFailed ? (
        <div className="flex items-center justify-between gap-2 rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-3 py-2">
          <p className="text-xs font-bold text-destructive">{t("imageUnavailable")}</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={signed.retry}
            className="h-7 gap-1 px-2 text-xs font-bold"
          >
            {t("retryLabel")}
          </Button>
        </div>
      ) : filled ? (
        <>
          <p className="text-xs font-extrabold">{t("fieldHeading")}</p>
          {/* Filled wrapper accepts drops so dragging a new file replaces
              the current one instead of hitting browser defaults. */}
          <div className="space-y-1.5" onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
          <div className="relative">
            {/* The preview itself is the replace affordance: click (or drop)
                a file onto it — no separate upload chrome to explain. */}
            <button
              type="button"
              disabled={disabled || isBusy}
              onClick={() => inputRef.current?.click()}
              aria-label={t("replaceAria")}
              className={`group/preview relative flex h-36 w-full cursor-pointer items-center justify-center overflow-hidden rounded-2xl border-[3px] bg-muted/40 outline-none transition-colors focus-visible:ring-4 focus-visible:ring-ring/40 disabled:cursor-not-allowed sm:h-48 ${
                dragOver
                  ? "border-primary bg-primary/10"
                  : "border-border hover:border-primary/60"
              }`}
            >
              {variant === "staged" && file ? (
                <img
                  ref={stagedImgRef}
                  alt={previewAlt}
                  className="max-h-full w-auto max-w-full object-contain"
                />
              ) : variant === "committed" ? (
                signed.url ? (
                  <img
                    src={signed.url}
                    alt={previewAlt}
                    className="max-h-full w-auto max-w-full object-contain"
                  />
                ) : (
                  <span
                    role="status"
                    aria-label={t("imageLoading")}
                    className="flex items-center justify-center"
                  >
                    <span
                      aria-hidden="true"
                      className="size-5 animate-spin rounded-full border-2 border-primary border-t-transparent"
                    />
                  </span>
                )
              ) : null}
              <span
                aria-hidden="true"
                className={`pointer-events-none absolute inset-0 items-center justify-center bg-black/50 font-heading text-xs font-bold text-white ${
                  dragOver
                    ? "flex"
                    : "hidden group-hover/preview:flex group-focus-visible/preview:flex"
                }`}
              >
                {t("dropPrompt")}
              </span>
            </button>

            {/* Remove is a literal bare X (no button chrome) — the dark drop
                shadow halo carries legibility on ANY image, touch has no
                hover, and it sits above the preview's own click target. */}
            {isBusy ? (
              <span
                role="status"
                aria-label={t("imageUploading")}
                className="absolute right-2 top-2 flex items-center rounded-xl border-[3px] border-border bg-card/95 px-2 py-1.5 shadow-[var(--shadow-clay-sm)]"
              >
                <span
                  aria-hidden="true"
                  className="size-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent"
                />
              </span>
            ) : (
              <button
                type="button"
                disabled={disabled}
                onClick={handleRemove}
                aria-label={t("removeAria")}
                className="absolute right-2 top-2 cursor-pointer rounded-full p-1 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.9),0_0_5px_rgba(0,0,0,0.45)] transition-transform duration-150 outline-none hover:scale-110 focus-visible:ring-4 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50"
              >
                <X className="size-5" aria-hidden />
              </button>
            )}
          </div>
          {variant === "staged" && file && (
            <p className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground">
              <ImageIcon className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate" title={file.name}>
                {file.name}
              </span>
              <span className="shrink-0">• {formatBytes(file.size)}</span>
            </p>
          )}
          </div>
        </>
      ) : (
        <button
          ref={zoneRef}
          type="button"
          className={dropzoneClasses}
          disabled={isBusy || disabled}
          aria-label={t("fieldHeading")}
          onClick={() => inputRef.current?.click()}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <span className="pointer-events-none flex flex-col items-center justify-center gap-1">
            <span className="mb-0.5 rounded-xl bg-primary/10 p-2 text-primary">
              <UploadCloud className="size-5" aria-hidden />
            </span>
            <span className="font-heading text-sm font-bold text-foreground">
              {t("dropPrompt")}
            </span>
            <span className="text-xs font-semibold text-muted-foreground">
              {t("dropHint", { size: formatBytes(MAX_QUESTION_IMAGE_BYTES) })}
            </span>
          </span>
        </button>
      )}

      {shownError && (
        <p role="alert" className="text-xs font-bold text-destructive">
          {shownError}
        </p>
      )}
    </div>
  );
}
