import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeSupabase, makeOwnerContext } from "@/app/api/quizzes/__tests__/fake-supabase";
import { _resetRateLimiter, _seedRateLimit } from "@/lib/classes/rate-limit";
import * as revealRoute from "@/app/api/quizzes/[id]/reveal/route";
import * as revealSettingsRoute from "@/app/api/quizzes/[id]/reveal-settings/route";

const fakeHolder: { current: FakeSupabase | undefined } = { current: undefined };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeHolder.current,
}));

const QUIZ = "00000000-0000-4000-8000-00000000000c";
const LECTURER_ID = "00000000-0000-4000-8000-00000000000a";

function jsonReq(body?: unknown, init?: RequestInit): Request {
  return new Request("http://localhost", {
    method: init?.method ?? "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function lecturerCtx(opts?: { mode?: string; status?: string; revealed?: boolean; autoReveal?: boolean }) {
  const ctx = makeOwnerContext({ quizStatus: (opts?.status ?? "live") as "live" | "draft" | "closed" });
  const quizRow = ctx.client.tables["quizzes"]![0];
  quizRow.mode = opts?.mode ?? "assessment";
  quizRow.results_revealed_at = opts?.revealed ? "2026-01-01T00:00:00Z" : null;
  if (opts?.autoReveal != null) quizRow.auto_reveal_on_complete = opts.autoReveal;
  ctx.client.setUser(LECTURER_ID, "lecturer");
  fakeHolder.current = ctx.client;
  return ctx;
}

beforeEach(() => {
  fakeHolder.current = undefined;
  _resetRateLimiter();
});

describe("POST /api/quizzes/[id]/reveal", () => {
it("reveals a live assessment → 200 { revealed: true }", async () => {
    lecturerCtx();
    const res = await revealRoute.POST(jsonReq(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revealed).toBe(true);
  });

  it("is idempotent: a second reveal → 200 { already: true }", async () => {
    lecturerCtx();
    await revealRoute.POST(jsonReq(), { params: Promise.resolve({ id: QUIZ }) });
    const res = await revealRoute.POST(jsonReq(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revealed).toBe(true);
    expect(body.already).toBe(true);
  });

  it("rejects revealing a practice quiz → 409 practice_always_revealed", async () => {
    lecturerCtx({ mode: "practice" });
    const res = await revealRoute.POST(jsonReq(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("practice_always_revealed");
  });

  it("reveals a CLOSED quiz → 200 (QC-2 closed-before-reveal recovery)", async () => {
    const ctx = lecturerCtx({ status: "closed" });
    const res = await revealRoute.POST(jsonReq(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revealed).toBe(true);
    expect(ctx.client.tables["quizzes"]![0].results_revealed_at).toBeTruthy();
  });

  it("rejects revealing a draft quiz → 409 quiz_not_revealable", async () => {
    lecturerCtx({ status: "draft" });
    const res = await revealRoute.POST(jsonReq(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("quiz_not_revealable");
  });

  it("reveals while live → sets results_revealed_at on the row", async () => {
    const ctx = lecturerCtx();
    await revealRoute.POST(jsonReq(), { params: Promise.resolve({ id: QUIZ }) });
    expect(ctx.client.tables["quizzes"]![0].results_revealed_at).toBeTruthy();
  });

  // audit-3 H3-ATOM-F5: reveal is bound to the end of the assessment.
  it("refuses a LIVE quiz whose in-flight session has already answered → 409 quiz_in_progress", async () => {
    const ctx = lecturerCtx();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000e1",
      quiz_id: QUIZ,
      student_id: "00000000-0000-4000-8000-0000000000f1",
      status: "active",
      mode: "assessment",
      attempt: 1,
      verify_nonce: "n",
      started_at: "2026-01-01T00:00:00Z",
      last_activity_at: "2026-01-01T00:00:00Z",
    });
    ctx.client.seedAnswer({
      id: "00000000-0000-4000-8000-0000000000a1",
      session_id: "00000000-0000-4000-8000-0000000000e1",
      question_id: "00000000-0000-4000-8000-0000000000d1",
      selected_index: 0,
      is_correct: true,
      answered_at: "2026-01-01T00:00:00Z",
    });
    const res = await revealRoute.POST(jsonReq(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("quiz_in_progress");
    expect(ctx.client.tables["quizzes"]![0].results_revealed_at).toBeNull();
  });

  it("ALLOWS revealing a live quiz whose in-flight session has answered nothing", async () => {
    // Nothing to leak yet; the e7-unlock journey reveals early so the
    // EndScreen can show the score.
    const ctx = lecturerCtx();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000e3",
      quiz_id: QUIZ,
      student_id: "00000000-0000-4000-8000-0000000000f3",
      status: "active",
      mode: "assessment",
      attempt: 1,
      verify_nonce: "n",
      started_at: "2026-01-01T00:00:00Z",
      last_activity_at: "2026-01-01T00:00:00Z",
    });
    const res = await revealRoute.POST(jsonReq(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(200);
    expect((await res.json()).revealed).toBe(true);
  });

  it("reveals a live quiz whose sessions have all submitted → 200", async () => {
    const ctx = lecturerCtx();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000e2",
      quiz_id: QUIZ,
      student_id: "00000000-0000-4000-8000-0000000000f2",
      status: "completed",
      mode: "assessment",
      attempt: 1,
      verify_nonce: "n",
      started_at: "2026-01-01T00:00:00Z",
      last_activity_at: "2026-01-01T00:00:00Z",
    });
    const res = await revealRoute.POST(jsonReq(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(200);
    expect((await res.json()).revealed).toBe(true);
  });

  // ── guard / transport arms ────────────────────────────────────────────
  it("non-uuid id → 404", async () => {
    lecturerCtx();
    const res = await revealRoute.POST(jsonReq(), { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(404);
  });

  it("non-owner lecturer → 404 (no oracle)", async () => {
    const ctx = lecturerCtx();
    ctx.client.setUser("00000000-0000-4000-8000-0000000000ee", "lecturer");
    const res = await revealRoute.POST(jsonReq(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(404);
  });

  it("cross-origin → 403 (CSRF before the rate limiter)", async () => {
    lecturerCtx();
    const cross = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
    });
    const res = await revealRoute.POST(cross, { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(403);
  });

  it("rate limit exhausted → 429", async () => {
    lecturerCtx();
    _seedRateLimit(`reveal:${LECTURER_ID}`, 10);
    const res = await revealRoute.POST(jsonReq(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(429);
  });

  it("live in-flight session read failure → 503", async () => {
    const ctx = lecturerCtx();
    ctx.client.selectError = "session read boom";
    ctx.client.selectErrorTable = "quiz_sessions";
    const res = await revealRoute.POST(jsonReq(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("internal");
    expect(ctx.client.tables["quizzes"]![0].results_revealed_at).toBeNull();
  });

  it("answer-count read failure → 503", async () => {
    const ctx = lecturerCtx();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000e4",
      quiz_id: QUIZ,
      student_id: "00000000-0000-4000-8000-0000000000f4",
      status: "active",
      mode: "assessment",
      attempt: 1,
      verify_nonce: "n",
      started_at: "2026-01-01T00:00:00Z",
      last_activity_at: "2026-01-01T00:00:00Z",
    });
    ctx.client.countError = "answer count boom";
    const res = await revealRoute.POST(jsonReq(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(503);
    expect(ctx.client.tables["quizzes"]![0].results_revealed_at).toBeNull();
  });

  it("a concurrent reveal (reveal_once_only trigger) → 200 idempotent", async () => {
    const ctx = lecturerCtx();
    ctx.client.updateError = "reveal_once_only";
    const res = await revealRoute.POST(jsonReq(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revealed).toBe(true);
    expect(body.already).toBe(true);
  });
});

describe("PATCH /api/quizzes/[id]/reveal-settings", () => {
  it("toggles auto_reveal_on_complete", async () => {
    const ctx = lecturerCtx();
    const res = await revealSettingsRoute.PATCH(jsonReq({ autoRevealOnComplete: true }, { method: "PATCH" }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.autoRevealOnComplete).toBe(true);
    expect((ctx.client.tables["quizzes"]![0] as Record<string, unknown>).auto_reveal_on_complete).toBe(true);
  });

  it("rejects an invalid payload → 400", async () => {
    lecturerCtx();
    const res = await revealSettingsRoute.PATCH(jsonReq({ autoRevealOnComplete: "yes" }, { method: "PATCH" }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(400);
  });
});