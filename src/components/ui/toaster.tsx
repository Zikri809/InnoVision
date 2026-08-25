"use client";

import { Toaster as SonnerToaster } from "sonner";

/**
 * Clay-styled sonner toaster for transient action confirmations ("Saved",
 * "Copied", …). Mounted once in the root layout; fire with `toast.*()` from
 * anywhere client-side. Deliberate policy: form-validation errors and
 * exam-critical states stay INLINE (persistent) — never route those here.
 */
export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
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
