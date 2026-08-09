import { describe, it, expect } from "vitest";
import { sanitizeRedirect } from "@/lib/auth/redirect";

const ORIGIN = "https://innovision.example";

describe("sanitizeRedirect", () => {
  it("passes through a local path", () => {
    expect(sanitizeRedirect("/dashboard", ORIGIN)).toBe("/dashboard");
    expect(sanitizeRedirect("/lecturer/classes", ORIGIN)).toBe("/lecturer/classes");
  });

  it("preserves query/hash on a local path", () => {
    expect(sanitizeRedirect("/login?message=check-email", ORIGIN)).toBe(
      "/login?message=check-email",
    );
  });

  it("rejects protocol-relative URLs", () => {
    expect(sanitizeRedirect("//evil.com", ORIGIN)).toBe("/dashboard");
    expect(sanitizeRedirect("//evil.com/path", ORIGIN)).toBe("/dashboard");
  });

  it("rejects absolute URLs", () => {
    expect(sanitizeRedirect("https://evil.com", ORIGIN)).toBe("/dashboard");
    expect(sanitizeRedirect("http://evil.com/x", ORIGIN)).toBe("/dashboard");
  });

  it("rejects backslash variants that normalize to external hosts", () => {
    expect(sanitizeRedirect("/\\evil.com", ORIGIN)).toBe("/dashboard");
    expect(sanitizeRedirect("/%5cevil.com", ORIGIN)).toBe("/dashboard");
    expect(sanitizeRedirect("\\evil.com", ORIGIN)).toBe("/dashboard");
  });

  it("rejects CR/LF header-injection vectors (raw and percent-encoded)", () => {
    expect(sanitizeRedirect("/login%0d%0aX:y", ORIGIN)).toBe("/dashboard");
    expect(sanitizeRedirect("/login%0d%0aLocation:%20https://evil.com", ORIGIN)).toBe("/dashboard");
    expect(sanitizeRedirect("/login%0aX:y", ORIGIN)).toBe("/dashboard");
    expect(sanitizeRedirect("/login%0dX:y", ORIGIN)).toBe("/dashboard");
    expect(sanitizeRedirect("/login\r\nX:y", ORIGIN)).toBe("/dashboard");
  });

  it("rejects values that don't start with a slash", () => {
    expect(sanitizeRedirect("evil.com", ORIGIN)).toBe("/dashboard");
    expect(sanitizeRedirect("javascript:alert(1)", ORIGIN)).toBe("/dashboard");
  });

  it("falls back for empty/null/undefined", () => {
    expect(sanitizeRedirect("", ORIGIN)).toBe("/dashboard");
    expect(sanitizeRedirect(null, ORIGIN)).toBe("/dashboard");
    expect(sanitizeRedirect(undefined, ORIGIN)).toBe("/dashboard");
  });
});
