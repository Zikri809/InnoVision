"use client";

import { useLocale, useTranslations } from "next-intl";
import { OptionCard } from "@/components/quiz/option-card";
import { QuestionImage } from "@/components/media/question-image";
import { isIntegrityHardeningEnabled } from "@/lib/integrity/hardening-gate";
import type { AnswerState } from "@/components/quiz/play-client";
import type { HoldProgress } from "@/lib/gestures/types";
import { isPracticeOracleExhausted } from "@/lib/sessions/practice-oracle";

type Question = {
  id: string;
  order_index: number;
  type: "mcq" | "true_false" | "multi_select" | "short_text";
  prompt: string;
  options: string[];
  has_image?: boolean;
  created_at: string;
};

export function QuestionCard({
  question,
  answer,
  mode,
  disabled,
  holdProgress,
  onSelect,
  pendingMulti = [],
  pendingText = "",
  onTextChange,
  practiceAttempts = 0,
}: {
  question: Question;
  answer: AnswerState | undefined;
  mode: "practice" | "assessment";
  disabled: boolean;
  holdProgress?: HoldProgress | null;
  onSelect: (index: number) => void;
  /** QT-1: the in-progress multi-selection (presented space) before Confirm. */
  pendingMulti?: number[];
  /** v4.9: the in-progress free-text answer for a short_text question. */
  pendingText?: string;
  /** v4.9: called on every keystroke in the short-text textarea. */
  onTextChange?: (text: string) => void;
  /** v4.9 (E-58): how many times this question has been answered in practice
   * mode. Drives the advisory oracle warning — see practice-oracle.ts for why
   * this is a client-side nudge rather than an enforced limit. */
  practiceAttempts?: number;
}) {
  const locale = useLocale();
  const t = useTranslations("play");
  const tCommon = useTranslations("common");
  const letters = ["A", "B", "C", "D", "E"];
  const isMulti = question.type === "multi_select";
  const isShortText = question.type === "short_text";

  // Integrity hardening (assessment only, deterrence-only): block the
  // clipboard/context-menu routes to off-device sharing of the live question.
  // The server secrecy layer is the real control — the key never reaches the
  // client — so this is defense-in-depth against shoulder-surf-adjacent
  // convenience, explicitly bypassable (hardening-gate) and bypassable by any
  // devtools user (documented; devtools detection is theater and was cut).
  // The `selectstart` guard was deliberately NOT added: it breaks text
  // selection for assistive-tech users for near-zero marginal deterrence.
  const harden = mode === "assessment" && isIntegrityHardeningEnabled();
  function blockEvent(e: { preventDefault(): void; stopPropagation(): void }) {
    if (!harden) return;
    e.preventDefault();
    e.stopPropagation();
  }
  const hardeningProps = harden
    ? {
        onCopy: blockEvent,
        onCut: blockEvent,
        onContextMenu: blockEvent,
        style: { userSelect: "none" as const },
      }
    : {};

  function formatOptionText(text: string, type: Question["type"]): string {
    if (type === "true_false") {
      const lower = text.trim().toLowerCase();
      if (lower === "true" || lower === "betul") {
        return locale === "ms" ? "Betul" : "True";
      }
      if (lower === "false" || lower === "salah") {
        return locale === "ms" ? "Salah" : "False";
      }
    }
    return text;
  }

  return (
    <section aria-labelledby="question-prompt" {...hardeningProps}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="rounded-full border-[3px] border-border bg-card px-3.5 py-1 text-xs font-extrabold text-muted-foreground">
          {/* Label MAP (v4.9): the original `=== "mcq" ? : trueFalse` ternary
          mislabelled multi_select via its else-fallthrough, and a ternary
          chain would do the same to every type added after it. An explicit
          map fails loudly (undefined) instead of silently lying. */}
          {{
            mcq: tCommon("mcq"),
            true_false: tCommon("trueFalse"),
            multi_select: tCommon("multiSelect"),
            short_text: t("shortText.label"),
          }[question.type]}
        </span>
        {answer && (
          <span
            className={`rounded-full border-[3px] px-3.5 py-1 text-xs font-extrabold ${
              answer.skipped
                ? "border-border bg-muted text-muted-foreground"
                : mode === "practice"
                  ? answer.isCorrect
                    ? "border-emerald-300 bg-emerald-100 text-emerald-800"
                    : "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-border bg-muted text-muted-foreground"
            }`}
          >
            {/* Two shapes that must NOT render a verdict, because
                `is_correct` is false for both while neither is a wrong answer:
                  - a SKIP (a deliberate non-answer), and
                  - a short_text in PRACTICE. Practice has no AI marking path
                    (no spend budget), so the RPC records the row as
                    `needs_review` with is_correct=false — a sentinel, not a
                    judgement. Rendering "Incorrect" would tell a student
                    their free-text answer was graded and failed, which never
                    happened. */}
            {answer.skipped
              ? t("skip.skipped")
              : isShortText && mode === "practice"
                ? t("shortText.needsReview")
                : mode === "practice"
                  ? answer.isCorrect
                    ? t("feedback.correct")
                    : t("feedback.incorrect")
                  : tCommon("completed")}
          </span>
        )}
      </div>

      <h2 id="question-prompt" className="mb-5 font-heading text-xl font-semibold leading-snug [text-wrap:balance] max-sm:text-prompt md:text-2xl">
        {question.prompt}
      </h2>

      {question.has_image && (
        <QuestionImage key={question.id} questionId={question.id} prompt={question.prompt} />
      )}

      {isMulti && !answer && (
        <p className="mb-4 rounded-2xl border-[3px] border-accent/30 bg-blue-50 px-4 py-2.5 text-sm font-bold text-accent" role="note">
          {t("multiHint")}
        </p>
      )}

      {/* v4.9 short_text: a typed answer instead of an option list. The
          textarea is disabled once answered (first-answer-wins), and the
          committed text echoes back so a resumed session shows what the
          student wrote. */}
      {isShortText && (
        <div className="mb-4">
          <textarea
            data-testid="short-text-input"
            className="w-full rounded-2xl border-[3px] border-border bg-card p-4 text-base font-semibold text-foreground shadow-[var(--shadow-clay-sm)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-70"
            rows={4}
            maxLength={500}
            placeholder={t("shortText.placeholder")}
            value={answer ? (answer.answerText ?? "") : pendingText}
            disabled={disabled || Boolean(answer)}
            onChange={(e) => onTextChange?.(e.target.value)}
            aria-label={t("shortText.placeholder")}
          />
          {!answer && (
            <p className="mt-2 text-xs font-bold text-muted-foreground" role="note">
              {t("shortText.pendingNote")}
            </p>
          )}
        </div>
      )}

      {!isShortText && (
      <ul className="space-y-3">
        {question.options.map((opt, i) => {
          // QT-1: multi questions select a SET (in-progress = pendingMulti,
          // committed = answer.selectedIndices); singles keep the scalar.
          const selected = answer
            ? isMulti
              ? (answer.selectedIndices?.includes(i) ?? false)
              : answer.selectedIndex === i
            : pendingMulti.includes(i);
          const showCorrect = mode === "practice" && answer && !answer.seeded;
          const isCorrectOption = showCorrect &&
            (isMulti
              ? (answer?.correctIndices?.includes(i) ?? false)
              : answer?.correctIndex === i);
          const isWrongSelection =
            showCorrect && selected && !isCorrectOption && !answer.isCorrect;
          const optionProgress =
            holdProgress && holdProgress.finger === i + 1 ? holdProgress.progress : 0;
          return (
            <li key={i}>
              <OptionCard
                letter={letters[i] ?? String(i + 1)}
                finger={i + 1}
                text={formatOptionText(opt, question.type)}
                selected={selected}
                correct={isCorrectOption}
                incorrect={isWrongSelection}
                disabled={disabled || Boolean(answer)}
                holdProgress={optionProgress}
                onClick={() => onSelect(i)}
              />
            </li>
          );
        })}
      </ul>
      )}

      {/* v4.9 (E-58): the practice oracle warning. Practice reveals
          correctness instantly, which is exactly what makes it unfit for
          rehearsal — this is the advisory half of that trade-off (see
          practice-oracle.ts). It renders for ANY practice answer — INCLUDING
          a resumed (seeded) one: n22, the old `!answer.seeded` gate meant a
          reload/remount silently hid the warning the student had already
          triggered, while the seeded badge still revealed correctness. The
          LIMIT line joins it once the same question has been answered
          PRACTICE_ORACLE_LIMIT times. */}
      {mode === "practice" && answer && (
        <div
          className="mt-5 rounded-2xl border-[3px] border-amber-300 bg-amber-50 p-4 text-sm font-semibold text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
          role="note"
        >
          <p>{t("oracle.warning")}</p>
          {isPracticeOracleExhausted(practiceAttempts) && (
            <p className="mt-1.5 font-extrabold">
              {t("oracle.limit", { count: practiceAttempts })}
            </p>
          )}
        </div>
      )}

      {mode === "practice" && answer && !answer.seeded && answer.explanation && (
        <div className="mt-5 rounded-2xl border-[3px] border-emerald-300 bg-emerald-50 p-4 text-sm font-semibold text-emerald-900" role="status">
          <strong className="font-extrabold">{t("end.explanation")}</strong> {answer.explanation}
        </div>
      )}
    </section>
  );
}
