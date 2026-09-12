import { describe, it, expect } from "vitest";
import { joinErrorKey } from "./join-errors";

/**
 * Table tests for the /join confirm island's error mapping. The mapping is
 * pure (no React/next-intl) so every branch is pinned here — the drawer's
 * raw-English precedent shows these rots happen silently.
 */
describe("joinErrorKey", () => {
  it("maps every typed business error from /api/classes/join", () => {
    expect(joinErrorKey(400, "invalid_code")).toBe("invalidCode");
    expect(joinErrorKey(409, "already_enrolled")).toBe("alreadyEnrolled");
    expect(joinErrorKey(429, "join_locked")).toBe("joinLocked");
    expect(joinErrorKey(429, "rate_limited")).toBe("rateLimited");
    expect(joinErrorKey(403, "forbidden")).toBe("forbidden");
    // audit-2 M-04: class_archived is folded to invalid_code ROUTE-side (no
    // existence oracle), so the mapper must never see it; audit-2 H-11:
    // matric_required is intercepted by the island (router.replace) before
    // the mapper runs. Both absent here on purpose.
  });

  it("maps transport/auth/CSRF errors to the generic key", () => {
    expect(joinErrorKey(400, "invalid_json")).toBe("generic");
    expect(joinErrorKey(503, "internal")).toBe("generic");
    expect(joinErrorKey(401, "unauthorized")).toBe("generic");
    expect(joinErrorKey(403, "invalid_origin")).toBe("generic");
  });

  it("folds unknown errors by status family", () => {
    expect(joinErrorKey(500, undefined)).toBe("generic");
    expect(joinErrorKey(401, "something_new")).toBe("generic");
    expect(joinErrorKey(403, "something_new")).toBe("generic");
    // Non-5xx, non-auth unknown: the code is the likeliest culprit.
    expect(joinErrorKey(400, "something_new")).toBe("invalidCode");
  });
});
