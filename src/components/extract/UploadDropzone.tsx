"use client";

import { useRef, useState } from "react";
import { isAllowedExtension, MAX_FILE_BYTES, sanitizeStorageFilename } from "@/lib/extract/types";

/**
 * Upload dropzone for source files. Validates extension + size client-side
 * (the server re-validates at the bucket and route levels — S1/S5), then
 * uploads to `quiz-sources/{uid}/{quizId}/...` via the browser Supabase client
 * (storage RLS: foldername(name)[1] = auth.uid()).
 */
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
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    if (!isAllowedExtension(file.name)) {
      onError("Unsupported file type. Use PDF, DOCX, PPTX, TXT, MD, PNG, JPG, or WEBP.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      onError("File is larger than 25 MB.");
      return;
    }
    setUploading(true);
    try {
      // Lazy-load the browser client (keeps SSR clean).
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      // Sanitize the browser-supplied name so it can't escape the user's
      // storage folder (path-traversal defense; see sanitizeStorageFilename).
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
      onError("Could not upload the file. Check your connection and try again.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Upload source file"
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
          <span>Uploading file…</span>
        </div>
      ) : fileName ? (
        <div className="pointer-events-none">
          <p className="break-all font-heading font-bold text-foreground">{fileName}</p>
          <p className="mt-1 text-xs font-semibold text-muted-foreground">
            File ready. Click to choose a different one, or drop a new file to replace it.
          </p>
        </div>
      ) : (
        <div className="pointer-events-none">
          <p className="font-semibold text-foreground">
            Drop a chapter PDF, slides, or document here, or click to browse.
          </p>
          <p className="mt-1 text-xs font-medium text-muted-foreground">
            PDF · DOCX · PPTX · TXT · MD · images (≤ 25 MB)
          </p>
        </div>
      )}
    </div>
  );
}
