import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  createQuizWithQuestions,
  installFakeHandTracker,
  assertFakeHandTrackerInstalled,
  completeCalibration,
  playGestureSequence,
  waitForScanClear,
  captureAnswerPosts,
} from "./helpers";
import { HOLD_MS } from "../src/lib/gestures/constants";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e8-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_EMAIL = `student-e8-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E8 Gestures";
const QUIZ_TITLE = "E8 Gesture Practice";

/**
 * E8 (Phase 6 demo-killer) — gesture answering with the injected fake tracker.
 *
 * Lecturer creates a class + PRACTICE quiz (4 questions: Q1 4-option, Q2
 * 4-option, Q3 true_false, Q4 5-option; untimed; publish). `correctIndex` is
 * pinned per question (Q1=1, Q2=3, Q3=0, Q4=4) so the final score is EXACT
 * (4/4).
 *
 * Student registers/joins; the fake tracker is installed BEFORE Start.
 *
 * Flow:
 *  1. Q1: hold finger 2 → answer POST `selectedIndex: 1` → feedback chip →
 *     `aria-pressed=true` on the correct option.
 *  2. HOLD-ONCE (U-G7): still on Q1 feedback, replay finger-2 → assert NO new
 *     POST for Q1's questionId (armed before the replay).
 *  3. PALM-NEXT: still on Q1 feedback, hold 5 (Q1 is 4-option → finger 5 is
 *     not a valid answer) → auto-advance to Q2.
 *  4. Q2: waitForScanClear → hold finger 4 → POST `selectedIndex: 3` →
 *     feedback → click Next (Q1→Q2 palm-next / Q2→Q3 click asymmetry is
 *     intentional: palm-next is gate-tested once; clicks remain primary).
 *  5. Q3 (true_false): waitForScanClear → hold finger 1 → POST
 *     `selectedIndex: 0` → click Next.
 *  6. Q4 (5-option): waitForScanClear → hold finger 5 → POST
 *     `selectedIndex: 4` (finger 5 IS a real answer on a 5-option question —
 *     the palm-next gate `optionCount < MAX_ANSWER_FINGERS` must NOT advance;
 *     assert Q4 stays on screen) → click Finish → EndScreen score 4/4.
 */
test.describe("E8 — gesture answering (simulated)", () => {
  test("a full quiz is playable hands-free via scripted holds", async ({ browser }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    // ── 1. Lecturer: class + practice quiz + publish ──
    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);

    await createQuizWithQuestions(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_TITLE,
      publish: true,
      questions: [
        {
          type: "mcq",
          prompt: "Q1: Which is a vector?",
          options: ["Speed", "Velocity", "Mass", "Distance"],
          correctIndex: 1,
        },
        {
          type: "mcq",
          prompt: "Q2: Which is a scalar?",
          options: ["Force", "Acceleration", "Work", "Temperature"],
          correctIndex: 3,
        },
        {
          type: "true_false",
          prompt: "Q3: Light travels faster than sound.",
          options: ["True", "False"],
          correctIndex: 0,
        },
        {
          type: "mcq",
          prompt: "Q4: Pick the fifth option.",
          options: ["One", "Two", "Three", "Four", "Five"],
          correctIndex: 4,
        },
      ],
    });

    // ── 2. Student: register + join + install fake tracker + start ──
    await registerUser(studentPage, STUDENT_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);

    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    await expect(studentPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();

    // Install BEFORE Start (addInitScript is not retroactive).
    await installFakeHandTracker(studentPage);
    await studentPage.getByRole("button", { name: "Start" }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    await assertFakeHandTrackerInstalled(studentPage);
    await completeCalibration(studentPage);

    // ── 3. Q1: hold finger 2 → selectedIndex 1 ──
    await expect(studentPage.getByText("Q1: Which is a vector?", { exact: true })).toBeVisible();
    const q1Answer = studentPage.waitForRequest(
      (req) => req.url().includes("/answer") && req.method() === "POST",
    );
    await playGestureSequence(studentPage, [{ fingers: 2, holdMs: HOLD_MS + 150 }]);
    const q1Req = await q1Answer;
    const q1Body = JSON.parse(q1Req.postData() ?? "{}") as {
      questionId: string;
      selectedIndex: number;
    };
    expect(q1Body.selectedIndex).toBe(1);
    expect(q1Body.questionId).toBeTruthy();

    // Feedback chip is the render barrier for `selected` (aria-pressed).
    await expect(studentPage.getByText(/^Correct/)).toBeVisible();
    await expect(studentPage.getByRole("button", { name: /Velocity/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // ── 4. HOLD-ONCE (U-G7): replay finger 2 while disarmed → no new POST ──
    const holdOnceCapture = captureAnswerPosts(studentPage);
    await playGestureSequence(studentPage, [{ fingers: 2, holdMs: HOLD_MS + 150 }]);
    // Poll rather than a fixed wait so the negative proof is load-independent
    // (a buggy re-latch at ~950ms would be caught even under CI CPU starvation).
    await expect
      .poll(
        () =>
          holdOnceCapture.bodies.filter((b) => {
            try {
              return (JSON.parse(b) as { questionId?: string }).questionId === q1Body.questionId;
            } catch {
              return false;
            }
          }).length,
        { timeout: 3_000 },
      )
      .toBe(0);
    holdOnceCapture.detach();

    // ── 5. PALM-NEXT: hold 5 on a 4-option question → auto-advance to Q2 ──
    await playGestureSequence(studentPage, [{ fingers: 5, holdMs: HOLD_MS + 150 }]);
    await expect(studentPage.getByText("Q2: Which is a scalar?", { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    // ── 6. Q2: hold finger 4 → selectedIndex 3 → click Next ──
    await waitForScanClear(studentPage);
    const q2Answer = studentPage.waitForRequest(
      (req) => req.url().includes("/answer") && req.method() === "POST",
    );
    await playGestureSequence(studentPage, [{ fingers: 4, holdMs: HOLD_MS + 150 }]);
    const q2Body = JSON.parse((await q2Answer).postData() ?? "{}") as { selectedIndex: number };
    expect(q2Body.selectedIndex).toBe(3);
    await expect(studentPage.getByText(/^Correct/)).toBeVisible();
    await expect(studentPage.getByRole("button", { name: /Temperature/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Click Next (the Q1→Q2 palm-next / Q2→Q3 click asymmetry is intentional —
    // palm-next is gate-tested once; clicks remain primary).
    await studentPage.getByRole("button", { name: "Next", exact: true }).click();

    // ── 7. Q3 true_false: hold finger 1 → selectedIndex 0 → click Next ──
    await waitForScanClear(studentPage);
    await expect(studentPage.getByText("Q3: Light travels faster than sound.", { exact: true })).toBeVisible();
    const q3Answer = studentPage.waitForRequest(
      (req) => req.url().includes("/answer") && req.method() === "POST",
    );
    await playGestureSequence(studentPage, [{ fingers: 1, holdMs: HOLD_MS + 150 }]);
    const q3Body = JSON.parse((await q3Answer).postData() ?? "{}") as { selectedIndex: number };
    expect(q3Body.selectedIndex).toBe(0);
    await expect(studentPage.getByText(/^Correct/)).toBeVisible();
    await studentPage.getByRole("button", { name: "Next", exact: true }).click();

    // ── 8. Q4 (5-option): finger 5 IS a valid answer → no palm-next advance ──
    await waitForScanClear(studentPage);
    await expect(studentPage.getByText("Q4: Pick the fifth option.", { exact: true })).toBeVisible();
    const q4Answer = studentPage.waitForRequest(
      (req) => req.url().includes("/answer") && req.method() === "POST",
    );
    await playGestureSequence(studentPage, [{ fingers: 5, holdMs: HOLD_MS + 150 }]);
    const q4Body = JSON.parse((await q4Answer).postData() ?? "{}") as { selectedIndex: number };
    expect(q4Body.selectedIndex).toBe(4);
    await expect(studentPage.getByText(/^Correct/)).toBeVisible();
    // The palm-next gate (`optionCount < MAX_ANSWER_FINGERS`) must NOT have
    // advanced on a 5-option question — Q4 is still on screen.
    await expect(studentPage.getByText("Q4: Pick the fifth option.", { exact: true })).toBeVisible();

    // ── 9. Finish → EndScreen score 4/4 ──
    await studentPage.getByRole("button", { name: "Finish", exact: true }).click();
    await expect(studentPage.getByText(/^4\s*\/\s*4$/)).toBeVisible({ timeout: 10_000 });

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
