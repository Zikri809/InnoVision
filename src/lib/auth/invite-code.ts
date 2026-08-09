import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison for the lecturer invite code.
 *
 * `timingSafeEqual` throws on length mismatch, and a bare length check leaks a
 * length oracle, so both sides are first hashed (SHA-256) to fixed-length
 * buffers. Comparing hashes is constant-time regardless of the input length,
 * and the hash pre-image is the actual secret — the compare never touches the
 * raw values. An empty/missing expected code means lecturer self-signup is
 * disabled entirely (fail closed).
 */
export function isValidInviteCode(
  input: string | undefined | null,
  expected?: string,
): boolean {
  const expectedCode = expected ?? process.env.LECTURER_INVITE_CODE;

  if (!expectedCode || !input) return false;
  if (typeof input !== "string") return false;

  const a = createHash("sha256").update(input.trim(), "utf8").digest();
  const b = createHash("sha256").update(expectedCode.trim(), "utf8").digest();

  return timingSafeEqual(a, b);
}
