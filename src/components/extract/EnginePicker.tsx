"use client";

import { useEffect, useState } from "react";
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

/**
 * OCR engine picker. Tesseract is always the default; GLM only appears when
 * the local GLM-OCR (Docker/vLLM) availability probe succeeds (U-E4); vision
 * is always an opt-in. The choice is persisted to localStorage (PLAN §3.3).
 */
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

  // Re-hide GLM if the stored engine is tesseract/vision (the parent's `value`
  // already controls selection; this only affects the probe visibility).
  // (No additional state needed — `glmAvailableFlag` already drives visibility.)

  return (
    <div className="space-y-1.5">
      <Label htmlFor="ocr-engine" className="font-extrabold">OCR Engine</Label>
      <Select
        value={value}
        onValueChange={(v) => onChange(v as ExtractEngine)}
      >
        <SelectTrigger id="ocr-engine" className="w-full">
          <SelectValue placeholder="Select OCR engine">
            {(v) =>
              v === "glm"
                ? "GLM-OCR (local, high accuracy)"
                : v === "vision"
                  ? "Cloud Vision (costs tokens)"
                  : "Tesseract (built-in, $0)"
            }
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="tesseract">Tesseract (built-in, $0)</SelectItem>
          {glmAvailableFlag && (
            <SelectItem value="glm">GLM-OCR (local, high accuracy)</SelectItem>
          )}
          <SelectItem value="vision">Cloud Vision (costs tokens)</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-xs font-semibold text-muted-foreground">
        Used only when the file is scanned or has no text layer.
        {glmAvailableFlag
          ? " GLM-OCR detected on this machine."
          : " GLM-OCR (local Docker) not detected."}
      </p>
    </div>
  );
}
