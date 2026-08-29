import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeSupabase } from "../../quizzes/__tests__/fake-supabase";

// The gradebook-export route imports createClient from
// "@/lib/supabase/server". Mock it to return our fake so the REAL guards +
// handler run against in-memory data (classes-routes.test.ts pattern).
const fakeHolder: { current: FakeSupabase | undefined } = { current: undefined };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeHolder.current,
}));

async function importHandler() {
  return await import("@/app/api/classes/[id]/gradebook-export/route");
}

const CLASS_ID = "00000000-0000-4000-8000-00000000000b";
const OTHER_CLASS_ID = "00000000-0000-4000-8000-00000000000c";
const LECTURER_ID = "00000000-0000-4000-8000-0000000000aa";
const STUDENT_ID = "00000000-0000-4000-8000-0000000000ff";
const QUIZ_ID = "00000000-0000-4000-8000-0000000000q1".replace("q", "1");

function lecturerContext() {
  const client = new FakeSupabase();
  client.setUser(LECTURER_ID, "lecturer");
  fakeHolder.current = client;
  return client;
}

function seedOwner(client: FakeSupabase) {
  client.tables["classes"] = [
    {
      id: CLASS_ID,
      lecturer_id: LECTURER_ID,
      title: "Physics",
      join_code: "ABCDEF",
      created_at: "2026-01-01T00:00:00Z",
      archived_at: null,
    },
  ];
}

function seedQuiz(client: FakeSupabase) {
  client.tables["quizzes"] = [
    {
      id: QUIZ_ID,
      class_id: CLASS_ID,
      title: "Quiz One",
      mode: "assessment",
      status: "live",
      results_revealed_at: null,
      created_at: "2026-08-01T00:00:00Z",
    },
  ];
  client.tables["questions"] = [
    {
      id: "q-1",
      quiz_id: QUIZ_ID,
      order_index: 0,
      type: "mcq",
      prompt: "2+2?",
      options: ["3", "4"],
      correct_index: 1,
      explanation: null,
    },
  ];
}

function seedSession(client: FakeSupabase, overrides: Record<string, unknown> = {}) {
  client.tables["quiz_sessions"] = [
    {
      id: "s-1",
      quiz_id: QUIZ_ID,
      student_id: STUDENT_ID,
      status: "completed",
      score: 1,
      started_at: "2026-08-02T10:00:00Z",
      submitted_at: "2026-08-02T10:30:00Z",
      last_activity_at: "2026-08-02T10:30:00Z",
      face_fail_streak: 0,
      focus_pause_count: 0,
      attempt: 1,
      ...overrides,
    },
  ];
}

function req() {
  return new Request(`http://localhost/api/classes/${CLASS_ID}/gradebook-export`, {
    headers: { origin: "http://localhost" },
  });
}

function params() {
  return { params: Promise.resolve({ id: CLASS_ID }) };
}

beforeEach(() => {
  vi.resetModules();
  fakeHolder.current = undefined;
});

describe("GET /api/classes/[id]/gradebook-export — guards", () => {
  it("non-UUID id → 404 no-oracle", async () => {
    lecturerContext();
    const route = await importHandler();
    const res = await route.GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(404);
  });

  it("student role → 401/404 (requireClassOwner role gate), never the workbook", async () => {
    const client = new FakeSupabase();
    client.setUser(STUDENT_ID, "student");
    fakeHolder.current = client;
    const route = await importHandler();
    const res = await route.GET(new Request("http://localhost"), params());
    expect([401, 403, 404]).toContain(res.status);
  });

  it("non-owner lecturer → uniform 404 (no oracle about class existence)", async () => {
    const client = lecturerContext();
    client.tables["classes"] = [
      {
        id: OTHER_CLASS_ID,
        lecturer_id: "00000000-0000-4000-8000-0000000000zz".replace("zz", "ab"),
        title: "Not Yours",
        join_code: "ZZZZZZ",
        created_at: "2026-01-01T00:00:00Z",
        archived_at: null,
      },
    ];
    const route = await importHandler();
    const res = await route.GET(new Request("http://localhost"), params());
    expect(res.status).toBe(404);
  });

  it("cross-origin request → 403 invalid_origin", async () => {
    const client = lecturerContext();
    seedOwner(client);
    seedQuiz(client);
    const route = await importHandler();
    const res = await route.GET(
      new Request(`http://localhost/api/classes/${CLASS_ID}/gradebook-export`, {
        headers: { origin: "https://evil.example" },
      }),
      params(),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("invalid_origin");
  });
});

describe("GET /api/classes/[id]/gradebook-export — happy path", () => {
  it("owner with data → 200 xlsx workbook with Summary + per-quiz sheet", async () => {
    const client = lecturerContext();
    seedOwner(client);
    seedQuiz(client);
    seedSession(client);
    client.tables["student_roster_view"] = [
      {
        class_id: CLASS_ID,
        student_id: STUDENT_ID,
        full_name: "Ali Bin Abu",
        enrolled_at: "2026-01-02T00:00:00Z",
        matric_no: "231001",
      },
    ];

    const route = await importHandler();
    const res = await route.GET(req(), params());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/spreadsheetml/);
    expect(res.headers.get("Content-Disposition")).toMatch(/gradebook-\d{4}-\d{2}-\d{2}\.xlsx/);

    const { default: ExcelJS } = await import("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toContain("Summary");
    expect(names).toContain("Quiz One");

    const summary = wb.getWorksheet("Summary")!;
    // Header: Num, Matric, Name, "<title> (/1)*", cumulative label. The "*"
    // marks an unrevealed quiz.
    expect(summary.getCell(1, 4).value).toBe("Quiz One (/1) *");
    // Row: matric + name + 100 (percent cell).
    expect(summary.getCell(2, 2).value).toBe("231001");
    expect(summary.getCell(2, 3).value).toBe("Ali Bin Abu");
    expect(summary.getCell(2, 4).value).toBe(100);
  });

  it("unrevealed quiz scores still appear (lecturer sees full matrix) with * marker", async () => {
    const client = lecturerContext();
    seedOwner(client);
    seedQuiz(client);
    seedSession(client);
    client.tables["student_roster_view"] = [];
    const route = await importHandler();
    const res = await route.GET(req(), params());
    expect(res.status).toBe(200);
    const { default: ExcelJS } = await import("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const summary = wb.getWorksheet("Summary")!;
    expect(summary.getCell(1, 4).value).toBe("Quiz One (/1) *");
  });

  it("orphan attempts (no roster) do not crash the export", async () => {
    const client = lecturerContext();
    seedOwner(client);
    seedQuiz(client);
    seedSession(client);
    client.tables["student_roster_view"] = [];
    const route = await importHandler();
    const res = await route.GET(req(), params());
    expect(res.status).toBe(200);
    const { default: ExcelJS } = await import("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    // Summary has header + average row only (roster-driven rows).
    const summary = wb.getWorksheet("Summary")!;
    expect(summary.actualRowCount).toBe(2);
  });
});

describe("GET /api/classes/[id]/gradebook-export — rate limit", () => {
  it("11th export within the window → 429", async () => {
    const client = lecturerContext();
    seedOwner(client);
    seedQuiz(client);
    client.tables["student_roster_view"] = [];
    const route = await importHandler();
    // Exhaust the budget.
    for (let i = 0; i < 10; i++) {
      const res = await route.GET(req(), params());
      expect(res.status).toBe(200);
    }
    const res = await route.GET(req(), params());
    expect(res.status).toBe(429);
  });
});
