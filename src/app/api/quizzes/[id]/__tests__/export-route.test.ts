import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeSupabase, makeOwnerContext } from "@/app/api/quizzes/__tests__/fake-supabase";
import { _resetRateLimiter, _seedRateLimit } from "@/lib/classes/rate-limit";
import * as exportRoute from "@/app/api/quizzes/[id]/export/route";

const fakeHolder: { current: FakeSupabase | undefined } = { current: undefined };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeHolder.current,
}));

const QUIZ = "00000000-0000-4000-8000-00000000000c";
const LECTURER_ID = "00000000-0000-4000-8000-00000000000a";
const STUDENT_ID = "00000000-0000-4000-8000-000000000001";

function getRequest(): Request {
  return new Request("http://localhost/api/quizzes/x/export", { method: "GET" });
}

function lecturerCtx() {
  const ctx = makeOwnerContext({ quizStatus: "closed" });
  const quizRow = ctx.client.tables["quizzes"]![0];
  quizRow.mode = "assessment";
  ctx.client.setUser(LECTURER_ID, "lecturer");
  // IMPORTANT: the fake resolves the sealed views to their BASE tables
  // (fake-supabase from() mapping), so fixtures go into quiz_sessions /
  // session_answers — seeding view names directly would be inert.
  ctx.client.tables["quiz_sessions"] = [
    {
      id: "sess-1",
      quiz_id: QUIZ,
      student_id: STUDENT_ID,
      status: "completed",
      score: 1,
      started_at: "2026-01-01T10:00:00Z",
      submitted_at: "2026-01-01T10:05:00Z",
      last_activity_at: "2026-01-01T10:05:00Z",
      face_fail_streak: 0,
      focus_pause_count: 0,
    },
  ];
  ctx.client.tables["questions"] = [
    {
      id: "q-1",
      quiz_id: QUIZ,
      order_index: 0,
      type: "mcq",
      prompt: "Pick one",
      options: ["Alpha", "Beta"],
      correct_index: 1,
      explanation: null,
    },
  ];
  ctx.client.tables["session_answers"] = [
    { session_id: "sess-1", question_id: "q-1", selected_index: 0, is_correct: false },
  ];
  ctx.client.tables["student_roster_view"] = [
    {
      class_id: ctx.classId,
      student_id: STUDENT_ID,
      full_name: "Ali Bin Abu",
      enrolled_at: "2026-01-01T09:00:00Z",
      matric_no: "231234",
    },
  ];
  fakeHolder.current = ctx.client;
  return ctx;
}

beforeEach(() => {
  fakeHolder.current = undefined;
  _resetRateLimiter();
});

describe("GET /api/quizzes/[id]/export", () => {
  it("student principal → uniform denial, zero xlsx bytes", async () => {
    const ctx = makeOwnerContext();
    ctx.client.setUser(STUDENT_ID, "student");
    fakeHolder.current = ctx.client;
    const res = await exportRoute.GET(getRequest(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).not.toContain("spreadsheet");
  });

  it("unknown quiz id → not-found", async () => {
    lecturerCtx();
    const badId = "00000000-0000-4000-8000-00000000dead";
    const res = await exportRoute.GET(getRequest(), { params: Promise.resolve({ id: badId }) });
    expect(res.status).toBe(404);
  });

  it("malformed id → not-found before any DB work", async () => {
    lecturerCtx();
    const res = await exportRoute.GET(getRequest(), { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(res.status).toBe(404);
  });

  it("owner lecturer → 200 xlsx attachment with disposition + bytes", async () => {
    lecturerCtx();
    const res = await exportRoute.GET(getRequest(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toMatch(/results-\d{4}-\d{2}-\d{2}\.xlsx/);
    const bytes = await res.arrayBuffer();
    expect(bytes.byteLength).toBeGreaterThan(100);
    // Real xlsx containers start with the PK zip magic.
    expect(new Uint8Array(bytes)[0]).toBe(0x50);
  });

  it("workbook substance: attempt data actually flows into the Results sheet", async () => {
    // Guards against vacuous fixtures: the session/answer reads must reach
    // the workbook (regression would show an empty not-started row instead).
    lecturerCtx();
    const res = await exportRoute.GET(getRequest(), { params: Promise.resolve({ id: QUIZ }) });
    const { default: ExcelJS } = await import("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const results = wb.getWorksheet("Results")!;
    expect(results.getCell(5, 3).value).toBe("Ali Bin Abu"); // roster name
    expect(results.getCell(5, 2).value).toBe("231234"); // matric via roster view
    expect(results.getCell(5, 5).value).toBe(1); // score from the session
    expect(results.getCell(5, 13).value).toBe("A — Alpha"); // chosen answer cell
  });

  it("filename sanitizes a hostile quiz title", async () => {
    const ctx = lecturerCtx();
    ctx.client.tables["quizzes"]![0].title = '=cmd|"/C calc"';
    const res = await exportRoute.GET(getRequest(), { params: Promise.resolve({ id: QUIZ }) });
    const disposition = res.headers.get("content-disposition") ?? "";
    // The QUOTED filename value itself must be free of operators/quotes —
    // the `filename=` / `filename*=` keys legitimately contain "=".
    const value = /filename="([^"]+)"/i.exec(disposition)?.[1] ?? "";
    expect(value).not.toMatch(/[="|\\/]/);
    expect(value).toMatch(/results-\d{4}-\d{2}-\d{2}\.xlsx/);
  });

  it("rate-limits after the per-user budget → 429", async () => {
    lecturerCtx();
    _seedRateLimit(`export:${LECTURER_ID}`, 10);
    const res = await exportRoute.GET(getRequest(), { params: Promise.resolve({ id: QUIZ }) });
    expect(res.status).toBe(429);
  });
});
