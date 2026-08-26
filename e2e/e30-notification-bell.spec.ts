import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  createQuizWithQuestions,
  E2E_PASSWORD,
} from "./helpers";

/**
 * E30 — Notification bell (HIGH #1).
 * Serial tests over one shared class. Poll cadence is driven down to 500ms via
 * the __INNOVISION_NOTIF_CONTROL__ seam (poll-state.ts:33-53) so a notification
 * created AFTER a page loads surfaces within a second. Desktop viewport only
 * (the mobile bottom sheet is out of scope).
 *   1. Lecturer bell: student joins → "Notifications, 1 unread"; open the
 *      panel (desktop Popover — anchor via trigger click, then the
 *      "Mark all as read" button, NO role/name on the panel) → row click
 *      navigates to /lecturer/classes/<id> and the count decrements.
 *   2. Student bell: quiz published → bell increments → click-through → back
 *      on /student/quizzes.
 *   3. Mark all as read: a second publish → fresh unread → mark-all → count 0
 *      and the button disables.
 */

const stamp = Date.now();
const LECTURER_EMAIL = `e30-lec-${stamp}@e2e.test`;
const STUDENT_EMAIL = `e30-stu-${stamp}@e2e.test`;
const INVITE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = `E30 Class ${stamp}`;
const QUIZ_A = `E30 Quiz A ${stamp}`;
const QUIZ_B = `E30 Quiz B ${stamp}`;

let joinCode = "";
let classId = "";

test.describe.configure({ mode: "serial" });

async function newSeamContext(browser: import("@playwright/test").Browser) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    (window as unknown as { __INNOVISION_NOTIF_CONTROL__?: { pollMs: number } }).__INNOVISION_NOTIF_CONTROL__ =
      { pollMs: 500 };
  });
  return ctx;
}

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.getByLabel(/Email/).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/(student|lecturer)\//, { timeout: 30_000 });
}

test("lecturer bell: join notification, panel row click navigates + decrements", async ({
  browser,
}) => {
  test.skip(!INVITE, "LECTURER_INVITE_CODE not set");

  const lecturerCtx = await newSeamContext(browser);
  const lecturer = await lecturerCtx.newPage();
  await registerUser(lecturer, LECTURER_EMAIL, "lecturer", INVITE);

  // Create the class and park the lecturer on the dashboard with the poll loop live.
  joinCode = await createClass(lecturer, CLASS_TITLE);
  await lecturer.goto("/lecturer/classes");
  classId = ""; // resolved after the student joins + row click

  const studentCtx = await newSeamContext(browser);
  const student = await studentCtx.newPage();
  await registerUser(student, STUDENT_EMAIL, "student", "");
  await joinClass(student, joinCode, CLASS_TITLE);

  // Lecturer's poll (500ms) picks up the student_joined notification.
  await expect(
    lecturer.getByRole("button", { name: "Notifications, 1 unread", exact: true }),
  ).toBeVisible({ timeout: 15_000 });

  // Open the desktop Popover (no role on the panel) — anchor on the Mark-all button.
  await lecturer.getByRole("button", { name: "Notifications, 1 unread", exact: true }).click();
  const markAll = lecturer.getByRole("button", { name: "Mark all as read", exact: true });
  await expect(markAll).toBeVisible();
  await expect(lecturer.getByRole("button", { name: /New student/ })).toBeVisible();

  // Click the row → navigates to the class detail and reads the notification.
  await lecturer.getByRole("button", { name: /New student/ }).click();
  await expect(lecturer).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
  classId = new URL(lecturer.url()).pathname.split("/").pop() ?? "";
  await expect(
    lecturer.getByRole("button", { name: "Notifications", exact: true }),
  ).toBeVisible();

  await lecturerCtx.close();
  await studentCtx.close();
});

test("student bell: publish → increment → click-through to /student/quizzes", async ({
  browser,
}) => {
  test.skip(!classId, "setup test did not run");

  const lecturerCtx = await browser.newContext();
  const lecturer = await lecturerCtx.newPage();
  await signIn(lecturer, LECTURER_EMAIL);
  await lecturer.goto("/lecturer/classes");

  // Student parks on /student/quizzes with the fast poll running.
  const studentCtx = await newSeamContext(browser);
  const student = await studentCtx.newPage();
  await signIn(student, STUDENT_EMAIL);
  await student.goto("/student/quizzes");

  // Publish a practice quiz → notify_quiz_live → the student's bell increments.
  await createQuizWithQuestions(lecturer, {
    classTitle: CLASS_TITLE,
    quizTitle: QUIZ_A,
    questions: [{ prompt: "Bell probe?", options: ["A", "B"], correctIndex: 0 }],
    publish: true,
  });

  await expect(
    student.getByRole("button", { name: "Notifications, 1 unread", exact: true }),
  ).toBeVisible({ timeout: 15_000 });

  // Click the "New practice quiz" row → back on the quizzes page, count cleared.
  await student.getByRole("button", { name: "Notifications, 1 unread", exact: true }).click();
  await student.getByRole("button", { name: /New practice quiz/ }).click();
  await expect(student).toHaveURL(/\/student\/quizzes/);
  await expect(
    student.getByRole("button", { name: "Notifications", exact: true }),
  ).toBeVisible();

  await lecturerCtx.close();
  await studentCtx.close();
});

test("mark all as read clears the badge and disables the button", async ({
  browser,
}) => {
  test.skip(!classId, "setup test did not run");

  const lecturerCtx = await browser.newContext();
  const lecturer = await lecturerCtx.newPage();
  await signIn(lecturer, LECTURER_EMAIL);
  await lecturer.goto("/lecturer/classes");

  const studentCtx = await newSeamContext(browser);
  const student = await studentCtx.newPage();
  await signIn(student, STUDENT_EMAIL);
  await student.goto("/student/quizzes");

  await createQuizWithQuestions(lecturer, {
    classTitle: CLASS_TITLE,
    quizTitle: QUIZ_B,
    questions: [{ prompt: "Bell probe two?", options: ["A", "B"], correctIndex: 0 }],
    publish: true,
  });

  await expect(
    student.getByRole("button", { name: "Notifications, 1 unread", exact: true }),
  ).toBeVisible({ timeout: 15_000 });

  await student.getByRole("button", { name: "Notifications, 1 unread", exact: true }).click();
  await student.getByRole("button", { name: "Mark all as read", exact: true }).click();
  await expect(
    student.getByRole("button", { name: "Notifications", exact: true }),
  ).toBeVisible();
  await expect(
    student.getByRole("button", { name: "Mark all as read", exact: true }),
  ).toBeDisabled();

  await lecturerCtx.close();
  await studentCtx.close();
});
