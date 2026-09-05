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
 *
 * Mobile redesign plan W3: the scrim is OPAQUE clay (no backdrop-filter on
 * /play), safe-area padded, and the paused/recovering card carries a LIVE
 * mirrored self-view — the student is usually paused because they moved, so
 * they must be able to see themselves while repositioning. The viewfinder
 * binds to the SAME shared MediaStream via srcObject (a second <video> on the
 * shared stream — the tracker's own bound element is untouched).
 */
function BlockingOverlay({
  children,
  selfViewStream,
}: {
  children: ReactNode;
  /** Shared camera stream for the recovery self-view (paused/recovering only). */
  selfViewStream?: MediaStream | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  useOverlayFocusTrap(ref, true);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (selfViewStream) {
      if (video.srcObject !== selfViewStream) video.srcObject = selfViewStream;
      video.play().catch(() => {});
    } else {
      video.srcObject = null;
    }
  }, [selfViewStream]);

  return (
    <div
      ref={ref}
      role="alertdialog"
      aria-modal="true"
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-background p-4 pt-[calc(var(--safe-top)+1rem)] pb-[max(1rem,var(--safe-bottom))] outline-none"
    >
      {children}
    </div>
  );
}

/**
 * Mirrored camera viewfinder for the paused/recovering flow: portrait card
 * with the clay face-oval guide, so the student can reposition with real
 * feedback instead of guessing. aria-hidden — the alertdialog copy carries
 * the meaning; the video is decorative self-view.
 */
function RecoverySelfView({ stream }: { stream: MediaStream | null }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (stream) {
      if (video.srcObject !== stream) video.srcObject = stream;
      video.play().catch(() => {});
    }
    return () => {
      if (video) video.srcObject = null;
    };
  }, [stream]);

  if (!stream) return null;
  return (
    <div
      aria-hidden="true"
      className="relative mx-auto aspect-[3/4] w-60 max-w-full overflow-hidden rounded-[18px] border-[3px] border-border bg-[#1c0f08] shadow-[var(--shadow-clay)]"
    >
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full object-cover -scale-x-100"
        autoPlay
        playsInline
        muted
      />
      {/* Face-oval guide — the same affordance the enrollment flow uses. */}
      <span className="pointer-events-none absolute inset-0 m-auto h-[72%] w-[54%] rounded-[50%] border-[3px] border-dashed border-primary/60" />
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
  stream = null,
  quizTitle,
  resume,
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
  /** Shared camera stream (FaceTracker.stream) — powers the recovery self-view. */
  stream?: MediaStream | null;
  /** Quiz title (mobile plan W3): shown once, in the gate — never on the question flow. */
  quizTitle?: string;
  /** Resume re-orientation (plan W7): "N of M answered" when resuming a seeded session. */
  resume?: { answered: number; total: number } | null;
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
        quizTitle={quizTitle}
        resume={resume}
        onBegin={onBegin}
        onConsent={onConsent}
      />
    );
  }

  return (
    <div className="relative">
      {children}

      {(status === "paused" || status === "recovering") && (
        <BlockingOverlay selfViewStream={stream}>
          <div className="w-full max-w-sm rounded-[28px] border-[3px] border-border bg-card p-5 text-center shadow-[var(--shadow-clay)] sm:p-8">
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
            {/* Live self-view (plan W3): reposition with real feedback. The
                stream comes from the SAME shared MediaStream as the tracker. */}
            <div className="mt-4">
              <RecoverySelfView stream={stream} />
            </div>
            {status === "paused" && (
              <Button size="lg" className="mt-6 w-full sm:w-auto" onClick={onRecover}>
                {pausedReason === "focus_lost" ? t("focusLostBtn") : t("recoverBtn")}
              </Button>
            )}
          </div>
        </BlockingOverlay>
      )}

      {/* Flagged stays blind (plan W3): a waiting state with no action that
          needs the camera — no self-view. */}
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
