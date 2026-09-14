import { vi } from "vitest";
import os from "node:os";
import path from "node:path";

/**
 * Vitest setup:
 *  - mock `server-only` so modules guarded by `import "server-only"` (e.g.
 *    lib/ai/client.ts with the API key) can be imported in unit tests.
 *  - set the AI/OCR env vars the routes read (AI_BASE_URL / AI_API_KEY /
 *    AI_MODEL / OCR_VISION_MODEL) so route-handler tests can construct the
 *    OpenAI client without a real key.
 *  - set the GLM-OCR provider selector + remote-leg knobs to their LOCAL,
 *    free defaults so the harness can never reach the metered Z.ai leg even
 *    on a machine whose .env.local says `GLM_PROVIDER=remote`.
 */
vi.mock("server-only", () => ({}));

// Public Supabase env (validated fail-fast by src/lib/env.ts at import time).
process.env.NEXT_PUBLIC_SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "test-anon-key";

process.env.AI_BASE_URL = process.env.AI_BASE_URL ?? "https://api.openai.com/v1";
process.env.AI_API_KEY = process.env.AI_API_KEY ?? "test-key";
process.env.AI_MODEL = process.env.AI_MODEL ?? "gpt-4o-mini";
process.env.OCR_VISION_MODEL = process.env.OCR_VISION_MODEL ?? "gpt-4o-mini";
process.env.OCR_DEFAULT_ENGINE = process.env.OCR_DEFAULT_ENGINE ?? "tesseract";
process.env.GLM_BASE_URL = process.env.GLM_BASE_URL ?? "http://localhost:11434";
process.env.OCR_GLM_MODEL = process.env.OCR_GLM_MODEL ?? "glm-ocr";

// ─── GLM-OCR provider toggle (contract §2/§7) ───
//
// FORCED, not defaulted (`=`, never `??`): these two are SAFETY rails, so an
// ambient value must not be able to win.
//  - `GLM_PROVIDER` — pinned to the FREE local leg. A developer shell (or a
//    .env.local loaded by an editor test runner) carrying `GLM_PROVIDER=remote`
//    must not be able to turn the unit suite into a metered run against a real
//    Z.ai key. With `??` a hostile ambient value won and the suite ran against
//    the metered leg.
//  - `GLM_SPEND_LEDGER_PATH` — the spend ledger MUST NOT land in the repo root.
//    A route test that exercises the remote leg (spend gate → recordGlmSpend)
//    writes the file on every record, so the app's default
//    `.glm-spend-ledger.json` would be created as an untracked artifact of
//    `vitest run`. With `??` an ambient value (or the app default) won, and a
//    future test that does not call `_resetGlmSpendForTests(tempPath)` itself
//    would write into the repo root.
// The individual suites still call `_resetGlmSpendForTests(tempPath)` in
// `beforeEach` for per-test isolation; this is the floor beneath that.
process.env.GLM_PROVIDER = "local";
process.env.ZAI_BASE_URL =
  process.env.ZAI_BASE_URL ?? "https://api.z.ai/api/paas/v4";
process.env.GLM_SPEND_LEDGER_PATH = path.join(
  os.tmpdir(),
  "innovision-test-glm-spend.json",
);
process.env.GLM_PROBE_TTL_MS = process.env.GLM_PROBE_TTL_MS ?? "300000";
process.env.GLM_PROBE_NEGATIVE_TTL_MS =
  process.env.GLM_PROBE_NEGATIVE_TTL_MS ?? "30000";
// ZAI_API_KEY is deliberately NOT defaulted: a test that wants the remote leg
// must stub it explicitly (vi.stubEnv), so an accidental remote path fails
// closed with `missing_key` instead of silently billing with an ambient key.
process.env.GLM_SPEND_DISABLED = process.env.GLM_SPEND_DISABLED ?? "0";
