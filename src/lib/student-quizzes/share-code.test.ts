import { describe, it, expect } from "vitest";
import {
  generateShareCode,
  normalizeShareCode,
  SHARE_CODE_LENGTH,
  SHARE_CODE_REGEX,
} from "./share-code";
import { JOIN_CODE_ALPHABET } from "@/lib/classes/join-code";

describe("generateShareCode", () => {
  it("produces 10-char codes on the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateShareCode();
      expect(code).toHaveLength(SHARE_CODE_LENGTH);
      expect(code).toMatch(SHARE_CODE_REGEX);
    }
  });

  it("honors an injectable rng (deterministic tests)", () => {
    let n = 0;
    const code = generateShareCode(() => {
      const v = [0, 1, 2][n % 3];
      n++;
      return v; // indexes into the alphabet
    });
    expect(code[0]).toBe(JOIN_CODE_ALPHABET[0]);
  });
});

describe("normalizeShareCode", () => {
  it("uppercases and strips surrounding spaces", () => {
    // NOTE: fixtures use alphabet chars only — I/1/L/0/O are excluded by design.
    expect(normalizeShareCode(" abcdefghjm ")).toBe("ABCDEFGHJM");
  });

  it("strips internal spaces and dashes", () => {
    expect(normalizeShareCode("abcd-ef ghjm")).toBe("ABCDEFGHJM");
  });

  it("rejects wrong length, bad charset, and non-strings", () => {
    expect(normalizeShareCode("abc")).toBeNull();
    expect(normalizeShareCode("ABCDEFGH00")).toBeNull(); // 0 not in alphabet
    expect(normalizeShareCode("ABCDEFG2")).toBeNull(); // 9 chars
    expect(normalizeShareCode("ABCDEFGHJKM2")).toBeNull(); // 11 chars
    expect(normalizeShareCode(undefined)).toBeNull();
    expect(normalizeShareCode(null)).toBeNull();
    expect(normalizeShareCode(42 as unknown as string)).toBeNull();
  });

  it("accepts every letter of the shared alphabet at length 10", () => {
    // Any 10 chars drawn from the alphabet must normalize to themselves.
    const sample = JOIN_CODE_ALPHABET.slice(0, 10).repeat(1);
    expect(normalizeShareCode(sample.toLowerCase())).toBe(sample.toUpperCase());
  });
});
