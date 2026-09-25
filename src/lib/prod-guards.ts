import "server-only";

/**
 * Prod fail-closed environment gate — plan §10.2 gates **S1** (fail-closed prod
 * env) and **S5** (kill-switch enforcement). Called once per server start from
 * `src/instrumentation.ts`'s `register()`.
 *
 * ## What this corrects (the false-confidence statements)
 *
 * - **S1 — "provision a real token" was a wish, not a control.** The compose
 *   file boots HEALTHY with `FACE_SIDECAR_TOKEN: "${FACE_SIDECAR_TOKEN:-}"`
 *   (empty) and the app sends no `x-sidecar-token` header when it is empty
 *   (`src/lib/face/server/insightface-client.ts`), so an unauthenticated
 *   `/extract` is an embedding oracle for anything that can reach the sidecar.
 *   Likewise `VLLM_API_KEY: "${VLLM_API_KEY:-}"` leaves the local OCR leg
 *   unauthenticated. An empty token is therefore a VIOLATION here, not a note
 *   in a runbook.
 * - **S5 — a kill-switch leak only `console.warn`ed.** `E2E_RATE_LIMIT_DISABLED`
 *   (`src/lib/classes/rate-limit.ts`), `NEXT_PUBLIC_E2E_FAKE_SEAM` +
 *   `FACE_MOCK_ENABLED` (`insightface-client.ts` `isMockMode()`) and
 *   `NEXT_PUBLIC_INTEGRITY_HARDENING_OFF` (`src/lib/integrity/hardening-gate.ts`)
 *   are harness-only, yet a harness-built image PROMOTED to a VPS keeps the
 *   baked `NEXT_PUBLIC_*=1` values and silently disables every rate limit, face
 *   verification and integrity hardening. Any of them set to `"1"` is a
 *   violation here, and under strict mode it aborts startup.
 * - **S4 (partial) — an unparseable `TRUSTED_PROXY_COUNT`.** `request-ip.ts`
 *   falls back to the conservative `0` for an unparseable value, but silently:
 *   the operator believes they pinned a hop count while every per-IP budget
 *   collapsed into one shared bucket. Unparseable is a violation here.
 *
 * ## Why `PROD_ENV_STRICT` gates the hard failure
 *
 * The Playwright harness deliberately runs a PRODUCTION build (`npm run build
 * && npm run start`) with the kill switches ON — that is the only way to serve
 * the fake face/hand tracker seams, per `src/lib/face/seam-gate.ts`. An
 * unconditional throw would therefore break the ENTIRE e2e suite. So the hard
 * fail is gated on `NODE_ENV === "production" && PROD_ENV_STRICT === "1"`: the
 * VPS app service sets `PROD_ENV_STRICT=1` (RUNTIME env — it is read from
 * `process.env`, never inlined at build time), and the harness simply does not.
 *
 * Strict mode (`NODE_ENV=production` + `PROD_ENV_STRICT=1`):
 *   any violation → THROW. `next start` fails (Next rejects `register()` from
 *   `prepare()`), which is the S5 "hard-fail `next start`" requirement.
 *
 * Non-strict production (the e2e harness, or a VPS that forgot the flag):
 *   one `console.warn` per process naming the KEYS — never the values.
 *
 * Non-production: silent. An empty `FACE_SIDECAR_TOKEN` / `VLLM_API_KEY` is the
 * documented LOCAL default (loopback-only sidecars), so warning there would
 * train operators to ignore the line that matters in production. Setting
 * `PROD_ENV_STRICT=1` in a dev shell opts back in to the warning.
 *
 * ## Secret handling (hard rule §0.3)
 *
 * `ProdGuardViolation.value` is only ever populated for NON-secret keys (the
 * kill switches, `TRUSTED_PROXY_COUNT`). For the token class
 * (`FACE_SIDECAR_TOKEN`, `VLLM_API_KEY`, `ZAI_API_KEY`) the value is rendered as
 * `"<empty>"` / `"<set>"` — the raw string never enters a violation, the thrown
 * error, or the warn line. Tests pin this.
 */

export type ProdGuardViolation = { key: string; value: string; why: string };

/**
 * Harness-only kill switches. `"1"` is the ONLY value that arms them (each
 * consumer compares `=== "1"`), so `"0"`/unset/`""` are all safe.
 */
const KILL_SWITCHES: readonly { key: string; why: string }[] = [
  {
    key: "E2E_RATE_LIMIT_DISABLED",
    why: "every rate limit in this process is DISABLED (src/lib/classes/rate-limit.ts) — the signup/invite/reset brute-force budgets are dead",
  },
  {
    key: "NEXT_PUBLIC_E2E_FAKE_SEAM",
    why: "baked into the client bundle at BUILD time; with FACE_MOCK_ENABLED it makes face verification return canned verdicts and verify NOTHING (src/lib/face/seam-gate.ts)",
  },
  {
    key: "FACE_MOCK_ENABLED",
    why: "server-side mock seam for the InsightFace client — face verification verifies NOTHING (src/lib/face/server/insightface-client.ts)",
  },
  {
    key: "NEXT_PUBLIC_INTEGRITY_HARDENING_OFF",
    why: "baked into the client bundle at BUILD time; clipboard/fullscreen integrity hardening never mounts (src/lib/integrity/hardening-gate.ts)",
  },
  {
    key: "NEXT_PUBLIC_DEMO_MODE",
    why: "baked into the client bundle at BUILD time; arms the exhibition walk-up flow — anonymous scanners of the demo join code get auto-provisioned guest student accounts (POST /api/demo/guest), and the /demo status/reset surfaces become reachable (src/lib/demo/gate.ts, docs/plans/PLAN_DEMO_MODE.md)",
  },
];

/**
 * Feature-enforcement keys that must be ARMED in production. These are the
 * inverse of the kill switches above: the safe value is `"1"`, and anything
 * else means the control is silently OFF. audit-5 M6: `FACE_SPOOF_ENFORCE`
 * lived only in a boot-time `console.warn`, so a deploy that dropped the key
 * booted clean under `PROD_ENV_STRICT=1` while photo/replay verdicts were
 * recorded but never enforced (a print held to the camera passes on
 * similarity alone).
 */
const ENFORCEMENT_KEYS: readonly { key: string; why: string }[] = [
  {
    key: "FACE_SPOOF_ENFORCE",
    why:
      "anti-spoof enforcement is OFF: MiniFASNet verdicts are recorded but a photo/replay is never forced to a FAIL " +
      "vote (src/app/api/face/verify/route.ts + enroll/route.ts). The deployment convention sets =1 " +
      "(deploy/secrets/prod.env.example) but nothing failed closed when the key was dropped",
  },
];

/** Token-shaped keys: their VALUE must never be captured in a violation. */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  "FACE_SIDECAR_TOKEN",
  "VLLM_API_KEY",
  "ZAI_API_KEY",
]);

/** Render a value for a violation without ever echoing a secret. */
function safeValue(key: string, raw: string): string {
  if (!SECRET_KEYS.has(key)) return raw;
  return raw === "" ? "<empty>" : "<set>";
}

function raw(env: NodeJS.ProcessEnv, key: string): string {
  return env[key] ?? "";
}

/**
 * Inspect an env object for the violations that must NEVER reach production.
 * Pure: reads only the object it is given (defaults to `process.env`), performs
 * no I/O, logs nothing. Returns `[]` when clean.
 *
 * NOTE on the token checks — "while the feature they gate is real":
 *  - Face is REAL unless BOTH harness flags are on (`NEXT_PUBLIC_E2E_FAKE_SEAM`
 *    and `FACE_MOCK_ENABLED`), mirroring `isMockMode()` exactly. A lone
 *    `FACE_MOCK_ENABLED=1` does NOT mock anything, so the token is still
 *    required — fail-closed in the direction that demands the control.
 *  - `GLM_PROVIDER` is resolved with the same fail-closed rule as
 *    `resolveGlmProvider()`: anything other than `remote` (case-insensitive) is
 *    the LOCAL leg. Inlined rather than imported so this module has no
 *    dependency on the in-flight `src/lib/ai/glm-provider.ts`; the rule is one
 *    comparison and drift is caught by the tests here.
 */
export function inspectProdEnv(env: NodeJS.ProcessEnv = process.env): ProdGuardViolation[] {
  const violations: ProdGuardViolation[] = [];

  for (const { key, why } of KILL_SWITCHES) {
    const value = raw(env, key);
    if (value === "1") violations.push({ key, value: safeValue(key, value), why });
  }

  // Enforcement keys: the feature is REAL unless the mock seam is fully armed,
  // and the control must be explicitly ON. Mirrors the kill-switch loop's
  // exact-"1" comparison (anything else is inert in the consumers).
  const faceMocked =
    raw(env, "NEXT_PUBLIC_E2E_FAKE_SEAM") === "1" && raw(env, "FACE_MOCK_ENABLED") === "1";
  for (const { key, why } of ENFORCEMENT_KEYS) {
    // The E2E harness runs with the fake sidecar, where spoof enforcement is
    // meaningless (the mock never produces a spoof verdict); exempt it the
    // same way the token check exempts the fully-mocked seam.
    if (key === "FACE_SPOOF_ENFORCE" && faceMocked) continue;
    const value = raw(env, key);
    if (value !== "1") violations.push({ key, value: safeValue(key, value), why });
  }

  if (!faceMocked && raw(env, "FACE_SIDECAR_TOKEN").trim() === "") {
    violations.push({
      key: "FACE_SIDECAR_TOKEN",
      value: safeValue("FACE_SIDECAR_TOKEN", ""),
      why:
        "the face sidecar's /extract is then UNAUTHENTICATED (the client omits x-sidecar-token when " +
        "the token is empty) — an embedding oracle for anything that can reach the sidecar. The " +
        "compose file boots healthy with an empty token, so an empty value is the failure mode, not a " +
        "safe default (gate S1)",
    });
  }

  if (raw(env, "GLM_PROVIDER").trim().toLowerCase() === "remote") {
    if (raw(env, "ZAI_API_KEY").trim() === "") {
      violations.push({
        key: "ZAI_API_KEY",
        value: safeValue("ZAI_API_KEY", ""),
        why:
          "GLM_PROVIDER=remote without a key: every remote OCR call fails (401/403 -> auth). The " +
          "remote leg never silently falls back to local, so this is a hard outage, not a degradation",
      });
    }
  } else if (raw(env, "VLLM_API_KEY").trim() === "") {
    violations.push({
      key: "VLLM_API_KEY",
      value: safeValue("VLLM_API_KEY", ""),
      why:
        "the LOCAL GLM leg is active (GLM_PROVIDER is unset/not 'remote') and vLLM auth is disabled " +
        "when the key is empty, so the OCR endpoint behind GLM_BASE_URL answers unauthenticated. Set " +
        "a real VLLM_API_KEY on both the app and the vLLM container, or run GLM_PROVIDER=remote with " +
        "ZAI_API_KEY (gate S1)",
    });
  }

  // Mirrors request-ip.ts's parser: unset/blank means the documented default (1)
  // and is fine; anything else must be a non-negative integer. A typo silently
  // selecting a permissive hop count is gate S4's failure mode.
  const proxyCount = env.TRUSTED_PROXY_COUNT;
  if (proxyCount !== undefined && proxyCount.trim() !== "") {
    const parsed = Number(proxyCount);
    if (!Number.isInteger(parsed) || parsed < 0) {
      violations.push({
        key: "TRUSTED_PROXY_COUNT",
        value: safeValue("TRUSTED_PROXY_COUNT", proxyCount),
        why:
          "not a non-negative integer, so the hop count is unparseable: per-IP budgets then silently " +
          "collapse into ONE shared bucket (or mint attacker-chosen buckets) while the operator " +
          "believes the count is pinned (gate S4)",
      });
    }
  }

  return violations;
}

/** One warn per process — `register()` runs once, but tests/reloads must not spam. */
let warned = false;

/** Test-only: reset the one-time warn latch (house pattern, cf. `_resetRateLimiter`). */
export function _resetProdGuardWarnForTests(): void {
  warned = false;
}

/**
 * Throw when `NODE_ENV === "production" && PROD_ENV_STRICT === "1"` and there is
 * any violation; otherwise log a single warn line naming the keys (never the
 * values). See the module header for why the throw is gated on
 * `PROD_ENV_STRICT` rather than on `NODE_ENV` alone.
 */
export function assertProdEnvSafe(env: NodeJS.ProcessEnv = process.env): void {
  const violations = inspectProdEnv(env);
  if (violations.length === 0) return;

  const isProd = env.NODE_ENV === "production";
  const strictRequested = env.PROD_ENV_STRICT === "1";

  if (isProd && strictRequested) {
    // Keys + reasons only: never a value from the secret class.
    throw new Error(
      `[prod-guards] refusing to start: ${violations.length} production env violation(s) — ` +
        violations.map((v) => `${v.key} (${v.why})`).join("; ") +
        ". Fix the environment (see .env.local.example and docs/DEPLOY_VPS.md). The Playwright " +
        "harness legitimately runs a production build with these switches; it simply does not set " +
        "PROD_ENV_STRICT=1.",
    );
  }

  // Only a production runtime (or an explicit opt-in) is worth a line: in dev
  // the empty-token findings are the documented local default.
  if ((isProd || strictRequested) && !warned) {
    warned = true;
    console.warn(
      `[prod-guards] ${violations.length} production env violation(s) — ` +
        violations.map((v) => `${v.key} (${v.why})`).join("; ") +
        ". This is a WARNING only because PROD_ENV_STRICT is not '1'; the VPS app service MUST set " +
        "PROD_ENV_STRICT=1 for this to fail closed.",
    );
  }
}
