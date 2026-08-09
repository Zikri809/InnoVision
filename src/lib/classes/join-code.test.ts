import { describe, it, expect } from "vitest";
import {
  generateJoinCode,
  normalizeJoinCode,
  createClassWithRetry,
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
  JOIN_CODE_REGEX,
} from "@/lib/classes/join-code";

describe("generateJoinCode", () => {
  it("produces a code matching the format regex", () => {
    for (let i = 0; i < 1000; i++) {
      const code = generateJoinCode();
      expect(code).toMatch(JOIN_CODE_REGEX);
      expect(code).toHaveLength(JOIN_CODE_LENGTH);
    }
  });

  it("only uses characters from the alphabet", () => {
    for (let i = 0; i < 1000; i++) {
      const code = generateJoinCode();
      for (const ch of code) {
        expect(JOIN_CODE_ALPHABET).toContain(ch);
      }
    }
    // Alphabet excludes the ambiguous 0/O/1/I (L is retained to match the DB CHECK).
    expect(JOIN_CODE_ALPHABET).not.toMatch(/[0O1I]/);
  });

  it("is deterministic with an injected RNG", () => {
    // rng always returns 0 → first char of alphabet repeated
    const code = generateJoinCode(() => 0);
    expect(code).toBe("AAAAAA");
  });

  it("maps an injected RNG index to an expected code", () => {
    // rng returns 1 → second char of alphabet each time
    const code = generateJoinCode(() => 1);
    expect(code).toBe("BBBBBB");
  });

  it("does not collide over a 1000-code sample", () => {
    // Birthday bound: 1000² / (2·32⁶) ≈ 0.0005 expected collisions — safe.
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(generateJoinCode());
    }
    expect(seen.size).toBe(1000);
  });
});

describe("normalizeJoinCode", () => {
  it("trims and uppercases", () => {
    expect(normalizeJoinCode("  ab3x9k  ")).toBe("AB3X9K");
  });

  it("strips internal spaces and dashes", () => {
    expect(normalizeJoinCode("AB 3X-9K")).toBe("AB3X9K");
  });

  it("returns null for invalid characters", () => {
    expect(normalizeJoinCode("ABC01!")).toBeNull(); // 0, 1, ! not allowed
  });

  it("returns null for wrong length", () => {
    expect(normalizeJoinCode("ABC")).toBeNull();
    expect(normalizeJoinCode("ABCDEFG")).toBeNull();
  });

  it("returns null for empty/whitespace/null/undefined", () => {
    expect(normalizeJoinCode("")).toBeNull();
    expect(normalizeJoinCode("   ")).toBeNull();
    expect(normalizeJoinCode(null)).toBeNull();
    expect(normalizeJoinCode(undefined)).toBeNull();
  });

  it("rejects ambiguous characters O and I", () => {
    expect(normalizeJoinCode("ABCOEF")).toBeNull();
    expect(normalizeJoinCode("ABCIEF")).toBeNull();
  });
});

describe("createClassWithRetry", () => {
  it("returns the class on first success", async () => {
    let calls = 0;
    const result = await createClassWithRetry(
      async (code) => {
        calls++;
        return { id: "c1", join_code: code };
      },
      { rng: () => 0 },
    );
    expect(result).toEqual({
      ok: true,
      class: { id: "c1", join_code: "AAAAAA" },
      attempts: 1,
    });
    expect(calls).toBe(1);
  });

  it("retries on collisions and succeeds", async () => {
    let insertCalls = 0;
    // First 12 rng invocations (attempts 1–2) → 0 (AAAAAA), then → 1 (BBBBBB).
    let rngCalls = 0;
    const rng = () => (rngCalls++ < 12 ? 0 : 1);

    const result = await createClassWithRetry(
      async (code) => {
        insertCalls++;
        if (code === "AAAAAA") return null; // simulated collision
        return { id: "c1", join_code: code };
      },
      { rng },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toBe(3);
      expect(result.class.join_code).toBe("BBBBBB");
    }
    expect(insertCalls).toBe(3);
  });

  it("returns typed collision error after max attempts", async () => {
    let calls = 0;
    const result = await createClassWithRetry(async () => {
      calls++;
      return null; // always collides
    });
    expect(result).toEqual({ ok: false, error: "join_code_collision" });
    expect(calls).toBe(3);
  });

  it("respects a custom maxAttempts", async () => {
    let calls = 0;
    const result = await createClassWithRetry(
      async () => {
        calls++;
        return null;
      },
      { maxAttempts: 5 },
    );
    expect(result.ok).toBe(false);
    expect(calls).toBe(5);
  });
});
