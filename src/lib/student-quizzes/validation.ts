import { z } from "zod";
import { stripBidiControls } from "@/lib/quizzes/validation";

/**
 * Zod schemas for the student practice-quiz API surface
 * (PLAN_STUDENT_PRACTICE_QUIZZES §4).
 *
 * Question shape reuses the lecturer constants/schemas verbatim from
 * `src/lib/quizzes/validation.ts` so both tables stay in lockstep with one
 * set of limits (title ≤200, prompt ≤2000, options 2–5 × ≤500 distinct
 * trimmed, explanation ≤2000). Practice-only by construction: no mode, no
 * time limit, no status here.
 *
 * Title sanitization strips bidi-override / zero-width characters
 * (homoglyph spoofing defense for shared UGC titles) — the shared
 * `stripBidiControls` lives in the lecturer validation module.
 */

// Re-exported so existing imports (and tests) keep working.
export { stripBidiControls };

const SanitizedTitleSchema = z
  .string()
  .transform(stripBidiControls)
  .pipe(
    z
      .string()
      .trim()
      .min(1, "Title is required.")
      .max(200, "Title must be at most 200 characters."),
  );

const SanitizedDescriptionSchema = z
  .string()
  .transform(stripBidiControls)
  .pipe(z.string().trim().max(500, "Description must be at most 500 characters."));

export const CreateStudentQuizSchema = z.object({
  title: SanitizedTitleSchema,
  description: SanitizedDescriptionSchema.nullable().optional(),
});

export type CreateStudentQuizInput = z.infer<typeof CreateStudentQuizSchema>;

export const UpdateStudentQuizSchema = z
  .object({
    title: SanitizedTitleSchema.optional(),
    description: SanitizedDescriptionSchema.nullable().optional(),
    /**
     * Share actions are explicit and EXCLUSIVE of content edits:
     *  - "share" mints a fresh code (idempotent: returns the current code if
     *    already shared).
     *  - "unshare" nulls the code — every existing link stops working.
     *  - "regenerate" rotates the code; old links die (gated server-side on
     *    currently-shared).
     */
    action: z.enum(["share", "unshare", "regenerate"]).optional(),
  })
  .refine((v) => v.title !== undefined || v.description !== undefined || v.action !== undefined, {
    message: "Nothing to update.",
  })
  // Exclusive payloads: mixing an action with content edits would silently
  // DROP the content edit (the route returns early in action branches).
  .refine((v) => !(v.action && (v.title !== undefined || v.description !== undefined)), {
    message: "Share actions cannot be combined with content edits.",
  });

export type UpdateStudentQuizInput = z.infer<typeof UpdateStudentQuizSchema>;

export type { QuestionInput } from "@/lib/quizzes/validation";
