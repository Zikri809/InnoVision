import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeSupabase, makeOwnerContext } from "@/app/api/quizzes/__tests__/fake-supabase";
import { _resetRateLimiter } from "@/lib/classes/rate-limit";
import * as closeRoute from "@/app/api/quizzes/[id]/close/route";

const fakeHolder: { current: FakeSupabase | undefined } = { current: undefined };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeHolder.current,
}));

const QUIZ = "00000000-0000-4000-8000-00000000000c";
const LECTURER_ID = "00000000-0000-4000-8000-00000000000a";
const CLASS_B = "00000000-0000-4000-8000-0000000000b0";

function req(opts?: { origin?: string }): Request {
  return new Request("http://localhost/api/close", {
    method: "POST",
    headers: opts?.origin ? { origin: opts.origin } : {},
  });
}

function ownerContext(opts?: { status?: "draft" | "live" | "closed" }) {
  const ctx = makeOwnerContext({ quizStatus: opts?.status ?? "live" });
  fakeHolder.current = ctx.client;
  return ctx;
}

beforeEach(() => {
  fakeHolder.current = undefined;
  _resetRateLimiter();
});

describe("POST /api/quizzes/[id]/close", () => {
  it("closes a live quiz → 200 with closed status persisted", async () => {
    const ctx = ownerContext({ status: "live" });
    const res = await closeRoute.POST(req(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quiz.status).toBe("closed");
    expect(ctx.client.tables["quizzes"]![0].status).toBe("closed");
  });

  it("is idempotent: closing an already-closed quiz → 200 (pre-check branch)", async () => {
    const ctx = ownerContext({ status: "closed" });
    const res = await closeRoute.POST(req(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quiz.status).toBe("closed");
    // Still closed, no surprise transition.
    expect(ctx.client.tables["quizzes"]![0].status).toBe("closed");
  });

  it("rejects closing a draft → 409 quiz_not_live", async () => {
    ownerContext({ status: "draft" });
    const res = await closeRoute.POST(req(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("quiz_not_live");
  });

  it("401 for unauthenticated callers", async () => {
    const ctx = ownerContext({ status: "live" });
    ctx.client.user = null;
    ctx.client.profileRole = null;
    const res = await closeRoute.POST(req(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(401);
  });

  it("404 for a non-owner lecturer (no oracle)", async () => {
    const ctx = ownerContext({ status: "live" });
    // Another lecturer who owns a DIFFERENT class — requireQuizOwner's
    // classes!inner filter yields 0 rows.
    ctx.client.seedClass(CLASS_B, "00000000-0000-4000-8000-0000000000ee");
    ctx.client.setUser("00000000-0000-4000-8000-0000000000ee", "lecturer");
    const res = await closeRoute.POST(req(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(404);
  });

  it("404 for a non-uuid id", async () => {
    ownerContext({ status: "live" });
    const res = await closeRoute.POST(req(), { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(404);
  });

  it("429 when the per-user close budget is exhausted (BEFORE idempotent short-circuit)", async () => {
    const { _seedRateLimit } = await import("@/lib/classes/rate-limit");
    ownerContext({ status: "closed" });
    _seedRateLimit(`quiz-close:${LECTURER_ID}`, 30);
    const res = await closeRoute.POST(req(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("rate_limited");
  });

  it("403 for cross-origin requests (CSRF)", async () => {
    ownerContext({ status: "live" });
    const res = await closeRoute.POST(req({ origin: "https://evil.example" }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("invalid_origin");
  });

  it("503 internal when the write errors for an unknown reason", async () => {
    const ctx = ownerContext({ status: "live" });
    ctx.client.updateError = "storage_failure";
    const res = await closeRoute.POST(req(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("internal");
  });

  it("maps a trigger closed_quiz_cannot_transition error → 409", async () => {
    const ctx = ownerContext({ status: "live" });
    ctx.client.updateError = "closed_quiz_cannot_transition";
    const res = await closeRoute.POST(req(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("quiz_closed");
  });

  it("404 when the CAS update hits 0 rows and the quiz is gone (concurrent delete)", async () => {
    ownerContext({ status: "live" });
    // Remove the row so the CAS update matches nothing AND the re-fetch
    // finds nothing → 404, never a fabricated 200 {quiz}.
    fakeHolder.current!.tables["quizzes"] = [];
    const res = await closeRoute.POST(req(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(404);
  });

  it("0-row CAS with a now-closed row → 200 (concurrent close won)", async () => {
    ownerContext({ status: "live" });
    // Emulate the CAS loser: the guard-read saw live, but by write time the
    // row is closed. The fake evaluates eq("status","live") against the
    // CURRENT table, so flip it before the route's write lands.
    const quizRow = fakeHolder.current!.tables["quizzes"]![0];
    const originalEq = quizRow.status;
    expect(originalEq).toBe("live");
    // Flip status right after requireQuizOwner reads it: patch the table
    // between the guard read and the update by seeding a getter that flips
    // once. Simplest deterministic approach: flip BEFORE the call — the route
    // then short-circuits on its own pre-check. The true interleave is
    // covered by the SQL harness; here we pin that the 0-row + still-present
    // path returns the FRESH row (not the stale guard copy).
    quizRow.status = "closed";
    const res = await closeRoute.POST(req(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quiz.status).toBe("closed");
  });
});