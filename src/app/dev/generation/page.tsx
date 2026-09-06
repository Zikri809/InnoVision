"use client";

/**
 * DEV-ONLY PROTOTYPE — /dev/generation (404s outside dev / the E2E harness,
 * same gate as /dev/bot and /dev/error — isDevPlaygroundEnabled()).
 *
 * Interactive proposal for replacing the full-page /lecturer/quizzes/[id]/
 * generating terminal console with an in-dialog generating state on step 2 of
 * GenerateFromFileDialog, per the coding-agent pattern:
 *   1. A flashing STATUS STRIP above the trace — the single line of current
 *      state ("Drafting questions…") that pulses on every change. A tiny dot
 *      trail keeps the four TRUE stages visible without the full rail.
 *   2. A "Thinking" ACCORDION below it — raw reasoning + content deltas
 *      stream inside, collapsed by default, auto-folds shortly after done.
 *      Coding-agent pattern: the COLLAPSED HEADER carries a live muted
 *      preview of the latest activity line ("Thinking · Draft: drafting
 *      questions…"), so stage transitions surface in the preview without
 *      expanding anything.
 *
 * Fidelity notes: the simulated stream speaks the real GenerationEvent stage
 * vocabulary (parse → draft → refine → save, truth rule — no invented
 * stages), traces render as inert aria-hidden plain text (S7 posture), and
 * cancel/error/done mirror the console's contracts. If adopted, the
 * sessionStorage handoff and NDJSON route contract stay unchanged — only the
 * presentation layer moves.
 */

import { useEffect, useRef, useState } from "react";
import { notFound } from "next/navigation";
import {
  AlertCircle,
  ArrowLeft,
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  FileText,
  Loader2,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";
import { isDevPlaygroundEnabled } from "@/lib/face/seam-gate";
import { BotAvatar } from "@/components/bot/bot-avatar";
import { Button } from "@/components/ui/button";
import type { GenerationStage } from "@/lib/ai/events";

type Scenario = "happy" | "fast" | "refine" | "error";
type RunPhase = "idle" | "running" | "done" | "error" | "cancelled";
type StageRun = "pending" | "active" | "done" | "failed";
type Trail = Record<GenerationStage, StageRun>;
/** A trace line: raw model text, or a server-derived stage marker. */
type TraceLine = { kind: "model" | "stage"; text: string };
/** Pulse flash hue for the status strip. */
type PulseTone = "primary" | "emerald" | "destructive" | "neutral";

const SCENARIOS: { id: Scenario; label: string }[] = [
  { id: "happy", label: "Happy path (~9s)" },
  { id: "fast", label: "Fast (~3s)" },
  { id: "refine", label: "With refine step" },
  { id: "error", label: "Fails mid-draft" },
];

const STAGE_DOT_LABEL: Record<GenerationStage, string> = {
  parse: "Parse",
  draft: "Draft",
  refine: "Refine",
  save: "Save",
};
const IDLE_TRAIL: Trail = { parse: "pending", draft: "pending", refine: "pending", save: "pending" };

/** Trace-line verb per stage (coding-agent transcript flavor). */
const STAGE_ACTIVITY: Record<GenerationStage, string> = {
  parse: "reading sources",
  draft: "drafting questions",
  refine: "polishing weak questions",
  save: "saving to your quiz",
};

/* Simulated model output — realistic reasoning + raw content fragments. */
const REASONING_DRAFT =
  "The source covers cellular respiration and photosynthesis — roughly 12k characters, good density for 10 questions.\nI'll balance 6 MCQ, 2 true/false and 2 short-answer, ramping easy → medium with two hards at the end.\nQ1 should anchor on ATP synthase; distractors must be plausible, so no 'none of the above' patterns.\nFor Q4 the stem is ambiguous — 'directly' vs 'indirectly' measured. Tighten it before emitting.";
const REASONING_REFINE =
  "Q4's distractor B overlaps with the correct answer conceptually — regenerating it.\nQ7's wording exceeds the reading level; simplifying the stem.";
const CONTENT_JSON =
  '{"questions":[{"type":"mcq","difficulty":"easy","stem":"Which organelle produces most of a cell\'s ATP?","options":["Mitochondrion","Ribosome","Golgi apparatus","Lysosome"],"answer_index":0},{"type":"true_false","stem":"Photosynthesis consumes oxygen and releases carbon dioxide.","answer":false},{"type":"short_answer","stem":"Name the enzyme complex that synthesizes ATP in the inner mitochondrial membrane."}';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Streams text word-by-word (reasoning cadence) through the coalescer. */
async function streamText(
  text: string,
  signal: AbortSignal,
  onChunk: (frag: string) => void,
  chunkMs: number,
) {
  const tokens = text.match(/\S+\s*/g) ?? [];
  for (const token of tokens) {
    await sleep(chunkMs + Math.random() * chunkMs, signal);
    onChunk(token);
  }
}

export default function DevGenerationPrototypePage() {
  // Component playground — not part of the product surface. 404 outside dev
  // or the E2E harness so the prototype never ships as a reachable route.
  if (!isDevPlaygroundEnabled()) notFound();

  const [scenario, setScenario] = useState<Scenario>("happy");
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [statusText, setStatusText] = useState("");
  const [pulsing, setPulsing] = useState(false);
  const [pulseTone, setPulseTone] = useState<PulseTone>("primary");
  const [trail, setTrail] = useState<Trail>(IDLE_TRAIL);
  const [trace, setTrace] = useState<TraceLine[]>([]);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [payoff, setPayoff] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const foldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const reducedRef = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedRef.current = mq.matches;
    const onChange = () => {
      reducedRef.current = mq.matches;
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Inert-plain-text scroll pinning (skipped for reduced motion).
  useEffect(() => {
    if (reducedRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [trace, thinkingOpen]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
      if (foldTimer.current) clearTimeout(foldTimer.current);
    };
  }, []);

  // Raw model deltas arrive as tiny fragments; coalesce into lines like the
  // console does (display-only hygiene — the trace is aria-hidden). Coalescing
  // only continues the last MODEL line — a stage marker always starts fresh.
  function appendTrace(frag: string) {
    const MAX_LINE = 160;
    setTrace((prev) => {
      const lines: TraceLine[] = [...prev];
      let cur = "";
      const last = lines[lines.length - 1];
      if (last && last.kind === "model") {
        cur = last.text;
        lines.pop();
      }
      const parts = frag.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          if (cur.trim() !== "") lines.push({ kind: "model", text: cur });
          cur = "";
        }
        cur += parts[i];
        while (cur.length >= MAX_LINE) {
          lines.push({ kind: "model", text: cur.slice(0, MAX_LINE) });
          cur = cur.slice(MAX_LINE);
        }
      }
      if (cur.trim() !== "") lines.push({ kind: "model", text: cur });
      return lines.length > 200 ? lines.slice(-200) : lines;
    });
  }

  /** Stage markers / terminal notes — always their own line, never merged. */
  function pushStageLine(text: string) {
    setTrace((prev) => {
      const lines: TraceLine[] = [...prev];
      const last = lines[lines.length - 1];
      if (last && last.kind === "model" && last.text.trim() === "") lines.pop();
      lines.push({ kind: "stage", text });
      return lines.length > 200 ? lines.slice(-200) : lines;
    });
  }

  function flashStatus(text: string, tone: PulseTone = "primary") {
    setStatusText(text);
    setPulseTone(tone);
    setPulsing(true);
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
    pulseTimer.current = setTimeout(() => setPulsing(false), 650);
  }

  function markStage(key: GenerationStage, status: StageRun) {
    setTrail((prev) => ({ ...prev, [key]: status }));
    // Stage transitions land as trace lines too — the collapsed header's
    // live preview keys off the trace, so state changes read like a
    // coding-agent transcript ("Refine: polishing weak questions…").
    const verb =
      status === "active" ? STAGE_ACTIVITY[key] : status === "done" ? "done" : status;
    pushStageLine(`${key.charAt(0).toUpperCase() + key.slice(1)}: ${verb}`);
  }

  function failActiveStages() {
    setTrail((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next) as GenerationStage[]) {
        if (next[key] === "active") next[key] = "failed";
      }
      return next;
    });
  }

  async function run(selected: Scenario) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;
    const isCurrent = () => abortRef.current === controller;
    if (foldTimer.current) clearTimeout(foldTimer.current);

    setPhase("running");
    setTrail(IDLE_TRAIL);
    setStatusText("Connecting to the AI…");
    setTrace([{ kind: "stage", text: "Connecting to the AI…" }]);
    setThinkingOpen(false);
    setPayoff(null);
    setErrorMessage(null);

    const fast = selected === "fast";
    try {
      await sleep(500, signal);
      if (!isCurrent()) return;

      markStage("parse", "active");
      flashStatus("Reading your sources…");
      await sleep(fast ? 400 : 1100, signal);
      if (!isCurrent()) return;
      markStage("parse", "done");

      markStage("draft", "active");
      flashStatus("Drafting questions…");
      await streamText(REASONING_DRAFT, signal, appendTrace, fast ? 7 : 15);
      await streamText(CONTENT_JSON, signal, appendTrace, fast ? 6 : 13);
      if (!isCurrent()) return;

      if (selected === "error") {
        await sleep(500, signal);
        if (!isCurrent()) return;
        failActiveStages();
        setPhase("error");
        setErrorMessage(
          "The AI provider is temporarily unavailable (503). Nothing was saved — try again in a moment.",
        );
        flashStatus("Generation failed", "destructive");
        return;
      }
      markStage("draft", "done");

      if (selected === "refine") {
        markStage("refine", "active");
        flashStatus("Polishing weak questions…");
        await streamText(REASONING_REFINE, signal, appendTrace, 13);
        if (!isCurrent()) return;
        markStage("refine", "done");
      }

      markStage("save", "active");
      flashStatus("Saving to your quiz…");
      await sleep(fast ? 350 : 900, signal);
      if (!isCurrent()) return;
      markStage("save", "done");

      setPhase("done");
      setPayoff("10 questions forged from 12,430 characters.");
      flashStatus("Done — 10 questions saved", "emerald");
      // Auto-fold shortly after done (coding-agent behavior); re-openable.
      foldTimer.current = setTimeout(() => setThinkingOpen(false), 1500);
    } catch {
      if (!signal.aborted || !isCurrent()) return;
      failActiveStages();
      setPhase("cancelled");
      flashStatus("Generation cancelled", "neutral");
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  function resetToIdle() {
    abortRef.current?.abort();
    if (foldTimer.current) clearTimeout(foldTimer.current);
    setPhase("idle");
    setTrail(IDLE_TRAIL);
    setTrace([]);
    setStatusText("");
    setPayoff(null);
    setErrorMessage(null);
    setThinkingOpen(false);
  }

  // Status strip chrome per phase — FLAT tinted panel (border carries the
  // hue, no offset shadow): the clay hard shadow made the strip read as a
  // giant button and fought the green/error tints in both themes.
  const stripTone: Record<Exclude<RunPhase, "idle">, string> = {
    running: "border-primary/40 bg-primary/5 text-foreground",
    done: "border-emerald-500/40 bg-emerald-500/10 text-emerald-950 dark:text-emerald-200",
    error: "border-destructive/40 bg-destructive/10 text-destructive",
    cancelled: "border-border bg-muted/40 text-muted-foreground",
  };
  const pulseToneClass: Record<PulseTone, string> = {
    primary: "border-primary/70 bg-primary/10",
    emerald: "border-emerald-500/70 bg-emerald-500/20",
    destructive: "border-destructive/70 bg-destructive/20",
    neutral: "border-border bg-muted/70",
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <div className="flex items-center gap-2.5">
        <h1 className="font-heading text-xl font-bold text-foreground">
          Generation UX prototype
        </h1>
        <span className="rounded-full border-[2px] border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-2xs font-extrabold text-amber-700 dark:text-amber-300">
          dev only
        </span>
      </div>
      <p className="mt-1 max-w-2xl text-xs font-semibold text-muted-foreground">
        Proposal: replace the full-page generating terminal with an in-dialog
        state on step 2 — a flashing status strip above a collapsible
        &ldquo;Thinking&rdquo; accordion (coding-agent pattern). Simulated
        stream, real event vocabulary.
      </p>

      {/* Scenario selector */}
      <div
        role="radiogroup"
        aria-label="Demo scenario"
        className="mt-5 flex flex-wrap gap-2"
      >
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={scenario === s.id}
            disabled={phase === "running"}
            onClick={() => setScenario(s.id)}
            className={`rounded-xl border-[3px] px-3 py-1.5 text-2xs font-extrabold transition-all duration-150 disabled:opacity-50 ${
              scenario === s.id
                ? "border-primary bg-primary text-primary-foreground shadow-[0_3px_0_var(--primary-deep)]"
                : "border-border bg-card text-foreground shadow-[0_3px_0_var(--border)] hover:-translate-y-0.5 hover:bg-muted active:translate-y-0"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Dialog frame — mirrors ResponsiveModalContent anatomy (max-w-3xl). */}
      <div className="mt-4 overflow-hidden rounded-[24px] border-[3px] border-border bg-card shadow-[var(--shadow-clay-sm)]">
        <div className="flex items-center justify-between gap-2 border-b-[3px] border-border/40 px-6 py-4 sm:px-7">
          <p className="flex items-center gap-2 font-heading text-xl font-bold text-foreground">
            <Sparkles className="size-5 text-primary" aria-hidden="true" />
            Generate from files
          </p>
          <span className="rounded-full border-[2px] border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-extrabold text-primary">
            Step 2 of 2
          </span>
        </div>

        <div className="space-y-4 px-6 py-5 sm:px-7">
          {/* Screen-reader channel for the flashing strip. */}
          <p aria-live="polite" className="sr-only">
            {statusText}
          </p>

          {phase === "idle" ? (
            <div className="space-y-4">
              <p className="text-2xs font-semibold text-muted-foreground">
                Step-2 controls stay as today — press Generate to preview the
                proposed generating state (controls are static here).
              </p>
              <div className="flex items-center gap-2.5 rounded-2xl border-[3px] border-border bg-background/50 p-3.5">
                <div className="rounded-xl bg-primary/10 p-2 text-primary">
                  <FileText className="size-4" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-xs font-bold text-foreground">
                    lecture-notes.pdf · 1 source
                  </p>
                  <p className="text-2xs font-semibold text-muted-foreground">
                    12,430 characters extracted
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {["Mixed", "Easy", "Medium", "Hard"].map((d, i) => (
                  <button
                    key={d}
                    type="button"
                    disabled
                    className={`min-h-[40px] rounded-xl border-[3px] text-2xs font-extrabold ${
                      i === 0
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-card text-foreground"
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-3.5">
              {/* Collapsed config summary (replaces the expanded controls). */}
              <div className="flex items-center gap-2.5 rounded-2xl border-[3px] border-border bg-background/50 px-3.5 py-2.5">
                <FileText className="size-4 shrink-0 text-primary" aria-hidden="true" />
                <p className="min-w-0 flex-1 truncate text-2xs font-bold text-foreground">
                  lecture-notes.pdf · 12,430 chars
                </p>
                <p className="hidden shrink-0 text-2xs font-semibold text-muted-foreground sm:block">
                  10 · Mixed · Auto · Replace
                </p>
              </div>

              {/* Flashing status strip — pulses (tone-matched) on every state
                  change. At a terminal state it MORPHS INTO the outcome card:
                  done → payoff + "Review questions"; error → reason + "Try
                  again"; cancelled → "nothing saved" note. One element tells
                  the whole ending — no duplicate banner underneath. */}
              <div
                className={`flex items-center gap-3 rounded-2xl border-[3px] px-3.5 py-2.5 transition-colors duration-500 ${
                  pulsing ? pulseToneClass[pulseTone] : stripTone[phase]
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
                    <p className="text-sm font-extrabold" role="alert">
                      Generation failed
                    </p>
                    {errorMessage && (
                      <p className="mt-0.5 text-2xs font-semibold text-destructive/90">
                        {errorMessage}
                      </p>
                    )}
                  </div>
                ) : phase === "cancelled" ? (
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-extrabold">Generation cancelled</p>
                    <p className="mt-0.5 text-2xs font-semibold text-muted-foreground">
                      Nothing was saved. The thinking trace is kept for review.
                    </p>
                  </div>
                ) : (
                  <p className="min-w-0 flex-1 truncate text-sm font-extrabold">
                    {phase === "done" && payoff ? payoff : statusText}
                  </p>
                )}
                {phase === "done" && payoff && (
                  <Button
                    type="button"
                    size="sm"
                    className="shrink-0 gap-1.5 rounded-xl text-xs font-bold"
                    onClick={resetToIdle}
                  >
                    Review questions
                  </Button>
                )}
                {phase === "error" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void run(scenario)}
                    className="shrink-0 rounded-xl text-xs font-bold"
                  >
                    Try again
                  </Button>
                )}
                {/* Dot trail — the four TRUE stages, truth rule intact.
                    Hidden at terminal states: their story is over. */}
                {phase !== "done" && phase !== "error" && phase !== "cancelled" && (
                  <div
                    className="flex shrink-0 items-center gap-1.5"
                    aria-label="Stage progress"
                  >
                    {(Object.keys(trail) as GenerationStage[]).map((key) => (
                      <span
                        key={key}
                        title={`${STAGE_DOT_LABEL[key]}: ${trail[key]}`}
                        className={
                          trail[key] === "done"
                            ? "text-emerald-600 dark:text-emerald-400"
                            : trail[key] === "active"
                              ? "text-primary"
                              : trail[key] === "failed"
                                ? "text-destructive"
                                : "text-muted-foreground/50"
                        }
                      >
                        {trail[key] === "done" ? (
                          <Check className="size-3.5 stroke-[3]" aria-hidden="true" />
                        ) : trail[key] === "active" ? (
                          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
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

              {/* Thinking accordion — collapsed by default, inert raw text. */}
              <div className="rounded-2xl border-[3px] border-border bg-card">
                <button
                  type="button"
                  onClick={() => setThinkingOpen((prev) => !prev)}
                  aria-expanded={thinkingOpen}
                  aria-controls="thinking-trace"
                  className="flex w-full items-center gap-2 rounded-2xl px-3.5 py-2.5 text-left hover:bg-muted/50"
                >
                  <Brain className="size-4 shrink-0 text-primary" aria-hidden="true" />
                  <span className="shrink-0 text-xs font-extrabold text-foreground">
                    Thinking
                  </span>
                  {/* Live preview of the latest activity — muted, truncated.
                      Coding-agent pattern: while collapsed, the header itself
                      churns with stage changes + raw model text. aria-hidden
                      because the throttled live region already announces
                      state; raw model text must stay out of the SR stream. */}
                  <span
                    aria-hidden="true"
                    className={`min-w-0 flex-1 truncate font-mono text-2xs ${
                      phase === "running"
                        ? "text-muted-foreground"
                        : "text-muted-foreground/70"
                    }`}
                  >
                    {/* Always the LATEST line — raw model text churns live
                        through the collapsed header; stage lines flash
                        through it at state changes, then the stream
                        continues. */}
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
                    id="thinking-trace"
                    ref={scrollRef}
                    aria-hidden="true"
                    className="mx-3.5 mb-3.5 max-h-44 overflow-y-auto rounded-xl border-[2px] border-border/40 bg-[#2b190b] p-3 font-mono text-2xs leading-relaxed text-amber-50/90"
                  >
                    {trace.length === 0 ? (
                      <p className="text-amber-50/50">Waiting for the model…</p>
                    ) : (
                      trace.map((line, i) => (
                        <p
                          key={i}
                          className={`break-words whitespace-pre-wrap ${
                            line.kind === "stage"
                              ? "font-sans font-extrabold text-primary/90"
                              : ""
                          }`}
                        >
                          {line.text || "\u00A0"}
                        </p>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer — same anatomy as the real dialog. */}
        <div className="flex items-center justify-between gap-3 border-t-[3px] border-border/40 px-6 py-4 sm:px-7">
          <Button
            type="button"
            variant="outline"
            className="gap-1.5 rounded-xl font-bold"
            onClick={resetToIdle}
            disabled={phase === "running"}
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to files
          </Button>
          {phase === "running" ? (
            <Button
              type="button"
              variant="outline"
              className="gap-1.5 rounded-xl font-bold"
              onClick={handleCancel}
            >
              <X className="size-4" aria-hidden="true" />
              Cancel generation
            </Button>
          ) : (
            <Button
              type="button"
              className="gap-2 rounded-xl font-bold"
              onClick={() => void run(scenario)}
            >
              <Wand2 className="size-4" aria-hidden="true" />
              {phase === "idle" ? "Generate questions" : "Run again"}
            </Button>
          )}
        </div>
      </div>

      {/* Behavior notes */}
      <ul className="mt-5 space-y-1.5 text-2xs font-semibold text-muted-foreground">
        <li>
          • Status strip pulses on every state change; the dot trail keeps the
          four TRUE stages (parse/draft/refine/save) — no invented stages.
        </li>
        <li>
          • Thinking accordion starts collapsed (progressive disclosure); the
          trace is raw model text — inert, aria-hidden, never markdown.
        </li>
        <li>
          • Auto-folds ~1.5s after done; re-open anytime. Cancel keeps the
          trace; error keeps it too (transcript retained contract).
        </li>
        <li>
          • If adopted: replaces the full-page /generating console. The
          sessionStorage handoff and NDJSON event contract stay unchanged.
        </li>
      </ul>
    </div>
  );
}
