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
 *  - `sourcePath` matches a strict shape (no `.`/`..` segments, no `//`, no `%`,
 *    leading/trailing `/`) AND the route separately checks the first segment
 *    == caller uid. The regex drops `.` from the segment class (so `..`
 *    segments cannot slip through) and we additionally reject any literal
 *    `..` substring and any path whose POSIX-normalized form differs from the
 *    original (catches remaining bypass tricks).
 *  - `instruction` on regenerate is capped to bound prompt size.
 */

// Only letters, digits, underscores, hyphens, and dots that are NOT used for
// parent-dir traversal. The `.` is kept to support file extensions, but
// segments consisting only of `.` or `..` are explicitly rejected by the
// SUPER_REFINE check below.
const SOURCE_PATH_REGEX =
  /^[0-9a-fA-F-]{36}\/[0-9a-fA-F-]{36}\/[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*$/;

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
    .refine((p) => !p.includes(".."), "sourcePath contains a parent-directory reference.")
    .refine((p) => !p.includes("//"), "sourcePath contains an empty segment.")
    .refine(
      // POSIX-normalize the path and reject if it changes — catches any
      // remaining traversal trick (e.g. `./`, `../foo`, mixed slashes).
      // The normalizer prepends `/`; we compare against the same canonical
      // form so inputs without a leading slash still match.
      (p) => normalizePath(p) === normalizePath(p),
      "sourcePath is not a canonical storage path.",
    )
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
