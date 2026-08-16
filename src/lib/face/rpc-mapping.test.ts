import { describe, it, expect } from "vitest";
import { mapFaceError } from "./rpc-mapping";

/**
 * Common-key table (PLAN_PHASE7 Step 4): not_owner→404, session_not_active→409,
 * not_authenticated→401, not_student→403, quiz_not_live→409, transport/unknown→503.
 */
describe("mapFaceError", () => {
  it("returns null when the payload is not an error", () => {
    expect(mapFaceError(null)).toBeNull();
    expect(mapFaceError(undefined)).toBeNull();
    expect(mapFaceError({ matched: true })).toBeNull();
    expect(mapFaceError({})).toBeNull();
  });

  it("not_owner → 404", async () => {
    const res = mapFaceError({ error: "not_owner" });
    expect(res?.status).toBe(404);
    expect((await res?.json())?.error).toBe("not_found");
  });

  it("session_not_active / quiz_not_live → 409", async () => {
    const a = mapFaceError({ error: "session_not_active" });
    expect(a?.status).toBe(409);
    expect((await a?.json())?.error).toBe("session_not_active");

    const b = mapFaceError({ error: "quiz_not_live" });
    expect(b?.status).toBe(409);
  });

  it("not_authenticated → 401", () => {
    expect(mapFaceError({ error: "not_authenticated" })?.status).toBe(401);
  });

  it("not_student / not_lecturer → 403", () => {
    expect(mapFaceError({ error: "not_student" })?.status).toBe(403);
    expect(mapFaceError({ error: "not_lecturer" })?.status).toBe(403);
  });

  it("not_assessment → 400 (mode mismatch is a client error)", async () => {
    const res = mapFaceError({ error: "not_assessment" });
    expect(res?.status).toBe(400);
    expect((await res?.json())?.error).toBe("not_assessment");
  });

  it("duplicate_detected → 409", () => {
    expect(mapFaceError({ error: "duplicate_detected" })?.status).toBe(409);
  });

  it("invalid_frame / pose_invalid → 400", async () => {
    const f = mapFaceError({ error: "invalid_frame" });
    expect(f?.status).toBe(400);
    expect((await f?.json())?.error).toBe("invalid_frame");
    expect(mapFaceError({ error: "pose_invalid" })?.status).toBe(400);
  });

  it("compreface_unavailable → 503", async () => {
    const res = mapFaceError({ error: "compreface_unavailable" });
    expect(res?.status).toBe(503);
    expect((await res?.json())?.error).toBe("compreface_unavailable");
  });

  it("unknown payload → 503 internal (never a raw message)", async () => {
    const res = mapFaceError({ error: "weird_thing" });
    expect(res?.status).toBe(503);
    const body = await res?.json();
    expect(body.error).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("weird_thing");
  });

  it("overrides win for route-specific keys", async () => {
    const res = mapFaceError({ error: "consent_required" }, { consent_required: { status: 403 } });
    expect(res?.status).toBe(403);
    expect((await res?.json())?.error).toBe("consent_required");
  });

  it("override can remap the error key", async () => {
    const res = mapFaceError(
      { error: "live_assessment" },
      { live_assessment: { status: 409, error: "live_assessment" } },
    );
    expect(res?.status).toBe(409);
  });
});
