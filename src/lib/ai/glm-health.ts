import "server-only";
import { createHash } from "node:crypto";
import { httpLayoutParsing, probeGlmModel } from "@/lib/ai/http-compat";
import { glmProviderMisconfig, resolveGlmProvider } from "@/lib/ai/glm-provider";
import type { GlmProvider, GlmProviderConfig } from "@/lib/ai/glm-provider";
import { checkGlmSpend, recordGlmSpend } from "@/lib/ai/glm-spend";

/**
 * Cached GLM-OCR liveness for the engine picker (gates G4 + G7).
 *
 * Why this exists: on the REMOTE leg the only probe that actually proves the
 * key works AND the account has balance AND OCR is entitled is a real
 * `layout_parsing` call — and that call is BILLED. An uncached probe per dialog
 * open would be chronic spend on a shared key, so:
 *  - verdicts are cached in-process (positive `GLM_PROBE_TTL_MS` = 300s,
 *    negative `GLM_PROBE_NEGATIVE_TTL_MS` = 30s — a dead key is re-checked
 *    quickly so a fixed key comes back without a restart, while a healthy
 *    verdict is not re-billed every few seconds);
 *  - `glmHealthCached()` NEVER probes. The POST path uses it purely to
 *    short-circuit a known-bad configuration, and a real POST is its own
 *    liveness proof — so the UI is never gated on an uncached billed call.
 *
 * The local leg stays FREE: `probeGlmModel` is a `GET /v1/models`.
 *
 * CACHE IDENTITY (defect #1): the verdict is cached under an IDENTITY TUPLE
 * covering everything that can change it — `provider`, `baseUrl`, `model` and
 * a NON-REVERSIBLE fingerprint of the key. A single unkeyed slot was proven to
 * serve the WRONG leg's verdict after a live env flip: a local→remote flip
 * served `{provider:"local",maxPages:200}` for up to 300 s, which made the
 * client take the per-page path and bill N calls for an N-page deck instead of
 * one whole-document call; a stale NEGATIVE verdict from the other leg 503'd
 * every POST with zero upstream calls (a hard 300 s outage); a key ROTATION
 * kept reporting the dead key's `auth` failure for 300 s. Any component change
 * is now a MISS, never a stale hit.
 *
 * PROBE ACCOUNTING (defect #5): the remote probe is a real billed
 * `layout_parsing` POST, so it goes through the SAME spend governor as a user
 * POST — `checkGlmSpend` refuses it at/over cap (and when the kill switch is
 * on) and `recordGlmSpend` books its reported usage under a reserved
 * pseudo-user so a cost audit can see probe spend separately from user spend.
 * When the requesting user is known (`glmHealth({ userId })`) the probe is ALSO
 * counted against that user, so probing cannot be a way around their cap.
 *
 * Secrets: this module never logs or returns key material. The probe reuses
 * the route's validated `data:`-prefixed base64 shape (G5 — never a URL). The
 * key enters the cache identity ONLY through a short SHA-256 hex prefix.
 */

export type GlmHealthReason =
  | "ok"
  | "disabled" // GLM_SPEND_DISABLED on the remote leg
  | "misconfigured" // remote without ZAI_API_KEY
  | "unreachable" // local probe failed / remote transport failure
  | "auth" // remote 401/403 — dead key / no entitlement (G4)
  | "rate_limited" // remote capacity
  | "error";

export type GlmHealth = {
  available: boolean;
  reason: GlmHealthReason;
  checkedAt: string; // ISO
  provider: GlmProvider;
  maxPages: number;
  maxImageBytes: number;
  maxPdfBytes: number;
  /** true when this verdict came from cache (no upstream call this time). */
  cached: boolean;
};

/**
 * The 1×1 PNG probe payload (same bytes the route tests use). A real
 * authenticated `layout_parsing` POST of this image is the cheapest call that
 * exercises auth + balance + entitlement end to end.
 */
export const GLM_PROBE_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export const DEFAULT_GLM_PROBE_TTL_MS = 300_000;
export const DEFAULT_GLM_PROBE_NEGATIVE_TTL_MS = 30_000;
/** Bounded probe call — a slow Z.ai must not hold the picker open. */
export const GLM_PROBE_TIMEOUT_MS = 5_000;

/**
 * The pseudo-user the probe's own usage is booked under (defect #5). A cost
 * audit can therefore separate probe spend from user spend in the ledger and
 * in the `[glm-usage]` lines. Deliberately NOT a UUID: it can never collide
 * with a real `auth.users.id`.
 */
export const GLM_PROBE_SPEND_USER = "__glm_probe__";

/**
 * Non-reversible fingerprint of a credential, for use in the cache identity.
 *
 * The key must participate in the identity (a rotation has to invalidate the
 * cached verdict) but must NEVER be stored or logged. A truncated SHA-256 of
 * the value is one-way: the cache holds 16 hex chars, not the secret, and two
 * different keys collide with negligible probability. Returns `"-"` for an
 * absent key so "no key" is itself a distinct identity component.
 */
export function fingerprintSecret(secret: string | undefined): string {
  if (!secret) return "-";
  return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 16);
}

/**
 * Everything that can change a verdict, as one comparable string.
 *
 * `maxPages` / byte caps are included because they are part of the payload the
 * picker acts on: an operator raising `GLM_REMOTE_MAX_PAGES` must not be told
 * "30" for another 300 s.
 */
function cacheIdentity(cfg: GlmProviderConfig): string {
  return [
    cfg.provider,
    cfg.baseUrl,
    cfg.model,
    String(cfg.maxPages),
    String(cfg.maxImageBytes),
    String(cfg.maxPdfBytes),
    fingerprintSecret(cfg.apiKey),
  ].join("\u0000");
}

/** Positive-integer env read with a fail-closed default. */
function intEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

export function glmProbeTtlMs(): number {
  return intEnv(process.env.GLM_PROBE_TTL_MS, DEFAULT_GLM_PROBE_TTL_MS);
}

export function glmProbeNegativeTtlMs(): number {
  return intEnv(
    process.env.GLM_PROBE_NEGATIVE_TTL_MS,
    DEFAULT_GLM_PROBE_NEGATIVE_TTL_MS,
  );
}

/**
 * A probe result plus whether it may be CACHED.
 *
 * `cacheable: false` exists because some verdicts are about the REQUESTING USER
 * rather than the provider configuration (the daily-cap refusal below). Caching
 * one of those in the shared, identity-keyed slot would serve it to every other
 * user for the negative TTL — one lecturer over their cap would hide the engine
 * from the whole cohort.
 */
type ProbeOutcome = { health: GlmHealth; cacheable: boolean };

type CacheEntry = { identity: string; health: GlmHealth; expiresAt: number };
let cached: CacheEntry | null = null;
/** In-flight probe, so N concurrent cold requests share ONE billed call. */
let inFlightProbe: { identity: string; promise: Promise<ProbeOutcome> } | null = null;

/** Test-only: drop the cached verdict (and any in-flight probe handle). */
export function _resetGlmHealthForTests(): void {
  cached = null;
  inFlightProbe = null;
}

/** Map an upstream failure to the health reason union. */
function reasonForError(
  error: "timeout" | "rate_limited" | "http_error" | "ai_error" | "auth",
): GlmHealthReason {
  switch (error) {
    case "auth":
      return "auth";
    case "rate_limited":
      return "rate_limited";
    case "timeout":
    case "http_error":
      return "unreachable";
    case "ai_error":
      return "error";
  }
}

function baseHealth(now: number, cfg: GlmProviderConfig): Omit<GlmHealth, "available" | "reason" | "cached"> {
  return {
    checkedAt: new Date(now).toISOString(),
    provider: cfg.provider,
    maxPages: cfg.maxPages,
    maxImageBytes: cfg.maxImageBytes,
    maxPdfBytes: cfg.maxPdfBytes,
  };
}

/**
 * Perform the real probe (no cache read, no cache write).
 *
 * `userId` is the authenticated caller when the probe is triggered from an
 * authenticated GET. When present, the probe's billed usage is booked BOTH
 * under the reserved probe pseudo-user (so an audit sees it) and under that
 * user (so a probe cannot be a way around their own daily cap).
 */
async function probe(userId: string | null): Promise<ProbeOutcome> {
  const now = Date.now();
  const cfg = resolveGlmProvider();
  const base = baseHealth(now, cfg);
  const cacheable = (health: GlmHealth): ProbeOutcome => ({ health, cacheable: true });

  // Remote + missing key: fail closed BEFORE any billed call. Never falls back
  // to the local leg (that would silently change what the operator configured).
  if (cfg.provider === "remote" && glmProviderMisconfig() === "missing_key") {
    return cacheable({ ...base, available: false, reason: "misconfigured", cached: false });
  }
  // Operator kill switch: the leg is configured but refuses to spend.
  if (cfg.provider === "remote" && process.env.GLM_SPEND_DISABLED === "1") {
    return cacheable({ ...base, available: false, reason: "disabled", cached: false });
  }
  // Defect #5: the probe is BILLED, so it must obey the same daily cap as a
  // user POST. Probing an already-over-cap user would be unmetered spend.
  // NOT cacheable: this verdict is about the USER, not the provider — caching
  // it would hide the engine from every other user for the negative TTL.
  if (cfg.provider === "remote" && userId !== null && !checkGlmSpend(userId).allowed) {
    return {
      health: { ...base, available: false, reason: "rate_limited", cached: false },
      cacheable: false,
    };
  }

  if (cfg.provider === "local") {
    const ok = await probeGlmModel({
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      apiKey: cfg.apiKey,
    });
    return cacheable({
      ...base,
      available: ok,
      reason: ok ? "ok" : "unreachable",
      cached: false,
    });
  }

  // Remote: a REAL authenticated tiny layout_parsing POST (G4/G7). Billed.
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const res = await httpLayoutParsing({
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: cfg.apiKey,
    fileDataUrl: GLM_PROBE_PNG_DATA_URL,
    timeoutMs: GLM_PROBE_TIMEOUT_MS,
    requestId,
  });

  // Book the probe's spend under the reserved pseudo-user. `recordGlmSpend`
  // never throws (a disk problem must not break the picker) and logs a redacted
  // usage line, which is what makes probe spend auditable. `usagePresent`
  // distinguishes "upstream reported zero" from "upstream reported nothing".
  if (res.usagePresent) {
    const ms = Date.now() - startedAt;
    const entry = {
      requestId,
      totalTokens: res.usage.totalTokens,
      pages: 1,
      provider: "remote" as const,
      model: cfg.model,
      promptTokens: res.usage.promptTokens,
      completionTokens: res.usage.completionTokens,
      ms,
      probe: true,
      usagePresent: true,
    };
    recordGlmSpend({ ...entry, userId: GLM_PROBE_SPEND_USER });
    // Defect #5: when the requesting user is known, the probe ALSO counts
    // against them — probing must not be a way around a user's own cap.
    if (userId !== null) recordGlmSpend({ ...entry, userId });
  } else {
    // Defect #4(c): a billed remote attempt that reported no usage is an
    // accounting gap an operator must be able to see.
    console.warn(
      "[glm-health] Remote liveness probe produced no usage data " +
        `(requestId=${requestId}, error=${res.ok ? "none" : res.error}); ` +
        "its token spend is NOT accounted.",
    );
  }

  if (res.ok) {
    return cacheable({ ...base, available: true, reason: "ok", cached: false });
  }
  return cacheable({
    ...base,
    available: false,
    reason: reasonForError(res.error),
    cached: false,
  });
}

/**
 * GET-path liveness: cached, and on a cold/stale cache performs a REAL
 * authenticated check (see the module header). TTLs: positive
 * `GLM_PROBE_TTL_MS` (300s), negative `GLM_PROBE_NEGATIVE_TTL_MS` (30s).
 *
 * `force: true` bypasses the cache read (and still refreshes it).
 *
 * `userId` is the authenticated caller, when known: it lets the billed probe be
 * counted against that user's daily cap (defect #5).
 */
export async function glmHealth(opts?: {
  force?: boolean;
  userId?: string | null;
}): Promise<GlmHealth> {
  const now = Date.now();
  const cfg = resolveGlmProvider();
  const identity = cacheIdentity(cfg);
  const userId = opts?.userId ?? null;

  // A cached verdict is only usable when it belongs to the CURRENT identity
  // tuple (provider/baseUrl/model/caps/key fingerprint). Any component change
  // is a MISS, never a stale hit — see the module header (defect #1).
  if (!opts?.force && cached !== null && cached.identity === identity && cached.expiresAt > now) {
    return { ...cached.health, cached: true };
  }

  // Collapse concurrent cold/stale probes onto one upstream call — on the
  // remote leg each probe costs money, so a burst of picker opens must not
  // bill once per request. The collapse is keyed on the identity too: a probe
  // for a DIFFERENT identity must not be answered by an in-flight one.
  if (inFlightProbe === null || inFlightProbe.identity !== identity) {
    const promise = probe(userId).finally(() => {
      if (inFlightProbe?.promise === promise) inFlightProbe = null;
    });
    inFlightProbe = { identity, promise };
  }
  const outcome = await inFlightProbe.promise;
  const health = outcome.health;

  // Never cache a verdict for an identity we are no longer on: the env could
  // have flipped while the probe was in flight. A user-scoped verdict (the cap
  // refusal) is never cached at all — see `ProbeOutcome`.
  if (outcome.cacheable && cacheIdentity(resolveGlmProvider()) === identity) {
    const ttl = health.available ? glmProbeTtlMs() : glmProbeNegativeTtlMs();
    cached = { identity, health, expiresAt: Date.now() + ttl };
  }
  return { ...health, cached: false };
}

/**
 * POST-path: the cached verdict when FRESH, else null. NEVER probes — a real
 * POST is its own liveness proof, so the UI must never gate on an uncached
 * billed call (gate G7).
 *
 * Returns null when the cached verdict belongs to a DIFFERENT identity than
 * the current env (defect #1): a stale cross-leg verdict must never
 * short-circuit a POST.
 */
export function glmHealthCached(): GlmHealth | null {
  if (cached === null) return null;
  if (cached.expiresAt <= Date.now()) return null;
  if (cached.identity !== cacheIdentity(resolveGlmProvider())) return null;
  return { ...cached.health, cached: true };
}
