import { describe, it, expect, vi, afterEach } from "vitest";
import { isValidInviteCode } from "@/lib/auth/invite-code";

describe("isValidInviteCode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts the correct code", () => {
    expect(isValidInviteCode("demo-code", "demo-code")).toBe(true);
  });

  it("accepts with surrounding whitespace trimmed", () => {
    expect(isValidInviteCode("  demo-code  ", "demo-code")).toBe(true);
  });

  it("rejects a wrong code", () => {
    expect(isValidInviteCode("wrong", "demo-code")).toBe(false);
  });

  it("rejects when expected is missing (disabled)", () => {
    expect(isValidInviteCode("anything", undefined)).toBe(false);
    expect(isValidInviteCode("anything", "")).toBe(false);
  });

  it("rejects null/undefined/empty input", () => {
    expect(isValidInviteCode(null, "demo-code")).toBe(false);
    expect(isValidInviteCode(undefined, "demo-code")).toBe(false);
    expect(isValidInviteCode("", "demo-code")).toBe(false);
    expect(isValidInviteCode("   ", "demo-code")).toBe(false);
  });

  it("reads from env when expected not passed", () => {
    vi.stubEnv("LECTURER_INVITE_CODE", "env-code-123");
    expect(isValidInviteCode("env-code-123")).toBe(true);
    expect(isValidInviteCode("nope")).toBe(false);
  });
});
