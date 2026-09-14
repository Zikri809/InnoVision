import "server-only";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GlmProvider } from "@/lib/ai/glm-provider";

/**
 * Durable per-user daily spend governor for the REMOTE GLM-OCR leg (gate G8).
 *
 * Why a file and not a Map: the remote leg bills a SHARED Z.ai key per token,
 * and the blast radius of a runaway deck (whole-doc retries × a 4096px canvas
 * that can tokenize 10× over estimate) is uncapped if the counter dies with the
 * process. A JSON ledger on disk survives restarts, so a crash-loop cannot
 * reset the day's spend.
 *
 * Ledger shape (`GLM_SPEND_LEDGER_PATH`, default `.glm-spend-ledger.json`):
 *   { "<utc-day>": { "<userId>": { tokens, usd, calls } } }
 *
 * RESIDUAL (documented, not a bug): the ledger is PER-HOST. Two app replicas
 * sharing one Z.ai key still double-spend, and the cap is enforced per process
 * against the file it can see. That is exactly why the deployment target is
 * single-instance (docs/DEPLOY_VPS.md); a shared store (Postgres/Redis) is the
 * upgrade path if the app is ever scaled horizontally.
 *
 * Failure posture (never crash the route): an unreadable/unparseable ledger
 * starts empty with a one-time warn, and a write failure warns and leaves the
 * in-memory count authoritative for this process. Both directions fail toward
 * "keep serving, keep counting" — the cap is a cost guard, not an authz gate.
 *
 * SHAPE REPAIR (defects #2 + #3): the ledger is attacker-adjacent and
 * hand-editable, so validating only the ROOT object was proven insufficient.
 * With `{"<today>":null}` on disk a remote POST billed upstream once and then
 * threw `TypeError: Cannot read properties of null` OUT of the route — the
 * paid-for markdown was lost and the spend was never recorded; `{"<today>":7}`
 * threw `Cannot create property … on number`. Worse, `{"<uid>":{}}` made
 * `undefined + tokens = NaN`, and `NaN >= cap` is `false` FOREVER — the cap
 * silently stopped binding and the file was rewritten with `"tokens":null`,
 * discarding the day's accumulation. Every inner shape is now validated and
 * repaired-or-discarded on load, and every number this module returns is
 * coerced through `finiteNonNegative` so NaN is structurally impossible.
 *
 * Secrets: the usage log line carries ids/numbers only. It never carries
 * `ZAI_API_KEY` (or any other key material).
 */

export type GlmSpendDecision =
  | { allowed: true; usedTokens: number; capTokens: number }
  | { allowed: false; reason: "cap" | "disabled"; usedTokens: number; capTokens: number };

export type GlmSpendEntry = {
  userId: string;
  requestId: string;
  totalTokens: number;
  pages: number | null;
  provider: GlmProvider;
  model: string;
  /** Optional (contract §3.5 log fields); omitted by the minimal call shape. */
  promptTokens?: number;
  completionTokens?: number;
  /** Upstream call duration, for the usage log line. */
  ms?: number;
  /** true when this record is a liveness PROBE, not a user extraction. */
  probe?: boolean;
  /**
   * Defect #4(b): false when upstream reported no usage at all. The spend is
   * still recorded (the call may well have been billed) but the log line marks
   * it so an operator can see the accounting gap instead of reading a
   * fabricated 0 as a free call.
   */
  usagePresent?: boolean;
};

export const DEFAULT_GLM_SPEND_LEDGER_PATH = ".glm-spend-ledger.json";
export const DEFAULT_GLM_DAILY_TOKEN_CAP = 2_000_000;
export const DEFAULT_GLM_TOKEN_PRICE_PER_MILLION = 0.03;
/** Keep only the most recent N UTC day buckets in the file. */
export const GLM_SPEND_RETAINED_DAYS = 7;

type UserSpend = { tokens: number; usd: number; calls: number };
type DayBucket = Record<string, UserSpend>;
type Ledger = Record<string, DayBucket>;

/**
 * The ONLY way a number enters or leaves this module's arithmetic.
 * `NaN`, `Infinity`, `-Infinity`, strings, null and undefined all become 0 —
 * so no corrupt ledger value can ever make a comparison false-by-NaN and no
 * counter can ever be poisoned into an unrepairable state.
 */
function finiteNonNegative(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

/** A plain object (not null, not an array) — the only shape a bucket/entry may be. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerce one stored user entry into a well-formed `UserSpend`, or null when it
 * is unrepairable. A string `"oops"`, `{tokens:null}` or a bare number is
 * DISCARDED rather than trusted: under-counting one corrupt entry is the
 * fail-safe direction for a cost guard whose job is to stop runaway spend
 * (the alternative — treating it as 0 and carrying the junk forward — is what
 * let the cap stop binding).
 */
function repairUserSpend(raw: unknown): UserSpend | null {
  if (!isPlainObject(raw)) return null;
  const tokens = finiteNonNegative(raw.tokens);
  // Repair a missing/invalid `usd` from the token count rather than dropping
  // the entry: the tokens are the load-bearing number for the cap.
  const usd = typeof raw.usd === "number" && Number.isFinite(raw.usd) && raw.usd >= 0
    ? raw.usd
    : glmCostUsd(tokens);
  const calls =
    typeof raw.calls === "number" && Number.isInteger(raw.calls) && raw.calls >= 0
      ? raw.calls
      : 0;
  return { tokens, usd, calls };
}

/**
 * Coerce one stored day bucket into a well-formed `DayBucket`. A bucket that is
 * not a plain object (`null`, `7`, `"x"`, an array) is DISCARDED — the proven
 * `TypeError` sources — as is every unrepairable user entry inside it.
 */
function repairDayBucket(raw: unknown): DayBucket {
  const bucket: DayBucket = {};
  if (!isPlainObject(raw)) return bucket;
  for (const [userId, entry] of Object.entries(raw)) {
    const repaired = repairUserSpend(entry);
    if (repaired !== null) bucket[userId] = repaired;
  }
  return bucket;
}

/** UTC day bucket key (`YYYY-MM-DD`). ISO dates sort lexicographically. */
export function utcDayKey(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Ledger path: the test override wins over `GLM_SPEND_LEDGER_PATH`. */
let ledgerPathOverride: string | null = null;
function ledgerPath(): string {
  return (
    ledgerPathOverride ||
    process.env.GLM_SPEND_LEDGER_PATH ||
    DEFAULT_GLM_SPEND_LEDGER_PATH
  );
}

/** Read-through cache. `null` = not loaded yet (or invalidated). */
let cache: Ledger | null = null;
/** The path `cache` was loaded from — a path change forces a reload. */
let cachePath: string | null = null;
let warnedReadFailure = false;
let warnedWriteFailure = false;
let warnedRecordFailure = false;

function isSpendDisabled(): boolean {
  return process.env.GLM_SPEND_DISABLED === "1";
}

/** Positive-integer env read with a fail-closed default (never NaN/0). */
function intEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

/** Non-negative float env read with a fail-closed default. */
function floatEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export function glmDailyTokenCap(): number {
  return intEnv(process.env.GLM_DAILY_TOKEN_CAP, DEFAULT_GLM_DAILY_TOKEN_CAP);
}

export function glmTokenPricePerMillion(): number {
  return floatEnv(
    process.env.GLM_TOKEN_PRICE_PER_MILLION,
    DEFAULT_GLM_TOKEN_PRICE_PER_MILLION,
  );
}

/** USD for a token count at the configured price. */
export function glmCostUsd(totalTokens: number): number {
  return (totalTokens / 1_000_000) * glmTokenPricePerMillion();
}

/**
 * Drop every bucket that is not one of the last `GLM_SPEND_RETAINED_DAYS` UTC
 * days (malformed keys are dropped too). Keeps the file bounded — it is
 * rewritten on every record, so an unbounded ledger would grow forever.
 *
 * Every surviving bucket is passed through `repairDayBucket`, so a corrupt
 * bucket can never reach the arithmetic (defects #2/#3).
 */
function pruneLedger(ledger: Ledger, now: number = Date.now()): Ledger {
  const cutoff = utcDayKey(now - (GLM_SPEND_RETAINED_DAYS - 1) * 86_400_000);
  const pruned: Ledger = {};
  for (const [day, bucket] of Object.entries(ledger)) {
    // `>=` also retains future-dated keys (clock skew) rather than silently
    // discarding a bucket that may hold today's spend on another replica.
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day >= cutoff) {
      pruned[day] = repairDayBucket(bucket);
    }
  }
  return pruned;
}

/** Load the ledger (read-through). Never throws. */
function loadLedger(): Ledger {
  const path = ledgerPath();
  if (cache !== null && cachePath === path) return cache;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("ledger root is not an object");
    }
    // Defect #2: the ROOT being an object is not enough — each day bucket and
    // each user entry is validated/repaird here, on the way IN, so no shape
    // corruption can reach the arithmetic or the writer.
    cache = pruneLedger(parsed as Ledger);
  } catch (err) {
    // ENOENT (first run) is the normal cold-start path — only a REAL read or
    // parse failure is worth a warn. Distinguish via the error code.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" && !warnedReadFailure) {
      warnedReadFailure = true;
      console.warn(
        `[glm-spend] Could not read the spend ledger (${code ?? "parse error"}); ` +
          `starting from an EMPTY ledger for this process. The daily cap will ` +
          `under-count until the file is readable again.`,
      );
    }
    cache = {};
  }
  cachePath = path;
  return cache;
}

/**
 * Persist the ledger. Atomic-ish: write a sibling temp file then rename over
 * the target, so a crash mid-write cannot truncate the previous good ledger.
 * Never throws — a write failure is logged once and the in-memory count stays
 * authoritative for this process.
 */
function saveLedger(ledger: Ledger): void {
  const path = ledgerPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(ledger), "utf8");
    renameSync(tmp, path);
    warnedWriteFailure = false;
  } catch (err) {
    if (!warnedWriteFailure) {
      warnedWriteFailure = true;
      const code = (err as NodeJS.ErrnoException)?.code ?? "unknown";
      console.warn(
        `[glm-spend] Could not persist the spend ledger (${code}); the daily ` +
          `cap continues from the in-memory count only. A restart will lose ` +
          `the un-persisted spend.`,
      );
    }
  }
}

/** Today's bucket, created on demand. Always a well-formed bucket. */
function todayBucket(ledger: Ledger, now: number = Date.now()): DayBucket {
  const day = utcDayKey(now);
  const bucket = ledger[day];
  if (bucket === undefined || !isPlainObject(bucket)) {
    // Repair in place: a corrupt bucket (`null`, a number, an array) is
    // REPLACED rather than trusted — writing into it was the proven
    // `Cannot create property … on number` / `Cannot read properties of null`.
    ledger[day] = {};
    return ledger[day];
  }
  return bucket;
}

/**
 * Remote-leg spend gate. Local leg never calls this.
 *
 * `GLM_SPEND_DISABLED=1` refuses EVERY remote OCR call (the operator kill
 * switch) regardless of usage; otherwise the call is refused once today's
 * tokens have reached `GLM_DAILY_TOKEN_CAP`.
 *
 * Defect #3: both sides of the comparison are `finiteNonNegative`, so a
 * corrupt ledger entry can never produce `NaN >= cap === false` and silently
 * disable the cap.
 */
export function checkGlmSpend(userId: string): GlmSpendDecision {
  const capTokens = glmDailyTokenCap();
  const usedTokens = glmSpendUsed(userId);
  if (isSpendDisabled()) {
    return { allowed: false, reason: "disabled", usedTokens, capTokens };
  }
  if (usedTokens >= capTokens) {
    return { allowed: false, reason: "cap", usedTokens, capTokens };
  }
  return { allowed: true, usedTokens, capTokens };
}

/**
 * Record a completed remote call and emit the redacted usage log line
 * (contract §3.5). Synchronous write — the ledger MUST be durable before the
 * response is returned (a fire-and-forget write loses the count on a crash).
 *
 * NEVER THROWS (defect #2): the caller has already paid for the extraction, so
 * no ledger IO or parse problem may take the response down with it. The whole
 * record path is wrapped; a failure warns once and the in-memory count stays
 * authoritative for this process.
 */
export function recordGlmSpend(entry: GlmSpendEntry): void {
  const tokens = finiteNonNegative(entry.totalTokens);
  const usd = glmCostUsd(tokens);
  const promptTokens = entry.promptTokens === undefined ? null : finiteNonNegative(entry.promptTokens);
  const completionTokens =
    entry.completionTokens === undefined ? null : finiteNonNegative(entry.completionTokens);
  const usagePresent = entry.usagePresent !== false;

  try {
    const ledger = loadLedger();
    const bucket = todayBucket(ledger);
    const prev = repairUserSpend(bucket[entry.userId]) ?? { tokens: 0, usd: 0, calls: 0 };
    bucket[entry.userId] = {
      tokens: prev.tokens + tokens,
      usd: prev.usd + usd,
      calls: prev.calls + 1,
    };

    // Prune in place so the in-memory cache and the file hold the same bounded
    // set of day buckets (otherwise the process keeps every bucket it ever saw
    // while the file stays capped).
    const pruned = pruneLedger(ledger);
    cache = pruned;
    cachePath = ledgerPath();
    saveLedger(pruned);
  } catch (err) {
    // Belt-and-braces: `loadLedger`/`saveLedger` already swallow their own IO
    // failures, but an unexpected shape must still not reach the route.
    if (!warnedRecordFailure) {
      warnedRecordFailure = true;
      console.warn(
        "[glm-spend] Could not record spend " +
          `(${err instanceof Error ? err.name : "unknown error"}); the in-memory ` +
          "count may be incomplete. The extraction itself is unaffected.",
      );
    }
  }

  // Redacted ops log (contract §3.5): ids and numbers only, never the key.
  // `usagePresent: false` marks a billed attempt whose token count upstream
  // never reported — an accounting gap, not a free call (defect #4).
  console.info(
    "[glm-usage] " +
      JSON.stringify({
        requestId: entry.requestId,
        userId: entry.userId,
        provider: entry.provider,
        model: entry.model,
        numPages: entry.pages,
        promptTokens,
        completionTokens,
        totalTokens: tokens,
        costUsd: Number(usd.toFixed(6)),
        ms: entry.ms ?? null,
        probe: entry.probe === true,
        usagePresent,
      }),
  );
}

/**
 * Today's tokens for a user (UTC day bucket) — for tests/diagnostics.
 * Always a finite non-negative number (defect #3).
 */
export function glmSpendUsed(userId: string): number {
  const ledger = loadLedger();
  return finiteNonNegative(ledger[utcDayKey()]?.[userId]?.tokens);
}

/** Today's cost in USD for a user (UTC day bucket). Always finite. */
export function glmSpendUsedUsd(userId: string): number {
  const ledger = loadLedger();
  return finiteNonNegative(ledger[utcDayKey()]?.[userId]?.usd);
}

/** Today's recorded call count for a user (UTC day bucket). Always finite. */
export function glmSpendCalls(userId: string): number {
  const ledger = loadLedger();
  const calls = ledger[utcDayKey()]?.[userId]?.calls;
  return typeof calls === "number" && Number.isFinite(calls) && calls >= 0 ? calls : 0;
}

/**
 * Test-only: clear the in-process cache + warn latches and point at a temp
 * ledger. Pass `null` to drop the override and fall back to
 * `GLM_SPEND_LEDGER_PATH`.
 */
export function _resetGlmSpendForTests(ledgerPath?: string | null): void {
  cache = null;
  cachePath = null;
  warnedReadFailure = false;
  warnedWriteFailure = false;
  warnedRecordFailure = false;
  ledgerPathOverride = ledgerPath ?? null;
}
