"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import type { FaceStatus } from "@/lib/face/types";
import type { PausedReason } from "@/components/face/use-face-pipeline";
import { FaceGate } from "@/components/face/face-gate";
import { BotAvatar } from "@/components/bot/bot-avatar";

export function FaceVerifier({
  status,
  phase,
  enrolled,
  consentGiven,
  remainingMs,
  pausedReason = "face",
  onBegin,
  onConsent,
  onRecover,
  onCheckAgain,
  children,
}: {
  status: FaceStatus;
  phase: "question" | "locked" | "feedback" | "submitting" | "submitted" | "timeUp" | "dead";
  enrolled: boolean;
  consentGiven: boolean;
  remainingMs: number | null;
  /** Why the student is paused — focus-loss gets its own overlay copy. */
  pausedReason?: PausedReason;
  onBegin: () => void;
  onConsent: () => void;
  onRecover: () => void;
  onCheckAgain: () => void;
  children: ReactNode;
}) {
  const t = useTranslations("face");
  const terminal = phase === "submitted" || phase === "dead";

  const livenessState: "idle" | "waiting" | "passed" | "failed" =
    status === "recovering" ? "waiting" : status === "paused" ? "failed" : "idle";

  if (terminal) {
    return <>{children}</>;
  }

  if (status === "off") {
    return <>{children}</>;
  }

  if (status === "unavailable") {
    return (
      <div className="relative">
        <div className="mb-2 flex justify-center">
          <span className="rounded-full border-[3px] border-border bg-muted px-3.5 py-1 text-xs font-extrabold text-muted-foreground" role="status">
            {t("offlineChip")}
          </span>
        </div>
        {children}
      </div>
    );
  }

  if (status === "gate") {
    return (
      <FaceGate
        consentGiven={consentGiven}
        enrolled={enrolled}
        remainingMs={remainingMs}
        livenessState={livenessState}
        status={status}
        onBegin={onBegin}
        onConsent={onConsent}
      />
    );
  }

  return (
    <div className="relative">
      {children}

      {(status === "paused" || status === "recovering") && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm" role="alert">
          <div className="rounded-[28px] border-[3px] border-border bg-card p-8 text-center shadow-[var(--shadow-clay)]">
            <div className="mb-4 grid place-items-center">
              <BotAvatar state="paused" size={112} />
            </div>
            <p className="font-heading text-xl font-semibold">
              {status === "recovering"
                ? t("recoveringTitle")
                : pausedReason === "focus_lost"
                  ? t("focusLostTitle")
                  : t("pausedTitle")}
            </p>
            <p className="mx-auto mt-2 max-w-xs text-sm font-semibold text-muted-foreground">
              {status === "recovering"
                ? t("recoveringBody")
                : pausedReason === "focus_lost"
                  ? t("focusLostBody")
                  : t("pausedBody")}
            </p>
            {status === "paused" && (
              <Button size="lg" className="mt-6" onClick={onRecover}>
                {pausedReason === "focus_lost" ? t("focusLostBtn") : t("recoverBtn")}
              </Button>
            )}
          </div>
        </div>
      )}

      {status === "flagged" && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm" role="alert">
          <div className="rounded-[28px] border-[3px] border-destructive/40 bg-card p-8 text-center shadow-[var(--shadow-clay)]">
            <div className="mb-4 grid place-items-center">
              <BotAvatar state="warn" size={112} bodyClassName="fill-destructive" />
            </div>
            <p className="font-heading text-xl font-semibold text-destructive">{t("flaggedTitle")}</p>
            <p className="mx-auto mt-2 max-w-sm text-sm font-semibold text-muted-foreground">
              {t("flaggedBody")}
            </p>
            <div className="mt-6 flex justify-center gap-3">
              <Button size="lg" variant="outline" onClick={onCheckAgain}>
                {t("checkAgainBtn")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
