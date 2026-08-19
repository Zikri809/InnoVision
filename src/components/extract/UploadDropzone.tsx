"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { isAllowedExtension, MAX_FILE_BYTES, sanitizeStorageFilename } from "@/lib/extract/types";

export function UploadDropzone({
  userId,
  quizId,
  fileName,
  onUploaded,
  onError,
}: {
  userId: string;
  quizId: string;
  /** Name of the file already selected/uploaded, to show in the dropzone. */
  fileName?: string | null;
  onUploaded: (path: string, file: File) => void;
  onError: (message: string) => void;
}) {
  const t = useTranslations("extract");
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    if (!isAllowedExtension(file.name)) {
      onError(t("unsupportedType"));
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      onError(t("fileTooLarge"));
      return;
    }
    setUploading(true);
    try {
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      const path = `${userId}/${quizId}/${sanitizeStorageFilename(file.name)}`;
      const { error } = await supabase.storage.from("quiz-sources").upload(path, file, {
        upsert: true,
      });
      if (error) {
        onError(error.message);
        return;
      }
      onUploaded(path, file);
    } catch {
      onError(t("uploadError"));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t("uploadAriaLabel")}

      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        handleFile(e.dataTransfer.files?.[0]);
      }}
      className={`cursor-pointer rounded-2xl border-[3px] border-dashed p-6 text-center text-sm transition-all duration-150 outline-none focus-visible:ring-4 focus-visible:ring-primary/20 ${
        dragOver ? "border-primary bg-primary/10 scale-[1.01]" : "border-border bg-card/60 hover:bg-card shadow-[var(--shadow-clay-sm)]"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx,.pptx,.txt,.md,.png,.jpg,.jpeg,.webp"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
      {uploading ? (
        <div className="pointer-events-none flex items-center justify-center gap-2 font-bold text-muted-foreground">
          <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span>{t("dropzoneUploading")}</span>
        </div>
      ) : fileName ? (
        <div className="pointer-events-none">
          <p className="break-all font-heading font-bold text-foreground">{fileName}</p>
          <p className="mt-1 text-xs font-semibold text-muted-foreground">
            {t("dropzoneReady")}
          </p>
        </div>
      ) : (
        <div className="pointer-events-none">
          <p className="font-semibold text-foreground">
            {t("dropzonePrompt")}
          </p>
          <p className="mt-1 text-xs font-medium text-muted-foreground">
            {t("dropzoneTypes")}
          </p>
        </div>
      )}
    </div>
  );
}
