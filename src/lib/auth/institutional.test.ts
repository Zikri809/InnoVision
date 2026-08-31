import { describe, expect, it, vi, afterEach } from "vitest";
import {
  institutionalDomains,
  isAllowedInstitutionalEmail,
  isSsoConfigured,
} from "./institutional";

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.INSTITUTIONAL_EMAIL_DOMAINS;
});

describe("AU-2 — institutionalDomains", () => {
  it("parses a comma list, trims, and lowercases", () => {
    expect(institutionalDomains(" XXXuni.edu.my , Sub2.XXXuni.edu.my,,")).toEqual([
      "xxxuni.edu.my",
      "sub2.xxxuni.edu.my",
    ]);
  });

  it("is empty when unset or blank (SSO disabled)", () => {
    expect(institutionalDomains(undefined)).toEqual([]);
    expect(institutionalDomains("  ")).toEqual([]);
    expect(isSsoConfigured()).toBe(false);
  });

  it("reads the env var at call time", () => {
    vi.stubEnv("INSTITUTIONAL_EMAIL_DOMAINS", "xxxuni.edu.my");
    expect(isSsoConfigured()).toBe(true);
  });
});

describe("AU-2 — isAllowedInstitutionalEmail (domain-filter matrix)", () => {
  const allowed = ["xxxuni.edu.my", "staff.xxxuni.edu.my"];

  it("accepts an exact allowlisted domain case-insensitively", () => {
    expect(isAllowedInstitutionalEmail("Student@XXXUni.EDU.MY", allowed)).toEqual({
      ok: true,
      domain: "xxxuni.edu.my",
    });
    expect(isAllowedInstitutionalEmail("lecturer@Staff.XXXuni.edu.my", allowed).ok).toBe(true);
  });

  it("rejects personal Microsoft/consumer domains", () => {
    for (const email of [
      "student@outlook.com",
      "student@hotmail.com",
      "student@gmail.com",
      "student@live.com.my",
    ]) {
      expect(isAllowedInstitutionalEmail(email, allowed)).toEqual({
        ok: false,
        reason: "not_allowed",
      });
    }
  });

  it("rejects lookalike suffixes (no wildcard subdomain or suffix match)", () => {
    // Subdomains are NOT auto-allowed (exact-match semantics, pinned).
    expect(isAllowedInstitutionalEmail("s@sub.xxxuni.edu.my", allowed).ok).toBe(false);
    // Suffix-spoofing host must not pass ("evilxxxuni.edu.my" ends with the
    // allowed domain as a string but is a different registrable domain).
    expect(isAllowedInstitutionalEmail("s@evilxxxuni.edu.my", allowed).ok).toBe(false);
  });

  it("rejects missing/malformed email (never admit an unknown identity)", () => {
    expect(isAllowedInstitutionalEmail(null, allowed)).toEqual({ ok: false, reason: "no_email" });
    expect(isAllowedInstitutionalEmail("", allowed)).toEqual({ ok: false, reason: "no_email" });
    expect(isAllowedInstitutionalEmail("no-at-sign", allowed)).toEqual({ ok: false, reason: "no_email" });
    expect(isAllowedInstitutionalEmail("user@", allowed)).toEqual({ ok: false, reason: "no_email" });
  });

  it("rejects everything when the allowlist is empty (SSO misconfig fail-closed)", () => {
    expect(isAllowedInstitutionalEmail("s@xxxuni.edu.my", []).ok).toBe(false);
  });

  it("splits on the LAST @ (unusual local parts cannot spoof the domain)", () => {
    expect(isAllowedInstitutionalEmail('a@b@xxxuni.edu.my', allowed).ok).toBe(true);
    expect(isAllowedInstitutionalEmail("a@b@evilxxxuni.edu.my", allowed).ok).toBe(false);
  });
});
