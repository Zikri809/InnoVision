import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeSupabase, makeOwnerContext } from "@/app/api/quizzes/__tests__/fake-supabase";
import { _resetRateLimiter, _seedRateLimit } from "@/lib/classes/rate-limit";
import * as reviewRoute from "@/app/api/face/enrollments/review/route";

const fakeHolder: { current: FakeSupabase | undefined } = { current: undefined };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeHolder.current,
}));

/**
 * audit-5 M4 — POST /api/face/enrollments/review.
 *
 * Pins the lecturer adjudication surface for a pending_review
 * (duplicate-detected) face enrollment: `decision: 'approve'` selects
 * `approve_face_enrollment`, `'reject'` selects `reject_face_enrollment`, and
 * every failure shape maps to a typed status (never a raw 503). Before this
 * route the RPCs had zero callers, so a flagged student was permanently
 * blocked.
 */
const STUDENT_ID = "00000000-0000-4000-8000-0000000000b1";
const LECTURER_ID = "00000000-0000-4000-8000-0000000000b2";

function req(body?: unknown, init?: RequestInit): Request {
  return new Request("http://localhost/api/face/enrollments/review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A lecturer-owned context with a pending_review student in the class. */
function lecturerContext() {
  const ctx = makeOwnerContext({ quizStatus: "live" });
  const client = ctx.client;
  client.setUser(LECTURER_ID, "lecturer");
  // The RPC stub authorizes via the seeded profile role; the student row the
  // review targets is seeded with a pending_review status.
  client.seedProfile({
    id: STUDENT_ID,
    role: "student",
    consent_given_at: "2026-01-01T00:00:00Z",
    face_enrollment_status: "pending_review",
  });
  fakeHolder.current = client;
  return ctx;
}

beforeEach(() => {
  _resetRateLimiter();
  fakeHolder.current = undefined;
});

describe("POST /api/face/enrollments/review — audit-5 M4", () => {
  it("approve → 200 {ok:true, status:'enrolled'}", async () => {
    const ctx = lecturerContext();
    const res = await reviewRoute.POST(req({ studentId: STUDENT_ID, decision: "approve" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "enrolled" });
    const profile = (ctx.client.tables["profiles"] ?? []).find((p) => p.id === STUDENT_ID);
    expect(profile?.face_enrollment_status).toBe("enrolled");
  });

  it("reject → 200 {ok:true, status:null} and clears the status", async () => {
    const ctx = lecturerContext();
    const res = await reviewRoute.POST(req({ studentId: STUDENT_ID, decision: "reject" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: null });
    const profile = (ctx.client.tables["profiles"] ?? []).find((p) => p.id === STUDENT_ID);
    expect(profile?.face_enrollment_status).toBeNull();
  });

  it("approve of a non-pending enrollment → 409 not_pending", async () => {
    const ctx = lecturerContext();
    const profile = (ctx.client.tables["profiles"] ?? []).find((p) => p.id === STUDENT_ID);
    profile!.face_enrollment_status = "enrolled";
    const res = await reviewRoute.POST(req({ studentId: STUDENT_ID, decision: "approve" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not_pending");
  });

  it("a foreign/missing student id → 404 (no oracle)", async () => {
    const ctx = lecturerContext();
    ctx.client.rpcResult = { data: { error: "not_owner" }, error: null };
    const res = await reviewRoute.POST(
      req({ studentId: "00000000-0000-4000-8000-0000000000ff", decision: "approve" }),
    );
    expect(res.status).toBe(404);
  });

  it("a student caller → 403 (requireLecturer)", async () => {
    const ctx = lecturerContext();
    ctx.client.setUser(STUDENT_ID, "student");
    const res = await reviewRoute.POST(req({ studentId: STUDENT_ID, decision: "approve" }));
    expect(res.status).toBe(403);
  });

  it("an invalid decision → 400 (Zod)", async () => {
    lecturerContext();
    const res = await reviewRoute.POST(req({ studentId: STUDENT_ID, decision: "maybe" }));
    expect(res.status).toBe(400);
  });

  it("a malformed studentId → 400 (Zod)", async () => {
    lecturerContext();
    const res = await reviewRoute.POST(req({ studentId: "not-a-uuid", decision: "approve" }));
    expect(res.status).toBe(400);
  });

  it("a transport/RPC error → 503 (never a raw message)", async () => {
    const ctx = lecturerContext();
    ctx.client.rpcResult = { data: null, error: { message: "connection reset" } };
    const res = await reviewRoute.POST(req({ studentId: STUDENT_ID, decision: "approve" }));
    expect(res.status).toBe(503);
    expect((await res.json()).message).not.toContain("connection reset");
  });

  it("is rate-limited per lecturer (429 past the ceiling)", async () => {
    lecturerContext();
    _seedRateLimit(`face-enroll-review:${LECTURER_ID}`, 30);
    const res = await reviewRoute.POST(req({ studentId: STUDENT_ID, decision: "approve" }));
    expect(res.status).toBe(429);
  });

  it("rejects a cross-origin POST (CSRF)", async () => {
    lecturerContext();
    const res = await reviewRoute.POST(
      new Request("http://localhost/api/face/enrollments/review", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "localhost",
          origin: "https://evil.example",
        },
        body: JSON.stringify({ studentId: STUDENT_ID, decision: "approve" }),
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("invalid_origin");
  });
});
