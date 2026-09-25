import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  createQuizWithQuestions,
  completeQuiz,
  startQuizByTitle,
  currentSessionId,
  setAutoReveal,
  openResults,
  resolveServiceClient,
} from "./helpers";

/**
 * E49 — auto-reveal-on-complete (the setAutoReveal helper existed unused).
 *
 * The submit_session RPC flips results_revealed_at ATOMICALLY when the LAST
 * fresh (≤2h) active/paused/flagged assessment session completes and the quiz
 * has auto_reveal_on_complete=true — no lecturer reveal click. Covers:
 *
 *  1. Student submits → EndScreen renders the SCORED state immediately
 *     (ScoreRing number + pct line, NOT the "results pending" panel).
 *  2. The quiz list card flips to the "View results" link without any
 *     lecturer action (e40's transition, driven by auto-reveal instead).
 *  3. Lecturer's dashboard shows "Results revealed" with zero visits to the
 *     reveal dialog.
 *  4. Server truth: results_revealed_at set (service-role probe).
 *  5. Control: a second quiz WITHOUT auto-reveal stays pending on both
 *     surfaces — the flag is the differentiator, not the submit.
 */

const stamp = Date.now();
const INVITE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = `E49 AutoReveal ${stamp}`;
const AUTO_QUIZ = `E49 Auto Quiz ${stamp}`;
const MANUAL_QUIZ = `E49 Manual Quiz ${stamp}`;

test.describe.configure({ mode: "serial" });

test("auto-reveal flips on last submit — scored EndScreen, live link, lecturer chip", async ({
  browser,
}) => {
  test.skip(!INVITE, "LECTURER_INVITE_CODE not set");
  test.setTimeout(240_000);

  const lecCtx = await browser.newContext();
  const lecturer = await lecCtx.newPage();
  await registerUser(lecturer, `e49-lec-${stamp}@e2e.test`, "lecturer", INVITE);
  const joinCode = await createClass(lecturer, CLASS_TITLE);

  // Both assessments share the class; the quiz id is parsed from the builder
  // URL each create lands on (e37 pattern).
  await createQuizWithQuestions(lecturer, {
    classTitle: CLASS_TITLE,
    quizTitle: AUTO_QUIZ,
    mode: "assessment",
    publish: true,
    // 0067: auto-reveal semantics, not identity — bypass the face gate.
    gesturesOff: true,
    questions: [{ prompt: "E49 auto q?", options: ["A1", "B1"], correctIndex: 1 }],
  });
  const autoQuizId = new URL(lecturer.url()).pathname.match(
    /\/lecturer\/quizzes\/([0-9a-f-]{36})/,
  )?.[1];
  expect(autoQuizId).toMatch(/^[0-9a-f-]{36}$/);

  await createQuizWithQuestions(lecturer, {
    classTitle: CLASS_TITLE,
    quizTitle: MANUAL_QUIZ,
    mode: "assessment",
    publish: true,
    gesturesOff: true,
    questions: [{ prompt: "E49 manual q?", options: ["A2", "B2"], correctIndex: 0 }],
  });

  // Arm auto-reveal on the FIRST quiz only (authenticated PATCH — helpers).
  await setAutoReveal(lecturer.request!, autoQuizId!);

  const stuCtx = await browser.newContext();
  const student = await stuCtx.newPage();
  await registerUser(student, `e49-stu-${stamp}@e2e.test`, "student", "");
  await joinClass(student, joinCode, CLASS_TITLE);

  // ── 1. Complete the AUTO quiz → EndScreen is SCORED immediately.
  await student.goto("/student/quizzes");
  await startQuizByTitle(student, AUTO_QUIZ);
  const sessionId = currentSessionId(student);
  await completeQuiz(student, ["B1"], { next: "Next", finish: "Finish" });

  // Scored state: the pct line renders; the pending panel does not.
  await expect(student.locator("p:visible", { hasText: "100% correct" }).first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(student.locator("p:visible", { hasText: /results will be released by your lecturer/i })).toHaveCount(0);

  // ── 2. List card: "View results" link already live (no lecturer action).
  await student.goto("/student/quizzes");
  const autoCard = student.locator("li").filter({ hasText: AUTO_QUIZ });
  await expect(
    autoCard.getByRole("link", { name: new RegExp(`View results.*${AUTO_QUIZ}`) }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    autoCard.getByRole("button", { name: /awaiting results|menunggu keputusan/i }),
  ).toHaveCount(0);

  // ── 3. Lecturer dashboard: revealed chip, without ever opening the
  //      reveal dialog. openResults does NOT reveal — revealQuiz would.
  await openResults(lecturer, CLASS_TITLE, AUTO_QUIZ);
  await expect(
    lecturer.getByText("Results revealed", { exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  // ── 4. Server truth: results_revealed_at is set on the auto quiz.
  const admin = resolveServiceClient();
  if (admin) {
    await expect
      .poll(async () => {
        const { data } = await admin
          .from("quizzes")
          .select("results_revealed_at")
          .eq("id", autoQuizId!)
          .maybeSingle();
        return data?.results_revealed_at ?? null;
      }, { timeout: 10_000 })
      .not.toBeNull();
  }

  // Reload the completed session: EndScreen stays scored (reveal persisted).
  await student.goto(`/play/${sessionId}`);
  await expect(student.locator("p:visible", { hasText: "100% correct" }).first()).toBeVisible({
    timeout: 10_000,
  });

  // ── 5. Control: the MANUAL quiz was completed the same way — it must
  //      still show the pending panel + awaiting chip.
  await student.goto("/student/quizzes");
  await startQuizByTitle(student, MANUAL_QUIZ);
  await completeQuiz(student, ["A2"], { next: "Next", finish: "Finish" });
  await expect(
    student.locator("p:visible", { hasText: /results will be released by your lecturer/i }),
  ).toBeVisible({ timeout: 10_000 });

  await student.goto("/student/quizzes");
  const manualCard = student.locator("li").filter({ hasText: MANUAL_QUIZ });
  await expect(
    manualCard.getByRole("button", { name: /awaiting results|menunggu keputusan/i }),
  ).toBeDisabled();
  await expect(
    manualCard.getByRole("link", { name: /view results|lihat keputusan/i }),
  ).toHaveCount(0);

  await stuCtx.close();
  await lecCtx.close();
});
