import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_GLM_DAILY_TOKEN_CAP,
  DEFAULT_GLM_TOKEN_PRICE_PER_MILLION,
  GLM_SPEND_RETAINED_DAYS,
  _resetGlmSpendForTests,
  checkGlmSpend,
  glmCostUsd,
  glmDailyTokenCap,
  glmSpendCalls,
  glmSpendUsed,
  glmSpendUsedUsd,
  glmTokenPricePerMillion,
  recordGlmSpend,
  utcDayKey,
} from "@/lib/ai/glm-spend";

/**
 * glm-spend — the durable per-user daily token governor (gate G8).
 *
 * Every test points `_resetGlmSpendForTests(path)` at a REAL temp file, so the
 * durability claims (persistence across a "process restart" = module reset,
 * pruning, corrupt-file recovery) are exercised against the filesystem rather
 * than a mock. The ledger is the only thing standing between a runaway deck
 * and an uncapped bill on a shared key.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const OTHER_USER = "00000000-0000-4000-8000-00000000000b";

let dir: string;
let ledgerPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "glm-spend-"));
  ledgerPath = join(dir, "ledger.json");
  _resetGlmSpendForTests(ledgerPath);
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  _resetGlmSpendForTests(null);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can hold a handle briefly; the temp dir is disposable.
  }
});

/** Record a call, keeping the test bodies short. */
function record(userId: string, totalTokens: number, overrides: Record<string, unknown> = {}) {
  recordGlmSpend({
    userId,
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    totalTokens,
    pages: 3,
    provider: "remote",
    model: "glm-ocr",
    ...overrides,
  });
}

describe("checkGlmSpend — the gate", () => {
  it("allows the first call of the day and reports the used/cap pair", () => {
    const d = checkGlmSpend(USER);
    expect(d.allowed).toBe(true);
    expect(d.usedTokens).toBe(0);
    expect(d.capTokens).toBe(DEFAULT_GLM_DAILY_TOKEN_CAP);
  });

  it("refuses with reason 'cap' once today's tokens reach the cap", () => {
    vi.stubEnv("GLM_DAILY_TOKEN_CAP", "1000");
    record(USER, 600);
    expect(checkGlmSpend(USER).allowed).toBe(true);
    record(USER, 400);
    const d = checkGlmSpend(USER);
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toBe("cap");
      expect(d.usedTokens).toBe(1000);
      expect(d.capTokens).toBe(1000);
    }
  });

  it("refuses an OVER-cap user even when the last call overshot (no negative headroom)", () => {
    vi.stubEnv("GLM_DAILY_TOKEN_CAP", "100");
    record(USER, 5_000);
    const d = checkGlmSpend(USER);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("cap");
  });

  it("isolates users from each other", () => {
    vi.stubEnv("GLM_DAILY_TOKEN_CAP", "100");
    record(USER, 100);
    expect(checkGlmSpend(USER).allowed).toBe(false);
    expect(checkGlmSpend(OTHER_USER).allowed).toBe(true);
  });

  it("refuses EVERY call with reason 'disabled' when GLM_SPEND_DISABLED=1", () => {
    vi.stubEnv("GLM_SPEND_DISABLED", "1");
    const d = checkGlmSpend(USER);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("disabled");
  });

  it("treats only the literal '1' as disabled (any other value keeps spending enabled)", () => {
    for (const value of ["0", "true", "yes", "", " 1 "]) {
      vi.stubEnv("GLM_SPEND_DISABLED", value);
      expect(checkGlmSpend(USER).allowed).toBe(true);
    }
  });

  it("falls back to the documented cap for garbage env values", () => {
    for (const bad of ["abc", "0", "-5", "1.5", ""]) {
      vi.stubEnv("GLM_DAILY_TOKEN_CAP", bad);
      expect(glmDailyTokenCap()).toBe(DEFAULT_GLM_DAILY_TOKEN_CAP);
    }
    vi.stubEnv("GLM_DAILY_TOKEN_CAP", "12345");
    expect(glmDailyTokenCap()).toBe(12345);
  });

  it("falls back to the documented price for garbage, and accepts 0 as a price", () => {
    for (const bad of ["abc", "-1", ""]) {
      vi.stubEnv("GLM_TOKEN_PRICE_PER_MILLION", bad);
      expect(glmTokenPricePerMillion()).toBe(DEFAULT_GLM_TOKEN_PRICE_PER_MILLION);
    }
    vi.stubEnv("GLM_TOKEN_PRICE_PER_MILLION", "0");
    expect(glmTokenPricePerMillion()).toBe(0);
  });
});

describe("recordGlmSpend — accounting + durability", () => {
  it("accumulates tokens, cost and call count for the day", () => {
    vi.stubEnv("GLM_TOKEN_PRICE_PER_MILLION", "1");
    record(USER, 1_000_000);
    record(USER, 500_000);
    expect(glmSpendUsed(USER)).toBe(1_500_000);
    expect(glmSpendUsedUsd(USER)).toBeCloseTo(1.5, 6);
    expect(glmSpendCalls(USER)).toBe(2);
  });

  it("computes cost as tokens/1e6 × price (contract §3.5)", () => {
    vi.stubEnv("GLM_TOKEN_PRICE_PER_MILLION", "0.03");
    expect(glmCostUsd(2_000_000)).toBeCloseTo(0.06, 9);
    expect(glmCostUsd(0)).toBe(0);
  });

  it("treats a non-finite token count as 0 (never NaN in the ledger)", () => {
    record(USER, Number.NaN);
    expect(glmSpendUsed(USER)).toBe(0);
    expect(glmSpendUsedUsd(USER)).toBe(0);
    expect(glmSpendCalls(USER)).toBe(1);
  });

  it("writes the ledger to disk on every record", () => {
    record(USER, 42);
    const onDisk = JSON.parse(readFileSync(ledgerPath, "utf8"));
    expect(onDisk[utcDayKey()][USER]).toEqual({
      tokens: 42,
      usd: expect.any(Number),
      calls: 1,
    });
  });

  it("SURVIVES a module reset (the process-restart / crash-loop case)", () => {
    record(USER, 7_000);
    // Simulate a fresh process: drop the in-process cache, keep the file.
    _resetGlmSpendForTests(ledgerPath);
    expect(glmSpendUsed(USER)).toBe(7_000);
    expect(glmSpendCalls(USER)).toBe(1);
    // ...and the cap still binds across the restart.
    vi.stubEnv("GLM_DAILY_TOKEN_CAP", "7000");
    expect(checkGlmSpend(USER).allowed).toBe(false);
  });

  it("keeps counting across MANY records without re-reading the file each time", () => {
    // 50 records: the read-through cache means one parse, not 50.
    for (let i = 0; i < 50; i++) record(USER, 10);
    expect(glmSpendUsed(USER)).toBe(500);
    expect(glmSpendCalls(USER)).toBe(50);
    const onDisk = JSON.parse(readFileSync(ledgerPath, "utf8"));
    expect(onDisk[utcDayKey()][USER].tokens).toBe(500);
  });

  it("creates the parent directory when it does not exist", () => {
    const nested = join(dir, "a", "b", "ledger.json");
    _resetGlmSpendForTests(nested);
    record(USER, 5);
    expect(existsSync(nested)).toBe(true);
    expect(glmSpendUsed(USER)).toBe(5);
  });
});

describe("day bucketing + pruning", () => {
  it("buckets by UTC day (utcDayKey is the ISO date)", () => {
    expect(utcDayKey(Date.UTC(2026, 8, 14, 23, 59, 59))).toBe("2026-09-14");
    expect(utcDayKey(Date.UTC(2026, 8, 15, 0, 0, 0))).toBe("2026-09-15");
  });

  it("prunes to the last GLM_SPEND_RETAINED_DAYS buckets on write", () => {
    // Seed 12 day buckets (3 more than the retention window) with a user entry.
    const seeded: Record<string, Record<string, { tokens: number; usd: number; calls: number }>> = {};
    for (let i = 0; i < 12; i++) {
      const day = utcDayKey(Date.now() - i * 86_400_000);
      seeded[day] = { [OTHER_USER]: { tokens: 1, usd: 0, calls: 1 } };
    }
    writeFileSync(ledgerPath, JSON.stringify(seeded), "utf8");
    _resetGlmSpendForTests(ledgerPath);

    // Any record triggers the prune + rewrite.
    record(USER, 1);

    const onDisk = JSON.parse(readFileSync(ledgerPath, "utf8")) as Record<string, unknown>;
    const days = Object.keys(onDisk).sort();
    expect(days.length).toBeLessThanOrEqual(GLM_SPEND_RETAINED_DAYS);
    // The newest bucket (today) survives and carries the new record.
    expect(days).toContain(utcDayKey());
    // The oldest seeded bucket is gone.
    expect(days).not.toContain(utcDayKey(Date.now() - 11 * 86_400_000));
  });

  it("drops malformed day keys instead of carrying them forever", () => {
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        "not-a-day": { [USER]: { tokens: 999, usd: 0, calls: 1 } },
        [utcDayKey()]: { [USER]: { tokens: 5, usd: 0, calls: 1 } },
      }),
      "utf8",
    );
    _resetGlmSpendForTests(ledgerPath);
    record(USER, 1);
    const onDisk = JSON.parse(readFileSync(ledgerPath, "utf8"));
    expect(Object.keys(onDisk)).toEqual([utcDayKey()]);
    expect(glmSpendUsed(USER)).toBe(6);
  });

  it("keeps today's spend out of YESTERDAY's bucket (the daily reset)", () => {
    const yesterday = utcDayKey(Date.now() - 86_400_000);
    writeFileSync(
      ledgerPath,
      JSON.stringify({ [yesterday]: { [USER]: { tokens: 999_999, usd: 1, calls: 9 } } }),
      "utf8",
    );
    _resetGlmSpendForTests(ledgerPath);
    // A fresh UTC day starts from zero even though yesterday is retained.
    expect(glmSpendUsed(USER)).toBe(0);
    expect(checkGlmSpend(USER).allowed).toBe(true);
    // Yesterday's bucket is still on disk (diagnostics), just not today's count.
    record(USER, 10);
    const onDisk = JSON.parse(readFileSync(ledgerPath, "utf8"));
    expect(onDisk[yesterday][USER].tokens).toBe(999_999);
    expect(onDisk[utcDayKey()][USER].tokens).toBe(10);
  });
});

/**
 * Defects #2 + #3 — the ledger's INNER shapes.
 *
 * Validating only the ROOT object was proven insufficient. Each case below is
 * a shape the critic measured on disk: `{"<today>":null}` billed upstream once
 * and then threw `TypeError: Cannot read properties of null` OUT of the route
 * (the paid-for markdown was lost and the spend was never recorded);
 * `{"<today>":7}` threw `Cannot create property … on number`; and a
 * `{tokens:null}` entry made `undefined + tokens = NaN`, after which
 * `NaN >= cap` is `false` FOREVER — the cap silently stopped binding and the
 * file was rewritten with `"tokens":null`, discarding the day's accumulation.
 *
 * The invariant asserted throughout: NO throw escapes, the spend is STILL
 * counted, and the cap STILL binds.
 */
describe("shape-corrupt ledger — repair-or-discard, never throw (defects #2/#3)", () => {
  const corruptions: [string, string][] = [
    ["a null day bucket", JSON.stringify({ [utcDayKey()]: null })],
    ["a numeric day bucket", JSON.stringify({ [utcDayKey()]: 7 })],
    ["a string day bucket", JSON.stringify({ [utcDayKey()]: "oops" })],
    ["an array day bucket", JSON.stringify({ [utcDayKey()]: [1, 2, 3] })],
    ["a string user entry", JSON.stringify({ [utcDayKey()]: { [USER]: "oops" } })],
    ["a null user entry", JSON.stringify({ [utcDayKey()]: { [USER]: null } })],
    ["a null tokens field", JSON.stringify({ [utcDayKey()]: { [USER]: { tokens: null } } })],
    ["a missing tokens field", JSON.stringify({ [utcDayKey()]: { [USER]: { usd: 1, calls: 2 } } })],
    ["a string tokens field", JSON.stringify({ [utcDayKey()]: { [USER]: { tokens: "many" } } })],
    ["a NaN-shaped tokens field", JSON.stringify({ [utcDayKey()]: { [USER]: { tokens: null, usd: null, calls: null } } })],
    ["a negative tokens field", JSON.stringify({ [utcDayKey()]: { [USER]: { tokens: -5 } } })],
  ];

  it.each(corruptions)("does not throw and still counts the spend with %s", (_label, raw) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(ledgerPath, raw, "utf8");
    _resetGlmSpendForTests(ledgerPath);

    // The request path: read the count, then record — neither may throw.
    expect(() => glmSpendUsed(USER)).not.toThrow();
    expect(() => checkGlmSpend(USER)).not.toThrow();
    expect(() => record(USER, 25)).not.toThrow();

    // The spend is STILL counted (the extraction was paid for).
    expect(glmSpendUsed(USER)).toBe(25);
    // `calls` may be PRESERVED by the repair (a valid seeded count survives),
    // but it is always a finite integer ≥ 1 after the record.
    expect(glmSpendCalls(USER)).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(glmSpendCalls(USER))).toBe(true);
    // …and the repaired file carries a real number, not null/NaN.
    const onDisk = JSON.parse(readFileSync(ledgerPath, "utf8"));
    expect(onDisk[utcDayKey()][USER].tokens).toBe(25);
    expect(typeof onDisk[utcDayKey()][USER].tokens).toBe("number");
  });

  it("preserves a VALID calls count while repairing a bad tokens field", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(
      ledgerPath,
      JSON.stringify({ [utcDayKey()]: { [USER]: { tokens: null, usd: 1, calls: 2 } } }),
      "utf8",
    );
    _resetGlmSpendForTests(ledgerPath);
    expect(glmSpendCalls(USER)).toBe(2);
    record(USER, 25);
    expect(glmSpendCalls(USER)).toBe(3);
    // The tokens start from 0 (the corrupt value is dropped, not guessed) and
    // then accumulate honestly.
    expect(glmSpendUsed(USER)).toBe(25);
  });

  it("never returns NaN from glmSpendUsed, even with every field corrupted", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(
      ledgerPath,
      JSON.stringify({ [utcDayKey()]: { [USER]: { tokens: null, usd: "x", calls: {} } } }),
      "utf8",
    );
    _resetGlmSpendForTests(ledgerPath);
    expect(Number.isFinite(glmSpendUsed(USER))).toBe(true);
    expect(glmSpendUsed(USER)).toBe(0);
    expect(Number.isFinite(glmSpendUsedUsd(USER))).toBe(true);
    expect(Number.isFinite(glmSpendCalls(USER))).toBe(true);
  });

  // Defect #3's exact proof: `GLM_DAILY_TOKEN_CAP=1` with a corrupt entry
  // billed three consecutive POSTs and rewrote the file with `"tokens":null`.
  it("a corrupt prior entry cannot defeat a 1-token cap (three calls, then refused)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("GLM_DAILY_TOKEN_CAP", "1");
    writeFileSync(ledgerPath, JSON.stringify({ [utcDayKey()]: { [USER]: { tokens: null } } }), "utf8");
    _resetGlmSpendForTests(ledgerPath);

    // Call 1 is admitted (nothing counted yet), then records 300 tokens.
    expect(checkGlmSpend(USER).allowed).toBe(true);
    record(USER, 300);
    expect(glmSpendUsed(USER)).toBe(300);

    // Calls 2 and 3 MUST be refused — the cap binds.
    for (let i = 0; i < 2; i++) {
      const d = checkGlmSpend(USER);
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toBe("cap");
    }
    // The accumulation was NOT discarded by a corrupt write.
    expect(glmSpendUsed(USER)).toBe(300);
    expect(JSON.parse(readFileSync(ledgerPath, "utf8"))[utcDayKey()][USER].tokens).toBe(300);
  });

  it("a corrupt bucket does not lose the OTHER users' counts", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        [utcDayKey()]: {
          [OTHER_USER]: { tokens: 900, usd: 0.5, calls: 3 },
          [USER]: null,
        },
      }),
      "utf8",
    );
    _resetGlmSpendForTests(ledgerPath);
    expect(glmSpendUsed(OTHER_USER)).toBe(900);
    record(USER, 10);
    expect(glmSpendUsed(OTHER_USER)).toBe(900);
    expect(glmSpendUsed(USER)).toBe(10);
  });

  it("repairs a missing usd from the token count rather than dropping the entry", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("GLM_TOKEN_PRICE_PER_MILLION", "1");
    writeFileSync(
      ledgerPath,
      JSON.stringify({ [utcDayKey()]: { [USER]: { tokens: 1_000_000, calls: 1 } } }),
      "utf8",
    );
    _resetGlmSpendForTests(ledgerPath);
    // Tokens (the number the cap binds on) survive.
    expect(glmSpendUsed(USER)).toBe(1_000_000);
    expect(glmSpendUsedUsd(USER)).toBeCloseTo(1, 6);
  });
});

describe("IO failure posture — never crash the route", () => {
  it("starts empty + warns when the ledger holds INVALID JSON", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(ledgerPath, "{not json at all", "utf8");
    _resetGlmSpendForTests(ledgerPath);
    expect(glmSpendUsed(USER)).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("EMPTY ledger");
    // ...and the process keeps working: a record repairs the file.
    record(USER, 25);
    expect(glmSpendUsed(USER)).toBe(25);
    expect(JSON.parse(readFileSync(ledgerPath, "utf8"))[utcDayKey()][USER].tokens).toBe(25);
  });

  it("starts empty + warns when the ledger root is not an object", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(ledgerPath, "[1,2,3]", "utf8");
    _resetGlmSpendForTests(ledgerPath);
    expect(glmSpendUsed(USER)).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("treats a MISSING ledger as a cold start (no warn — that is the normal first run)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    _resetGlmSpendForTests(join(dir, "never-written.json"));
    expect(glmSpendUsed(USER)).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns ONCE (not per call) when the ledger cannot be written", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Point the ledger at a path whose parent is a FILE — mkdir/write must fail.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");
    _resetGlmSpendForTests(join(blocker, "ledger.json"));

    record(USER, 10);
    record(USER, 10);
    record(USER, 10);

    // The write failed, but the in-memory count is authoritative for this
    // process — the route keeps serving and the cap keeps binding.
    expect(glmSpendUsed(USER)).toBe(30);
    expect(glmSpendCalls(USER)).toBe(3);
    const writeWarns = warn.mock.calls.filter((c) => String(c[0]).includes("persist"));
    expect(writeWarns).toHaveLength(1);
  });

  it("still enforces the cap when the ledger is unreadable (in-memory authority)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(ledgerPath, "garbage", "utf8");
    _resetGlmSpendForTests(ledgerPath);
    vi.stubEnv("GLM_DAILY_TOKEN_CAP", "50");
    record(USER, 50);
    expect(checkGlmSpend(USER).allowed).toBe(false);
  });

  it("recovers from a read-only ledger file by keeping the in-memory count", () => {
    // A read-only file (chmod 0o444) makes the rename-over fail on POSIX;
    // on Windows chmod is advisory, so accept either outcome — the invariant
    // asserted is only that NO THROW escapes and the count is right.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(ledgerPath, "{}", "utf8");
    try {
      chmodSync(ledgerPath, 0o444);
    } catch {
      // ignore — not all platforms/filesystems support it
    }
    _resetGlmSpendForTests(ledgerPath);
    expect(() => record(USER, 77)).not.toThrow();
    expect(glmSpendUsed(USER)).toBe(77);
    void warn;
  });
});

describe("recordGlmSpend — redacted usage log (contract §3.5)", () => {
  it("logs requestId/userId/tokens/pages/cost/model and NEVER a key", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubEnv("GLM_TOKEN_PRICE_PER_MILLION", "0.03");
    recordGlmSpend({
      userId: USER,
      requestId: "req-abc",
      totalTokens: 1_000_000,
      pages: 12,
      provider: "remote",
      model: "glm-ocr",
      promptTokens: 400_000,
      completionTokens: 600_000,
      ms: 16_000,
    });

    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0][0]);
    expect(line).toContain("[glm-usage]");
    const payload = JSON.parse(line.slice(line.indexOf("{")));
    expect(payload).toMatchObject({
      requestId: "req-abc",
      userId: USER,
      provider: "remote",
      model: "glm-ocr",
      numPages: 12,
      promptTokens: 400_000,
      completionTokens: 600_000,
      totalTokens: 1_000_000,
      ms: 16_000,
    });
    expect(payload.costUsd).toBeCloseTo(0.03, 6);
  });

  it("logs nulls (not undefined) for the fields a minimal call omits", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    record(USER, 5, { pages: null });
    const line = String(info.mock.calls[0][0]);
    const payload = JSON.parse(line.slice(line.indexOf("{")));
    expect(payload.numPages).toBeNull();
    expect(payload.promptTokens).toBeNull();
    expect(payload.completionTokens).toBeNull();
    expect(payload.ms).toBeNull();
  });

  it("never writes key material into the ledger file", () => {
    vi.stubEnv("ZAI_API_KEY", "super-secret-key-value");
    record(USER, 10);
    const raw = readFileSync(ledgerPath, "utf8");
    expect(raw).not.toContain("super-secret-key-value");
    expect(raw).not.toContain("Bearer");
  });
});
