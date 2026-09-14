import { describe, expect, it, vi } from "vitest";

/**
 * Security-header + deployment-origin contracts from next.config.ts.
 *
 * audit-3 R3-INT-F1: `Permissions-Policy: microphone=()` is an EMPTY allowlist
 * that blocks same-origin too, so the integrity suite's own
 * `getUserMedia({audio:true})` (src/components/face/use-integrity-advisories.ts)
 * always failed with NotAllowedError — the voice_activity + headset_active
 * advisories and the incident-clip audio track were dead in every deployment.
 * The assertion below pins the corrected allowlist.
 *
 * audit-3 H-F8: the server-action / dev-origin allowlists must be env-driven,
 * not a hardcoded single deployment.
 */
const { default: nextConfig } = await import("../next.config");

describe("Permissions-Policy (audit-3 R3-INT-F1)", () => {
  it("allows same-origin microphone access", async () => {
    const rules = await nextConfig.headers!();
    const header = rules
      .flatMap((r) => r.headers)
      .find((h) => h.key === "Permissions-Policy");
    expect(header).toBeDefined();
    expect(header!.value).toContain("microphone=(self)");
    // The empty allowlist is the exact regression: it blocks self too.
    expect(header!.value).not.toMatch(/microphone=\(\s*\)/);
    // Camera was already correct and must stay.
    expect(header!.value).toContain("camera=(self)");
  });
});

describe("deployment origins (audit-3 H-F8 / R2-TOP-F1)", () => {
  it("server actions allow origins are env-driven, keeping the tunnel default", () => {
    const origins = nextConfig.experimental!.serverActions!.allowedOrigins!;
    expect(origins).toContain("innovision.zikr-i.uk");
    expect(nextConfig.allowedDevOrigins).toEqual(origins);
  });

  it("picks up an extra deployment origin from TRUSTED_ORIGINS", async () => {
    vi.resetModules();
    vi.stubEnv("TRUSTED_ORIGINS", "https://staging.example.edu");
    const { default: fresh } = await import("../next.config");
    expect(fresh.experimental!.serverActions!.allowedOrigins).toContain(
      "staging.example.edu",
    );
    vi.unstubAllEnvs();
  });
});
