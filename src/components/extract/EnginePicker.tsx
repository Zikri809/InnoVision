"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Info, Zap } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { glmAvailable } from "@/lib/extract/glm-ocr";
import type { ExtractEngine, OcrConfig } from "@/lib/extract/types";
import type { UploadedFileItem } from "./UploadDropzone";

const STORAGE_KEY = "innovision.ocrEngine";

export function EnginePicker({
  config,
  value,
  onChange,
  files = [],
  disabled = false,
}: {
  config: OcrConfig;
  value: ExtractEngine;
  onChange: (engine: ExtractEngine) => void;
  files?: UploadedFileItem[];
  disabled?: boolean;
}) {
  const [glmAvailableFlag, setGlmAvailableFlag] = useState(false);
  const t = useTranslations("extract");

  const hasFiles = files.length > 0;
  const allOfficeFiles = hasFiles && files.every((f) => /\.(pptx|docx|txt|md)$/i.test(f.file.name));
  const hasMixedFiles = hasFiles && !allOfficeFiles && files.some((f) => /\.(pptx|docx|txt|md)$/i.test(f.file.name));

  const isPickerDisabled = disabled || allOfficeFiles;

  useEffect(() => {
    let cancelled = false;
    glmAvailable({ baseUrl: config.glmBaseUrl, model: config.glmModel }).then((ok) => {
      if (!cancelled) setGlmAvailableFlag(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [config.glmBaseUrl, config.glmModel]);

  // Persist the selection (so a reload restores it — read below on init).
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      /* ignore storage errors */
    }
  }, [value]);

  return (
    <div className="space-y-2 rounded-2xl border-[3px] border-border bg-card p-4 shadow-[var(--shadow-clay-sm)]">
      <div className="flex items-center justify-between">
        <Label htmlFor="ocr-engine" className="text-xs font-extrabold text-foreground font-heading">
          {t("engineLabel")}
        </Label>
        {allOfficeFiles && (
          <span className="flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-extrabold text-emerald-800 dark:text-emerald-300">
            <Zap className="size-3" />
            {t("badgeNative")}
          </span>
        )}
      </div>

      <Select
        value={value}
        onValueChange={(v) => onChange(v as ExtractEngine)}
        disabled={isPickerDisabled}
      >
        <SelectTrigger id="ocr-engine" className={`w-full rounded-xl border-[3px] font-bold text-xs ${allOfficeFiles ? "opacity-75 bg-muted/40 cursor-not-allowed" : ""}`}>
          <SelectValue placeholder={t("engineLabel")}>
            {(v) =>
              allOfficeFiles
                ? `${t("badgeNative")} (Direct File Reader)`
                : v === "glm"
                  ? t("engineGlm")
                  : t("engineTesseract")
            }
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="tesseract">{t("engineTesseract")}</SelectItem>
          {glmAvailableFlag && (
            <SelectItem value="glm">{t("engineGlm")}</SelectItem>
          )}
        </SelectContent>
      </Select>

      {allOfficeFiles ? (
        <div className="flex items-start gap-1.5 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-2.5 text-[11px] font-bold text-emerald-900 dark:text-emerald-200">
          <Zap className="size-3.5 shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400" />
          <span>{t("engineOfficeOnlyHint")}</span>
        </div>
      ) : hasMixedFiles ? (
        <div className="flex items-start gap-1.5 rounded-xl border border-primary/20 bg-primary/10 p-2.5 text-[11px] font-bold text-foreground">
          <Info className="size-3.5 shrink-0 mt-0.5 text-primary" />
          <span>{t("engineMixedHint")}</span>
        </div>
      ) : null}
    </div>
  );
}
