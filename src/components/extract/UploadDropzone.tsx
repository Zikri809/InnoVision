"use client";

import { useRef, useState } from "react";
import { isAllowedExtension, MAX_FILE_BYTES } from "@/lib/extract/types";

/**
 * Upload dropzone for source files. Validates extension + size client-side
 * (the server re-validates at the bucket and route levels — S1/S5), then
 * uploads to `quiz-sources/{uid}/{quizId}/...` via the browser Supabase client
 * (storage RLS: foldername(name)[1] = auth.uid()).
 */
export function UploadDropzone({
  userId,
  quizId,
  onUploaded,
  onError,
}: {
  userId: string;
  quizId: string;
  onUploaded: (path: string, file: File) => void;
  onError: (message: string) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const supabaseRef = useRef<SupabaseClient | null>(null);

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
      supabaseRef.current = supabase;
      const path = `${userId}/${quizId}/${file.name}`;
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
      className={`cursor-pointer rounded-lg border-2 border-dashed p-6 text-center text-sm transition-colors ${
        dragOver ? "border-primary bg-primary/5" : "border-muted-foreground/30"
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
        <p className="text-muted-foreground">Uploading…</p>
      ) : (
        <p className="text-muted-foreground">
          Drop a chapter PDF, slides, or document here, or click to browse.
          <br />
          <span className="text-xs">PDF · DOCX · PPTX · TXT · MD · images (≤ 25 MB)</span>
        </p>
      )}
    </div>
  );
}

type SupabaseClient = {
  storage: {
    from: (bucket: string) => {
      upload: (path: string, file: File, opts?: { upsert?: boolean }) => Promise<{
        error: { message: string } | null;
      }>;
    };
  };
};
