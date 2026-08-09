/**
 * Compare a stored timestamptz value against an expected ISO timestamp.
 *
 * PostgREST serializes `timestamptz` as "...+00:00" while JS `toISOString()`
 * yields "...Z" — a direct string `===` never matches. Compare by epoch
 * milliseconds instead.
 *
 * @param stored The value read back from the DB (string | null).
 * @param expected An ISO-8601 string (e.g. from `new Date().toISOString()`).
 * @returns true when both parse to the same instant and stored is non-null.
 */
export function isSameTimestamp(
  stored: string | null | undefined,
  expected: string,
): boolean {
  if (stored == null) return false;
  const a = Date.parse(stored);
  const b = Date.parse(expected);
  return Number.isFinite(a) && a === b;
}
