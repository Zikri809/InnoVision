"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Cloud, Info, Zap } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { glmEngineInfo } from "@/lib/extract/glm-ocr";
import { engineAfterProbe } from "@/lib/extract/pipeline";
import type { ExtractEngine, GlmEngineInfo, OcrProvider } from "@/lib/extract/types";
import type { UploadedFileItem } from "./UploadDropzone";

const STORAGE_KEY = "innovision.ocrEngine";

export function EnginePicker({
  value,
  onChange,
  files = [],
  disabled = false,
  onEngineInfo,
}: {
  value: ExtractEngine;
  onChange: (engine: ExtractEngine) => void;
  files?: UploadedFileItem[];
  disabled?: boolean;
  /**
   * gate G6: reports the last observed provider + caps so the dialog can pass
   * them into the extraction pipeline (`provider`/`maxPages`). Fired once per
   * probe, including the fail-closed local/unavailable shape.
   */
  onEngineInfo?: (info: GlmEngineInfo) => void;
}) {
  const [engineInfo, setEngineInfo] = useState<GlmEngineInfo | null>(null);
  const t = useTranslations("extract");

  const hasFiles = files.length > 0;
  const allOfficeFiles = hasFiles && files.every((f) => /\.(pptx|docx|txt|md)$/i.test(f.file.name));
  const hasMixedFiles = hasFiles && !allOfficeFiles && files.some((f) => /\.(pptx|docx|txt|md)$/i.test(f.file.name));

  const isPickerDisabled = disabled || allOfficeFiles;
  const glmAvailableFlag = engineInfo?.available === true;
  const remoteProvider: OcrProvider | null =
    glmAvailableFlag && engineInfo?.provider === "remote" ? "remote" : null;

  useEffect(() => {
    let cancelled = false;
    glmEngineInfo().then((info) => {
      if (cancelled) return;
      setEngineInfo(info);
      onEngineInfo?.(info);
    });
    return () => {
      cancelled = true;
    };
    // `onEngineInfo` is intentionally NOT a dependency: the probe must run
    // once per mount (it is cached server-side), and a caller passing an
    // inline arrow would otherwise re-probe on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Defect #1: the dialog restores `glm` from localStorage, so a probe that
  // FAILS leaves the option SELECTED but HIDDEN — the engine stays extractable
  // and the user never sees why the scanner vanished. `engineAfterProbe` is the
  // tested decision: a `glm` selection cannot survive a verdict that says the
  // engine is unusable or unidentified. A selection the probe has not answered
  // for yet is left alone (the dialog's own gate refuses to extract on it).
  useEffect(() => {
    if (engineInfo === null) return;
    const next = engineAfterProbe(value, engineInfo);
    if (next !== value) onChange(next);
    // `onChange` is a setter from the dialog's state; re-running on its
    // identity would loop, and the transition is keyed on the verdict alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineInfo, value]);

  // Persist the selection (so a reload restores it — read below on init).
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      /* ignore storage errors */
    }
  }, [value]);

  return (
    <div className="space-y-1.5 rounded-2xl border-[2px] border-border/70 bg-card/60 p-3 shadow-[var(--shadow-clay-sm)]">
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
        <SelectTrigger id="ocr-engine" className={`w-full rounded-xl border-[2px] font-bold text-xs h-9 ${allOfficeFiles ? "opacity-75 bg-muted/40 cursor-not-allowed" : ""}`}>
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
            <SelectItem value="glm">
              {/* The accessible name must keep the "AI Vision Scanner" PREFIX —
                  e2e/e2c-glm-ocr.spec.ts selects this option by
                  `getByRole("option", { name: /AI Vision Scanner/i })`, a
                  substring match. The badge appends to the name (never
                  replaces the label), so the regex still matches. */}
              <span>{t("engineGlm")}</span>
              {remoteProvider === "remote" && (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-extrabold text-emerald-800 dark:text-emerald-300"
                  data-testid="engine-remote-badge"
                  title={t("engineGlmRemote")}
                >
                  <Cloud className="size-3" aria-hidden="true" />
                  <span>{t("engineGlmRemote")}</span>
                </span>
              )}
            </SelectItem>
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
