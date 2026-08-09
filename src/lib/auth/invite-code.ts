import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison for the lecturer invite code.
 *
 * `timingSafeEqual` throws on length mismatch, so we normalize both sides to
 * fixed-length buffers first. An empty/missing expected code means lecturer
 * self-signup is disabled entirely (fail closed).
 */
export function isValidInviteCode(
  input: string | undefined | null,
  expected?: string,
): boolean {
  const expectedCode = expected ?? process.env.LECTURER_INVITE_CODE;

  if (!expectedCode || !input) return false;
  if (typeof input !== "string") return false;

  const a = Buffer.from(input.trim());
  const b = Buffer.from(expectedCode.trim());
  if (a.length !== b.length || a.length === 0) return false;

  return timingSafeEqual(a, b);
}
