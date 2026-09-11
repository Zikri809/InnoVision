import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  createAssessmentAndPublish,
  startQuizByTitle,
  completeQuiz,
} from "./helpers";

/**
 * m3 — mobile gradebook composition (`GradebookMobile`).
 * Runs ONLY in the `mobile` project (iPhone X descriptor, 375×812).
 *
 * Covers:
 *  1. Viewport swap: desktop <table> is completely unmounted; <GradebookMobile> renders.
 *  2. Class summary meter: section[aria-label="Class average"], 75%, 2 students · 2 quizzes, width: 75%.
 *  3. Quiz chip strip: horizontal scrollable strip with chips for each assessment and average percent.
 *  4. Per-quiz drawer sheet:
 *     - ResponsiveModal with quiz title, average percent, unrevealed status.
 *     - 5-bucket clay distribution bar (<50 · 50-64 · 65-79 · 80-89 · 90-100%).
 *     - Student scores with colored badges.
 *  5. Per-student drawer sheet:
 *     - ResponsiveModal with student name, cumulative progress meter, overall percent.
 *     - List of quizzes with percentage and score (e.g. 2/2, 1/2, or —).
 *  6. Search filter: #gradebook-search narrows visible rows and updates visible count text.
 */

const UNIQUE = `m3-${Date.now()}`;
const LECTURER_EMAIL = `${UNIQUE}-lec@innovision.test`;
const STUDENT_A_EMAIL = `${UNIQUE}-stu-a@innovision.test`;
const STUDENT_B_EMAIL = `${UNIQUE}-stu-b@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = `M3 Class ${UNIQUE}`;
const QUIZ_ALPHA = `M3 Alpha ${UNIQUE}`;
const QUIZ_BETA = `M3 Beta ${UNIQUE}`;

test.describe("M3 — Mobile Gradebook", () => {
  test("summary meter, quiz chips, per-quiz sheet with distribution, per-student sheet, and search filter", async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile-only");
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");
    test.setTimeout(120_000);

    const lecturerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const studentACtx = await browser.newContext();
    const studentBCtx = await browser.newContext();

    const lecturerPage = await lecturerCtx.newPage();
    const pageA = await studentACtx.newPage();
    const pageB = await studentBCtx.newPage();

    // 1. Lecturer Setup: 1 Class, 2 Assessments
    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);

    // Assessment 1: 2 questions
    await createAssessmentAndPublish(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_ALPHA,
      questions: [
        { prompt: "What is 2+2?", options: ["3", "4"], correctIndex: 1 },
        { prompt: "Capital of France?", options: ["Paris", "Rome"], correctIndex: 0 },
      ],
    });

    // Assessment 2: 1 question
    await createAssessmentAndPublish(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_BETA,
      questions: [
        { prompt: "5 x 5 = ?", options: ["20", "25"], correctIndex: 1 },
      ],
    });

    // 2. Student Setup: Register & Join Class
    await registerUser(pageA, STUDENT_A_EMAIL, "student", LECTURER_INVITE_CODE);
    await joinClass(pageA, joinCode, CLASS_TITLE);

    await registerUser(pageB, STUDENT_B_EMAIL, "student", LECTURER_INVITE_CODE);
    await joinClass(pageB, joinCode, CLASS_TITLE);

    const studentAName = `student-${STUDENT_A_EMAIL.split("@")[0]}`;
    const studentBName = `student-${STUDENT_B_EMAIL.split("@")[0]}`;

    // Student A: 100% on Alpha (2/2), 100% on Beta (1/1) -> Cumulative 100%
    await pageA.goto("/student/quizzes");
    await startQuizByTitle(pageA, QUIZ_ALPHA);
    await completeQuiz(pageA, ["4", "Paris"], { next: "Next", finish: "Finish" });
    await expect(pageA.getByText(/Assessment submitted!/i)).toBeVisible();

    await pageA.goto("/student/quizzes");
    await startQuizByTitle(pageA, QUIZ_BETA);
    await completeQuiz(pageA, ["25"], { next: "Next", finish: "Finish" });
    await expect(pageA.getByText(/Assessment submitted!/i)).toBeVisible();

    // Student B: 50% on Alpha (1/2), unattempted Beta -> Cumulative 50%
    await pageB.goto("/student/quizzes");
    await startQuizByTitle(pageB, QUIZ_ALPHA);
    await completeQuiz(pageB, ["4", "Rome"], { next: "Next", finish: "Finish" });
    await expect(pageB.getByText(/Assessment submitted!/i)).toBeVisible();

    // 3. Lecturer Navigates to Gradebook on Mobile Viewport
    // Close student contexts
    await studentACtx.close();
    await studentBCtx.close();

    // Switch lecturer viewport to mobile for mobile gradebook assertions
    await lecturerPage.setViewportSize({ width: 375, height: 812 });

    // Open gradebook in lecturerPage
    await lecturerPage.goto("/lecturer/classes");
    await expect(lecturerPage.getByRole("heading", { name: /My Classes|Kelas Saya/i })).toBeVisible();
    await lecturerPage.getByText(CLASS_TITLE, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);

    await lecturerPage.getByRole("link", { name: /Gradebook|Buku gred/i }).click();
    await expect(lecturerPage).toHaveURL(/\/gradebook$/);
    await expect(lecturerPage.getByRole("heading", { name: /Gradebook|Buku gred/i })).toBeVisible();

    // 4. Assert Component Swap: Desktop <table> is completely absent
    await expect(lecturerPage.locator("table")).toHaveCount(0);

    // 5. Assert Class Summary Meter
    const summarySection = lecturerPage.locator('section[aria-label="Class average"]');
    await expect(summarySection).toBeVisible();
    await expect(summarySection.getByText("75%")).toBeVisible();
    await expect(summarySection.getByText(/2 students · 2 quizzes/i)).toBeVisible();
    await expect(summarySection.locator('div[style*="width: 75%"]')).toBeVisible();

    // 6. Assert Quiz Chip Strip
    const alphaChip = lecturerPage.locator("button").filter({ hasText: QUIZ_ALPHA });
    await expect(alphaChip).toBeVisible();
    await expect(alphaChip.getByText("75%")).toBeVisible();

    const betaChip = lecturerPage.locator("button").filter({ hasText: QUIZ_BETA });
    await expect(betaChip).toBeVisible();
    await expect(betaChip.getByText("100%")).toBeVisible();

    // 7. Assert Per-Quiz Drawer Sheet (Open Alpha)
    await alphaChip.click();
    const quizModal = lecturerPage.getByRole("dialog");
    await expect(quizModal).toBeVisible();
    await expect(quizModal.getByRole("heading", { name: QUIZ_ALPHA })).toBeVisible();
    await expect(quizModal.getByText(/Class average:\s*75%/i)).toBeVisible();

    // 5-Bucket Distribution Bar
    await expect(quizModal.getByText("<50 · 50-64 · 65-79 · 80-89 · 90-100%")).toBeVisible();
    await expect(quizModal.locator("span.bg-amber-400\\/80")).toBeVisible(); // 50-64 band (Student B 50%)
    await expect(quizModal.locator("span.bg-emerald-600\\/80")).toBeVisible(); // 90-100 band (Student A 100%)

    // Student rows inside quiz sheet
    await expect(quizModal.locator("li").filter({ hasText: studentAName }).getByText("100%")).toBeVisible();
    await expect(quizModal.locator("li").filter({ hasText: studentBName }).getByText("50%")).toBeVisible();

    // Close quiz sheet via Escape
    await lecturerPage.keyboard.press("Escape");
    await expect(quizModal).toHaveCount(0);

    // 8. Assert Per-Student Drawer Sheet (Student A)
    const studentList = lecturerPage.locator("ul.rounded-\\[22px\\]");
    await expect(studentList).toBeVisible();

    const rowBtnA = studentList.getByRole("button").filter({ hasText: studentAName });
    await expect(rowBtnA).toBeVisible();
    await expect(rowBtnA.getByText("100%")).toBeVisible();
    await rowBtnA.click();

    const studentModal = lecturerPage.getByRole("dialog");
    await expect(studentModal).toBeVisible();
    await expect(studentModal.getByRole("heading", { name: studentAName })).toBeVisible();
    await expect(studentModal.getByText(/Overall:\s*100%/i)).toBeVisible();

    // Quiz rows for Student A
    const aRowAlpha = studentModal.locator("li").filter({ hasText: QUIZ_ALPHA });
    await expect(aRowAlpha.getByText("100%")).toBeVisible();
    await expect(aRowAlpha.getByText("2/2")).toBeVisible();

    const aRowBeta = studentModal.locator("li").filter({ hasText: QUIZ_BETA });
    await expect(aRowBeta.getByText("100%")).toBeVisible();
    await expect(aRowBeta.getByText("1/1")).toBeVisible();

    // Close via Escape
    await lecturerPage.keyboard.press("Escape");
    await expect(studentModal).toHaveCount(0);

    // Assert Per-Student Drawer Sheet (Student B)
    const rowBtnB = studentList.getByRole("button").filter({ hasText: studentBName });
    await expect(rowBtnB).toBeVisible();
    await expect(rowBtnB.getByText("50%")).toBeVisible();
    await rowBtnB.click();

    await expect(studentModal).toBeVisible();
    await expect(studentModal.getByRole("heading", { name: studentBName })).toBeVisible();
    await expect(studentModal.getByText(/Overall:\s*50%/i)).toBeVisible();

    // Quiz rows for Student B
    const bRowAlpha = studentModal.locator("li").filter({ hasText: QUIZ_ALPHA });
    await expect(bRowAlpha.getByText("50%")).toBeVisible();
    await expect(bRowAlpha.getByText("1/2")).toBeVisible();
    await expect(studentModal.locator("li").filter({ hasText: QUIZ_BETA }).getByText("—")).toBeVisible();

    // Close via Escape
    await lecturerPage.keyboard.press("Escape");
    await expect(studentModal).toHaveCount(0);

    // 9. Search Filter Integration
    const searchInput = lecturerPage.locator("#gradebook-search");
    await expect(searchInput).toBeVisible();

    await searchInput.fill(studentAName);
    await expect(lecturerPage.getByText(/Showing 1 of 2 students/i)).toBeVisible();
    await expect(studentList.getByRole("button").filter({ hasText: studentAName })).toBeVisible();
    await expect(studentList.getByRole("button").filter({ hasText: studentBName })).toHaveCount(0);

    // Clear search filter -> full roster restored
    await searchInput.fill("");
    await expect(lecturerPage.getByText(/Showing 2 of 2 students/i)).toBeVisible();
    await expect(studentList.getByRole("button").filter({ hasText: studentAName })).toBeVisible();
    await expect(studentList.getByRole("button").filter({ hasText: studentBName })).toBeVisible();

    await lecturerCtx.close();
  });
});
