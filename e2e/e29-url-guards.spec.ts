import { test, expect } from "@playwright/test";
import { registerUser, createClass, joinClass, createQuizWithQuestions } from "./helpers";

/**
 * E29 — URL guards (HIGH #4 page-level).
 * Serial tests:
 *   1. Role guard: a student hitting /lecturer/classes is redirected to
 *      /student/classes (lecturer layout role check).
 *   2. Auth guard: a logged-out visitor hitting /student/quizzes is sent to
 *      /login.
 *   3. Foreign-session isolation: student B opens student A's REAL
 *      /play/<sessionId> → notFound() (no oracle, no RLS leak).
 */

const stamp = Date.now();
const LECTURER_EMAIL = `e29-lec-${stamp}@e2e.test`;
const STUDENT_A = `e29-stuA-${stamp}@e2e.test`;
const STUDENT_B = `e29-stuB-${stamp}@e2e.test`;
const INVITE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = `E29 Guards ${stamp}`;
const QUIZ_TITLE = `E29 Guard Quiz ${stamp}`;

test.describe.configure({ mode: "serial" });

test("role guard: student redirected away from the lecturer area", async ({
  page,
}) => {
  await registerUser(page, STUDENT_A, "student", "");
  await page.goto("/lecturer/classes");
  await expect(page).toHaveURL(/\/student\/classes/);
});

test("logged-out visitor is sent to the login wall", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/student/quizzes");
  await expect(page).toHaveURL(/\/login/);
  await ctx.close();
});

test("foreign session URL renders notFound (no oracle)", async ({
  browser,
}) => {
  test.skip(!INVITE, "LECTURER_INVITE_CODE not set");

  // Lecturer + live practice quiz so student A can mint a real session.
  const lecturerCtx = await browser.newContext();
  const lecturer = await lecturerCtx.newPage();
  await registerUser(lecturer, LECTURER_EMAIL, "lecturer", INVITE);
  const joinCode = await createClass(lecturer, CLASS_TITLE);
  await createQuizWithQuestions(lecturer, {
    classTitle: CLASS_TITLE,
    quizTitle: QUIZ_TITLE,
    publish: true,
    questions: [{ prompt: "Guard question?", options: ["A", "B"], correctIndex: 1 }],
  });

  // Student A joins and starts → lands on /play/<sessionId>.
  const aCtx = await browser.newContext();
  const a = await aCtx.newPage();
  await registerUser(a, STUDENT_A, "student", "");
  await joinClass(a, joinCode, CLASS_TITLE);
  await a.goto("/student/quizzes");
  await a.getByRole("button", { name: "Start", exact: true }).click();
  await a.waitForURL(/\/play\/[0-9a-f-]{36}$/);
  const sessionId = new URL(a.url()).pathname.split("/").pop() ?? "";
  expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

  // Student B — a genuinely enrolled peer — hits the same URL: notFound.
  const bCtx = await browser.newContext();
  const b = await bCtx.newPage();
  await registerUser(b, STUDENT_B, "student", "");
  await b.goto(`/play/${sessionId}`);
  await expect(b).toHaveURL(new RegExp(`/play/${sessionId}`));
  await expect(b.getByText("404", { exact: true })).toBeVisible();
  await expect(
    b.getByRole("heading", { name: "Page not found", exact: true }),
  ).toBeVisible();

  await lecturerCtx.close();
  await aCtx.close();
  await bCtx.close();
});
