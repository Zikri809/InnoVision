"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
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

const STORAGE_KEY = "innovision.ocrEngine";

export function EnginePicker({
  config,
  value,
  onChange,
}: {
  config: OcrConfig;
  value: ExtractEngine;
  onChange: (engine: ExtractEngine) => void;
}) {
  const [glmAvailableFlag, setGlmAvailableFlag] = useState(false);
  const t = useTranslations("extract");

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
    <div className="space-y-1.5">
      <Label htmlFor="ocr-engine" className="font-extrabold">{t("engineLabel")}</Label>
      <Select
        value={value}
        onValueChange={(v) => onChange(v as ExtractEngine)}
      >
        <SelectTrigger id="ocr-engine" className="w-full">
          <SelectValue placeholder={t("engineLabel")}>
            {(v) =>
              v === "glm"
                ? t("engineGlm")
                : v === "vision"
                  ? t("engineVision")
                  : t("engineTesseract")
            }
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="tesseract">{t("engineTesseract")}</SelectItem>
          {glmAvailableFlag && (
            <SelectItem value="glm">{t("engineGlm")}</SelectItem>
          )}
          <SelectItem value="vision">{t("engineVision")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
