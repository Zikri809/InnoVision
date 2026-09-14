import { describe, it, expect, vi, beforeEach } from "vitest";
import ExcelJS from "exceljs";
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

function seedQuiz(client: FakeSupabase, overrides: Record<string, unknown> = {}) {
  client.tables["quizzes"] = [
    {
      id: QUIZ_ID,
      class_id: CLASS_ID,
      title: "Quiz One",
      mode: "assessment",
      status: "live",
      results_revealed_at: null,
      created_at: "2026-08-01T00:00:00Z",
      ...overrides,
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
      correct_indices: null,
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

function seedRoster(
  client: FakeSupabase,
  entries: Array<{ student_id: string; full_name: string | null; matric_no: string | null }>,
) {
  client.tables["student_roster_view"] = entries.map((e) => ({
    class_id: CLASS_ID,
    enrolled_at: "2026-01-02T00:00:00Z",
    ...e,
  }));
}

function req() {
  return new Request(`http://localhost/api/classes/${CLASS_ID}/gradebook-export`, {
    headers: { origin: "http://localhost" },
  });
}

function params() {
  return { params: Promise.resolve({ id: CLASS_ID }) };
}

async function loadWorkbook(res: Response) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await res.arrayBuffer());
  return wb;
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
    seedRoster(client, [
      { student_id: STUDENT_ID, full_name: "Ali Bin Abu", matric_no: "231001" },
    ]);

    const route = await importHandler();
    const res = await route.GET(req(), params());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/spreadsheetml/);
    expect(res.headers.get("Content-Disposition")).toMatch(/gradebook-\d{4}-\d{2}-\d{2}\.xlsx/);

    const wb = await loadWorkbook(res);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toContain("Summary");
    expect(names).toContain("Quiz One");

    const summary = wb.getWorksheet("Summary")!;
    // Header: Num, Matric, Name, "<title> (/1)*", cumulative label. The "*"
    // marks an unrevealed quiz.
    expect(summary.getCell(1, 4).value).toBe("Quiz One (/1) *");
    // Row: matric + name + 100 (percent cell as a 0-1 fraction with 0% numFmt).
    expect(summary.getCell(2, 2).value).toBe("231001");
    expect(summary.getCell(2, 3).value).toBe("Ali Bin Abu");
    expect(summary.getCell(2, 4).value).toBe(1);
    expect(summary.getCell(2, 4).numFmt).toBe("0%");
    expect(summary.getCell(2, 5).value).toBe(1);
    expect(summary.getCell(2, 5).numFmt).toBe("0%");
  });

  it("unrevealed quiz scores still appear (lecturer sees full matrix) with * marker", async () => {
    const client = lecturerContext();
    seedOwner(client);
    seedQuiz(client);
    seedSession(client);
    seedRoster(client, []);
    const route = await importHandler();
    const res = await route.GET(req(), params());
    expect(res.status).toBe(200);
    const wb = await loadWorkbook(res);
    const summary = wb.getWorksheet("Summary")!;
    expect(summary.getCell(1, 4).value).toBe("Quiz One (/1) *");
  });

  it("orphan attempts (no roster) get an appended row instead of vanishing (B-F1)", async () => {
    const client = lecturerContext();
    seedOwner(client);
    seedQuiz(client);
    seedSession(client);
    seedRoster(client, []);
    const route = await importHandler();
    const res = await route.GET(req(), params());
    expect(res.status).toBe(200);
    const wb = await loadWorkbook(res);
    const summary = wb.getWorksheet("Summary")!;
    // header + orphan row + average footer.
    expect(summary.actualRowCount).toBe(3);
    expect(summary.getCell(2, 3).value).toBeNull(); // null name → blank cell
    expect(summary.getCell(2, 4).value).toBe(1); // orphan score 1/1 still shown
  });

  it("per-quiz sheet CONTENT + percent numFmt (B-F2/B-F9)", async () => {
    const client = lecturerContext();
    seedOwner(client);
    seedQuiz(client);
    seedSession(client, { score: 1 });
    seedRoster(client, [
      { student_id: STUDENT_ID, full_name: "Ali Bin Abu", matric_no: "231001" },
    ]);
    const route = await importHandler();
    const res = await route.GET(req(), params());
    expect(res.status).toBe(200);
    const wb = await loadWorkbook(res);
    const sheet = wb.getWorksheet("Quiz One")!;
    // Header row.
    expect(sheet.getCell(1, 7).value).toBe("%");
    // Student row: #, matric, name, status, score, total, percent.
    expect(sheet.getCell(2, 2).value).toBe("231001");
    expect(sheet.getCell(2, 3).value).toBe("Ali Bin Abu");
    expect(sheet.getCell(2, 4).value).toBe("completed");
    expect(sheet.getCell(2, 5).value).toBe(1);
    expect(sheet.getCell(2, 6).value).toBe(1);
    expect(sheet.getCell(2, 7).value).toBe(1);
    // The exact regression B-F2 hid: a real percent number format.
    expect(sheet.getCell(2, 7).numFmt).toBe("0%");
  });

  it("Summary average footer is a 0-1 fraction with 0% numFmt", async () => {
    const client = lecturerContext();
    seedOwner(client);
    seedQuiz(client);
    seedRoster(client, [
      { student_id: STUDENT_ID, full_name: "Ali", matric_no: "231001" },
      { student_id: "00000000-0000-4000-8000-0000000000e1", full_name: "Beth", matric_no: "231002" },
    ]);
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
      },
    ];
    const route = await importHandler();
    const res = await route.GET(req(), params());
    const wb = await loadWorkbook(res);
    const summary = wb.getWorksheet("Summary")!;
    // header + 2 roster rows + footer.
    expect(summary.actualRowCount).toBe(4);
    expect(summary.getCell(4, 3).value).toBe("Class average");
    expect(summary.getCell(4, 4).value).toBe(1); // one attempt, 1/1 = 100%
    expect(summary.getCell(4, 4).numFmt).toBe("0%");
  });
});

describe("GET /api/classes/[id]/gradebook-export — safeText (B-F3)", () => {
  it("neutralises a formula-shaped full_name in the Summary sheet", async () => {
    const client = lecturerContext();
    seedOwner(client);
    seedQuiz(client);
    seedRoster(client, [
      { student_id: STUDENT_ID, full_name: "=cmd|' /C calc'!A0", matric_no: "=1+1" },
    ]);
    const route = await importHandler();
    const res = await route.GET(req(), params());
    expect(res.status).toBe(200);
    const wb = await loadWorkbook(res);
    const summary = wb.getWorksheet("Summary")!;
    expect(summary.getCell(2, 3).value).toBe("'=cmd|' /C calc'!A0");
    expect(summary.getCell(2, 2).value).toBe("'=1+1");
    // Never an exceljs formula object.
    expect(typeof summary.getCell(2, 3).value).toBe("string");
  });

  it("neutralises a formula-shaped quiz title in the Summary header", async () => {
    const client = lecturerContext();
    seedOwner(client);
    seedQuiz(client, { title: "=HYPERLINK(\"http://evil\")" });
    seedRoster(client, []);
    const route = await importHandler();
    const res = await route.GET(req(), params());
    const wb = await loadWorkbook(res);
    const summary = wb.getWorksheet("Summary")!;
    expect(summary.getCell(1, 4).value).toBe("'=HYPERLINK(\"http://evil\") (/1) *");
  });
});

describe("GET /api/classes/[id]/gradebook-export — sheet names (INJ-F1)", () => {
  it("apostrophe-terminal titles do not 500 and produce valid sheet names", async () => {
    const client = lecturerContext();
    seedOwner(client);
    // 39-char title, leading quote, trailing quote, all-apostrophes fallback.
    client.tables["quizzes"] = [
      {
        id: "qz-1",
        class_id: CLASS_ID,
        title: "Photosynthesis and Respiration's Phases",
        mode: "assessment",
        status: "live",
        results_revealed_at: null,
        created_at: "2026-08-01T00:00:00Z",
      },
      {
        id: "qz-2",
        class_id: CLASS_ID,
        title: "'Leading quote",
        mode: "assessment",
        status: "live",
        results_revealed_at: null,
        created_at: "2026-08-02T00:00:00Z",
      },
      {
        id: "qz-3",
        class_id: CLASS_ID,
        title: "Trailing'",
        mode: "assessment",
        status: "live",
        results_revealed_at: null,
        created_at: "2026-08-03T00:00:00Z",
      },
      {
        id: "qz-4",
        class_id: CLASS_ID,
        title: "'''",
        mode: "assessment",
        status: "live",
        results_revealed_at: null,
        created_at: "2026-08-04T00:00:00Z",
      },
      {
        // Adversarial review: ExcelJS rejects a BACKSLASH (worksheet.js) even
        // though Excel's UI tolerates it, and the old strip class omitted it —
        // so this title threw inside addWorksheet and 500'd the whole export.
        id: "qz-5",
        class_id: CLASS_ID,
        title: "Ch 3 \ Review",
        mode: "assessment",
        status: "live",
        results_revealed_at: null,
        created_at: "2026-08-05T00:00:00Z",
      },
      {
        // ExcelJS also refuses Excel's protected name "History", which threw
        // inside addWorksheet for the same reason.
        id: "qz-6",
        class_id: CLASS_ID,
        title: "History",
        mode: "assessment",
        status: "live",
        results_revealed_at: null,
        created_at: "2026-08-06T00:00:00Z",
      },
    ];
    client.tables["questions"] = [];
    seedRoster(client, []);

    const route = await importHandler();
    const res = await route.GET(req(), params());
    expect(res.status).toBe(200);
    const wb = await loadWorkbook(res);
    const names = wb.worksheets.map((w) => w.name);
    expect(names[0]).toBe("Summary");
    for (const name of names) {
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(31);
      expect(name.startsWith("'")).toBe(false);
      expect(name.endsWith("'")).toBe(false);
      expect(name).not.toMatch(/[\\/*?:[\]]/);
    }
    expect(names).toContain("Trailing");
    expect(names).toContain("Leading quote");
    expect(names).toContain("Quiz");
    // The backslash fixture must have been stripped, not merely tolerated.
    expect(names.some((n) => n.includes("\\"))).toBe(false);
    expect(names.some((n) => n.includes("Ch 3"))).toBe(true);
    // "History" is protected: it must appear under a DIFFERENT name.
    expect(names).not.toContain("History");
    expect(names.some((n) => n.startsWith("History"))).toBe(true);
  });

  it("dedupes colliding and reserved sheet names", async () => {
    const client = lecturerContext();
    seedOwner(client);
    client.tables["quizzes"] = [
      { id: "qz-1", class_id: CLASS_ID, title: "midterm", mode: "assessment", status: "live", results_revealed_at: null, created_at: "2026-08-01T00:00:00Z" },
      { id: "qz-2", class_id: CLASS_ID, title: "MIDTERM", mode: "assessment", status: "live", results_revealed_at: null, created_at: "2026-08-02T00:00:00Z" },
      { id: "qz-3", class_id: CLASS_ID, title: "Summary", mode: "assessment", status: "live", results_revealed_at: null, created_at: "2026-08-03T00:00:00Z" },
    ];
    client.tables["questions"] = [];
    seedRoster(client, []);
    const route = await importHandler();
    const res = await route.GET(req(), params());
    expect(res.status).toBe(200);
    const wb = await loadWorkbook(res);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toEqual(["Summary", "midterm", "MIDTERM (2)", "Summary (2)"]);
  });
});

describe("GET /api/classes/[id]/gradebook-export — truncation signals (B-F4/B-F7)", () => {
  it(">25 quizzes → Summary-only workbook with a visible note + header flag", async () => {
    const client = lecturerContext();
    seedOwner(client);
    client.tables["quizzes"] = Array.from({ length: 26 }, (_, i) => ({
      id: `qz-${i}`,
      class_id: CLASS_ID,
      title: `Quiz ${i}`,
      mode: "assessment",
      status: "live",
      results_revealed_at: null,
      created_at: new Date(Date.parse("2026-08-01T00:00:00Z") + i * 1000).toISOString(),
    }));
    client.tables["questions"] = [];
    seedRoster(client, []);

    const route = await importHandler();
    const res = await route.GET(req(), params());
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Gradebook-Sheet-Detail-Omitted")).toBe("1");
    expect(res.headers.get("X-Gradebook-Columns-Truncated")).toBe("0");
    const wb = await loadWorkbook(res);
    expect(wb.worksheets).toHaveLength(1);
    const summary = wb.getWorksheet("Summary")!;
    // The note row names the count and the limit.
    const notes = collectStrings(summary);
    expect(notes.some((s) => s.includes("26") && s.includes("25"))).toBe(true);
  });

  it("roster read truncation surfaces a note + header flag", async () => {
    const client = lecturerContext();
    seedOwner(client);
    seedQuiz(client);
    client.tables["questions"] = [];
    // 101 rows → getClassRoster reports truncated (fetches LIMIT+1).
    seedRoster(
      client,
      Array.from({ length: 101 }, (_, i) => ({
        student_id: `stu-${i}`,
        full_name: `Student ${i}`,
        matric_no: null,
      })),
    );
    const route = await importHandler();
    const res = await route.GET(req(), params());
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Gradebook-Roster-Truncated")).toBe("1");
    const wb = await loadWorkbook(res);
    const notes = collectStrings(wb.getWorksheet("Summary")!);
    expect(notes.some((s) => s.includes("100"))).toBe(true);
  });

  it("sessions read with a dropped tail → sessionsTruncated flag (B-F7)", async () => {
    const client = lecturerContext();
    seedOwner(client);
    seedQuiz(client);
    // A tail must actually be DROPPED for the flag to be honest — use the
    // simulated PostgREST clamp rather than merely filling the limit.
    client.maxRows = 10;
    // 20,000 sessions for ONE student: deduped to one representative row but
    // the read is clamped well below the matching total.
    client.tables["quiz_sessions"] = Array.from({ length: 20_000 }, (_, i) => ({
      id: `s-${i}`,
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
    }));
    seedRoster(client, [
      { student_id: STUDENT_ID, full_name: "Ali", matric_no: "231001" },
    ]);
    const route = await importHandler();
    const res = await route.GET(req(), params());
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Gradebook-Sessions-Truncated")).toBe("1");
    const wb = await loadWorkbook(res);
    const notes = collectStrings(wb.getWorksheet("Summary")!);
    expect(notes.some((s) => s.includes("20000"))).toBe(true);
  });

  it("does NOT flag truncation when the count equals the returned rows at the cap", async () => {
    // Adversarial review: the old `|| len >= SESSIONS_LIMIT` fallback fired even
    // when an exact count proved nothing was dropped. With the count available
    // it must NOT report truncation at exactly the cap.
    const client = lecturerContext();
    seedOwner(client);
    seedQuiz(client);
    client.tables["quiz_sessions"] = Array.from({ length: 20_000 }, (_, i) => ({
      id: `s-${i}`,
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
    }));
    seedRoster(client, [
      { student_id: STUDENT_ID, full_name: "Ali", matric_no: "231001" },
    ]);
    const route = await importHandler();
    const res = await route.GET(req(), params());
    expect(res.status).toBe(200);
    // count === returned rows → nothing was dropped → NOT truncated.
    expect(res.headers.get("X-Gradebook-Sessions-Truncated")).toBe("0");
  });

  it("flags truncation when PostgREST max_rows silently clamps the read", async () => {
    // The deployed PostgREST `max_rows` (1000 locally) caps ANY range request,
    // so the app's 20k limit is clamped and a tail IS dropped. Only the exact
    // count reveals it — this is the case the flag exists for.
    const client = lecturerContext();
    seedOwner(client);
    seedQuiz(client);
    client.maxRows = 5;
    client.tables["quiz_sessions"] = Array.from({ length: 40 }, (_, i) => ({
      id: `s-${i}`,
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
    }));
    seedRoster(client, [
      { student_id: STUDENT_ID, full_name: "Ali", matric_no: "231001" },
    ]);
    const route = await importHandler();
    const res = await route.GET(req(), params());
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Gradebook-Sessions-Truncated")).toBe("1");
  });

  it("answers read at its cap → answersTruncated note + header (B-F9)", async () => {
    const client = lecturerContext();
    seedOwner(client);
    seedQuiz(client);
    seedSession(client);
    seedRoster(client, [
      { student_id: STUDENT_ID, full_name: "Ali", matric_no: "231001" },
    ]);
    client.tables["session_answers"] = Array.from({ length: 20_000 }, (_, i) => ({
      id: `a-${i}`,
      session_id: "s-1",
      question_id: "q-1",
      selected_index: 1,
      selected_indices: null,
      is_correct: true,
    }));
    const route = await importHandler();
    const res = await route.GET(req(), params());
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Gradebook-Answers-Truncated")).toBe("1");
    const wb = await loadWorkbook(res);
    const notes = collectStrings(wb.getWorksheet("Summary")!);
    expect(notes.some((s) => s.toLowerCase().includes("answer"))).toBe(true);
  });

  it("a class with no quizzes exports an empty Summary without an .in() 400 (B-F9)", async () => {
    const client = lecturerContext();
    seedOwner(client);
    client.tables["quizzes"] = [];
    seedRoster(client, []);
    const route = await importHandler();
    const res = await route.GET(req(), params());
    expect(res.status).toBe(200);
    const wb = await loadWorkbook(res);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary"]);
    expect(res.headers.get("X-Gradebook-Sessions-Truncated")).toBe("0");
  });
});

describe("GET /api/classes/[id]/gradebook-export — read failures", () => {
  it("roster read error → typed 503, not a crash", async () => {
    const client = lecturerContext();
    seedOwner(client);
    seedQuiz(client);
    client.selectError = "roster boom";
    client.selectErrorTable = "student_roster_view";
    const route = await importHandler();
    const res = await route.GET(req(), params());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("internal");
  });

  it("sessions read error → typed 503, not a crash", async () => {
    const client = lecturerContext();
    seedOwner(client);
    seedQuiz(client);
    // The sessions read is the only count-exact query in this route.
    client.countError = "sessions boom";
    const route = await importHandler();
    const res = await route.GET(req(), params());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("internal");
  });

  it("per-quiz answers read error → typed 503, not a crash", async () => {
    const client = lecturerContext();
    seedOwner(client);
    seedQuiz(client);
    seedSession(client);
    seedRoster(client, [
      { student_id: STUDENT_ID, full_name: "Ali", matric_no: "231001" },
    ]);
    // The fake maps lecturer_answers_view → session_answers.
    client.selectError = "answers boom";
    client.selectErrorTable = "session_answers";
    const route = await importHandler();
    const res = await route.GET(req(), params());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("internal");
  });
});

/** Flatten every string cell of a worksheet (note-row assertions). */
function collectStrings(ws: ExcelJS.Worksheet): string[] {
  const out: string[] = [];
  ws.eachRow((row) => {
    row.eachCell((cell) => {
      if (typeof cell.value === "string") out.push(cell.value);
    });
  });
  return out;
}

describe("GET /api/classes/[id]/gradebook-export — rate limit", () => {
  it("11th export within the window → 429", async () => {
    // Restored after an adversarial review found this block had been dropped
    // during the fix pass, leaving the route's 429 branch uncovered.
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
