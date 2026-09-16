"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslations } from "next-intl";
import { GenerationSphere } from "@/components/bot/generation-sphere";
import { Button } from "@/components/ui/button";
import {
  useGenerationStream,
  type GenerationTraceLine,
  type StageRun,
} from "@/lib/ai/use-generation-stream";
import type { GenerationStage } from "@/lib/ai/events";
import type { BotState } from "@/lib/bot/engine";

/**
 * The in-dialog generating view — THE TAKEOVER (adopted from
 * redesign-previews/generation-progress-redesign.html concept 2, plan-
 * adherent per docs/plans/agentic-generation.md Phase 2/§C):
 *
 *  - The dialog body becomes ONE moment: the morphing bot on its clay
 *    pedestal, the stage RAIL, and a single live sentence.
 *  - The rail shows the FOUR TRUE stages (Parse → Draft → Refine → Save;
 *    the plan's truth rule: no invented stages). Search is a TOOL inside
 *    Parse — its chip appears only in web-augmented mode (the route emits
 *    the search stage only there). Skipped stages dim (plan §C); at
 *    terminal states every chip settles (the rail reads done/failed as a
 *    whole, never mid-run).
 *  - ONE live signal: the sentence speaks the active stage or the outcome.
 *    Beneath it, the model's latest trace line renders as a ONE-LINE grey
 *    token strip (aria-hidden, inert S7 text, ellipsized — never two lines).
 *    The old "Thinking" accordion is gone: the plan's console is replaced
 *    by this ambient line plus the throttled live region.
 *  - Fast completions (<8s from stream open, plan §Endings) skip the staged
 *    animation and settle straight to the payoff after a short beat.
 *  - Cancel is a quiet underlined text action.
 *
 * The only live region remains the throttled polite summary (≤1 update/5s;
 * terminal announcements bypass the throttle).
 *
 * The generation runs on mount — the call site keys this component by
 * `runId` so "Try again" is a clean remount with the same body.
 */

/** Warm chip tick per stage status. Terminal states override via `settled`. */
function chipClass(status: StageRun, settled: boolean): string {
  if (settled) {
    // Whole-rail settle: success = all green; any failure = its chip red.
    return status === "failed"
      ? "bg-destructive"
      : status === "skip"
        ? "bg-muted-foreground/30"
        : "bg-emerald-500";
  }
  switch (status) {
    case "pending":
      return "bg-primary/15";
    case "active":
      return "bg-primary scale-y-[1.6]";
    case "done":
      return "bg-emerald-500";
    case "skip":
      return "bg-muted-foreground/30";
    case "failed":
      return "bg-destructive";
  }
}

const STAGE_LABEL_KEY: Record<GenerationStage, string> = {
  parse: "stageParseLabel",
  search: "stageSearchLabel",
  draft: "stageDraftLabel",
  refine: "stageRefineLabel",
  save: "stageSaveLabel",
};

const STAGE_ACTIVE_KEY: Record<GenerationStage, string> = {
  parse: "stageParseActive",
  search: "stageSearchActive",
  draft: "stageDraftActive",
  refine: "stageRefineActive",
  save: "stageSaveActive",
};

/**
 * Known error codes → localized sentence copy. Raw English server messages
 * are never rendered for these; unknown codes fall back to the generic
 * failure title + server message. `already_running` keeps its distinct
 * no-retry state. The student-route codes sit beside the search ones —
 * the lecturer route never emits them, so the mapping can never mislabel
 * a lecturer failure.
 */
const ERROR_CODE_KEY: Record<string, string> = {
  search_unavailable: "errSearchUnavailable",
  search_failed: "errSearchFailed",
  search_corpus_thin: "errSearchThin",
  question_cap_reached: "errQuestionCap",
  rate_limited: "errRateLimited",
  invalid_ai_output: "errInvalidAi",
  ai_unavailable: "errInvalidAi",
};

const SUMMARY_THROTTLE_MS = 5_000;
/** Plan §Endings: runs faster than this settle straight to the payoff. */
const FAST_RUN_MS = 8_000;

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

/** Bot mood per lifecycle position — the engine morphs between these. */
function botStateFor(phase: string, activeStage?: GenerationStage): BotState {
  if (phase === "running") return activeStage === "search" ? "scanning" : "thinking";
  if (phase === "done") return "celebrate";
  if (phase === "saved-refresh-failed") return "warn";
  if (phase === "cancelled") return "paused";
  return "fail"; // error
}

export function GenerationProgress({
  endpoint,
  body,
  onOutcome,
  onRetry,
  onReview,
  onGenerated,
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
  /** Student surface only: the done payload's question rows merge into the
   * editor's local state (the editor owns its questions; no server refresh).
   * Absent on the lecturer surface (refresh path). */
  onGenerated?: (questions: unknown[], info: { capped: boolean }) => void;
}) {
  const t = useTranslations("extract");
  const [liveLine, setLiveLine] = useState("");
  // Settle beat: phase flips to "done" immediately at the event; the visual
  // (chips + sentence + CTA) lands after FAST_SETTLE_MS so the celebrate
  // morph reads. Fast runs (<8s) skip straight through with no beat.
  const [settlePending, setSettlePending] = useState(false);
  // Identity key for the module-level throttle clock (WeakMap entry).
  const liveKeyRef = useRef({});
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stream-open time for the fast-run rule — captured in an effect (the
  // react-hooks purity rule forbids Date.now() during render).
  const mountedAtRef = useRef<number | null>(null);
  const reducedRef = useRef(false);

  type TerminalKind = Parameters<
    NonNullable<Parameters<typeof useGenerationStream>[0]["announceTerminal"]>
  >[0];

  /** Localized word for a chip tick tooltip (never the raw English enum). */
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

  /** Localized trace line for a stage transition (server chrome — the one-
   * line grey strip only ever shows stage/tool chrome and model tokens as
   * inert text; the plan's all-copy-localized rule covers the chrome). */
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
    formatToolLine: (kind, info) => {
      if (kind === "call") return t("toolSearchCall", { query: info.query });
      if (kind === "skip") return t("toolSearchSkip", { url: info.query, reason: info.reason ?? "" });
      return t("toolSearchResult", { count: info.resultCount ?? 0, query: info.query });
    },
    announceStage: (stage) =>
      announceThrottledInto(setLiveLine, liveKeyRef, t(STAGE_ACTIVE_KEY[stage])),
    announceTerminal: (kind, doneCount) =>
      announceNowInto(setLiveLine, liveKeyRef, terminalLine(kind, doneCount)),
    onDone: (_count, payload) => {
      // Student surface: merge the saved rows locally (the save committed —
      // the merge is bookkeeping, not a second write). Capped notice mirrors
      // the legacy path's partial-add honesty.
      if (onGenerated) {
        const p = (payload ?? {}) as { questions?: unknown[]; capped?: boolean };
        onGenerated(Array.isArray(p.questions) ? p.questions : [], {
          capped: Boolean(p.capped),
        });
      }
      onOutcome("done", null);
    },
    onSavedRefreshFailed: () => onOutcome("saved_refresh_failed", null),
    onError: (code) => onOutcome("error", code),
    onCancelled: () => onOutcome("cancelled", null),
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
      if (settleTimer.current) clearTimeout(settleTimer.current);
    };
  }, []);

  // Plan §Endings: a committed save settles the visuals after a short beat
  // (the celebrate morph needs a frame to read); fast runs (<8s from mount)
  // settle instantly — the staged playthrough would be pure theatre. All
  // state flips happen inside timer callbacks (external systems) — the
  // effect itself only schedules them.
  useEffect(() => {
    if (phase !== "done") {
      // Not a success: any pending settle is cancelled via the timer guard.
      settleTimer.current = setTimeout(() => setSettlePending(false), 0);
      return;
    }
    const openedAt = mountedAtRef.current ?? Number.POSITIVE_INFINITY;
    const fastRun = Date.now() - openedAt < FAST_RUN_MS;
    if (reducedRef.current || fastRun) {
      settleTimer.current = setTimeout(() => setSettlePending(false), 0);
      return;
    }
    setSettlePending(true);
    settleTimer.current = setTimeout(() => setSettlePending(false), 900);
  }, [phase]);

  // Stamp the stream-open time on mount (external-system clock, effect-only).
  useEffect(() => {
    mountedAtRef.current = Date.now();
  }, []);

  const activeStage = (Object.keys(trail) as GenerationStage[]).find(
    (k) => trail[k] === "active",
  );

  const runningCopy = activeStage
    ? t(STAGE_ACTIVE_KEY[activeStage])
    : t("consoleWaiting");

  const botState = botStateFor(phase, activeStage);

  /** Web-augmented mode: the route emits the search stage only here — the
   * rail renders the search chip only in this mode (plan's 4 TRUE stages +
   * search-as-tool). */
  const webMode = typeof body.topic === "string" && body.useWebSearch === true;
  const railStages: GenerationStage[] = webMode
    ? ["parse", "search", "draft", "refine", "save"]
    : ["parse", "draft", "refine", "save"];

  /** Payoff sentence for a committed save (count + provenance). */
  const payoffCopy = webMode
    ? // Web mode: sources are the meaningful count (the old
      // chars fallback reads "0 characters" here — critique fix).
      t("forgedStampWeb", { count: stream.doneCount ?? 0, sources: stream.webSources ?? 0 })
    : t("forgedStamp", {
        count: stream.doneCount ?? 0,
        // Parse renders skip when the text came from the client (no server
        // detail) — fall back to the request body so the stamp never says
        // "0 characters" on the primary flow.
        chars: (
          stream.chars ??
          (typeof body.extractedText === "string" ? body.extractedText.length : 0)
        ).toLocaleString(),
      });

  const knownErrorCode =
    phase === "error" && stream.errorCode && ERROR_CODE_KEY[stream.errorCode]
      ? ERROR_CODE_KEY[stream.errorCode]
      : null;

  /** The ONE live sentence: stage narration while running, the outcome at
   * terminal (held through the settle beat — the chips settle under it). */
  const settled = phase !== "running" && !settlePending;
  const headline =
    phase === "running" || settlePending
      ? runningCopy
      : phase === "done"
        ? payoffCopy
        : phase === "error"
          ? knownErrorCode
            ? t(knownErrorCode)
            : stream.errorCode === "already_running"
              ? t("alreadyRunningTitle")
              : t("generationFailedTitle")
          : phase === "cancelled"
            ? t("cancelledTitle")
            : t("savedRefreshFailedTitle");

  const headlineTone =
    !settled && phase !== "error"
      ? "text-foreground"
      : phase === "done"
        ? "text-emerald-700 dark:text-emerald-300"
        : phase === "error"
          ? "text-destructive"
          : phase === "saved-refresh-failed"
            ? "text-amber-700 dark:text-amber-300"
            : "text-muted-foreground"; // cancelled

  /** Secondary reassurance line — localized descriptors for cancelled /
   * saved-refresh-failed; raw server message only for unknown error codes.
   * No role="alert": the polite live region already announced the ending. */
  const subline =
    phase === "running" || settlePending
      ? null
      : phase === "error"
        ? stream.errorMessage && !knownErrorCode && stream.errorCode !== "already_running"
          ? stream.errorMessage
          : null
        : phase === "cancelled"
          ? t("cancelledDesc")
          : phase === "saved-refresh-failed"
            ? t("savedRefreshFailedDesc")
            : null;

  // The grey one-liner: the LLM's latest trace token (or the latest stage
  // chrome line). Inert aria-hidden text, hard-ellipsized to ONE line.
  const lastTrace: GenerationTraceLine | undefined = trace[trace.length - 1];
  const tokenLine =
    phase === "running" && lastTrace ? lastTrace.text : null;

  return (
    <div className="space-y-4" data-testid="generation-progress">
      {/* The ONLY live region (throttled; terminals bypass). */}
      <p aria-live="polite" className="sr-only">
        {liveLine}
      </p>

      {/* THE TAKEOVER: one centered moment — bot on pedestal, stage rail,
          one sentence, one grey token line, CTA. Terminal morphs in place. */}
      <div
        data-testid="generation-status-strip"
        className="flex flex-col items-center px-2 pb-1 pt-2 text-center"
      >
        <GenerationSphere
          state={botState}
          size={96}
          className="relative z-10 shrink-0"
        />
        {/* Clay pedestal — pulled up under the sphere so its bottom edge
            sinks ~4px into the bar (seated exactly on it per the reference
            pic); the SVG paints ON TOP so the orbit ring's lower arc and
            the cream halo cross the bar visibly, as in the pic. */}
        <div
          aria-hidden="true"
          className="relative -mt-[19px] h-4 w-32 rounded-full border-[3px] border-border bg-orange-200/50 shadow-[0_4px_0_#FED7AA] dark:bg-orange-500/15"
        />

        {/* Stage rail — the plan's TRUE stages (search chip only in web
            mode). Decorative; announcements are the SR channel. */}
        <div aria-hidden="true" className="mt-4 flex items-center gap-1.5">
          {railStages.map((key) => (
            <span
              key={key}
              title={`${t(STAGE_LABEL_KEY[key])}: ${stageStatusWord(trail[key])}`}
              className={`h-2.5 w-6 rounded-full transition-colors duration-300 ${chipClass(trail[key], settled)}`}
            />
          ))}
        </div>

        {/* The ONE live sentence — stage narration → payoff/failure. */}
        <p
          className={`mt-3 min-h-[26px] max-w-[42ch] text-balance text-base font-extrabold leading-snug ${headlineTone}`}
        >
          {headline}
        </p>

        {/* The grey one-liner — the model's latest token as ambient, inert
            text (S7). Always exactly one line (truncate), gone at terminal
            states — endings are spoken by the sentence + live region. */}
        {tokenLine && (
          <p
            aria-hidden="true"
            data-testid="generation-token-line"
            className="mt-0.5 max-w-[46ch] truncate font-mono text-2xs text-muted-foreground/70"
          >
            {tokenLine}
          </p>
        )}
        {subline && (
          <p className="mt-0.5 max-w-[46ch] text-2xs font-semibold leading-relaxed text-muted-foreground">
            {subline}
          </p>
        )}

        {/* CTA rises under the sentence at terminal states (after the
            settle beat on normal runs; instantly on fast runs). */}
        {!settlePending && (phase === "done" || phase === "saved-refresh-failed") && (
          <Button
            type="button"
            size="sm"
            data-testid="generation-review-btn"
            className="mt-4 gap-1.5 rounded-xl text-xs font-bold"
            onClick={onReview}
          >
            {t("reviewQuestions")}
          </Button>
        )}
        {!settlePending &&
          (phase === "error" || phase === "cancelled") &&
          !(phase === "error" && stream.errorCode === "already_running") && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="generation-retry-btn"
              className="mt-4 rounded-xl text-xs font-bold"
              onClick={onRetry}
            >
              {t("tryAgain")}
            </Button>
          )}
      </div>

      {/* Cancel — a quiet text action INSIDE the generating view (the dialog
          footer is hidden while running): aborts the stream, keeps the
          dialog open, marks the run cancelled and retains the trace. */}
      {phase === "running" && (
        <div className="flex justify-center">
          <button
            type="button"
            data-testid="generation-cancel-btn"
            className="rounded-lg px-3 py-2 text-xs font-bold text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring"
            onClick={stream.cancel}
          >
            {t("cancelGeneration")}
          </button>
        </div>
      )}
    </div>
  );
}
