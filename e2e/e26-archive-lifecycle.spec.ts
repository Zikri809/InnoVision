import { test, expect } from "@playwright/test";
import { registerUser, createClass, joinClass, createQuizWithQuestions, E2E_PASSWORD } from "./helpers";

/**
 * E26 — Class archiving lifecycle (HIGH #9).
 * Serial tests over one shared setup:
 *   1. Lecturer archives a live class with an enrolled student → lands on the
 *      archived page; the archived page's search filter isolates the card.
 *   2. Student loses visibility: class gone from /student/classes, quiz gone
 *      from /student/quizzes; re-attempting the join code yields the inline
 *      hardcoded archived error (route.ts:103-107).
 *   3. Restore: archived class detail still shows the roster (audit
 *      preservation) + the archived banner; restore via the filtered search
 *      → student sees class + quiz again.
 */

const stamp = Date.now();
const LECTURER_EMAIL = `e26-lec-${stamp}@e2e.test`;
const STUDENT_EMAIL = `e26-stu-${stamp}@e2e.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = `E26 Physics ${stamp}`;
const QUIZ_TITLE = `E26 Quiz ${stamp}`;

let joinCode = "";
let classId = "";

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.getByLabel(/Email/).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/(student|lecturer)\//, { timeout: 30_000 });
}

test.describe.configure({ mode: "serial" });

test("lecturer archives a live class with an enrolled student", async ({
  browser,
}) => {
  test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

  const lecturerCtx = await browser.newContext();
  const studentCtx = await browser.newContext();
  const lecturer = await lecturerCtx.newPage();
  const student = await studentCtx.newPage();

  await registerUser(lecturer, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
  await registerUser(student, STUDENT_EMAIL, "student", LECTURER_INVITE_CODE);

  // Create class + one live practice quiz.
  joinCode = await createClass(lecturer, CLASS_TITLE);
  await createQuizWithQuestions(lecturer, {
    classTitle: CLASS_TITLE,
    quizTitle: QUIZ_TITLE,
    questions: [{ prompt: "What is 2 + 2?", options: ["3", "4"], correctIndex: 1 }],
    publish: true,
  });

  // Student joins.
  await student.goto("/student/classes");
  await joinClass(student, joinCode, CLASS_TITLE);

  // Lecturer archives from the class detail page.
  await lecturer.goto("/lecturer/classes");
  await lecturer.getByText(CLASS_TITLE, { exact: true }).click();
  await expect(lecturer).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
  classId = new URL(lecturer.url()).pathname.split("/").pop() ?? "";

  await lecturer.getByRole("button", { name: "Archive class", exact: true }).click();
  const archiveDialog = lecturer.getByRole("dialog");
  await expect(archiveDialog.getByRole("heading", { name: "Archive this class?" })).toBeVisible();
  await archiveDialog.getByRole("button", { name: "Archive class", exact: true }).click();

  // Lands on the archived page; search filter isolates our card.
  await expect(lecturer).toHaveURL(/\/lecturer\/classes\/archived/);
  await lecturer.getByPlaceholder(/Search archived classes/).fill(CLASS_TITLE);
  await expect(lecturer.getByText(/1 class matching/)).toBeVisible();
  await expect(lecturer.getByText(CLASS_TITLE, { exact: true })).toBeVisible();

  await lecturerCtx.close();
  await studentCtx.close();
});

test("student loses visibility; rejoin attempts hit the archived alert", async ({
  browser,
}) => {
  test.skip(!joinCode, "setup test did not run");

  const ctx = await browser.newContext();
  const student = await ctx.newPage();
  await signIn(student, STUDENT_EMAIL);

  // Class absent from /student/classes; empty state shown.
  await student.goto("/student/classes");
  await expect(student.getByText(CLASS_TITLE, { exact: true })).toHaveCount(0);
  await expect(student.getByText("Join your first class")).toBeVisible();

  // Quiz absent from /student/quizzes.
  await student.goto("/student/quizzes");
  await expect(student.getByText(QUIZ_TITLE, { exact: true })).toHaveCount(0);
  await expect(student.getByText("No quizzes available yet")).toBeVisible();

  // Rejoin attempt → inline hardcoded archived error.
  await student.goto("/student/classes");
  await student.getByLabel("Join code").fill(joinCode);
  await student.getByRole("button", { name: /^join class$/i }).click();
  await expect(
    student.getByRole("alert").filter({ hasText: "This class has been archived and cannot be joined." }),
  ).toBeVisible();

  await ctx.close();
});

test("restore re-exposes the class and quiz to the student", async ({
  browser,
}) => {
  test.skip(!classId, "setup test did not run");

  const lecturerCtx = await browser.newContext();
  const studentCtx = await browser.newContext();
  const lecturer = await lecturerCtx.newPage();
  const student = await studentCtx.newPage();
  await signIn(lecturer, LECTURER_EMAIL);
  await signIn(student, STUDENT_EMAIL);

  // Archived class detail: banner + roster preserved (audit).
  await lecturer.goto(`/lecturer/classes/${classId}`);
  await expect(lecturer.getByText(/This class is archived/)).toBeVisible();
  await expect(lecturer.getByRole("button", { name: "Restore class", exact: true }).first()).toBeVisible();
  await expect(lecturer.getByText("Roster")).toBeVisible();
  await expect(lecturer.getByText(/student-/)).toBeVisible();

  // Restore via the filtered archived list.
  await lecturer.goto("/lecturer/classes/archived");
  await lecturer.getByPlaceholder(/Search archived classes/).fill(CLASS_TITLE);
  await expect(lecturer.getByText(CLASS_TITLE, { exact: true })).toBeVisible();
  await lecturer.getByRole("button", { name: `Restore ${CLASS_TITLE}` }).click();
  const restoreDialog = lecturer.getByRole("dialog");
  await expect(restoreDialog.getByRole("heading", { name: "Restore this class?" })).toBeVisible();
  await restoreDialog.getByRole("button", { name: "Restore class", exact: true }).click();
  await expect(lecturer.getByText(CLASS_TITLE, { exact: true })).toHaveCount(0);

  // Student refresh → class + quiz back.
  await student.goto("/student/classes");
  await expect(student.getByText(CLASS_TITLE, { exact: true })).toBeVisible();
  await student.goto("/student/quizzes");
  await expect(student.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();

  await lecturerCtx.close();
  await studentCtx.close();
});
