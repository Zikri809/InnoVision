import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeSupabase, makeOwnerContext } from "@/app/api/quizzes/__tests__/fake-supabase";
import { _resetRateLimiter } from "@/lib/classes/rate-limit";
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