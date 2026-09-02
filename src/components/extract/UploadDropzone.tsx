"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { FileText, Image as ImageIcon, Trash2, UploadCloud, Zap } from "lucide-react";
import {
  isAllowedExtension,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TOTAL_UPLOAD_BYTES,
  sanitizeStorageFilename,
} from "@/lib/extract/types";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";

export type UploadedFileItem = {
  id: string;
  file: File;
  path: string;
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function generateUniqueId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    buf[6] = (buf[6] & 0x0f) | 0x40;
    buf[8] = (buf[8] & 0x3f) | 0x80;
    return [...buf]
      .map((b, i) => ([4, 6, 8, 10].includes(i) ? `-${b.toString(16).padStart(2, "0")}` : b.toString(16).padStart(2, "0")))
      .join("");
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function UploadDropzone({
  userId,
  quizId,
  files = [],
  onFilesChanged,
  onError,
  disabled = false,
}: {
  userId: string;
  quizId: string;
  files?: UploadedFileItem[];
  onFilesChanged: (files: UploadedFileItem[]) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("extract");
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const totalBytes = files.reduce((acc, f) => acc + f.file.size, 0);

  async function handleFiles(incomingFiles: FileList | File[] | undefined | null) {
    if (!incomingFiles || incomingFiles.length === 0 || disabled || uploading) return;

    const list = Array.from(incomingFiles);

    if (files.length + list.length > MAX_FILES) {
      onError(t("maxFilesError", { max: MAX_FILES }));
      return;
    }

    for (const f of list) {
      if (!isAllowedExtension(f.name)) {
        onError(t("unsupportedType"));
        return;
      }
      if (f.size > MAX_FILE_BYTES) {
        onError(t("fileTooLarge"));
        return;
      }
    }

    const newTotalBytes = totalBytes + list.reduce((acc, f) => acc + f.size, 0);
    if (newTotalBytes > MAX_TOTAL_UPLOAD_BYTES) {
      onError(t("maxTotalBytesError", { max: formatBytes(MAX_TOTAL_UPLOAD_BYTES) }));
      return;
    }

    setUploading(true);
    try {
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      const newItems: UploadedFileItem[] = [];

      for (const file of list) {
        const uniqueId = generateUniqueId();
        const path = `${userId}/${quizId}/${uniqueId}-${sanitizeStorageFilename(file.name)}`;
        const { error } = await supabase.storage.from("quiz-sources").upload(path, file, {
          upsert: true,
        });

        if (error) {
          onError(error.message);
          return;
        }

        newItems.push({
          id: uniqueId,
          file,
          path,
        });
      }

      onFilesChanged([...files, ...newItems]);
    } catch {
      onError(t("uploadError"));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function handleRemoveFile(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    onFilesChanged(files.filter((f) => f.id !== id));
  }

  return (
    <div className="space-y-3">
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={t("uploadAriaLabel")}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (!disabled && (e.key === "Enter" || e.key === " ")) {
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          if (disabled) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          if (disabled) return;
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={`cursor-pointer rounded-2xl border-[3px] border-dashed p-6 text-center text-sm transition-all duration-150 outline-none focus-visible:ring-4 focus-visible:ring-primary/20 ${
          disabled
            ? "opacity-60 cursor-not-allowed border-border bg-muted/30"
            : dragOver
              ? "border-primary bg-primary/10 scale-[1.01]"
              : "border-border bg-card/60 hover:bg-card shadow-[var(--shadow-clay-sm)]"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.pptx,.txt,.md,.png,.jpg,.jpeg,.webp"
          className="hidden"
          disabled={disabled}
          onChange={(e) => handleFiles(e.target.files)}
        />
        {uploading ? (
          <div className="pointer-events-none flex items-center justify-center gap-2 font-bold text-muted-foreground py-2">
            <span className="size-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span>{t("dropzoneUploading")}</span>
          </div>
        ) : (
          <div className="pointer-events-none flex flex-col items-center justify-center gap-1.5 py-1">
            <div className="rounded-xl bg-primary/10 p-2 text-primary mb-1">
              <UploadCloud className="size-6" />
            </div>
            <p className="font-heading font-bold text-foreground text-sm">
              {t("dropzonePrompt")}
            </p>
            <p className="text-xs font-semibold text-muted-foreground">
              {t("dropzoneTypes")} • {t("dropzoneLimits", { max: MAX_FILES, size: formatBytes(MAX_TOTAL_UPLOAD_BYTES) })}
            </p>
          </div>
        )}
      </div>

      {files.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs font-bold text-muted-foreground px-1">
            <span>{t("uploadedFilesTitle", { count: files.length, max: MAX_FILES })}</span>
            <span>{formatBytes(totalBytes)} / {formatBytes(MAX_TOTAL_UPLOAD_BYTES)}</span>
          </div>
          <div className="flex max-h-72 flex-wrap items-stretch gap-2 overflow-y-auto p-1 sm:p-2">
            {files.map((item) => {
              const isImage = item.file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(item.file.name);
              const isOffice = /\.(pptx|docx|txt|md)$/i.test(item.file.name);
              return (
                <Attachment key={item.id} className="min-w-[14rem] flex-1 basis-[calc(50%-0.5rem)] lg:basis-[calc(33.333%-0.667rem)]">
                  <AttachmentMedia variant="icon">
                    {isImage ? <ImageIcon className="size-4" /> : <FileText className="size-4" />}
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle title={item.file.name}>
                      {item.file.name}
                    </AttachmentTitle>
                    <AttachmentDescription>
                      {formatBytes(item.file.size)} •{" "}
                      <span className={`inline-flex items-center gap-1 text-[10px] font-extrabold uppercase leading-none ${
                        isOffice
                          ? "text-emerald-700 dark:text-emerald-300"
                          : "text-primary"
                      }`}>
                        {isOffice ? (
                          <Zap className="size-2.5 shrink-0" />
                        ) : isImage ? (
                          <ImageIcon className="size-2.5 shrink-0" />
                        ) : (
                          <FileText className="size-2.5 shrink-0" />
                        )}
                        <span>{isOffice ? t("badgeNative") : isImage ? t("badgeOcr") : t("badgePdf")}</span>
                      </span>
                    </AttachmentDescription>
                  </AttachmentContent>
                  <AttachmentActions>
                    <AttachmentAction
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t("removeFile", { filename: item.file.name })}
                      onClick={(e) => handleRemoveFile(item.id, e)}
                      disabled={disabled || uploading}
                      className="text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                    >
                      <Trash2 className="size-4" />
                    </AttachmentAction>
                  </AttachmentActions>
                </Attachment>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
