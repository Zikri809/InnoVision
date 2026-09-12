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
 *
 * audit-2 M-19 (rotation grace): `LECTURER_INVITE_CODE_PREVIOUS` stays valid
 * for in-flight signups. Without it, rotating the code broke every email
 * confirmation still carrying `emailRedirectTo` from the old code's flow
 * (the confirm lands AFTER rotation and the promotion half had no code
 * anymore) — an indefinite-leak-vs-broken-signup corner the rotation runbook
 * now avoids: set PREVIOUS=old, CODE=new, drop PREVIOUS after the grace
 * window. Both comparisons are constant-time.
 */
export function isValidInviteCode(
  input: string | undefined | null,
  expected?: string,
  expectedPrevious?: string,
): boolean {
  const expectedCode = expected ?? process.env.LECTURER_INVITE_CODE;
  const previousCode =
    expectedPrevious ?? process.env.LECTURER_INVITE_CODE_PREVIOUS;

  if (!expectedCode || !input) return false;
  if (typeof input !== "string") return false;

  const a = createHash("sha256").update(input.trim(), "utf8").digest();

  if (matches(a, expectedCode)) return true;
  // The grace code is OPTIONAL — empty/missing means no grace window.
  if (previousCode && matches(a, previousCode)) return true;
  return false;
}

function matches(hashedInput: Buffer, expected: string): boolean {
  const b = createHash("sha256").update(expected.trim(), "utf8").digest();
  return timingSafeEqual(hashedInput, b);
}
