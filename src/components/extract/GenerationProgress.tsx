"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslations } from "next-intl";
import {
  AlertCircle,
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  Loader2,
  Sparkles,
} from "lucide-react";
import { BotAvatar } from "@/components/bot/bot-avatar";
import { Button } from "@/components/ui/button";
import {
  useGenerationStream,
  type StageRun,
} from "@/lib/ai/use-generation-stream";
import type { GenerationStage } from "@/lib/ai/events";

/**
 * The in-dialog generating view (docs/plans/agentic-generation.md Phase 3
 * pattern, adopted for the lecturer surface): a flat STATUS STRIP that pulses
 * on every state change and MORPHS INTO the outcome card at terminal states
 * (done → payoff + Review; error → reason + Try again; cancelled →
 * nothing-saved note) — one element tells the whole ending, no duplicate
 * banner — above a collapsed "Thinking" accordion whose header churns with
 * the live trace (coding-agent pattern).
 *
 * Raw model text is INERT aria-hidden plain text (S7 posture — never
 * markdown/HTML); the only live region is the throttled polite summary
 * (≤1 update/5s; terminal announcements bypass the throttle).
 *
 * The generation runs on mount — the call site keys this component by
 * `runId` so "Try again" is a clean remount with the same body.
 */

const DOT_TONE: Record<StageRun, string> = {
  done: "text-emerald-600 dark:text-emerald-400",
  active: "text-primary",
  failed: "text-destructive",
  skip: "text-muted-foreground/50",
  pending: "text-muted-foreground/50",
};

/** Flat tone per phase — borders carry the hue, no offset shadow (a hard
 * shadow under a wide strip reads as a giant button and fights the tints). */
const STRIP_TONE: Record<string, string> = {
  running: "border-primary/40 bg-primary/5 text-foreground",
  done: "border-emerald-500/40 bg-emerald-500/10 text-emerald-950 dark:text-emerald-200",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
  "saved-refresh-failed":
    "border-amber-500/40 bg-amber-500/10 text-amber-950 dark:text-amber-200",
  cancelled: "border-border bg-muted/40 text-muted-foreground",
};

const PULSE_TONE: Record<string, string> = {
  running: "border-primary/70 bg-primary/10",
  done: "border-emerald-500/70 bg-emerald-500/20",
  error: "border-destructive/70 bg-destructive/20",
  "saved-refresh-failed": "border-amber-500/70 bg-amber-500/20",
  cancelled: "border-border bg-muted/70",
};

const STAGE_LABEL_KEY: Record<GenerationStage, string> = {
  parse: "stageParseLabel",
  draft: "stageDraftLabel",
  refine: "stageRefineLabel",
  save: "stageSaveLabel",
};

const STAGE_ACTIVE_KEY: Record<GenerationStage, string> = {
  parse: "stageParseActive",
  draft: "stageDraftActive",
  refine: "stageRefineActive",
  save: "stageSaveActive",
};

const SUMMARY_THROTTLE_MS = 5_000;

/**
 * Throttle state for the SR summary, kept OUTSIDE React (module-level
 * WeakMap keyed by the live-region ref) — `Date.now()` is impure and the
 * react-hooks/purity rule forbids it in component-body functions. The
 * callbacks below are only ever invoked from event/stream callbacks, but
 * the linter can't prove that, so the clock lives here.
 */
const summaryClocks = new WeakMap<object, number>();

function announceThrottledInto(
  setLive: (line: string) => void,
  keyRef: RefObject<object | null>,
  line: string,
) {
  const now = Date.now();
  const last = keyRef.current ? (summaryClocks.get(keyRef.current) ?? 0) : 0;
  if (now - last < SUMMARY_THROTTLE_MS) return;
  if (keyRef.current) summaryClocks.set(keyRef.current, now);
  setLive(line);
}

function announceNowInto(
  setLive: (line: string) => void,
  keyRef: RefObject<object | null>,
  line: string,
) {
  if (keyRef.current) summaryClocks.set(keyRef.current, Date.now());
  setLive(line);
}

export function GenerationProgress({
  endpoint,
  body,
  onOutcome,
  onRetry,
  onReview,
}: {
  endpoint: string;
  body: Record<string, unknown>;
  /** Terminal report at EVENT time (done/saved_refresh_failed: the save is
   * committed the moment this fires — the call site refreshes here, NOT at
   * CTA click; error/cancelled keep the dialog open with a retry). */
  onOutcome: (kind: "done" | "saved_refresh_failed" | "error" | "cancelled", errorCode: string | null) => void;
  /** "Try again" — remount the engine with the same body (new key). */
  onRetry: () => void;
  /** Done CTA — purely navigational at the call site (save already handled). */
  onReview: () => void;
}) {
  const t = useTranslations("extract");
  const [pulsing, setPulsing] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [liveLine, setLiveLine] = useState("");
  // Identity key for the module-level throttle clock (WeakMap entry).
  const liveKeyRef = useRef({});
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const foldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const reducedRef = useRef(false);
  // Whether the user has manually toggled the accordion — the post-done
  // auto-fold must never close a deliberate open.
  const userToggledRef = useRef(false);

  type TerminalKind = Parameters<
    NonNullable<Parameters<typeof useGenerationStream>[0]["announceTerminal"]>
  >[0];

  /** Localized word for a dot-trail status (never the raw English enum). */
  function stageStatusWord(status: StageRun): string {
    switch (status) {
      case "done":
        return t("stageDoneWord");
      case "skip":
        return t("stageSkipped");
      case "active":
        return t("stageActiveWord");
      case "failed":
        return t("stageFailedWord");
      default:
        return t("stagePendingWord");
    }
  }

  /** Localized trace line for a stage transition (server chrome, not raw
   * model text — the plan's all-copy-localized rule applies to it). */
  function formatStageLine(stage: GenerationStage, status: string): string {
    const label = t(STAGE_LABEL_KEY[stage]);
    if (status === "active") return `${label} — ${t(STAGE_ACTIVE_KEY[stage])}`;
    if (status === "done") return `${label} — ${t("stageDoneWord")}`;
    return `${label} — ${t("stageSkipped")}`;
  }

  const stream = useGenerationStream({
    endpoint,
    body,
    formatStageLine,
    announceStage: (stage) =>
      announceThrottledInto(setLiveLine, liveKeyRef, t(STAGE_ACTIVE_KEY[stage])),
    announceTerminal: (kind, doneCount) =>
      announceNowInto(setLiveLine, liveKeyRef, terminalLine(kind, doneCount)),
    onError: (code) => onOutcome("error", code),
    onCancelled: () => onOutcome("cancelled", null),
    onDone: () => onOutcome("done", null),
    onSavedRefreshFailed: () => onOutcome("saved_refresh_failed", null),
  });

  /** Localized terminal summary for the aria-live region. `doneCount` comes
   * through the callback — component state hasn't committed yet when the
   * hook fires this synchronously inside the stream event handler. */
  function terminalLine(kind: TerminalKind, doneCount?: number): string {
    switch (kind) {
      case "done":
        return t("doneSummary", { count: doneCount ?? stream.doneCount ?? 0 });
      case "already_running":
        return t("alreadyRunningSummary");
      case "cancelled":
        return t("cancelledSummary");
      case "saved_refresh_failed":
        return t("savedRefreshFailedSummary");
      default:
        return t("errorSummary");
    }
  }

  const { phase, trail, trace } = stream;

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedRef.current = mq.matches;
    const onChange = () => {
      reducedRef.current = mq.matches;
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    return () => {
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
      if (foldTimer.current) clearTimeout(foldTimer.current);
    };
  }, []);

  // Pin the trace to the newest line while open (skipped for reduced motion).
  useEffect(() => {
    if (reducedRef.current) return;
    const el = scrollRef.current;
    if (el && thinkingOpen) el.scrollTop = el.scrollHeight;
  }, [trace, thinkingOpen]);

  // Pulse the strip while a stream is live; auto-fold the accordion shortly
  // after a committed save — but never close a DELIBERATE user open. All
  // state flips happen inside timer callbacks (external systems).
  const streamLive = phase === "running";
  useEffect(() => {
    if (streamLive) {
      pulseTimer.current = setTimeout(() => setPulsing(true), 0);
    } else {
      pulseTimer.current = setTimeout(() => setPulsing(false), 0);
    }
    if ((phase === "done" || phase === "saved-refresh-failed") && !userToggledRef.current) {
      foldTimer.current = setTimeout(() => setThinkingOpen(false), 1_500);
    }
  }, [phase, streamLive]);

  const activeStage = (Object.keys(trail) as GenerationStage[]).find(
    (k) => trail[k] === "active",
  );

  const runningCopy = activeStage
    ? t(STAGE_ACTIVE_KEY[activeStage])
    : t("consoleWaiting");

  return (
    <div className="space-y-3.5" data-testid="generation-progress">
      {/* The ONLY live region (throttled; terminals bypass). */}
      <p aria-live="polite" className="sr-only">
        {liveLine}
      </p>

      {/* Status strip — morphs into the outcome card at terminal states. */}
      <div
        data-testid="generation-status-strip"
        className={`flex items-center gap-3 rounded-2xl border-[3px] px-3.5 py-2.5 transition-colors duration-500 ${
          pulsing ? PULSE_TONE[phase] : STRIP_TONE[phase]
        }`}
      >
        {phase === "running" ? (
          <BotAvatar state="thinking" size={28} className="shrink-0" />
        ) : phase === "done" ? (
          <Sparkles
            className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400"
            aria-hidden="true"
          />
        ) : phase === "error" ? (
          <AlertCircle className="size-5 shrink-0" aria-hidden="true" />
        ) : (
          <BotAvatar state="idle" size={28} className="shrink-0" />
        )}

        {phase === "error" ? (
          <div className="min-w-0 flex-1">
            {/* No role="alert": the terminal announce in the polite live
                region already announces the failure — assertive+polite
                doubles the SR announcement. */}
            <p className="text-sm font-extrabold">
              {stream.errorCode === "already_running"
                ? t("alreadyRunningTitle")
                : t("generationFailedTitle")}
            </p>
            {stream.errorMessage && (
              <p className="mt-0.5 text-2xs font-semibold text-destructive/90">
                {stream.errorMessage}
              </p>
            )}
          </div>
        ) : phase === "cancelled" ? (
          <div className="min-w-0 flex-1">
            <p className="text-sm font-extrabold">{t("cancelledTitle")}</p>
            <p className="mt-0.5 text-2xs font-semibold text-muted-foreground">
              {t("cancelledDesc")}
            </p>
          </div>
        ) : phase === "saved-refresh-failed" ? (
          <div className="min-w-0 flex-1">
            <p className="text-sm font-extrabold">{t("savedRefreshFailedTitle")}</p>
            <p className="mt-0.5 text-2xs font-semibold text-amber-900/90 dark:text-amber-300/90">
              {t("savedRefreshFailedDesc")}
            </p>
          </div>
        ) : (
          <p className="min-w-0 flex-1 truncate text-sm font-extrabold">
            {phase === "done"
              ? t("forgedStamp", {
                  count: stream.doneCount ?? 0,
                  // Parse renders skip when the text came from the client
                  // (no server detail) — fall back to the request body so
                  // the stamp never says "0 characters" on the primary flow.
                  chars: (
                    stream.chars ??
                    (typeof body.extractedText === "string" ? body.extractedText.length : 0)
                  ).toLocaleString(),
                })
              : runningCopy}
          </p>
        )}

        {phase === "done" && (
          <Button
            type="button"
            size="sm"
            data-testid="generation-review-btn"
            className="shrink-0 gap-1.5 rounded-xl text-xs font-bold"
            onClick={onReview}
          >
            {t("reviewQuestions")}
          </Button>
        )}
        {(phase === "error" || phase === "cancelled") &&
          !(phase === "error" && stream.errorCode === "already_running") && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="generation-retry-btn"
              className="shrink-0 rounded-xl text-xs font-bold"
              onClick={onRetry}
            >
              {t("tryAgain")}
            </Button>
          )}
        {phase === "saved-refresh-failed" && (
          <Button
            type="button"
            size="sm"
            data-testid="generation-review-btn"
            className="shrink-0 gap-1.5 rounded-xl text-xs font-bold"
            onClick={onReview}
          >
            {t("reviewQuestions")}
          </Button>
        )}

        {/* Dot trail — the four TRUE stages; hidden at terminal states. */}
        {phase === "running" && (
          <div
            className="flex shrink-0 items-center gap-1.5"
            aria-label={t("consoleTitle")}
          >
            {(Object.keys(trail) as GenerationStage[]).map((key) => (
              <span
                key={key}
                title={`${t(STAGE_LABEL_KEY[key])}: ${stageStatusWord(trail[key])}`}
                className={DOT_TONE[trail[key]]}
              >
                {trail[key] === "done" ? (
                  <Check className="size-3.5 stroke-[3]" aria-hidden="true" />
                ) : trail[key] === "active" ? (
                  <Loader2
                    className="size-3.5 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : trail[key] === "failed" ? (
                  <AlertCircle className="size-3.5" aria-hidden="true" />
                ) : (
                  <CircleDashed className="size-3.5" aria-hidden="true" />
                )}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Thinking accordion — collapsed by default; the header churns with
          the live trace (aria-hidden preview). Raw model text: inert plain
          text (S7) — the trace BODY is aria-hidden entirely. */}
      <div className="rounded-2xl border-[3px] border-border bg-card">
        <button
          type="button"
          onClick={() => {
            userToggledRef.current = true;
            setThinkingOpen((prev) => !prev);
          }}
          aria-expanded={thinkingOpen}
          aria-controls="generation-thinking-trace"
          data-testid="generation-thinking-toggle"
          className="flex w-full items-center gap-2 rounded-2xl px-3.5 py-2.5 text-left hover:bg-muted/50 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Brain className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="shrink-0 text-xs font-extrabold text-foreground">
            {t("thinkingLabel")}
          </span>
          <span
            aria-hidden="true"
            className={`min-w-0 flex-1 truncate font-mono text-2xs ${
              phase === "running" ? "text-muted-foreground" : "text-muted-foreground/70"
            }`}
          >
            {trace[trace.length - 1]?.text ?? ""}
          </span>
          <span className="ml-auto shrink-0 text-muted-foreground">
            {thinkingOpen ? (
              <ChevronUp className="size-4" aria-hidden="true" />
            ) : (
              <ChevronDown className="size-4" aria-hidden="true" />
            )}
          </span>
        </button>
        {thinkingOpen && (
          <div
            id="generation-thinking-trace"
            ref={scrollRef}
            aria-hidden="true"
            data-testid="generation-thinking-trace"
            className="mx-3.5 mb-3.5 max-h-44 overflow-y-auto rounded-xl border-[2px] border-border/40 bg-[#2b190b] p-3 font-mono text-2xs leading-relaxed text-amber-50/90"
          >
            {trace.length === 0 ? (
              <p className="text-amber-50/50">{t("consoleWaiting")}</p>
            ) : (
              trace.map((line, i) => (
                <p
                  key={i}
                  className={`break-words whitespace-pre-wrap ${
                    line.kind === "stage" ? "font-sans font-extrabold text-primary/90" : ""
                  }`}
                >
                  {line.text || "\u00A0"}
                </p>
              ))
            )}
          </div>
        )}
      </div>

      {/* Cancel — INSIDE the generating view (the dialog footer is hidden
          while running): aborts the stream, keeps the dialog open, marks the
          strip cancelled and retains the trace (old console contract). */}
      {phase === "running" && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="generation-cancel-btn"
          className="mx-auto flex gap-1.5 rounded-xl text-xs font-bold"
          onClick={stream.cancel}
        >
          {t("cancelGeneration")}
        </Button>
      )}
    </div>
  );
}
