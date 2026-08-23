/**
 * Share-code helpers for student practice quizzes (pure, unit-testable).
 *
 * Same unambiguous alphabet as class join codes (join-code.ts) but LONGER:
 * 10 chars → 32^10 ≈ 2^50 combinations, so enumeration is infeasible even
 * unthrottled (join codes are 6 chars and rely on route rate limiting).
 */

import { JOIN_CODE_ALPHABET } from "@/lib/classes/join-code";

export const SHARE_CODE_LENGTH = 10;
export const SHARE_CODE_REGEX = new RegExp(
  `^[${JOIN_CODE_ALPHABET}]{${SHARE_CODE_LENGTH}}$`,
);

export interface Rng {
  (): number;
}

/** Generate a share code (crypto.getRandomValues + rejection sampling). */
export function generateShareCode(rng?: Rng): string {
  const rand = rng ?? randomInt;
  const alphabetLength = JOIN_CODE_ALPHABET.length;
  let code = "";
  for (let i = 0; i < SHARE_CODE_LENGTH; i++) {
    code += JOIN_CODE_ALPHABET[rand() % alphabetLength];
  }
  return code;
}

function randomInt(): number {
  // Rejection sampling keeps the draw uniform if the alphabet ever changes.
  const buf = new Uint32Array(1);
  const limit =
    Math.floor(0x1_0000_0000 / JOIN_CODE_ALPHABET.length) * JOIN_CODE_ALPHABET.length;
  for (;;) {
    crypto.getRandomValues(buf);
    const value = buf[0] >>> 0;
    if (value < limit) return value;
  }
}

/**
 * Normalize a user-supplied code: trim, uppercase, strip internal
 * spaces/dashes, then validate against the charset. Returns null when
 * invalid so callers can respond with a generic 400 BEFORE touching the DB.
 */
export function normalizeShareCode(input: string | undefined | null): string | null {
  if (typeof input !== "string") return null;
  const cleaned = input.trim().toUpperCase().replace(/[\s-]/g, "");
  return SHARE_CODE_REGEX.test(cleaned) ? cleaned : null;
}
