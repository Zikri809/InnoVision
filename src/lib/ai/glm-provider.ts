import "server-only";

/**
 * GLM-OCR provider selection (contract §2 / §4.1).
 *
 * Two legs behind ONE route (`/api/extract/ocr`):
 *  - `local`  — the loopback vLLM/Docker container (`GLM_BASE_URL`,
 *               `VLLM_API_KEY`, OpenAI-compatible chat + `GET /v1/models`).
 *               Free, one rasterized page per call.
 *  - `remote` — the Z.ai PaaS API (`ZAI_BASE_URL` carries `/api/paas/v4`),
 *               `POST /layout_parsing`, whole-document, BILLED per token.
 *
 * Fail-closed (hard rule 2): the ONLY value that selects the metered leg is
 * `remote` (case-insensitive, trimmed). Unset, `local`, or any unrecognised
 * value selects `local` — an operator typo can never silently start spending
 * money on a shared API key. An unrecognised NON-EMPTY value additionally
 * emits a one-time `console.warn` so the typo is visible in the logs.
 *
 * This module reads env at CALL time (never at module load) so tests can
 * `vi.stubEnv` and so a route never caches a stale value.
 *
 * Secrets: this module never logs or returns `ZAI_API_KEY` / `VLLM_API_KEY`
 * values; `apiKey` is only ever handed to the fetch header builder.
 */

export type GlmProvider = "local" | "remote";

export type GlmProviderConfig = {
  provider: GlmProvider;
  /** local: GLM_BASE_URL; remote: ZAI_BASE_URL (root carries /api/paas/v4). */
  baseUrl: string;
  model: string;
  /** local: VLLM_API_KEY; remote: ZAI_API_KEY. */
  apiKey: string | undefined;
  /** Page cap for this provider (local 200, remote GLM_REMOTE_MAX_PAGES ?? 30). */
  maxPages: number;
  /** Max DECODED bytes accepted for a single image. */
  maxImageBytes: number;
  /** Max DECODED bytes accepted for a PDF (local: irrelevant/0). */
  maxPdfBytes: number;
  /** Max base64 data-URL characters accepted in the request body. */
  maxDataUrlChars: number;
  /** true only for remote — the leg that spends money. */
  metered: boolean;
};

/**
 * Local (vLLM) decoded-byte ceiling. Today's route caps the data-URL at 32M
 * chars, which is ≈24 MB decoded; this constant makes the byte bound explicit.
 */
export const LOCAL_MAX_IMAGE_BYTES = 24_000_000;
/** Unchanged from today's route: `MAX_IMAGE_DATAURL_CHARS`. */
export const LOCAL_MAX_DATAURL_CHARS = 32_000_000;
/** Z.ai documented image ceiling. */
export const REMOTE_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Z.ai documented PDF ceiling. */
export const REMOTE_MAX_PDF_BYTES = 50 * 1024 * 1024;
/**
 * ≈25 MB file cap × 4/3 + slack. Derived from the app's own client upload cap
 * (`MAX_FILE_BYTES = 25_000_000` in `src/lib/extract/types.ts`), which is
 * BELOW the remote 50 MB allowance — the UI cannot reach the full remote
 * allowance, so this body cap is not the binding constraint for a PDF.
 */
export const REMOTE_MAX_DATAURL_CHARS = 36_000_000;
/**
 * Local page cap. MUST equal `MAX_OCR_PAGES` in `src/lib/extract/types.ts`
 * (that file is owned by another workstream; `glm-provider.test.ts` pins the
 * equality so a drift is caught by the suite rather than by a runtime bug).
 */
export const LOCAL_MAX_PAGES = 200;
/** Interim remote cap: the Z.ai docs conflict (100 vs 30 pages). */
export const REMOTE_MAX_PAGES_DEFAULT = 30;

export const DEFAULT_GLM_BASE_URL = "http://localhost:11434";
export const DEFAULT_ZAI_BASE_URL = "https://api.z.ai/api/paas/v4";
export const DEFAULT_GLM_MODEL = "glm-ocr";

/**
 * Parse a positive integer env value, falling back to `fallback` for anything
 * unset / unparseable / non-positive / non-integer. Fail-closed direction: a
 * typo yields the documented default, never `NaN` (which would disable the cap)
 * and never 0 (which would block every document).
 */
export function positiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

/** One-time latch for the unrecognised-value warn (test-resettable). */
let warnedUnrecognised = false;

/** Test-only: reset the one-time unknown-value warn latch. */
export function _resetGlmProviderWarnForTests(): void {
  warnedUnrecognised = false;
}

/**
 * Fail-closed: any value other than "remote" (case-insensitive, trimmed) →
 * "local".
 */
export function resolveGlmProvider(env: NodeJS.ProcessEnv = process.env): GlmProviderConfig {
  const raw = env.GLM_PROVIDER;
  const normalized = (raw ?? "").trim().toLowerCase();

  let provider: GlmProvider = "local";
  if (normalized === "remote") {
    provider = "remote";
  } else if (normalized !== "" && normalized !== "local" && !warnedUnrecognised) {
    // One-time, value-free warn: an operator typo must be visible, but the
    // value itself is not a secret — still, keep the line short and single.
    warnedUnrecognised = true;
    console.warn(
      `[glm-provider] Unrecognised GLM_PROVIDER value — falling back to the ` +
        `LOCAL (free, unmetered) leg. Only "local" or "remote" are accepted.`,
    );
  }

  if (provider === "remote") {
    return {
      provider,
      baseUrl: env.ZAI_BASE_URL || DEFAULT_ZAI_BASE_URL,
      model: env.OCR_GLM_MODEL || DEFAULT_GLM_MODEL,
      // Never falls back to VLLM_API_KEY: a remote run without ZAI_API_KEY is
      // a misconfiguration (glmProviderMisconfig → "missing_key"), not a
      // reason to present the local container's token to Z.ai.
      apiKey: env.ZAI_API_KEY || undefined,
      maxPages: positiveIntEnv(env.GLM_REMOTE_MAX_PAGES, REMOTE_MAX_PAGES_DEFAULT),
      maxImageBytes: REMOTE_MAX_IMAGE_BYTES,
      maxPdfBytes: REMOTE_MAX_PDF_BYTES,
      maxDataUrlChars: REMOTE_MAX_DATAURL_CHARS,
      metered: true,
    };
  }

  return {
    provider: "local",
    baseUrl: env.GLM_BASE_URL || DEFAULT_GLM_BASE_URL,
    model: env.OCR_GLM_MODEL || DEFAULT_GLM_MODEL,
    // audit-3 R3-DEP-F2 dual-read contract: the local container may run vLLM
    // with `--api-key`; unset is the existing keyless loopback posture.
    apiKey: env.VLLM_API_KEY || undefined,
    maxPages: LOCAL_MAX_PAGES,
    maxImageBytes: LOCAL_MAX_IMAGE_BYTES,
    // Local is one rasterized page per call — there is no PDF path at all, so
    // the PDF cap is deliberately 0 (any PDF input is rejected before here).
    maxPdfBytes: 0,
    maxDataUrlChars: LOCAL_MAX_DATAURL_CHARS,
    metered: false,
  };
}

/**
 * Human-readable misconfiguration for the remote leg, or null when usable.
 * Remote + missing ZAI_API_KEY → "missing_key" (never falls back to local).
 */
export function glmProviderMisconfig(
  env: NodeJS.ProcessEnv = process.env,
): "missing_key" | null {
  const cfg = resolveGlmProvider(env);
  if (cfg.provider !== "remote") return null;
  if (!cfg.apiKey) return "missing_key";
  return null;
}
