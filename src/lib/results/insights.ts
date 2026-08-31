/**
 * RA-2 — on-screen item analysis ("Question insights") for the results
 * dashboard.
 *
 * Pure model builder in the gradebook.ts precedent: reuses the EXPORT's own
 * primitives (`normalizeExportQuestions` + `computeDistributions` +
 * `summarizeQuestionStats`) fed the same representative-session policy, so
 * the dashboard section and the xlsx sheets 2–3 can NEVER disagree — there is
 * exactly one implementation of the distribution math (QT-1-aware: multi
 * attempts count each selection, one answered attempt per question).
 *
 * RSC wiring (results/page.tsx): read questions rows + `lecturer_answers_view`
 * (20k cap, mirroring the export route) alongside the existing reads, call
 * `buildExportModel`, then `buildQuestionInsights`, and pass the serializable
 * output down as a separate prop — `ResultsSessionRow` must never widen with
 * key/explanation fields (types.ts security comment).
 */
import {
  buildExportModel,
  summarizeQuestionStats,
  type BuildExportInput,
  type ExportModel,
} from "./export";

/** % correct below which a question is flagged as a teaching gap (RA-2). */
export const LOW_CORRECT_THRESHOLD = 30;

export type QuestionInsight = {
  /** 1-based presentation position. */
  index: number;
  prompt: string;
  type: string;
  options: string[];
  correctIndex: number | null;
  correctIndices: number[] | null;
  /** Answered attempts of representative sessions (excluded: blanks). */
  timesAnswered: number;
  timesCorrect: number;
  percentCorrect: number;
  /** Per-option pick stats among answered attempts (export sheet 3 mirror). */
  distribution: ExportModel["distribution"][number];
  /** RA-2 "needs a re-teach" hint: <30% correct. */
  lowCorrect: boolean;
  /** RA-2 hint: at least one wrong option the class NEVER picked. */
  hasNeverPickedDistractor: boolean;
};

export type QuestionInsightsModel = {
  questions: QuestionInsight[];
  /** True when any hint applies (drives the section's summary line). */
  hasDegenerate: boolean;
};

/**
 * Derive the serializable item-analysis model from the SAME inputs the export
 * route feeds `buildExportModel`. `buildInput` must already carry the
 * representative-session policy via its `sessions` feed order
 * (started_at DESC, id DESC — the export route's read shape).
 */
export function buildQuestionInsights(
  buildInput: Omit<BuildExportInput, "nowMs" | "generatedAtISO"> & {
    nowMs: number;
    generatedAtISO: string;
  },
): QuestionInsightsModel {
  const model = buildExportModel(buildInput);
  const stats = summarizeQuestionStats(model);

  const questions: QuestionInsight[] = model.questions.map((q, qi) => {
    const s = stats[qi];
    const distribution = model.distribution[qi] ?? [];
    // A distractor is "never picked" when it is wrong (not on the key), the
    // question was answered at least once, and its chosenCount is 0.
    const keySet = new Set<number>([
      ...(q.correctIndices ?? (q.correctIndex != null ? [q.correctIndex] : [])),
    ]);
    const hasNeverPickedDistractor =
      s.timesAnswered > 0 &&
      q.options.length > 0 &&
      q.options.some(
        (_, oi) => !keySet.has(oi) && (distribution[oi]?.chosenCount ?? 0) === 0,
      );
    return {
      index: q.index,
      prompt: q.prompt,
      type: q.type,
      options: q.options,
      correctIndex: q.correctIndex,
      correctIndices: q.correctIndices,
      timesAnswered: s.timesAnswered,
      timesCorrect: s.timesCorrect,
      percentCorrect: s.percentCorrect,
      distribution,
      lowCorrect: s.timesAnswered > 0 && s.percentCorrect < LOW_CORRECT_THRESHOLD,
      hasNeverPickedDistractor,
    };
  });

  return {
    questions,
    hasDegenerate: questions.some((q) => q.lowCorrect || q.hasNeverPickedDistractor),
  };
}
