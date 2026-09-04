import { z } from "zod";

/**
 * Zod schemas for the face API surface (InsightFace migration; shape from the Phase 7 plan).
 *
 * InsightFace migration: the wire payload is a base64 JPEG FRAME, not a 192-dim
 * embedding. `frameSchema` is the single contract owner — a non-empty string
 * capped at `MAX_FRAME_BASE64_CHARS` (~150 KB; the route returns 413 on
 * overflow). Both the enroll and verify routes validate through it.
 */

export const frameSchema = z
  .string("Frame must be a base64 image string.")
  .min(1, "Frame must not be empty.");
// NOTE: no `.max()` here — an oversized frame is rejected by the ROUTE with
// 413 (payloadTooLarge), not a 400 Zod error. A Zod max would fire first and
// the explicit 413 check (L21 DoS guard) would be unreachable.

/** Enrollment: exactly one frame per guided angle (front/left/right). */
export const EnrollSchema = z.object({
  frames: z.array(frameSchema).length(3, "Enrollment requires exactly 3 frames (front, left, right)."),
});

export type EnrollInput = z.infer<typeof EnrollSchema>;

/**
 * Verify frames — each entry allows the EMPTY string as the client's
 * "no face captured" sentinel for that capture slot. The verify route skips
 * the sidecar for empty frames (a fail vote) and passes the rest to the
 * sidecar; the RPC records ONE row whose verdict is the strict majority
 * of per-frame baseline similarities ≥ 0.5. Enrollment frames stay non-empty
 * via `frameSchema`.
 */
export const verifyFrameSchema = z.string("Frame must be a base64 image string.");

export const VerifySchema = z.object({
  sessionId: z.string().uuid("sessionId must be a valid UUID."),
  frames: z
    .array(verifyFrameSchema)
    .min(1, "At least one frame is required.")
    .max(3, "At most 3 frames per check."),
  trigger: z.enum(["start", "question", "periodic"], {
    message: "trigger must be start, question, or periodic.",
  }),
  nonce: z.string().uuid("nonce must be a valid UUID."),
});

export type VerifyInput = z.infer<typeof VerifySchema>;

/** Shared UUID param schema for face routes that take a session id. */
export const SessionIdSchema = z.object({
  sessionId: z.string().uuid("sessionId must be a valid UUID."),
});

export type SessionIdInput = z.infer<typeof SessionIdSchema>;

export const ExemptSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "A reason is required to exempt a session.")
    .max(500, "Reason must be at most 500 characters."),
});

export type ExemptInput = z.infer<typeof ExemptSchema>;

export const ConsentSchema = z.object({
  consent: z.boolean("consent must be a boolean."),
});

export type ConsentInput = z.infer<typeof ConsentSchema>;