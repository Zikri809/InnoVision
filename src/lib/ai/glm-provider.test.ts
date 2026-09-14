import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_GLM_BASE_URL,
  DEFAULT_GLM_MODEL,
  DEFAULT_ZAI_BASE_URL,
  LOCAL_MAX_DATAURL_CHARS,
  LOCAL_MAX_IMAGE_BYTES,
  LOCAL_MAX_PAGES,
  REMOTE_MAX_DATAURL_CHARS,
  REMOTE_MAX_IMAGE_BYTES,
  REMOTE_MAX_PAGES_DEFAULT,
  REMOTE_MAX_PDF_BYTES,
  _resetGlmProviderWarnForTests,
  glmProviderMisconfig,
  positiveIntEnv,
  resolveGlmProvider,
} from "@/lib/ai/glm-provider";
import { MAX_OCR_PAGES } from "@/lib/extract/types";

/**
 * glm-provider — the fail-closed selector (contract §4.1).
 *
 * The load-bearing property: only the exact string "remote" (case-insensitive,
 * trimmed) selects the BILLED leg. Every other input — including a typo, an
 * empty string, or a plausible-looking synonym — must select the free local leg.
 */

/** Minimal env object; ProcessEnv has many optional index keys. */
function env(vars: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return vars as NodeJS.ProcessEnv;
}

beforeEach(() => {
  _resetGlmProviderWarnForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("resolveGlmProvider — fail-closed selection", () => {
  it("defaults to local when GLM_PROVIDER is unset", () => {
    const cfg = resolveGlmProvider(env({}));
    expect(cfg.provider).toBe("local");
    expect(cfg.metered).toBe(false);
    expect(cfg.baseUrl).toBe(DEFAULT_GLM_BASE_URL);
    expect(cfg.model).toBe(DEFAULT_GLM_MODEL);
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.maxPages).toBe(LOCAL_MAX_PAGES);
    expect(cfg.maxImageBytes).toBe(LOCAL_MAX_IMAGE_BYTES);
    expect(cfg.maxPdfBytes).toBe(0);
    expect(cfg.maxDataUrlChars).toBe(LOCAL_MAX_DATAURL_CHARS);
  });

  it("selects local for the literal value 'local'", () => {
    expect(resolveGlmProvider(env({ GLM_PROVIDER: "local" })).provider).toBe("local");
  });

  it("selects local for an empty string", () => {
    expect(resolveGlmProvider(env({ GLM_PROVIDER: "" })).provider).toBe("local");
  });

  it("selects local for whitespace only", () => {
    expect(resolveGlmProvider(env({ GLM_PROVIDER: "   " })).provider).toBe("local");
  });

  it("selects remote for the exact string 'remote'", () => {
    const cfg = resolveGlmProvider(env({ GLM_PROVIDER: "remote", ZAI_API_KEY: "k" }));
    expect(cfg.provider).toBe("remote");
    expect(cfg.metered).toBe(true);
    expect(cfg.baseUrl).toBe(DEFAULT_ZAI_BASE_URL);
    expect(cfg.apiKey).toBe("k");
    expect(cfg.maxPages).toBe(REMOTE_MAX_PAGES_DEFAULT);
    expect(cfg.maxImageBytes).toBe(REMOTE_MAX_IMAGE_BYTES);
    expect(cfg.maxPdfBytes).toBe(REMOTE_MAX_PDF_BYTES);
    expect(cfg.maxDataUrlChars).toBe(REMOTE_MAX_DATAURL_CHARS);
  });

  it("accepts 'remote' case-insensitively and trims surrounding whitespace", () => {
    for (const raw of ["REMOTE", "Remote", "  remote  ", "\tReMoTe\n"]) {
      expect(resolveGlmProvider(env({ GLM_PROVIDER: raw })).provider).toBe("remote");
    }
  });

  it("fails closed to local for an unrecognised value (never the metered leg)", () => {
    for (const raw of ["zai", "api", "cloud", "remotee", "1", "true", "yes"]) {
      const cfg = resolveGlmProvider(env({ GLM_PROVIDER: raw }));
      expect(cfg.provider).toBe("local");
      expect(cfg.metered).toBe(false);
    }
  });

  it("warns exactly once for an unrecognised non-empty value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveGlmProvider(env({ GLM_PROVIDER: "typo" }));
    resolveGlmProvider(env({ GLM_PROVIDER: "typo" }));
    resolveGlmProvider(env({ GLM_PROVIDER: "another-typo" }));
    expect(warn).toHaveBeenCalledTimes(1);
    // The warn must name the failure and the safe fallback — without echoing
    // anything secret (there is no secret here, but the posture is pinned).
    const line = warn.mock.calls[0][0] as string;
    expect(line).toMatch(/LOCAL/);
    expect(line).not.toContain("typo");
  });

  it("does not warn for unset / local / remote", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveGlmProvider(env({}));
    resolveGlmProvider(env({ GLM_PROVIDER: "local" }));
    resolveGlmProvider(env({ GLM_PROVIDER: "remote" }));
    expect(warn).not.toHaveBeenCalled();
  });

  it("re-arms the warn latch after the test reset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveGlmProvider(env({ GLM_PROVIDER: "typo" }));
    _resetGlmProviderWarnForTests();
    resolveGlmProvider(env({ GLM_PROVIDER: "typo" }));
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("resolveGlmProvider — per-leg env wiring", () => {
  it("local reads GLM_BASE_URL / VLLM_API_KEY and never ZAI_*", () => {
    const cfg = resolveGlmProvider(
      env({
        GLM_PROVIDER: "local",
        GLM_BASE_URL: "http://127.0.0.1:11434",
        VLLM_API_KEY: "local-secret",
        ZAI_API_KEY: "remote-secret",
        ZAI_BASE_URL: "https://example.invalid",
        OCR_GLM_MODEL: "custom-model",
      }),
    );
    expect(cfg.baseUrl).toBe("http://127.0.0.1:11434");
    expect(cfg.apiKey).toBe("local-secret");
    expect(cfg.model).toBe("custom-model");
  });

  it("remote reads ZAI_BASE_URL / ZAI_API_KEY and NEVER falls back to VLLM_API_KEY", () => {
    const cfg = resolveGlmProvider(
      env({
        GLM_PROVIDER: "remote",
        GLM_BASE_URL: "http://127.0.0.1:11434",
        VLLM_API_KEY: "local-secret",
        ZAI_API_KEY: "remote-secret",
        ZAI_BASE_URL: "https://api.z.ai/api/paas/v4",
      }),
    );
    expect(cfg.baseUrl).toBe("https://api.z.ai/api/paas/v4");
    expect(cfg.apiKey).toBe("remote-secret");

    // The local container's token must never be presented to Z.ai.
    const noZaiKey = resolveGlmProvider(
      env({ GLM_PROVIDER: "remote", VLLM_API_KEY: "local-secret" }),
    );
    expect(noZaiKey.apiKey).toBeUndefined();
  });

  it("treats an empty ZAI_API_KEY as unset", () => {
    expect(resolveGlmProvider(env({ GLM_PROVIDER: "remote", ZAI_API_KEY: "" })).apiKey).toBeUndefined();
  });

  it("honours GLM_REMOTE_MAX_PAGES and falls back on garbage", () => {
    expect(
      resolveGlmProvider(env({ GLM_PROVIDER: "remote", GLM_REMOTE_MAX_PAGES: "100" })).maxPages,
    ).toBe(100);
    for (const bad of ["0", "-5", "abc", "1.5", "NaN", ""]) {
      expect(
        resolveGlmProvider(env({ GLM_PROVIDER: "remote", GLM_REMOTE_MAX_PAGES: bad })).maxPages,
      ).toBe(REMOTE_MAX_PAGES_DEFAULT);
    }
  });

  it("keeps the local page cap equal to MAX_OCR_PAGES (cross-workstream pin)", () => {
    // `LOCAL_MAX_PAGES` is the route's cap; `MAX_OCR_PAGES` (types.ts, owned by
    // another workstream) is the client's. A drift silently loses pages.
    expect(LOCAL_MAX_PAGES).toBe(MAX_OCR_PAGES);
  });

  it("documents the remote data-URL cap as unreachable from the UI's own file cap", () => {
    // MAX_FILE_BYTES = 25 MB ⇒ a base64 data URL is at most ≈33.4M chars, well
    // under REMOTE_MAX_DATAURL_CHARS. The remote 50 MB PDF allowance is
    // therefore NOT reachable through the UI (documented in the module header).
    const MAX_FILE_BYTES = 25_000_000;
    const maxDataUrlForUiFile = Math.ceil(MAX_FILE_BYTES / 3) * 4 + 64;
    expect(REMOTE_MAX_DATAURL_CHARS).toBeGreaterThan(maxDataUrlForUiFile);
    expect(REMOTE_MAX_DATAURL_CHARS).toBeLessThan(50 * 1024 * 1024 * (4 / 3));
  });
});

describe("glmProviderMisconfig", () => {
  it("returns null on the local leg even with no key", () => {
    expect(glmProviderMisconfig(env({ GLM_PROVIDER: "local" }))).toBeNull();
  });

  it("returns 'missing_key' for remote without ZAI_API_KEY (never a local fallback)", () => {
    expect(glmProviderMisconfig(env({ GLM_PROVIDER: "remote" }))).toBe("missing_key");
    expect(
      glmProviderMisconfig(env({ GLM_PROVIDER: "remote", ZAI_API_KEY: "" })),
    ).toBe("missing_key");
    // A local-only key must not satisfy the remote leg.
    expect(
      glmProviderMisconfig(env({ GLM_PROVIDER: "remote", VLLM_API_KEY: "local" })),
    ).toBe("missing_key");
  });

  it("returns null for remote WITH a key", () => {
    expect(
      glmProviderMisconfig(env({ GLM_PROVIDER: "remote", ZAI_API_KEY: "k" })),
    ).toBeNull();
  });

  it("returns null for an unrecognised provider (it resolved to local)", () => {
    expect(glmProviderMisconfig(env({ GLM_PROVIDER: "nope" }))).toBeNull();
  });
});

describe("positiveIntEnv", () => {
  it("returns the parsed value for positive integers", () => {
    expect(positiveIntEnv("7", 3)).toBe(7);
    expect(positiveIntEnv(" 42 ", 3)).toBe(42);
  });

  it("falls back for unset / empty / unparseable / non-positive / non-integer", () => {
    for (const bad of [undefined, "", "  ", "abc", "0", "-1", "1.5", "Infinity", "NaN"]) {
      expect(positiveIntEnv(bad, 3)).toBe(3);
    }
  });
});
