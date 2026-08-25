"use client";

import { useLocale, useTranslations } from "next-intl";
import { OptionCard } from "@/components/quiz/option-card";
import { QuestionImage } from "@/components/media/question-image";
import type { AnswerState } from "@/components/quiz/play-client";
import type { HoldProgress } from "@/lib/gestures/types";

type Question = {
  id: string;
  order_index: number;
  type: "mcq" | "true_false";
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
}: {
  question: Question;
  answer: AnswerState | undefined;
  mode: "practice" | "assessment";
  disabled: boolean;
  holdProgress?: HoldProgress | null;
  onSelect: (index: number) => void;
}) {
  const locale = useLocale();
  const t = useTranslations("play");
  const tCommon = useTranslations("common");
  const letters = ["A", "B", "C", "D", "E"];

  function formatOptionText(text: string, type: "mcq" | "true_false"): string {
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
    <section aria-labelledby="question-prompt">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="rounded-full border-[3px] border-border bg-card px-3.5 py-1 text-xs font-extrabold text-muted-foreground">
          {question.type === "mcq" ? tCommon("mcq") : tCommon("trueFalse")}
        </span>
        {answer && (
          <span
            className={`rounded-full border-[3px] px-3.5 py-1 text-xs font-extrabold ${
              mode === "practice"
                ? answer.isCorrect
                  ? "border-emerald-300 bg-emerald-100 text-emerald-800"
                  : "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-border bg-muted text-muted-foreground"
            }`}
          >
            {mode === "practice"
              ? answer.isCorrect
                ? t("feedback.correct")
                : t("feedback.incorrect")
              : tCommon("completed")}
          </span>
        )}
      </div>

      <h2 id="question-prompt" className="mb-5 font-heading text-xl font-semibold leading-snug [text-wrap:balance] md:text-2xl">
        {question.prompt}
      </h2>

      {question.has_image && (
        <QuestionImage key={question.id} questionId={question.id} prompt={question.prompt} />
      )}

      <ul className="space-y-3">
        {question.options.map((opt, i) => {
          const selected = answer?.selectedIndex === i;
          const showCorrect = mode === "practice" && answer && !answer.seeded;
          const isCorrectOption = showCorrect && answer.correctIndex === i;
          const isWrongSelection =
            showCorrect && selected && answer.correctIndex !== i && !answer.isCorrect;
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

      {mode === "practice" && answer && !answer.seeded && answer.explanation && (
        <div className="mt-5 rounded-2xl border-[3px] border-emerald-300 bg-emerald-50 p-4 text-sm font-semibold text-emerald-900" role="status">
          <strong className="font-extrabold">{t("end.explanation")}</strong> {answer.explanation}
        </div>
      )}
    </section>
  );
}
