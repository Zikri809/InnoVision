import { OptionCard } from "@/components/quiz/option-card";
import type { AnswerState } from "@/components/quiz/play-client";
import type { HoldProgress } from "@/lib/gestures/types";

type Question = {
  id: string;
  order_index: number;
  type: "mcq" | "true_false";
  prompt: string;
  options: string[];
  created_at: string;
};

/**
 * Prompt + ordered option cards (A/B/C/D/E + finger glyphs). Click-first: each
 * option is a keyboard-focusable card; feedback states are driven by the
 * `answer` prop:
 *  - `answer` undefined → unanswered (selectable when `disabled` is false)
 *  - `answer.seeded` → previously answered on a resume: neutral "answered"
 *    chip (assessment) or correct/incorrect chip (practice) — WITHOUT the key
 *    or explanation (they're never stored on session_answers)
 *  - fresh answer → full practice feedback (correct/incorrect + correctIndex
 *    + explanation) or quiet "answered" chip (assessment)
 *
 * `holdProgress` (P6) forwards the 0..1 hold completion to the matching
 * OptionCard (finger === `i + 1`); other options show no bar.
 */
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
  const letters = ["A", "B", "C", "D", "E"];

  return (
    <section aria-labelledby="question-prompt">
      <div className="mb-2 flex items-center justify-between">
        <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {question.type === "mcq" ? "Multiple choice" : "True / False"}
        </span>
        {answer && (
          <span
            className={`rounded px-2 py-0.5 text-xs ${
              mode === "practice"
                ? answer.isCorrect
                  ? "bg-emerald-100 text-emerald-800"
                  : "bg-destructive/10 text-destructive"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {mode === "practice"
              ? answer.isCorrect
                ? "Correct"
                : "Incorrect"
              : "Answered"}
          </span>
        )}
      </div>

      <h2 id="question-prompt" className="mb-4 text-lg font-medium">
        {question.prompt}
      </h2>

      <ul className="space-y-2">
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
                text={opt}
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
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900" role="status">
          <strong>Explanation:</strong> {answer.explanation}
        </div>
      )}
    </section>
  );
}
