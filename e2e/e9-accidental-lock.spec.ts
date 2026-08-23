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
  expectNoAnswerPost,
} from "./helpers";
import { HOLD_MS } from "../src/lib/gestures/constants";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e9-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_EMAIL = `student-e9-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E9 Accidental";
const QUIZ_TITLE = "E9 Accidental Lock";

/**
 * E9 (Phase 6) — accidental-lock guard (U-G4 end-to-end).
 *
 * The student holds finger 2 for 400ms, then CHANGES to finger 3 mid-hold and
 * completes an 800ms+ hold. Assertions:
 *  1. NO answer POST targets `selectedIndex: 1` (the finger-2 option) — the
 *     mid-hold change must have reset the accumulator before it latched.
 *  2. An answer POST targeting `selectedIndex: 2` arrives (finger 3 → index 2)
 *     — asserted via `waitForRequest` (a fixed window could miss it).
 *  3. Option 3 (`aria-pressed=true`) confirms the fresh hold was registered.
 */
test.describe("E9 — accidental-lock guard", () => {
  test("a finger change mid-hold resets progress and never fires the earlier option", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    // ── Lecturer: class + practice quiz (4 options) + publish ──
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
          prompt: "Q1: Pick an option.",
          options: ["Alpha", "Beta", "Gamma", "Delta"],
          correctIndex: 2,
        },
      ],
    });

    // ── Student: register + join + fake tracker + start ──
    await registerUser(studentPage, STUDENT_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);

    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    await expect(studentPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();

    await installFakeHandTracker(studentPage);
    await studentPage.getByRole("button", { name: "Start" }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    await assertFakeHandTrackerInstalled(studentPage);
    await completeCalibration(studentPage);

    await expect(studentPage.getByText("Q1: Pick an option.", { exact: true })).toBeVisible();

    // Hold finger 2 for 400ms (below HOLD_MS), then change to finger 3 and
    // complete a full hold. The change must reset the accumulator (U-G4), so
    // `selectedIndex: 1` never fires.
    const answerPromise = studentPage.waitForRequest(
      (req) => req.url().includes("/answer") && req.method() === "POST",
    );
    await playGestureSequence(studentPage, [
      { fingers: 2, holdMs: 400 },
      { fingers: 3, holdMs: HOLD_MS + 150 },
    ]);

    // Negative: no POST targets index 1 (armed before the finger-2 phase of the
    // sequence completes, so a premature index-1 latch would be captured).
    const captured = await expectNoAnswerPost(studentPage, { forIndex: 1, windowMs: 1_500 });
    // Positive: an answer POST for index 2 arrives (Gamma).
    const ansReq = await answerPromise;
    const ansBody = JSON.parse(ansReq.postData() ?? "{}") as { selectedIndex: number };
    expect(ansBody.selectedIndex).toBe(2);
    // The same capture must not contain index 1 either (belt + braces).
    expect(
      captured.some((b) => {
        try {
          return (JSON.parse(b) as { selectedIndex?: number }).selectedIndex === 1;
        } catch {
          return false;
        }
      }),
    ).toBe(false);

    await expect(studentPage.getByRole("button", { name: /Gamma/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
