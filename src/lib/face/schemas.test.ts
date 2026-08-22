import { describe, it, expect } from "vitest";
import { frameSchema, verifyFrameSchema, EnrollSchema, VerifySchema, ConsentSchema, ExemptSchema } from "./schemas";
import { MAX_FRAME_BASE64_CHARS } from "./constants";

/**
 * U-F4 (CompreFace migration) — frame schema validation (base64 JPEG data URL
 * contract). The wire payload is a frame string, not a 192-dim embedding.
 */
describe("face schemas (CompreFace frames)", () => {
  it("U-F4: accepts a non-empty frame string", () => {
    expect(frameSchema.safeParse("data:image/jpeg;base64,abc").success).toBe(true);
  });

  it("U-F4: rejects empty string", () => {
    expect(frameSchema.safeParse("").success).toBe(false);
  });

  it("U-F4: rejects non-string / null", () => {
    expect(frameSchema.safeParse(123).success).toBe(false);
    expect(frameSchema.safeParse(null).success).toBe(false);
    expect(frameSchema.safeParse(undefined).success).toBe(false);
  });

  it("U-F4: frameSchema does NOT cap size (the route returns 413 — a Zod max would preempt it)", () => {
    // The schema validates shape only; the ROUTE rejects oversized frames with
    // 413 (payloadTooLarge). Assert the schema itself accepts any length.
    expect(frameSchema.safeParse("a".repeat(MAX_FRAME_BASE64_CHARS + 1)).success).toBe(true);
  });

  it("U-F4: EnrollSchema requires exactly 3 frames", () => {
    expect(EnrollSchema.safeParse({ frames: ["a", "b", "c"] }).success).toBe(true);
    expect(EnrollSchema.safeParse({ frames: ["a", "b"] }).success).toBe(false);
    expect(EnrollSchema.safeParse({ frames: ["a", "b", "c", "d"] }).success).toBe(false);
    expect(EnrollSchema.safeParse({ frames: ["a", "", "c"] }).success).toBe(false);
  });

  it("U-F4: verifyFrameSchema accepts the EMPTY no-face sentinel", () => {
    // The verify route treats an empty frame string as the client's "no face
    // captured" vote (a FAIL vote — never a silent pass). Enrollment frames
    // stay non-empty via `frameSchema`.
    expect(verifyFrameSchema.safeParse("").success).toBe(true);
    expect(verifyFrameSchema.safeParse("data:image/jpeg;base64,abc").success).toBe(true);
    expect(verifyFrameSchema.safeParse(123).success).toBe(false);
    const base = {
      frames: [""],
      trigger: "start",
      nonce: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000002",
    };
    expect(VerifySchema.safeParse(base).success).toBe(true);
  });

  it("VerifySchema: validates 1–3 frames + trigger + nonce + sessionId", () => {
    const nonce = "00000000-0000-4000-8000-000000000001";
    const sessionId = "00000000-0000-4000-8000-000000000002";
    const base = { frames: ["data:image/jpeg;base64,abc"], trigger: "start", nonce, sessionId };
    expect(VerifySchema.safeParse({ ...base, trigger: "start" }).success).toBe(true);
    expect(VerifySchema.safeParse({ ...base, trigger: "question" }).success).toBe(true);
    expect(VerifySchema.safeParse({ ...base, trigger: "periodic" }).success).toBe(true);
    expect(VerifySchema.safeParse({ ...base, trigger: "other" }).success).toBe(false);
    expect(VerifySchema.safeParse({ ...base, nonce: "not-a-uuid" }).success).toBe(false);
    expect(VerifySchema.safeParse({ ...base, frames: [] }).success).toBe(false);
    expect(
      VerifySchema.safeParse({ ...base, frames: ["a", "b", "c", "d"] }).success,
    ).toBe(false);
  });

  it("ConsentSchema: requires a boolean", () => {
    expect(ConsentSchema.safeParse({ consent: true }).success).toBe(true);
    expect(ConsentSchema.safeParse({ consent: false }).success).toBe(true);
    expect(ConsentSchema.safeParse({ consent: "yes" }).success).toBe(false);
    expect(ConsentSchema.safeParse({}).success).toBe(false);
  });

  it("ExemptSchema: requires a non-empty reason", () => {
    expect(ExemptSchema.safeParse({ reason: "camera broken" }).success).toBe(true);
    expect(ExemptSchema.safeParse({ reason: "  " }).success).toBe(false);
    expect(ExemptSchema.safeParse({ reason: "" }).success).toBe(false);
    expect(ExemptSchema.safeParse({}).success).toBe(false);
  });
});