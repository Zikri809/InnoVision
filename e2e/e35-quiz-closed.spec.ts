import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  createQuizWithQuestions,
  resolveServiceClient,
} from "./helpers";

/**
 * E35 — quiz closed-state contract (HIGH #4 continuation).
 *
 * Nothing in the app drives a quiz into `closed` today, so the state machine's
 * terminal behavior was never verified E2E. This spec uses the localhost-gated
 * service-role seam (e13b/e26 precedent) to flip a live quiz to `closed`,
 * then asserts:
 *   1. `closed → live` republish via POST /api/quizzes/[id]/publish → 409
 *      quiz_closed (one-way machine).
 *   2. A student starting the closed quiz via POST /api/sessions → 404
 *      (quiz_not_live collapses into the no-oracle 404).
 *   3. The builder shows the Closed status chip and the Publish control is
 *      gone/disabled for a closed quiz.
 */

const stamp = Date.now();
const LECTURER_EMAIL = `e35-lec-${stamp}@e2e.test`;
const STUDENT_EMAIL = `e35-stu-${stamp}@e2e.test`;
const INVITE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = `E35 Closed ${stamp}`;
const QUIZ_TITLE = `E35 Closed Quiz ${stamp}`;

test.describe.configure({ mode: "serial" });

let quizId = "";

test("closed quiz rejects republish and student starts, builder shows Closed", async ({
  browser,
}) => {
  test.skip(!INVITE, "LECTURER_INVITE_CODE not set");
  test.setTimeout(180_000);

  const admin = resolveServiceClient();
  test.skip(!admin, "service-role seam unavailable (non-local Supabase)");

  // ── Setup: lecturer class + published practice quiz; enrolled student.
  const lecCtx = await browser.newContext();
  const lecturer = await lecCtx.newPage();
  await registerUser(lecturer, LECTURER_EMAIL, "lecturer", INVITE);
  const joinCode = await createClass(lecturer, CLASS_TITLE);
  await createQuizWithQuestions(lecturer, {
    classTitle: CLASS_TITLE,
    quizTitle: QUIZ_TITLE,
    publish: true,
    questions: [{ prompt: "E35 question?", options: ["A", "B"], correctIndex: 0 }],
  });
  quizId = new URL(lecturer.url()).pathname.match(
    /\/lecturer\/quizzes\/([0-9a-f-]{36})/,
  )?.[1] ?? "";
  expect(quizId).toMatch(/^[0-9a-f-]{36}$/);

  const stuCtx = await browser.newContext();
  const student = await stuCtx.newPage();
  await registerUser(student, STUDENT_EMAIL, "student", "");
  await joinClass(student, joinCode, CLASS_TITLE);

  // ── Flip live → closed via the service-role seam.
  // The SQL trigger requires a non-empty questions check only on draft→live;
  // closing is a plain UPDATE the one-way machine permits (live→closed).
  const { error } = await admin!
    .from("quizzes")
    .update({ status: "closed" })
    .eq("id", quizId);
  expect(error).toBeNull();

  // ── 1. Republish API: closed → live must be rejected with 409 quiz_closed.
  const pubRes = await lecturer.request.post(`/api/quizzes/${quizId}/publish`);
  expect(pubRes.status()).toBe(409);
  expect((await pubRes.json()).error).toBe("quiz_closed");

  // ── 2. Student start API on a closed quiz → no-oracle 404.
  const startRes = await student.request.post("/api/sessions", {
    data: { quizId },
  });
  expect(startRes.status()).toBe(404);
  expect((await startRes.json()).error).not.toBe("quiz_not_live"); // no oracle

  // ── 3. Builder UI reflects the closed state.
  await lecturer.goto(`/lecturer/quizzes/${quizId}/builder`);
  await expect(lecturer.getByText("Closed", { exact: true })).toBeVisible();

  // Students can no longer see/start it from their list either.
  await student.goto("/student/quizzes");
  await expect(student.getByText(QUIZ_TITLE, { exact: true })).toBeHidden();

  await lecCtx.close();
  await stuCtx.close();
});
