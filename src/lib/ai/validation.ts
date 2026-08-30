import { z } from "zod";
import {
  AI_INSTRUCTION_MAX,
  AI_QUESTIONS_MAX,
  AI_QUESTIONS_MIN,
} from "@/lib/ai/quiz-schema";
import { MAX_AGGREGATE_CHARS } from "@/lib/extract/types";

/**
 * Zod schemas for AI quiz generation routes.
 */

// Storage path shape: `<uuid>/<uuid>/<file-with-dots>[/<file-with-dots>]*`
//   - segments: letters/digits/underscore/hyphen, optionally with internal dots
//     (e.g. `chapter.2024.notes.pdf`) — but never `.`/`..` as the whole
//     segment (traversal), and never `//`.
//   - The literal `..` substring + the canonical-normalize refine are
//     belt-and-suspenders: even if the regex ever changes, traversal is
//     rejected at the refine layer.
const SEGMENT = String.raw`[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*`;
const SOURCE_PATH_REGEX = new RegExp(
  `^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}/${SEGMENT}(?:/${SEGMENT})*$`,
);

export const QuizDifficultySchema = z
  .enum(["easy", "medium", "hard", "mixed"])
  .default("mixed");
export type QuizDifficulty = z.infer<typeof QuizDifficultySchema>;

export const QuestionFormatDistributionSchema = z
  .enum(["mixed", "mcq_only", "true_false_only"])
  .default("mixed");
export type QuestionFormatDistribution = z.infer<
  typeof QuestionFormatDistributionSchema
>;

export const QuizGenerationModeSchema = z
  .enum(["replace", "append"])
  .default("replace");
export type QuizGenerationMode = z.infer<typeof QuizGenerationModeSchema>;

export const sourcePathSchema = z
  .string()
  .regex(SOURCE_PATH_REGEX, "sourcePath is not a valid storage path.")
  .max(512, "sourcePath is too long.")
  .refine((p) => !p.includes(".."), "sourcePath contains a parent-directory reference.")
  .refine((p) => !p.includes("//"), "sourcePath contains an empty segment.")
  .refine(
    (p) => normalizePath(p) === p,
    "sourcePath is not a canonical storage path.",
  );

export const GenerateQuizSchema = z.object({
  quizId: z.string().uuid("quizId must be a valid UUID."),
  mode: QuizGenerationModeSchema.optional().default("replace"),
  extractedText: z
    .string()
    .max(MAX_AGGREGATE_CHARS, `Extracted text exceeds the maximum cap of ${MAX_AGGREGATE_CHARS} characters.`)
    .optional(),
  sourcePath: sourcePathSchema.optional(),
  sourcePaths: z
    .array(sourcePathSchema)
    .min(1, "Provide at least one source path.")
    .max(5, "Maximum 5 source files allowed per generation.")
    .optional(),
  questionCount: z
    .number()
    .int()
    .min(AI_QUESTIONS_MIN)
    .max(AI_QUESTIONS_MAX)
    .optional(),
  difficulty: QuizDifficultySchema.optional().default("mixed"),
  formatDistribution: QuestionFormatDistributionSchema.optional().default("mixed"),
  /**
   * QT-1 opt-in (default false): when true, the mixed distribution may
   * include multi_select questions. Deliberately ABSENT from
   * GenerateStudentQuizSchema (below) — the student path inherits the
   * lib-level default-false and can never emit multi rows.
   */
  allowMultiSelect: z.boolean().optional().default(false),
  steeringPrompt: z
    .string()
    .trim()
    .max(AI_INSTRUCTION_MAX, `Steering prompt must be at most ${AI_INSTRUCTION_MAX} characters.`)
    .optional(),
  language: z.enum(["en", "ms", "auto"]).optional().default("auto"),
});

export type GenerateQuizInput = z.infer<typeof GenerateQuizSchema>;

/**
 * Student practice-quiz generation body (POST /api/student-quizzes/[id]/generate).
 * Differences from the lecturer contract (deliberate):
 *  - NO quizId in the body — the quiz comes from the URL param.
 *  - NO steeringPrompt / formatDistribution / mode controls (plan §5: student
 *    mode hides steering + format mix; generation is always replace-or-append
 *    decided by the route's save call).
 * questionCount stays within the shared AI bounds; sourcePath(s) reuse the
 * same two-UUID-segment tenant contract (`${uid}/${quizId}/file`).
 */
export const GenerateStudentQuizSchema = z.object({
  extractedText: z
    .string()
    .max(MAX_AGGREGATE_CHARS, `Extracted text exceeds the maximum cap of ${MAX_AGGREGATE_CHARS} characters.`)
    .optional(),
  sourcePaths: z
    .array(sourcePathSchema)
    .min(1, "Provide at least one source path.")
    .max(5, "Maximum 5 source files allowed per generation.")
    .optional(),
  questionCount: z
    .number()
    .int()
    .min(AI_QUESTIONS_MIN)
    .max(AI_QUESTIONS_MAX)
    .optional(),
  difficulty: QuizDifficultySchema.optional().default("mixed"),
  language: z.enum(["en", "ms", "auto"]).optional().default("auto"),
}).strict();

export type GenerateStudentQuizInput = z.infer<typeof GenerateStudentQuizSchema>;

/** Daily AI-generation budget per user (DB-side cost guard, plan D7). */
export const STUDENT_AI_DAILY_LIMIT = 20;

export const RegenerateQuestionSchema = z.object({
  questionId: z.string().uuid("questionId must be a valid UUID."),
  instruction: z
    .string()
    .max(AI_INSTRUCTION_MAX, `Instruction must be at most ${AI_INSTRUCTION_MAX} characters.`)
    .optional(),
});

export type RegenerateQuestionInput = z.infer<typeof RegenerateQuestionSchema>;

/**
 * POSIX-style path normalizer for the sourcePath validator. Resolves `.`
 * and `..` segments against forward-slash separators.
 *
 * Returns the normalized form with the SAME shape as the input (preserves a
 * leading slash if present). Returns an empty string for a path that
 * resolves to nothing (caller decides what that means).
 */
export function normalizePath(p: string): string {
  const leadingSlash = p.startsWith("/");
  const parts = p.split("/");
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("/");
  return (leadingSlash ? "/" : "") + joined;
}
