import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import {
  registerUser,
  createClass,
  joinClass,
  createAssessmentAndPublish,
  openResults,
} from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e18-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_EMAIL = `student-e18-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E18 Export";
const QUIZ_TITLE = "E18 Assessment";

// Fail-fast: every in-page assertion gets a 5s budget instead of the repo's
// 15s global — a broken step here surfaces in seconds, not quarters.
const fast = expect.configure({ timeout: 5_000 });

/**
 * E18 (optional, non-gate) — lecturer results Excel export, END TO END:
 *
 * 1. Lecturer: class + UNTIMED assessment (2 questions) + publish.
 * 2. Student: join → start → answer Q1 CORRECT → answer Q2 WRONG → Finish
 *    (the unseamed click-first path — same choreography as E13's Student B).
 * 3. Lecturer: Results dashboard → "Export Excel" button → Playwright captures
 *    the BLOB download → file parsed with exceljs and inspected:
 *      - suggested filename matches `<title>-results-YYYY-MM-DD.xlsx`
 *      - exactly 3 sheets in presentation order
 *      - Results row: name, matric, Completed status, score 1/2, 50% numeric,
 *        per-question cells ("B — 4" correct-green / wrong red)
 *      - Questions & Key: correct-answer letters + per-question stats
 *      - Choice Distribution rows exist for both questions
 *
 * This is the ONLY layer that exercises the real download UX (fetch → blob →
 * anchor click) plus a real xlsx container; route/model units stay pure.
 */
test.describe("E18 — results Excel export", () => {
  // Fail fast: the full flow is ~12 quick UI steps; every expect uses
  // Playwright's 5s default so a broken step surfaces in seconds, not minutes.
  test("Export button downloads an xlsx with matric, score, choices, key", async ({ browser }, testInfo) => {
    testInfo.setTimeout(90_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    // ── 1. Lecturer: class + assessment + publish ────────────────────
    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await fast(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    await createAssessmentAndPublish(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_TITLE,
      questions: [
        { prompt: "What is 2+2?", options: ["3", "4"], correctIndex: 1 },
        { prompt: "Capital of France?", options: ["Paris", "Rome"], correctIndex: 0 },
      ],
    });

    // ── 2. Student: join + complete with one right, one wrong ────────
    const { matric } = await registerUser(studentPage, STUDENT_EMAIL, "student", LECTURER_INVITE_CODE);
    expect(matric).toMatch(/^[0-9]{6}$/);
    const studentName = `student-${STUDENT_EMAIL.split("@")[0]}`;
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await fast(studentPage).toHaveURL(/\/student\/quizzes/);
    await studentPage.getByRole("button", { name: "Start", exact: true }).click();
    await fast(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    // Option buttons' accessible names are "<letter> <text>" (e.g. "B 4") —
    // match on the unique option text, same convention as E13.
    await fast(studentPage.getByText("What is 2+2?", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /4/ }).click();
    await studentPage.getByRole("button", { name: "Next", exact: true }).click();
    await fast(studentPage.getByText("Capital of France?", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /Rome/ }).click();
    await studentPage.getByRole("button", { name: "Finish", exact: true }).click();
    // Unrevealed assessment end screen ("Assessment complete" is practice copy).
    await fast(studentPage.getByText(/Assessment submitted!/i)).toBeVisible();

    // ── 3. Export via the dashboard button + inspect the workbook ────
    await openResults(lecturerPage, CLASS_TITLE, QUIZ_TITLE);
    // "Completed" appears in the stat tile AND the row chip — scope to the
    // attendance list (E14 convention).
    await fast(
      lecturerPage.getByRole("list").getByText("Completed", { exact: true }),
    ).toHaveCount(1);

    // ── RA-2: the on-screen "Question insights" section mirrors the model ──
    await fast(lecturerPage.getByRole("button", { name: /Question insights/i })).toBeVisible();
    await lecturerPage.getByRole("button", { name: /Question insights/i }).click();
    // Q1 (2+2): the student answered correctly → 100% stat chip. The
    // never-picked-distractor hint FIRES here: with 2 options, the unpicked
    // "3" is a wrong option (distractor) — exactly the class-never-touched-it
    // signal RA-2 exists to surface.
    const q1Card = lecturerPage.locator("li").filter({ hasText: "What is 2+2?" });
    await fast(q1Card.getByText(/100% · 1 answered/)).toBeVisible();
    await fast(q1Card.getByText(/Distractor never picked/i)).toBeVisible();
    // Q2 (Capital of France): wrong pick → 0% + the low-correct hint chip
    // (<30% threshold). The distractor hint must NOT fire here: the only
    // UNPICKED option (Paris) is the KEY, and key options are excluded from
    // the distractor check (insights.ts) — a wrong pick never triggers it on
    // a 2-option question.
    const q2Card = lecturerPage.locator("li").filter({ hasText: "Capital of France?" });
    await fast(q2Card.getByText(/0% · 1 answered/)).toBeVisible();
    await fast(q2Card.getByText(/Only 0% correct/i)).toBeVisible();
    await fast(q2Card.getByText(/Distractor never picked/i)).toHaveCount(0);
    // The section's summary line flips to the degenerate variant (Q2 is 0%).
    await fast(lecturerPage.getByText(/teaching gap/i)).toBeVisible();

    const downloadPromise = lecturerPage.waitForEvent("download");
    await lecturerPage.getByRole("button", { name: /Export Excel/i }).click();
    const download = await downloadPromise;

    // Filename mirrors Content-Disposition: <safe-title>-results-<date>.xlsx
    expect(download.suggestedFilename()).toMatch(new RegExp(`^E18 Assessment-results-\\d{4}-\\d{2}-\\d{2}\\.xlsx$`));

    const filePath = await download.path();
    expect(filePath).toBeTruthy();

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath as string);

    // Exactly the three localized sheets, in order.
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Results",
      "Questions & Key",
      "Choice Distribution",
    ]);

    // ── Sheet 1: header + the student's row ──────────────────────────
    const results = wb.getWorksheet("Results")!;
    expect(results.getCell(4, 3).value).toBe("Name");
    expect(results.getCell(4, 13).value).toBe("Q1");

    expect(results.getCell(5, 1).value).toBe(1); // first data row
    expect(results.getCell(5, 2).value).toBe(matric); // MATRIC from roster view
    expect(results.getCell(5, 3).value).toBe(studentName);
    expect(results.getCell(5, 4).value).toBe("Completed");
    expect(results.getCell(5, 5).value).toBe(1); // score: one correct of two
    expect(results.getCell(5, 6).value).toBe(2); // total
    expect(results.getCell(5, 7).value).toBeCloseTo(0.5); // numeric percent

    // Per-question cells: chosen option letter + text, colored by correctness.
    expect(results.getCell(5, 13).value).toBe("B — 4"); // Q1 correct choice
    expect(results.getCell(5, 13).font?.color?.argb).toBe("FF166534"); // green
    expect(results.getCell(5, 14).value).toBe("B — Rome"); // Q2 wrong choice
    expect(results.getCell(5, 14).font?.color?.argb).toBe("FFB91C1C"); // red

    // ── Sheet 2: answer key letters + stats ──────────────────────────
    const key = wb.getWorksheet("Questions & Key")!;
    expect(key.getCell(3, 9).value).toBe("B"); // Q1 correct = index 1
    expect(key.getCell(4, 9).value).toBe("A"); // Q2 correct = index 0
    expect(key.getCell(3, 11).value).toBe(1); // times answered (per question)
    expect(key.getCell(3, 12).value).toBe(1); // times correct
    expect(key.getCell(3, 13).value).toBeCloseTo(1.0); // % correct Q1
    expect(key.getCell(4, 13).value).toBeCloseTo(0); // % correct Q2
    // Explanation column empty (fixtures have none) but prompt present.
    expect(key.getCell(4, 3).value).toBe("Capital of France?");

    // ── Sheet 3: distribution covers both questions' options ────────
    const dist = wb.getWorksheet("Choice Distribution")!;
    // Header at row 2; data starts at 3 → 2 questions × 2 options = 4 rows.
    expect(dist.getCell(3, 1).value).toBe("Q1");
    expect(dist.getCell(5, 1).value).toBe("Q2");
    expect(dist.actualRowCount).toBeGreaterThanOrEqual(4);
    // Q1's correct option was chosen once → count column on row 4 (option B).
    expect(dist.getCell(4, 6).value).toBe(1);

    await lecturerCtx.close();
    await studentCtx.close();
  });

  test("zero-session export keeps roster rows as Not started with headers intact", async ({ browser }, testInfo) => {
    testInfo.setTimeout(90_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    // Lecturer: class + published assessment.
    const lec = `lecturer-e18z-${TEST_TIMESTAMP}@innovision.test`;
    const stu = `student-e18z-${TEST_TIMESTAMP}@innovision.test`;
    await registerUser(lecturerPage, lec, "lecturer", LECTURER_INVITE_CODE);
    const joinCode = await createClass(lecturerPage, `${CLASS_TITLE} Z`);
    await createAssessmentAndPublish(lecturerPage, {
      classTitle: `${CLASS_TITLE} Z`,
      quizTitle: `${QUIZ_TITLE} Z`,
      questions: [{ prompt: "Nobody will answer this?", options: ["a", "b"] }],
    });

    // Student joins but NEVER attempts.
    const { matric } = await registerUser(studentPage, stu, "student", LECTURER_INVITE_CODE);
    expect(matric).toMatch(/^[0-9]{6}$/);
    await joinClass(studentPage, joinCode, `${CLASS_TITLE} Z`);

    // Export from a zero-session quiz.
    await openResults(lecturerPage, `${CLASS_TITLE} Z`, `${QUIZ_TITLE} Z`);
    const downloadPromise = lecturerPage.waitForEvent("download");
    await lecturerPage.getByRole("button", { name: /Export Excel/i }).click();
    const download = await downloadPromise;
    const filePath = await download.path();
    expect(filePath).toBeTruthy();

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath as string);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Results",
      "Questions & Key",
      "Choice Distribution",
    ]);

    // Headers intact + a roster row for the never-attempted student.
    const results = wb.getWorksheet("Results")!;
    expect(results.getCell(4, 3).value).toBe("Name");
    expect(results.getCell(4, 4).value).toBe("Status");
    expect(results.getCell(5, 1).value).toBe(1);
    expect(results.getCell(5, 2).value).toBe(matric);
    expect(results.getCell(5, 4).value).toBe("Not started");
    // Never-attempted: score cell stays EMPTY (null), not a fabricated 0.
    expect(results.getCell(5, 5).value).toBe(null);

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
