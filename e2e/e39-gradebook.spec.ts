import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  createAssessmentAndPublish,
  createQuizWithQuestions,
  openResults,
  revealQuiz,
  currentSessionId,
  completeQuiz,
  startQuizByTitle,
  loadWorkbook,
} from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e39-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_A_EMAIL = `student-e39a-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_B_EMAIL = `student-e39b-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E39 Class";
const QUIZ_1 = "E39 Quiz One";
const QUIZ_2 = "E39 Quiz Two";

// Fail-fast: 5s in-page assertion budget (e18 convention — e34 has NO budget
// and must not be copied), 90s per-test ceiling, skip without invite code.
const fast = expect.configure({ timeout: 5_000 });

/**
 * E39 — RA-1 cross-quiz class gradebook, END TO END:
 *
 * 1. Matrix: two assessment quizzes × two students; revealed vs unrevealed
 *    column markers; cumulative %; per-quiz averages; export parity.
 * 2. Never-attempted student → em-dash cells, Not started on export.
 * 3. Draft + practice quizzes do NOT become columns.
 * 4. Non-owner lecturer direct-URLs the page → 404; student → redirect.
 */
test.describe("E39 — gradebook", () => {
  test("matrix cells, cumulative %, unrevealed marker, export parity", async ({ browser }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentACtx = await browser.newContext();
    const studentBCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const pageA = await studentACtx.newPage();
    const pageB = await studentBCtx.newPage();

    // ── Setup: lecturer, class, two assessments, two students ────────
    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    await createAssessmentAndPublish(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_1,
      questions: [
        { prompt: "What is 2+2?", options: ["3", "4"], correctIndex: 1 },
        { prompt: "Capital of France?", options: ["Paris", "Rome"], correctIndex: 0 },
      ],
    });
    await createAssessmentAndPublish(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_2,
      questions: [{ prompt: "5x5=?", options: ["20", "25"], correctIndex: 1 }],
    });

    const a = await registerUser(pageA, STUDENT_A_EMAIL, "student", LECTURER_INVITE_CODE);
    await joinClass(pageA, joinCode, CLASS_TITLE);
    const b = await registerUser(pageB, STUDENT_B_EMAIL, "student", LECTURER_INVITE_CODE);
    await joinClass(pageB, joinCode, CLASS_TITLE);

    // Student A: perfect on Q1 (2/2), correct on Q2 (1/1) → cumulative 100%.
    await pageA.goto("/student/quizzes");
    await fast(pageA).toHaveURL(/\/student\/quizzes/);
    await startQuizByTitle(pageA, QUIZ_1);
    const sessionA1 = currentSessionId(pageA);
    expect(await completeQuiz(pageA, ["4", "Paris"], { next: "Next", finish: "Finish" })).toBe(sessionA1);
    await fast(pageA.getByText(/Assessment submitted!/i)).toBeVisible();

    // A also completes QUIZ_2 perfectly (1/1).
    await pageA.goto("/student/quizzes");
    await fast(pageA).toHaveURL(/\/student\/quizzes/);
    await startQuizByTitle(pageA, QUIZ_2);
    await completeQuiz(pageA, ["25"], { next: "Next", finish: "Finish" });
    await fast(pageA.getByText(/Assessment submitted!/i)).toBeVisible();

    // Student B: half on Q1 (wrong on Q2 → 1/2), NEVER starts Q2 — that
    // column renders em-dash for B (the UI has no mid-quiz skip; the
    // never-attempted column is how the em-dash cell is exercised).
    await pageB.goto("/student/quizzes");
    await fast(pageB).toHaveURL(/\/student\/quizzes/);
    await startQuizByTitle(pageB, QUIZ_1);
    await completeQuiz(pageB, ["4", "Rome"], { next: "Next", finish: "Finish" });
    await fast(pageB.getByText(/Assessment submitted!/i)).toBeVisible();

    // ── Gradebook: open from class detail ────────────────────────────
    await lecturerPage.goto("/lecturer/classes");
    await fast(lecturerPage.getByRole("heading", { name: /My Classes|Kelas Saya/i })).toBeVisible();
    await lecturerPage.getByText(CLASS_TITLE, { exact: true }).click();
    await fast(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
    await lecturerPage.getByRole("link", { name: /Gradebook|Buku gred/i }).click();
    await fast(lecturerPage).toHaveURL(/\/gradebook$/);
    await fast(lecturerPage.getByRole("heading", { name: /Gradebook|Buku gred/i })).toBeVisible();

    // Both quizzes are unrevealed → two "unrevealed" markers.
    await fast(lecturerPage.getByText(/unrevealed|belum didedahkan/i)).toHaveCount(2);

    // Student A row: 100% both cells + cumulative 100%.
    const rowA = lecturerPage.getByRole("row").filter({ hasText: a.matric ?? "impossible" });
    await fast(rowA).toHaveCount(1);
    await fast(rowA.getByText("100%", { exact: true })).toHaveCount(3);

    // Student B row: Q1 50%, Q2 em-dash, cumulative 50%.
    const rowB = lecturerPage.getByRole("row").filter({ hasText: b.matric ?? "impossible" });
    await fast(rowB.getByText("50%", { exact: true })).toHaveCount(2);

    // Per-quiz averages: Q1 = 75% (100 + 50)/2, Q2 = 100% (A only).
    const footer = lecturerPage.getByRole("row").filter({ hasText: /Class average|Purata kelas/ });
    await fast(footer.getByText("75%", { exact: true })).toHaveCount(1);
    await fast(footer.getByText("100%", { exact: true })).toHaveCount(1);

    // ── Reveal Q1 → its unrevealed marker disappears ─────────────────
    await revealQuiz(lecturerPage, CLASS_TITLE, QUIZ_1);
    await lecturerPage.goto(`/lecturer/classes`);
    await lecturerPage.getByText(CLASS_TITLE, { exact: true }).click();
    await lecturerPage.getByRole("link", { name: /Gradebook|Buku gred/i }).click();
    await fast(lecturerPage.getByText(/unrevealed|belum didedahkan/i)).toHaveCount(1);

    // ── Export parity: Summary sheet mirrors the on-screen matrix ────
    const downloadPromise = lecturerPage.waitForEvent("download");
    await lecturerPage.getByRole("button", { name: /Export Excel|Eksport Excel/i }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/-gradebook-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const filePath = await download.path();
    expect(filePath).toBeTruthy();

    const wb = await loadWorkbook(filePath as string);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", QUIZ_1, QUIZ_2]);

    const summary = wb.getWorksheet("Summary")!;
    // Header row: Num/Matric/Name + 2 quiz columns + Overall.
    expect(summary.getCell(1, 4).value).toBe(`${QUIZ_1} (/2)`);
    expect(summary.getCell(1, 5).value).toBe(`${QUIZ_2} (/1) *`);
    // Student A row (row 2): 100, 100, cumulative 100.
    expect(summary.getCell(2, 4).value).toBe(100);
    expect(summary.getCell(2, 5).value).toBe(100);
    expect(summary.getCell(2, 6).value).toBe(100);
    // Student B row (row 3): 50, null (em-dash → empty cell), cumulative 50.
    expect(summary.getCell(3, 4).value).toBe(50);
    expect(summary.getCell(3, 5).value).toBe(null);
    expect(summary.getCell(3, 6).value).toBe(50);

    await lecturerCtx.close();
    await studentACtx.close();
    await studentBCtx.close();
  });

  test("draft and practice quizzes never become columns; zero-quizzes class shows empty state", async ({ browser }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();

    await registerUser(lecturerPage, `lecturer-e39z-${TEST_TIMESTAMP}@innovision.test`, "lecturer", LECTURER_INVITE_CODE);
    const joinCode = await createClass(lecturerPage, `${CLASS_TITLE} Z`);

    // PRACTICE quiz (published) + assessment left as DRAFT (not published).
    await createQuizWithQuestions(lecturerPage, {
      classTitle: `${CLASS_TITLE} Z`,
      quizTitle: "E39 Practice Z",
      mode: "practice",
      questions: [{ prompt: "Practice q?", options: ["a", "b"] }],
      publish: true,
    });
    await createQuizWithQuestions(lecturerPage, {
      classTitle: `${CLASS_TITLE} Z`,
      quizTitle: "E39 Draft Z",
      mode: "assessment",
      questions: [{ prompt: "Draft q?", options: ["a", "b"] }],
      publish: false,
    });

    await lecturerPage.goto("/lecturer/classes");
    await lecturerPage.getByText(`${CLASS_TITLE} Z`, { exact: true }).click();
    await fast(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
    await lecturerPage.getByRole("link", { name: /Gradebook|Buku gred/i }).click();
    await fast(lecturerPage).toHaveURL(/\/gradebook$/);

    // Neither practice nor draft appears as a column → empty state.
    await fast(lecturerPage.getByText(/No published quizzes yet|Tiada kuiz diterbitkan/)).toBeVisible();
    await fast(lecturerPage.getByText("E39 Practice Z")).toHaveCount(0);
    await fast(lecturerPage.getByText("E39 Draft Z")).toHaveCount(0);

    await lecturerCtx.close();
  });

  test("non-owner lecturer direct-URL → 404; student → redirected to student classes", async ({ browser }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const ownerCtx = await browser.newContext();
    const ownerPage = await ownerCtx.newPage();
    await registerUser(ownerPage, `lecturer-e39o-${TEST_TIMESTAMP}@innovision.test`, "lecturer", LECTURER_INVITE_CODE);
    await createClass(ownerPage, `${CLASS_TITLE} O`);

    // Grab the class id from the owner's URL (wait for the SPA nav to commit
    // before parsing — unbounded url() reads are a flake).
    await ownerPage.getByText(`${CLASS_TITLE} O`, { exact: true }).click();
    await fast(ownerPage).toHaveURL(/\/lecturer\/classes\/[0-9a-f-]{36}$/);
    const url = ownerPage.url();
    const classId = /\/lecturer\/classes\/([0-9a-f-]{36})/.exec(url)?.[1];
    expect(classId).toBeTruthy();
    await ownerCtx.close();

    // Non-owner lecturer direct-URLs the gradebook → 404 page.
    const intruderCtx = await browser.newContext();
    const intruderPage = await intruderCtx.newPage();
    await registerUser(intruderPage, `lecturer-e39i-${TEST_TIMESTAMP}@innovision.test`, "lecturer", LECTURER_INVITE_CODE);
    await intruderPage.goto(`/lecturer/classes/${classId}/gradebook`);
    await fast(intruderPage.getByText(/page not found|404/i).first()).toBeVisible();
    await intruderCtx.close();

    // Student direct-URL → redirected to /student/classes.
    const studentCtx = await browser.newContext();
    const studentPage = await studentCtx.newPage();
    await registerUser(studentPage, `student-e39o-${TEST_TIMESTAMP}@innovision.test`, "student", LECTURER_INVITE_CODE);
    await studentPage.goto(`/lecturer/classes/${classId}/gradebook`);
    await fast(studentPage).toHaveURL(/\/student\/classes/);
    await studentCtx.close();
  });
});
