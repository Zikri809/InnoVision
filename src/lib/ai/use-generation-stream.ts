"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  readGenerationEvents,
  STREAM_ACCEPT,
  type GenerationStage,
} from "@/lib/ai/events";

/**
 * The in-dialog generation stream engine (extracted from the Phase 2 console
 * page when generation moved into GenerateFromFileDialog — same NDJSON
 * two-segment contract, same truth rule, presentation-independent).
 *
 * The dialog renders <GenerationProgress key={runId}> on submit; the engine
 * OWNS the POST for that mount:
 *  - POSTs with `Accept: application/x-ndjson`; a non-NDJSON response is a
 *    PRE-stream guard rejection — the legacy JSON error body is authoritative
 *    and carries the same code the legacy path always returned.
 *  - Dead-stream watchdog: any event (pings included) proves liveness; 30s of
 *    total silence means the route is wedged → phase "error" (stream_dead).
 *    EOF without a terminal event is the same failure.
 *  - Terminal phases: "done" (save committed; `doneCount` from the payload),
 *    "saved-refresh-failed" (committed but refetch failed — a retry would
 *    wipe + re-bill the save, so the UI must NOT offer one), "error"
 *    (retryable; `errorCode` drives copy — already_running is distinct),
 *    "cancelled" (user cancel or dialog-close abort; trace kept).
 *  - Strict-mode dev double-invoke: the same-fiber `startedRef` guard makes
 *    the second effect run a no-op (NOT a module-scope guard — that would
 *    block a legitimate retry remount).
 *  - Trace lines: raw reasoning/content deltas COALESCE into MODEL lines
 *    (hard-wrapped, capped); STAGE markers always start their own line, so
 *    the collapsed header's live preview reads like a coding-agent transcript.
 *
 * Localization lives in the COMPONENT: the announce callbacks receive
 * semantic tokens (stage names / terminal kinds), never English copy.
 */

export type StreamPhase =
  | "running"
  | "done"
  | "saved-refresh-failed"
  | "error"
  | "cancelled";
export type StageRun = "pending" | "active" | "done" | "skip" | "failed";
export type TerminalKind =
  | "done"
  | "error"
  | "already_running"
  | "cancelled"
  | "saved_refresh_failed";

/** A trace line: raw model text, or a server-derived stage marker. */
export type GenerationTraceLine = { kind: "model" | "stage"; text: string };

const STAGE_ORDER: GenerationStage[] = ["parse", "search", "draft", "refine", "save"];
const MAX_LINE_CHARS = 160;
const MAX_LINES = 200;
const DEAD_STREAM_MS = 30_000;

export type GenerationStreamState = {
  phase: StreamPhase;
  trail: Record<GenerationStage, StageRun>;
  trace: GenerationTraceLine[];
  /** Character count from the parse-done detail (payoff copy). */
  chars: number | null;
  /** Fetched web-source count from the search-done detail (web payoff). */
  webSources: number | null;
  /** Question count from the done payload (payoff copy). */
  doneCount: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** Abort the in-flight run (user cancel); resolves to phase "cancelled". */
  cancel: () => void;
};

export function useGenerationStream({
  endpoint,
  body,
  formatStageLine,
  formatToolLine,
  announceStage,
  announceTerminal,
  onDone,
  onSavedRefreshFailed,
  onError,
  onCancelled,
}: {
  endpoint: string;
  body: Record<string, unknown>;
  /** Localized one-line transcript text for a stage transition. */
  formatStageLine: (stage: GenerationStage, status: string) => string;
  /** Localized one-line transcript text for tool_call/tool_result events.
   * kind "call" → issuing query; "result" → resultCount hits;
   * "skip" → fetch failed for the page at `query` (URL) with `reason`. */
  formatToolLine: (
    kind: "call" | "result" | "skip",
    info: { query: string; resultCount?: number; reason?: string },
  ) => string;
  /** Throttled polite announcements for stage starts (component localizes). */
  announceStage: (stage: GenerationStage) => void;
  /** Terminal announcements — bypass the throttle (SRs must get endings).
   * `done` carries the question count from the payload (the component's
   * state hasn't committed yet when this fires synchronously). */
  announceTerminal: (kind: TerminalKind, doneCount?: number) => void;
  /** Save committed + payload fetched. `payload` is the route's terminal
   * body (lecturer `{quiz,questions}`; student `{questions,capped}`) —
   * surfaces that merge locally (student editor) consume it here. */
  onDone?: (count: number, payload: unknown) => void;
  /** Save committed but the refetch failed — retry must NOT be offered. */
  onSavedRefreshFailed?: () => void;
  /** Terminal failure (already_running included). */
  onError?: (code: string, message: string | null) => void;
  /** User cancel / dialog-close abort (not the dead-stream failure). */
  onCancelled?: () => void;
}): GenerationStreamState {
  const [phase, setPhase] = useState<StreamPhase>("running");
  const [trail, setTrail] = useState<Record<GenerationStage, StageRun>>(() =>
    Object.fromEntries(
      STAGE_ORDER.map((k) => [k, "pending" as StageRun]),
    ) as Record<GenerationStage, StageRun>,
  );
  const [trace, setTrace] = useState<GenerationTraceLine[]>([]);
  const [chars, setChars] = useState<number | null>(null);
  const [doneCount, setDoneCount] = useState<number | null>(null);
  const [webSources, setWebSources] = useState<number | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const startedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // Latest callbacks in a ref so the run effect reads them fresh without
  // re-running (one run per mounted key). Assigned in an effect, not during
  // render (react-hooks/refs rule).
  const cbRef = useRef({
    formatStageLine,
    formatToolLine,
    announceStage,
    announceTerminal,
    onDone,
    onSavedRefreshFailed,
    onError,
    onCancelled,
  });
  useEffect(() => {
    cbRef.current = {
      formatStageLine,
      formatToolLine,
      announceStage,
      announceTerminal,
      onDone,
      onSavedRefreshFailed,
      onError,
      onCancelled,
    };
  });

  const markStage = useCallback((key: GenerationStage, status: StageRun) => {
    setTrail((prev) => ({ ...prev, [key]: status }));
  }, []);

  const failActiveStages = useCallback(() => {
    setTrail((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next) as GenerationStage[]) {
        if (next[key] === "active") next[key] = "failed";
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    // StrictMode dev double-invoke: run 1's cleanup runs before run 2 — the
    // abort below must let the SECOND invocation start a fresh run, not
    // strand the user on a self-inflicted "cancelled" strip. `superseded`
    // marks THIS invocation as replaced (no cancelled transition); the guard
    // ref resets so the restart proceeds. A real unmount never re-runs the
    // effect, so nothing restarts there — the dialog is genuinely gone.
    let superseded = false;

    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;

    function appendTrace(frag: string) {
      const parts = frag.split("\n");
      setTrace((prev) => {
        const lines: GenerationTraceLine[] = [...prev];
        let cur = "";
        const last = lines[lines.length - 1];
        if (last && last.kind === "model") {
          cur = last.text;
          lines.pop();
        }
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) {
            if (cur.trim() !== "") lines.push({ kind: "model", text: cur });
            cur = "";
          }
          cur += parts[i];
          while (cur.length >= MAX_LINE_CHARS) {
            lines.push({ kind: "model", text: cur.slice(0, MAX_LINE_CHARS) });
            cur = cur.slice(MAX_LINE_CHARS);
          }
        }
        if (cur.trim() !== "") lines.push({ kind: "model", text: cur });
        return lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines;
      });
    }

    /** Stage markers — always their own line, never merged into model text. */
    function pushStageLine(text: string) {
      setTrace((prev) => {
        const lines: GenerationTraceLine[] = [...prev];
        const last = lines[lines.length - 1];
        if (last && last.kind === "model" && last.text.trim() === "") lines.pop();
        lines.push({ kind: "stage", text });
        return lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines;
      });
    }

    function finishAsError(code: string, message: string | null) {
      setErrorCode(code);
      setErrorMessage(message);
      setPhase("error");
      failActiveStages();
      cbRef.current.announceTerminal(code === "already_running" ? "already_running" : "error");
      cbRef.current.onError?.(code, message);
    }

    async function run() {
      // Dead-stream watchdog — declared before the interval closes over it.
      let deadStream = false;
      let lastByteAt = Date.now();
      let watchdogTimer: ReturnType<typeof setInterval> | undefined;
      const clearWatchdog = () => clearInterval(watchdogTimer);

      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", accept: STREAM_ACCEPT },
          body: JSON.stringify(body),
          signal,
        });

        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("application/x-ndjson")) {
          const json = (await res.json().catch(() => ({}))) as {
            error?: string;
            message?: string;
          };
          finishAsError(json.error ?? "internal", json.message ?? null);
          return;
        }
        if (!res.body) {
          finishAsError("internal", null);
          return;
        }

        watchdogTimer = setInterval(() => {
          if (Date.now() - lastByteAt > DEAD_STREAM_MS) {
            deadStream = true;
            clearWatchdog();
            controller.abort();
          }
        }, 5_000);

        let sawTerminal = false;
        try {
          for await (const ev of readGenerationEvents(res.body)) {
            lastByteAt = Date.now();
            switch (ev.type) {
              case "stage": {
                // Wire status → rail status: "start" renders as active.
                const railStatus: StageRun =
                  ev.status === "start"
                    ? "active"
                    : ev.status === "done"
                      ? "done"
                      : "skip";
                markStage(ev.stage, railStatus);
                pushStageLine(cbRef.current.formatStageLine(ev.stage, ev.status));
                if (railStatus === "active") cbRef.current.announceStage(ev.stage);
                if (ev.stage === "parse" && ev.status === "done" && ev.detail) {
                  setChars(Number(ev.detail) || null);
                }
                if (ev.stage === "search" && ev.status === "done" && ev.detail) {
                  // Truthful payoff figure: the route reports the number of
                  // web pages actually fetched (≤3), mirroring parse's chars.
                  setWebSources(Number(ev.detail) || null);
                }
                break;
              }
              case "reasoning":
              case "content_delta":
                appendTrace(ev.text);
                break;
              case "tool_call":
                // Server-chrome line: the search query being issued. Always
                // its own stage-kind line so it survives the model-text merge.
                pushStageLine(cbRef.current.formatToolLine("call", { query: ev.query }));
                break;
              case "tool_result":
                pushStageLine(
                  ev.skipped
                    ? cbRef.current.formatToolLine("skip", { query: ev.query, reason: ev.reason })
                    : cbRef.current.formatToolLine("result", {
                        query: ev.query,
                        resultCount: ev.resultCount,
                      }),
                );
                break;
              case "ping":
                break;
              case "error":
                sawTerminal = true;
                finishAsError(ev.code, ev.message ?? null);
                break;
              case "cancelled": {
                sawTerminal = true;
                failActiveStages();
                setPhase("cancelled");
                cbRef.current.announceTerminal("cancelled");
                cbRef.current.onCancelled?.();
                break;
              }
              case "saved_refresh_failed": {
                sawTerminal = true;
                markStage("save", "done");
                setPhase("saved-refresh-failed");
                cbRef.current.announceTerminal("saved_refresh_failed");
                cbRef.current.onSavedRefreshFailed?.();
                break;
              }
              case "done": {
                sawTerminal = true;
                markStage("save", "done");
                const payload = ev.payload as { questions?: unknown[] } | null;
                const count = Array.isArray(payload?.questions)
                  ? payload.questions.length
                  : 0;
                setDoneCount(count);
                setPhase("done");
                cbRef.current.announceTerminal("done", count);
                cbRef.current.onDone?.(count, ev.payload);
                break;
              }
            }
          }
        } finally {
          clearWatchdog();
        }

        if (!sawTerminal) {
          // EOF without a terminal event: the route died mid-stream.
          finishAsError("stream_dead", null);
        }
      } catch {
        clearWatchdog();
        if (controller.signal.aborted) {
          // Three abort flavors: the dead-stream watchdog (a FAILURE — the
          // route wedged), a user cancel/dialog close (nothing to undo), or
          // a StrictMode supersession (the restart owns the outcome now).
          if (superseded) return;
          if (deadStream) {
            finishAsError("stream_dead", null);
            return;
          }
          failActiveStages();
          setPhase("cancelled");
          cbRef.current.announceTerminal("cancelled");
          cbRef.current.onCancelled?.();
          return;
        }
        finishAsError("network", null);
      }
    }

    void run();

    return () => {
      // Dialog closed / key remounted mid-run → abort. The server's in-flight
      // guard releases, so an immediate retry is never locked out. A
      // StrictMode remount re-runs the effect and starts a fresh generation.
      superseded = true;
      startedRef.current = false;
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    phase,
    trail,
    trace,
    chars,
    webSources,
    doneCount,
    errorCode,
    errorMessage,
    cancel: useCallback(() => abortRef.current?.abort(), []),
  };
}
