import { z } from "zod";
import {
  AI_EXTRACTED_TEXT_MAX,
  AI_INSTRUCTION_MAX,
  AI_QUESTIONS_MAX,
  AI_QUESTIONS_MIN,
} from "@/lib/ai/quiz-schema";

/**
 * Zod schemas for the Phase 4 AI routes (PLAN_PHASE4 §Step 4).
 *
 * Boundary rules (from the P4 plan review):
 *  - `extractedText` is capped server-side at 15k (S2) — the client-side cap
 *    alone is not a security boundary.
 *  - `sourcePath` matches a strict shape (no `..`, `//`, `%`, leading/trailing
 *    `/`) AND the route separately checks the first segment == caller uid.
 *  - `instruction` on regenerate is capped to bound prompt size.
 */

const SOURCE_PATH_REGEX =
  /^[0-9a-fA-F-]{36}\/[0-9a-fA-F-]{36}\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export const GenerateQuizSchema = z.object({
  quizId: z.string().uuid("quizId must be a valid UUID."),
  extractedText: z
    .string()
    .max(AI_EXTRACTED_TEXT_MAX, `Extracted text must be at most ${AI_EXTRACTED_TEXT_MAX} characters.`)
    .optional(),
  sourcePath: z
    .string()
    .regex(SOURCE_PATH_REGEX, "sourcePath is not a valid storage path.")
    .max(512, "sourcePath is too long.")
    .optional(),
  questionCount: z
    .number()
    .int()
    .min(AI_QUESTIONS_MIN)
    .max(AI_QUESTIONS_MAX)
    .optional(),
});

export type GenerateQuizInput = z.infer<typeof GenerateQuizSchema>;

export const RegenerateQuestionSchema = z.object({
  questionId: z.string().uuid("questionId must be a valid UUID."),
  instruction: z
    .string()
    .max(AI_INSTRUCTION_MAX, `Instruction must be at most ${AI_INSTRUCTION_MAX} characters.`)
    .optional(),
});

export type RegenerateQuestionInput = z.infer<typeof RegenerateQuestionSchema>;

export const VisionOcrSchema = z.object({
  images: z
    .array(z.string().min(1, "Images must not be empty."))
    .min(1, "Provide at least one image.")
    .max(3, "Send at most 3 images per request."),
});

export type VisionOcrInput = z.infer<typeof VisionOcrSchema>;
