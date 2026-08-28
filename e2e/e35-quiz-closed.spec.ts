import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  createQuizWithQuestions,
  resolveServiceClient,
  closeQuiz,
} from "./helpers";

/**
 * E35 — quiz closed-state contract (HIGH #4 continuation + QC-1/QC-2).
 *
 * Ordered serial tests:
 *  1. App-driven close: the lecturer closes a LIVE quiz through the UI
 *     (results dashboard → Close dialog → confirm), then the state machine's
 *     terminal behavior is verified: republish → 409, student start → 404,
 *     builder chip → Closed.
 *  2. The service-role seam (localhost-gated, e13b/e26 precedent) drives a
 *     SECOND quiz closed to re-assert the API contract independently of the
 *     UI (kept for environments where the UI flow is broken).
 */

const stamp = Date.now();
const LECTURER_EMAIL = `e35-lec-${stamp}@e2e.test`;
const STUDENT_EMAIL = `e35-stu-${stamp}@e2e.test`;
const INVITE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = `E35 Closed ${stamp}`;
const QUIZ_TITLE = `E35 Closed Quiz ${stamp}`;
const QUIZ_TITLE_2 = `E35 Closed Quiz B ${stamp}`;

test.describe.configure({ mode: "serial" });

let quizId = "";
let quizId2 = "";

test("app-driven close: UI dialog → terminal state pinned", async ({ browser }) => {
  test.skip(!INVITE, "LECTURER_INVITE_CODE not set");
  test.setTimeout(180_000);

  // ── Setup: lecturer class + published quiz; enrolled student.
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

  // ── 1. App-driven close through the UI (QC-1).
  await closeQuiz(lecturer, CLASS_TITLE, QUIZ_TITLE);

  // Settle: the button unmount can outrun the state flip under load — read
  // the authoritative status via the service-role DB (NOT the publish API:
  // a 500ms republish poll exhausts the 30/hr publish rate budget, and
  // repeat-each instances share the lecturer's bucket).
  const admin0 = resolveServiceClient();
  if (admin0) {
    await expect
      .poll(async () => {
        const { data } = await admin0
          .from("quizzes")
          .select("status")
          .eq("id", quizId)
          .single();
        return data?.status;
      })
      .toBe("closed");
  }

  // ── 2. Republish API: closed → live must be rejected with 409 quiz_closed.
  const pubRes = await lecturer.request.post(`/api/quizzes/${quizId}/publish`);
  expect(pubRes.status()).toBe(409);
  expect((await pubRes.json()).error).toBe("quiz_closed");

  // ── 3. Close API is idempotent (second close → 200).
  const closeRes = await lecturer.request.post(`/api/quizzes/${quizId}/close`);
  expect(closeRes.status()).toBe(200);

  // ── 4. Student start API on a closed quiz → no-oracle 404.
  const startRes = await student.request.post("/api/sessions", {
    data: { quizId },
  });
  expect(startRes.status()).toBe(404);
  expect((await startRes.json()).error).not.toBe("quiz_not_live"); // no oracle

  // ── 5. Builder UI reflects the closed state; Publish control gone.
  await lecturer.goto(`/lecturer/quizzes/${quizId}/builder`);
  await expect(lecturer.getByText("Closed", { exact: true })).toBeVisible();

  // ── 6. Students no longer see/start it from their list either.
  await student.goto("/student/quizzes");
  await expect(student.getByText(QUIZ_TITLE, { exact: true })).toBeHidden();

  await lecCtx.close();
  await stuCtx.close();
});

test("service-role closed flip keeps the API contract (republish 409, start 404)", async ({
  browser,
}) => {
  test.skip(!INVITE, "LECTURER_INVITE_CODE not set");
  test.setTimeout(180_000);

  const admin = resolveServiceClient();
  test.skip(!admin, "service-role seam unavailable (non-local Supabase)");

  const lecCtx = await browser.newContext();
  const lecturer = await lecCtx.newPage();
  await registerUser(lecturer, `e35-lec2-${stamp}@e2e.test`, "lecturer", INVITE);
  const joinCode = await createClass(lecturer, `${CLASS_TITLE} B`);
  await createQuizWithQuestions(lecturer, {
    classTitle: `${CLASS_TITLE} B`,
    quizTitle: QUIZ_TITLE_2,
    publish: true,
    questions: [{ prompt: "E35b question?", options: ["A", "B"], correctIndex: 0 }],
  });
  quizId2 = new URL(lecturer.url()).pathname.match(
    /\/lecturer\/quizzes\/([0-9a-f-]{36})/,
  )?.[1] ?? "";
  expect(quizId2).toMatch(/^[0-9a-f-]{36}$/);

  const stuCtx = await browser.newContext();
  const student = await stuCtx.newPage();
  await registerUser(student, `e35-stu2-${stamp}@e2e.test`, "student", "");
  await joinClass(student, joinCode, `${CLASS_TITLE} B`);

  // ── Flip live → closed via the service-role seam.
  // The SQL trigger requires a non-empty questions check only on draft→live;
  // closing is a plain UPDATE the one-way machine permits (live→closed).
  const { error } = await admin!
    .from("quizzes")
    .update({ status: "closed" })
    .eq("id", quizId2);
  expect(error).toBeNull();

  // ── Republish API: closed → live must be rejected with 409 quiz_closed.
  const pubRes = await lecturer.request.post(`/api/quizzes/${quizId2}/publish`);
  expect(pubRes.status()).toBe(409);
  expect((await pubRes.json()).error).toBe("quiz_closed");

  // ── Student start API on a closed quiz → no-oracle 404.
  const startRes = await student.request.post("/api/sessions", {
    data: { quizId: quizId2 },
  });
  expect(startRes.status()).toBe(404);
  expect((await startRes.json()).error).not.toBe("quiz_not_live"); // no oracle

  // ── Builder UI reflects the closed state.
  await lecturer.goto(`/lecturer/quizzes/${quizId2}/builder`);
  await expect(lecturer.getByText("Closed", { exact: true })).toBeVisible();

  // Students can no longer see/start it from their list either.
  await student.goto("/student/quizzes");
  await expect(student.getByText(QUIZ_TITLE_2, { exact: true })).toBeHidden();

  await lecCtx.close();
  await stuCtx.close();
});
