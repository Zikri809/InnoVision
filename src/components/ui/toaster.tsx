"use client";

import { Toaster as SonnerToaster } from "sonner";
import { useMediaQuery } from "@/hooks/use-media-query";

/**
 * Clay-styled sonner toaster for transient action confirmations ("Saved",
 * "Copied", …). Mounted once in the root layout; fire with `toast.*()` from
 * anywhere client-side. Deliberate policy: form-validation errors and
 * exam-critical states stay INLINE (persistent) — never route those here.
 *
 * Position (mobile redesign R2/R3 finding): bottom-right toasts land exactly
 * on the floating clay dock on phones — and sonner pauses auto-dismiss while
 * the pointer is over a toast, so a hover-retry deadlocks the UI. On small
 * screens toasts render top-center, clear of the dock.
 */
export function Toaster() {
  const isMobile = useMediaQuery("(max-width: 767px)");

  return (
    <SonnerToaster
      position={isMobile ? "top-center" : "bottom-right"}
      theme="system"
      toastOptions={{
        classNames: {
          toast:
            "!rounded-2xl !border-[3px] !border-border !bg-card !text-foreground !font-sans !shadow-[0_4px_0_var(--border)]",
          description: "!text-muted-foreground",
        },
      }}
    />
  );
}
