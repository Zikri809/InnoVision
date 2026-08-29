"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useOverlayFocusTrap } from "@/lib/a11y/focus-trap";
import type { FaceStatus } from "@/lib/face/types";
import type { PausedReason } from "@/components/face/use-face-pipeline";
import { FaceGate } from "@/components/face/face-gate";
import { BotAvatar } from "@/components/bot/bot-avatar";

/**
 * Full-screen proctoring block. Deliberately NOT a Dialog (no Esc-dismiss;
 * sits above the live camera feed), but it must still capture focus — without
 * the trap a keyboard user could keep operating the quiz behind the backdrop.
 */
function BlockingOverlay({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useOverlayFocusTrap(ref, true);
  return (
    <div
      ref={ref}
      role="alertdialog"
      aria-modal="true"
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80 p-4 outline-none backdrop-blur-sm"
    >
      {children}
    </div>
  );
}

/**
 * IO-1 wait-time affordance: elapsed-since-flagged minute ticker for the
 * flagged overlay. Purely visual (aria-live OFF — a per-minute live update
 * would spam SR users who already heard the alertdialog); the alertdialog
 * itself is the announcement. Transition-detected: the clock starts only when
 * status ENTERS flagged from another state, so a remount-by-rerender never
 * restarts it, and leaving flagged resets it.
 */
function FlaggedWaitTicker({ active }: { active: boolean }) {
  const t = useTranslations("face");
  const enteredAtRef = useRef<number | null>(null);
  const [minutes, setMinutes] = useState(0);

  useEffect(() => {
    if (active) {
      enteredAtRef.current ??= Date.now();
      const update = () => {
        const started = enteredAtRef.current ?? Date.now();
        setMinutes(Math.floor((Date.now() - started) / 60_000));
      };
      // Microtask-deferred first tick (cascading-render rule; the interval
      // owns all subsequent updates anyway).
      void Promise.resolve().then(update);
      const iv = setInterval(update, 15_000);
      return () => clearInterval(iv);
    }
    // Left flagged: reset so a NEW flag event starts a fresh clock. The
    // setState here runs only on the flagged → other transition, not on
    // every mount/effect pass.
    enteredAtRef.current = null;
    void Promise.resolve().then(() => setMinutes(0));
  }, [active]);

  if (!active) return null;
  return (
    <p
      aria-live="off"
      className="mt-4 text-sm font-bold text-muted-foreground"
      data-testid="flagged-wait-ticker"
    >
      {t("flaggedWaitMinutes", { count: minutes })}
    </p>
  );
}

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
        {/* SQ-5 degraded-proctoring banner (replaces the faint chip): the
            student must KNOW face checks are failing — what it means for
            them (click-first continues to work), what to do (raise hand to
            tell the invigilator; try again later), and that answers still
            count. role=status, non-blocking; the failure cause is NOT shown
            here because mid-assessment boot failures are typically
            models/network, not a permission the student can fix in-place. */}
        <div className="mb-3 rounded-2xl border-[3px] border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/40 dark:bg-amber-500/10" role="status" data-testid="face-degraded-banner">
          <p className="text-sm font-extrabold text-amber-900 dark:text-amber-300">
            {t("degradedTitle")}
          </p>
          <p className="mt-1 text-xs font-semibold text-amber-800 dark:text-amber-200/80">
            {t("degradedBody")}
          </p>
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
        <BlockingOverlay>
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
        </BlockingOverlay>
      )}

      {status === "flagged" && (
        <BlockingOverlay>
          <div className="rounded-[28px] border-[3px] border-destructive/40 bg-card p-8 text-center shadow-[var(--shadow-clay)]">
            <div className="mb-4 grid place-items-center">
              <BotAvatar state="warn" size={112} bodyClassName="fill-destructive" />
            </div>
            <p className="font-heading text-xl font-semibold text-destructive">{t("flaggedTitle")}</p>
            <p className="mx-auto mt-2 max-w-sm text-sm font-semibold text-muted-foreground">
              {t("flaggedBody")}
            </p>
            <FlaggedWaitTicker active={status === "flagged"} />
            <div className="mt-6 flex justify-center gap-3">
              <Button size="lg" variant="outline" onClick={onCheckAgain}>
                {t("checkAgainBtn")}
              </Button>
            </div>
          </div>
        </BlockingOverlay>
      )}
    </div>
  );
}
