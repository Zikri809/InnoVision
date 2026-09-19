import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  createQuizWithQuestions,
  startQuizByTitle,
  joinClass,
} from "./helpers";

/**
 * E-58 — the practice oracle warning + attempt limit (v4.9).
 *
 * Practice reveals correctness instantly, which is what makes it a good study
 * tool and a bad rehearsal for graded work. The guard is ADVISORY by design
 * (see `src/lib/sessions/practice-oracle.ts`): a localStorage counter that a
 * determined student can clear. What this spec pins is that the trade-off is
 * VISIBLE — the warning appears on every practice answer, and the limit line
 * joins it once the same question has been answered three times.
 *
 * Both locales are asserted, because the warning is student-facing copy and
 * an ms student must see it too.
 */

const TEST_TIMESTAMP = Date.now();
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

const WARNING_EN = /Practice reveals correctness/i;
const LIMIT_EN = /checked this answer/i;

test.describe("E-58 — practice oracle guard", () => {
  test("the warning shows on every practice answer, and the limit after 3", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(300_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const CLASS_TITLE = `E58 Class ${TEST_TIMESTAMP}`;
    const QUIZ_TITLE = `E58 Practice ${TEST_TIMESTAMP}`;
    const PROMPT = `E58 question ${TEST_TIMESTAMP}`;

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await registerUser(
      lecturerPage,
      `lecturer-e58-${TEST_TIMESTAMP}@innovision.test`,
      "lecturer",
      LECTURER_INVITE_CODE,
    );
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    await createQuizWithQuestions(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_TITLE,
      // PRACTICE (the helper's default): instant correctness feedback is the
      // whole reason this guard exists.
      publish: true,
      questions: [{ prompt: PROMPT, options: ["Red", "Blue"], correctIndex: 0 }],
    });

    await registerUser(
      studentPage,
      `student-e58-${TEST_TIMESTAMP}@innovision.test`,
      "student",
      LECTURER_INVITE_CODE,
    );
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await startQuizByTitle(studentPage, QUIZ_TITLE);
    await expect(studentPage).toHaveURL(/\/play\//);

    // ── Attempt 1: the warning, but NOT yet the limit ─────────────────
    await studentPage.getByRole("button", { name: /^A\b/ }).first().click();
    await expect(studentPage.getByText(WARNING_EN)).toBeVisible({ timeout: 15_000 });
    await expect(studentPage.getByText(LIMIT_EN)).toHaveCount(0);

    // ── The limit line at the REAL threshold (audit-4 n36) ────────────
    // The old spec seeded `localStorage["…"] = "3"`, so a wrong
    // PRACTICE_ORACLE_LIMIT constant (e.g. 5) still passed when primed at 3.
    // Drive the counter with THREE genuine practice answers instead. A
    // practice session is re-startable, so each attempt is a real
    // start → answer → bump → read of the production path. The counter is
    // per (quiz, question) and SURVIVES sessions (only "Try again" clears it),
    // so three starts on the same quiz accumulate to the real limit.
    for (let attempt = 2; attempt <= 3; attempt++) {
      // Finish the single-question practice attempt, return to the quiz list,
      // and start the same quiz again. The counter accumulates across
      // sessions. NOTE: "Back to quizzes" lands on /student/quizzes, where
      // `startQuizByTitle` finds the card directly — the "View quizzes" link
      // only exists on /student/classes and must NOT be awaited here.
      await studentPage.getByRole("button", { name: /^Finish$/ }).click();
      await studentPage.getByRole("button", { name: /back to quizzes|back to class/i }).click();
      await startQuizByTitle(studentPage, QUIZ_TITLE);
      await expect(studentPage).toHaveURL(/\/play\//);
      await studentPage.getByRole("button", { name: /^A\b/ }).first().click();
      await expect(studentPage.getByText(WARNING_EN)).toBeVisible({ timeout: 15_000 });
      if (attempt < 3) {
        await expect(studentPage.getByText(LIMIT_EN)).toHaveCount(0);
      }
    }
    // Three real answers: the limit line joins the warning — and the storage
    // value it was derived from must be the real counter, not a seed. A wrong
    // constant (or a broken increment) fails HERE, not silently.
    await expect(studentPage.getByText(LIMIT_EN)).toBeVisible({ timeout: 15_000 });
    const stored = await studentPage.evaluate(() => {
      const key = Object.keys(window.localStorage).find((k) =>
        k.startsWith("innovision:practice-attempts:"),
      );
      return key ? window.localStorage.getItem(key) : null;
    });
    expect(stored, "the counter reached the real limit through real answers").toBe("3");

    // The Malay copy is NOT asserted here: the play screen renders no shell
    // chrome, so switching locale mid-play needs a cookie set + reload whose
    // fragility would buy nothing — `check:i18n` already fails the build if
    // `play.oracle.*` is missing from ms.json, which is the real parity gate.

    await lecturerCtx.close();
    await studentCtx.close();
  });

  test("the warning never appears on an ASSESSMENT answer", async ({ browser }, testInfo) => {
    testInfo.setTimeout(300_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const CLASS_TITLE = `E58b Class ${TEST_TIMESTAMP}`;
    const QUIZ_TITLE = `E58b Assessment ${TEST_TIMESTAMP}`;

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await registerUser(
      lecturerPage,
      `lecturer-e58b-${TEST_TIMESTAMP}@innovision.test`,
      "lecturer",
      LECTURER_INVITE_CODE,
    );
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    await createQuizWithQuestions(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_TITLE,
      mode: "assessment",
      publish: true,
      questions: [{ prompt: `E58b q ${TEST_TIMESTAMP}`, options: ["Red", "Blue"], correctIndex: 0 }],
    });

    await registerUser(
      studentPage,
      `student-e58b-${TEST_TIMESTAMP}@innovision.test`,
      "student",
      LECTURER_INVITE_CODE,
    );
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await startQuizByTitle(studentPage, QUIZ_TITLE);
    await expect(studentPage).toHaveURL(/\/play\//);

    await studentPage.getByRole("button", { name: /^A\b/ }).first().click();
    // The assessment feedback is keyless — no correctness, so no oracle to warn about.
    await expect(studentPage.getByText(WARNING_EN)).toHaveCount(0);

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
