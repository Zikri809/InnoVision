/**
 * Join-code helpers (pure, unit-testable).
 *
 * Alphabet: 32 chars, unambiguous — excludes 0/O, 1/I, and L (Crockford-like).
 * Codes are 6 chars → 32^6 ≈ 1.07 billion combinations; collision retry is a
 * cheap safety net rather than a probability requirement.
 */

export const JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const JOIN_CODE_LENGTH = 6;
export const JOIN_CODE_REGEX =
  /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

export interface Rng {
  (): number;
}

/**
 * Generate a join code. `rng` is injectable for deterministic tests; the
 * default uses crypto.getRandomValues with rejection sampling to avoid
 * modulo bias.
 */
export function generateJoinCode(rng?: Rng): string {
  const rand = rng ?? randomInt;
  const alphabetLength = JOIN_CODE_ALPHABET.length;
  let code = "";
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    code += JOIN_CODE_ALPHABET[rand() % alphabetLength];
  }
  return code;
}

function randomInt(): number {
  // crypto.getRandomValues returns a Uint32Array of uniform values.
  // Rejection sampling: 2^32 is not an exact multiple of the alphabet length,
  // so plain `% len` is biased. Re-roll when the value falls in the partial
  // final bucket. (For len=32, 2^32 % 32 == 0, so this is a no-op today, but
  // it keeps the helper correct if the alphabet length ever changes.)
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / JOIN_CODE_ALPHABET.length) * JOIN_CODE_ALPHABET.length;
  for (;;) {
    crypto.getRandomValues(buf);
    const value = buf[0] >>> 0;
    if (value < limit) return value;
  }
}

/**
 * Normalize a user-supplied join code: trim, uppercase, strip internal
 * spaces/dashes, then validate against the charset. Returns null when invalid
 * (length mismatch or disallowed characters) so callers can respond with a
 * generic "invalid code" message (no oracle on what was wrong).
 */
export function normalizeJoinCode(input: string | undefined | null): string | null {
  if (typeof input !== "string") return null;
  const cleaned = input.trim().toUpperCase().replace(/[\s-]/g, "");
  return JOIN_CODE_REGEX.test(cleaned) ? cleaned : null;
}

export type CreateClassResult<T> =
  | { ok: true; class: T; attempts: number }
  | { ok: false; error: "join_code_collision" };

/**
 * Insert a class with retry-on-collision.
 *
 * `insert(joinCode)` must perform `INSERT ... ON CONFLICT (join_code) DO
 * NOTHING RETURNING ...` and return the row, or null when the conflict won
 * (no exception — see the transaction-abort gotcha: a unique_violation raised
 * inside a transaction aborts the whole txn, so we rely on ON CONFLICT, never
 * catch-and-retry).
 *
 * Up to MAX_ATTEMPTS tries with fresh codes; returns the created class or a
 * typed `join_code_collision` error.
 */
export async function createClassWithRetry<T>(
  insert: (joinCode: string) => Promise<T | null>,
  opts?: { maxAttempts?: number; rng?: Rng },
): Promise<CreateClassResult<T>> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const code = generateJoinCode(opts?.rng);
    const created = await insert(code);
    if (created) return { ok: true, class: created, attempts: attempt };
  }
  return { ok: false, error: "join_code_collision" };
}
