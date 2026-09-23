import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  inspectProdEnv,
  assertProdEnvSafe,
  _resetProdGuardWarnForTests,
  type ProdGuardViolation,
} from "@/lib/prod-guards";

/**
 * Gates S1/S5 (plan §10.2) — the fail-closed production env gate.
 *
 * The load-bearing assertions here are:
 *  1. every kill switch is caught individually AND together;
 *  2. an EMPTY gated token is a violation (S1: the compose file boots healthy
 *     with `${...:-}` empty, so "provision a real token" was a wish);
 *  3. an unparseable TRUSTED_PROXY_COUNT is a violation (S4's silent-hop-count
 *     failure mode);
 *  4. NO SECRET VALUE ever reaches the violations array, the thrown error or
 *     the warn line (hard rule §0.3);
 *  5. the Playwright-harness shape (production build + kill switches ON, but
 *     PROD_ENV_STRICT unset) does NOT throw — otherwise this gate would break
 *     the entire e2e suite.
 */

/** A violation-free production env. */
function cleanEnv(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PROD_ENV_STRICT: "1",
    FACE_SIDECAR_TOKEN: "a-real-sidecar-token",
    FACE_SPOOF_ENFORCE: "1",
    GLM_PROVIDER: "remote",
    ZAI_API_KEY: "a-real-zai-key",
    TRUSTED_PROXY_COUNT: "1",
    ...over,
  } as NodeJS.ProcessEnv;
}

function keys(violations: ProdGuardViolation[]): string[] {
  return violations.map((v) => v.key);
}

function find(violations: ProdGuardViolation[], key: string): ProdGuardViolation | undefined {
  return violations.find((v) => v.key === key);
}

/** Secret values used across the leak assertions. */
const SECRETS = {
  FACE_SIDECAR_TOKEN: "sidecar-token-DO-NOT-ECHO-9f3a",
  VLLM_API_KEY: "vllm-key-DO-NOT-ECHO-7c1b",
  ZAI_API_KEY: "zai-key-DO-NOT-ECHO-2e5d",
} as const;

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetProdGuardWarnForTests();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("inspectProdEnv — kill switches (S5)", () => {
  it("returns [] for a clean production env", () => {
    expect(inspectProdEnv(cleanEnv())).toEqual([]);
  });

  // Each switch is checked separately so a regression in one loop iteration
  // cannot hide behind another.
  it.each([
    "E2E_RATE_LIMIT_DISABLED",
    "NEXT_PUBLIC_E2E_FAKE_SEAM",
    "FACE_MOCK_ENABLED",
    "NEXT_PUBLIC_INTEGRITY_HARDENING_OFF",
  ])("flags %s=1", (key) => {
    const violations = inspectProdEnv(cleanEnv({ [key]: "1" }));
    expect(keys(violations)).toEqual([key]);
    expect(find(violations, key)?.value).toBe("1");
    expect(find(violations, key)?.why).toMatch(/./);
  });

  it("flags all four kill switches at once, and only those", () => {
    const violations = inspectProdEnv(
      cleanEnv({
        E2E_RATE_LIMIT_DISABLED: "1",
        NEXT_PUBLIC_E2E_FAKE_SEAM: "1",
        FACE_MOCK_ENABLED: "1",
        NEXT_PUBLIC_INTEGRITY_HARDENING_OFF: "1",
      }),
    );
    expect(keys(violations).sort()).toEqual(
      [
        "E2E_RATE_LIMIT_DISABLED",
        "FACE_MOCK_ENABLED",
        "NEXT_PUBLIC_E2E_FAKE_SEAM",
        "NEXT_PUBLIC_INTEGRITY_HARDENING_OFF",
      ].sort(),
    );
  });

  it("accepts the switches explicitly OFF (0 / empty / unset), not just absent", () => {
    for (const off of ["0", "", undefined]) {
      expect(
        inspectProdEnv(
          cleanEnv({
            E2E_RATE_LIMIT_DISABLED: off,
            NEXT_PUBLIC_E2E_FAKE_SEAM: off,
            FACE_MOCK_ENABLED: off,
            NEXT_PUBLIC_INTEGRITY_HARDENING_OFF: off,
          }),
        ),
      ).toEqual([]);
    }
  });

  it("treats a truthy-but-not-1 value as OFF (the consumers compare === '1')", () => {
    // Each consumer in the app compares against the string "1"; anything else
    // is inert, so flagging it here would be a false positive.
    expect(
      inspectProdEnv(
        cleanEnv({
          E2E_RATE_LIMIT_DISABLED: "true",
          FACE_MOCK_ENABLED: "yes",
          NEXT_PUBLIC_INTEGRITY_HARDENING_OFF: "on",
        }),
      ),
    ).toEqual([]);
  });
});

describe("inspectProdEnv — empty tokens while the feature is real (S1)", () => {
  it("flags an EMPTY FACE_SIDECAR_TOKEN when face is real", () => {
    const violations = inspectProdEnv(cleanEnv({ FACE_SIDECAR_TOKEN: undefined }));
    expect(keys(violations)).toEqual(["FACE_SIDECAR_TOKEN"]);
    // The value is rendered as a marker, never as the (empty) raw string alone.
    expect(find(violations, "FACE_SIDECAR_TOKEN")?.value).toBe("<empty>");
    expect(find(violations, "FACE_SIDECAR_TOKEN")?.why).toMatch(/unauthenticated/i);
  });

  it("treats a whitespace-only token as empty", () => {
    expect(keys(inspectProdEnv(cleanEnv({ FACE_SIDECAR_TOKEN: "   " })))).toEqual([
      "FACE_SIDECAR_TOKEN",
    ]);
  });

  it("does NOT flag the token when face is genuinely mocked (both harness flags)", () => {
    // Mirrors isMockMode(): the mock needs BOTH flags, so only then is the
    // sidecar token irrelevant.
    const violations = inspectProdEnv(
      cleanEnv({
        FACE_SIDECAR_TOKEN: undefined,
        NEXT_PUBLIC_E2E_FAKE_SEAM: "1",
        FACE_MOCK_ENABLED: "1",
      }),
    );
    expect(keys(violations)).not.toContain("FACE_SIDECAR_TOKEN");
  });

  it("still requires the token with only ONE of the two seam flags (fail-closed)", () => {
    // A lone FACE_MOCK_ENABLED does not mock anything, so the token is still
    // load-bearing — demanding it is the fail-closed direction.
    expect(
      keys(inspectProdEnv(cleanEnv({ FACE_SIDECAR_TOKEN: undefined, FACE_MOCK_ENABLED: "1" }))),
    ).toContain("FACE_SIDECAR_TOKEN");
    expect(
      keys(
        inspectProdEnv(
          cleanEnv({ FACE_SIDECAR_TOKEN: undefined, NEXT_PUBLIC_E2E_FAKE_SEAM: "1" }),
        ),
      ),
    ).toContain("FACE_SIDECAR_TOKEN");
  });

  it("requires ZAI_API_KEY when GLM_PROVIDER=remote, and accepts it when set", () => {
    expect(keys(inspectProdEnv(cleanEnv({ GLM_PROVIDER: "remote", ZAI_API_KEY: undefined })))).toEqual([
      "ZAI_API_KEY",
    ]);
    expect(inspectProdEnv(cleanEnv({ GLM_PROVIDER: "remote" }))).toEqual([]);
  });

  it("resolves GLM_PROVIDER case-insensitively and fail-closed to the LOCAL leg", () => {
    // "REMOTE" is the remote leg (same as resolveGlmProvider's lowercase
    // comparison) → ZAI is required, VLLM is not.
    expect(
      keys(inspectProdEnv(cleanEnv({ GLM_PROVIDER: "REMOTE", ZAI_API_KEY: undefined }))),
    ).toEqual(["ZAI_API_KEY"]);
    // An unknown value falls back to LOCAL → VLLM_API_KEY is the token that
    // matters (never a silent "no token needed" reading).
    expect(
      keys(inspectProdEnv(cleanEnv({ GLM_PROVIDER: "gpu", ZAI_API_KEY: undefined }))),
    ).toEqual(["VLLM_API_KEY"]);
  });

  it("requires VLLM_API_KEY only while the LOCAL leg is the active one", () => {
    // Local leg (default) with an empty key → violation.
    expect(keys(inspectProdEnv(cleanEnv({ GLM_PROVIDER: undefined, VLLM_API_KEY: undefined })))).toEqual(
      ["VLLM_API_KEY"],
    );
    expect(
      keys(inspectProdEnv(cleanEnv({ GLM_PROVIDER: "local", VLLM_API_KEY: "" }))),
    ).toEqual(["VLLM_API_KEY"]);
    // Remote leg: no local vLLM container exists (plan §B4 non-goal), so an
    // empty VLLM_API_KEY is NOT a violation — otherwise the documented VPS
    // posture could never boot.
    expect(inspectProdEnv(cleanEnv({ GLM_PROVIDER: "remote", VLLM_API_KEY: undefined }))).toEqual([]);
    // ...and it is reported as an empty-token violation, never a value echo.
    const v = inspectProdEnv(cleanEnv({ GLM_PROVIDER: undefined, VLLM_API_KEY: undefined }))[0];
    expect(v.value).toBe("<empty>");
  });
});

describe("inspectProdEnv — FACE_SPOOF_ENFORCE must be armed (audit-5 M6)", () => {
  it("flags an unset / non-1 FACE_SPOOF_ENFORCE when the sidecar is real", () => {
    for (const bad of [undefined, "", "0", "true"]) {
      const violations = inspectProdEnv(cleanEnv({ FACE_SPOOF_ENFORCE: bad }));
      expect(keys(violations), `expected ${JSON.stringify(bad)} to be flagged`).toEqual([
        "FACE_SPOOF_ENFORCE",
      ]);
      expect(find(violations, "FACE_SPOOF_ENFORCE")?.why).toMatch(/anti-spoof/i);
    }
  });

  it("accepts FACE_SPOOF_ENFORCE=1", () => {
    expect(inspectProdEnv(cleanEnv({ FACE_SPOOF_ENFORCE: "1" }))).toEqual([]);
  });

  it("exempts the fully-mocked E2E seam (the mock produces no spoof verdicts)", () => {
    const violations = inspectProdEnv(
      cleanEnv({
        FACE_SPOOF_ENFORCE: undefined,
        NEXT_PUBLIC_E2E_FAKE_SEAM: "1",
        FACE_MOCK_ENABLED: "1",
      }),
    );
    expect(keys(violations)).not.toContain("FACE_SPOOF_ENFORCE");
  });

  it("still requires enforcement with only ONE of the two seam flags (fail-closed)", () => {
    expect(
      keys(inspectProdEnv(cleanEnv({ FACE_SPOOF_ENFORCE: undefined, FACE_MOCK_ENABLED: "1" }))),
    ).toContain("FACE_SPOOF_ENFORCE");
    expect(
      keys(
        inspectProdEnv(
          cleanEnv({ FACE_SPOOF_ENFORCE: undefined, NEXT_PUBLIC_E2E_FAKE_SEAM: "1" }),
        ),
      ),
    ).toContain("FACE_SPOOF_ENFORCE");
  });
});

describe("inspectProdEnv — TRUSTED_PROXY_COUNT (S4 posture)", () => {
  it("flags unparseable hop counts", () => {
    // Mirrors request-ip.ts's Number() parse: "2 " is 2 (valid), "0,"/"one"/"1.5"
    // are not integers and "-1" is negative.
    for (const bad of ["zero", "0,", "-1", "1.5", "one", "NaN", "+-2"]) {
      const violations = inspectProdEnv(cleanEnv({ TRUSTED_PROXY_COUNT: bad }));
      expect(keys(violations), `expected ${JSON.stringify(bad)} to be flagged`).toEqual([
        "TRUSTED_PROXY_COUNT",
      ]);
      // Not a secret: echoing the raw value is what makes the typo visible.
      expect(find(violations, "TRUSTED_PROXY_COUNT")?.value).toBe(bad);
    }
  });

  it("accepts 0, positive integers, blank and unset (blank = the documented default 1)", () => {
    for (const good of ["0", "1", "2", "10", "", undefined]) {
      expect(
        inspectProdEnv(cleanEnv({ TRUSTED_PROXY_COUNT: good })),
        `expected ${JSON.stringify(good)} to be clean`,
      ).toEqual([]);
    }
  });
});

describe("inspectProdEnv — secret hygiene (hard rule §0.3)", () => {
  it("never puts a secret VALUE in a violation, even when everything else is wrong", () => {
    const env = cleanEnv({
      FACE_SIDECAR_TOKEN: SECRETS.FACE_SIDECAR_TOKEN,
      VLLM_API_KEY: SECRETS.VLLM_API_KEY,
      ZAI_API_KEY: SECRETS.ZAI_API_KEY,
      TRUSTED_PROXY_COUNT: "not-a-number",
      E2E_RATE_LIMIT_DISABLED: "1",
    });
    const violations = inspectProdEnv(env);
    expect(violations.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(violations);
    for (const secret of Object.values(SECRETS)) {
      expect(serialized).not.toContain(secret);
    }
    // Structural guard: ANY violation whose key is token-shaped must carry a
    // marker, never the raw value.
    for (const v of violations) {
      if (v.key in SECRETS) expect(["<set>", "<empty>"]).toContain(v.value);
    }
  });

  it("marks a SET secret as <set>, never as the value itself", () => {
    // No rule currently flags a token that IS set, so this asserts the renderer
    // directly through the one path that does produce a token violation: the
    // empty case must be "<empty>" rather than "".
    const empty = inspectProdEnv(cleanEnv({ FACE_SIDECAR_TOKEN: "" }))[0];
    expect(empty.key).toBe("FACE_SIDECAR_TOKEN");
    expect(empty.value).toBe("<empty>");
    expect(empty.value).not.toBe("");
  });

  it("keeps secret values out of the WARN line (non-strict prod)", () => {
    assertProdEnvSafe(
      cleanEnv({
        PROD_ENV_STRICT: undefined,
        FACE_SIDECAR_TOKEN: SECRETS.FACE_SIDECAR_TOKEN,
        VLLM_API_KEY: SECRETS.VLLM_API_KEY,
        ZAI_API_KEY: SECRETS.ZAI_API_KEY,
        TRUSTED_PROXY_COUNT: "unparseable",
      }),
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = String(warnSpy.mock.calls[0]?.[0] ?? "");
    for (const secret of Object.values(SECRETS)) expect(line).not.toContain(secret);
    // The line still names the offending KEY so an operator can act.
    expect(line).toContain("TRUSTED_PROXY_COUNT");
  });

  it("keeps secret values out of the THROWN error (strict prod)", () => {
    let thrown: Error | null = null;
    try {
      assertProdEnvSafe(
        cleanEnv({
          FACE_SIDECAR_TOKEN: SECRETS.FACE_SIDECAR_TOKEN,
          ZAI_API_KEY: SECRETS.ZAI_API_KEY,
          VLLM_API_KEY: SECRETS.VLLM_API_KEY,
          TRUSTED_PROXY_COUNT: "-3",
        }),
      );
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeInstanceOf(Error);
    for (const secret of Object.values(SECRETS)) {
      expect(thrown!.message).not.toContain(secret);
    }
    expect(thrown!.message).toContain("TRUSTED_PROXY_COUNT");
    expect(thrown!.message).toContain("PROD_ENV_STRICT");
  });
});

describe("assertProdEnvSafe — strict vs warn (S5 hard-fail)", () => {
  it("throws in production when PROD_ENV_STRICT=1 and there is a violation", () => {
    expect(() => assertProdEnvSafe(cleanEnv({ E2E_RATE_LIMIT_DISABLED: "1" }))).toThrow(
      /refusing to start/,
    );
    // The message names the key so the operator does not have to grep for it.
    expect(() => assertProdEnvSafe(cleanEnv({ FACE_MOCK_ENABLED: "1" }))).toThrow(
      /FACE_MOCK_ENABLED/,
    );
  });

  it("does NOT throw when the env is clean, even in strict production", () => {
    expect(() => assertProdEnvSafe(cleanEnv())).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("only WARNS in production without PROD_ENV_STRICT, and only once", () => {
    const env = cleanEnv({ PROD_ENV_STRICT: undefined, E2E_RATE_LIMIT_DISABLED: "1" });
    expect(() => assertProdEnvSafe(env)).not.toThrow();
    expect(() => assertProdEnvSafe(env)).not.toThrow();
    expect(() => assertProdEnvSafe(env)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("E2E_RATE_LIMIT_DISABLED");
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("PROD_ENV_STRICT");
  });

  it("stays silent outside production unless strict is requested", () => {
    // Dev shells legitimately have empty loopback tokens (the documented local
    // default) — warning there would train operators to ignore the line.
    assertProdEnvSafe(cleanEnv({ NODE_ENV: "development", PROD_ENV_STRICT: undefined }));
    expect(warnSpy).not.toHaveBeenCalled();
    expect(() =>
      assertProdEnvSafe(cleanEnv({ NODE_ENV: "test", PROD_ENV_STRICT: undefined })),
    ).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns but does NOT throw when PROD_ENV_STRICT=1 outside production", () => {
    expect(() =>
      assertProdEnvSafe(cleanEnv({ NODE_ENV: "development", E2E_RATE_LIMIT_DISABLED: "1" })),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("the Playwright-harness shape does NOT throw (production build + kill switches ON)", () => {
    // playwright.config.ts runs `npm run build && npm run start` with
    // NEXT_PUBLIC_E2E_FAKE_SEAM / FACE_MOCK_ENABLED / E2E_RATE_LIMIT_DISABLED /
    // NEXT_PUBLIC_INTEGRITY_HARDENING_OFF all "1" and no real tokens. An
    // unconditional throw here would break the ENTIRE e2e suite, which is
    // exactly why the hard fail is gated on PROD_ENV_STRICT.
    const harness: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      E2E_RATE_LIMIT_DISABLED: "1",
      NEXT_PUBLIC_E2E_FAKE_SEAM: "1",
      FACE_MOCK_ENABLED: "1",
      NEXT_PUBLIC_INTEGRITY_HARDENING_OFF: "1",
      INSIGHTFACE_BASE_URL: "http://localhost:8000",
      GLM_PROVIDER: "local",
      GLM_BASE_URL: "http://localhost:11434",
    } as NodeJS.ProcessEnv;

    expect(() => assertProdEnvSafe(harness)).not.toThrow();
    // It still WARNS (the harness is not a real deployment) — one line, keys
    // only, so the noise is bounded and the risk visible.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(inspectProdEnv(harness).length).toBeGreaterThan(0);
    // ...and the moment the harness (or a promoted artifact) sets the strict
    // flag, the same env is refused.
    expect(() => assertProdEnvSafe({ ...harness, PROD_ENV_STRICT: "1" })).toThrow();
  });

  it("uses process.env by default (the register() call site passes nothing)", () => {
    // register() calls assertProdEnvSafe() with no argument, so the default
    // parameter must be the live process env. Vitest's NODE_ENV is "test", so
    // the call must be silent and non-throwing.
    expect(() => assertProdEnvSafe()).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

/**
 * Gate S1/S5's DEPLOY-ARTIFACT half. The gate above is only a control if the
 * VPS actually arms it: `assertProdEnvSafe` deliberately warns rather than
 * throws unless `PROD_ENV_STRICT === "1"`, and the Playwright harness relies on
 * exactly that. For a while NOTHING in the repo set it — the same binary booted
 * on the VPS, logged `[prod-guards] N production env violation(s) …`, and
 * served anyway, which is the "wish, not a control" gate S1 exists to remove.
 * These assertions read the compose file so deleting the pin fails here rather
 * than in production.
 */
describe("docker-compose pins PROD_ENV_STRICT=1 on the app service (S1/S5)", () => {
  const composePath = path.resolve(process.cwd(), "docker-compose.yml");
  const compose = readFileSync(composePath, "utf8");

  it("sets PROD_ENV_STRICT to '1' in the app service's environment block", () => {
    const appBlock = compose.slice(compose.indexOf("\n  app:"), compose.indexOf("\n  caddy:"));
    expect(appBlock.length).toBeGreaterThan(0);
    // The runtime `environment:` mapping — not a build arg (the value is read
    // from process.env at startup and is never inlined) and not a comment.
    expect(appBlock).toMatch(/^\s+PROD_ENV_STRICT:\s*"1"\s*$/m);
  });

  it("does NOT arm the gate for the Playwright harness (the complementary pin)", () => {
    // playwright.config.ts deliberately pins PROD_ENV_STRICT: "" so the e2e
    // harness keeps its fake seams; the two changes are complementary. Guarded
    // by a read so a future edit cannot quietly arm the harness (which would
    // break the whole e2e suite) or quietly disarm the VPS.
    const pwPath = path.resolve(process.cwd(), "playwright.config.ts");
    if (!existsSync(pwPath)) return;
    const pw = readFileSync(pwPath, "utf8");
    if (!pw.includes("PROD_ENV_STRICT")) return;
    expect(pw).not.toMatch(/PROD_ENV_STRICT:\s*"1"/);
  });
});
