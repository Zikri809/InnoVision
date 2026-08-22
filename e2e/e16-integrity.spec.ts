import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  installFakeFaceTracker,
  enrollViaFacePage,
  setFaceVerifyMode,
  triggerFaceBlink,
  setFacePeriodic,
  setFacePose,
} from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

/**
 * E16 — integrity suite E2E (migration 0020/0021):
 *
 *  A. Focus-loss pause: a DEBOUNCED window blur (exam still visible) pauses
 *     the exam with dedicated copy; click-to-return + blink recovers; the
 *     3rd confirmed loss FLAGS server-side (focus_pause_count escalation)
 *     and the lecturer sees the flagged state.
 *
 *  B. Second-face advisory: sustained two-face pose samples flow through
 *     the advisories hook → /api/sessions/[id]/advisory → session_advisories
 *     → the lecturer results dashboard renders the review chip.
 */
test.describe("E16 — integrity suite", () => {
  async function setupAssessment(
    browser: import("@playwright/test").Browser,
    tag: string,
  ): Promise<{
    lecturerCtx: import("@playwright/test").BrowserContext;
    studentCtx: import("@playwright/test").BrowserContext;
    lecturerPage: import("@playwright/test").Page;
    studentPage: import("@playwright/test").Page;
    quizTitle: string;
    quizId: string;
  }> {
    const lecturerEmail = `lecturer-e16-${tag}-${TEST_TIMESTAMP}@innovision.test`;
    const studentEmail = `student-e16-${tag}-${TEST_TIMESTAMP}@innovision.test`;
    const classTitle = `E16 ${tag}`;
    const quizTitle = `E16 Quiz ${tag}`;

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();    return setupAssessmentInner(lecturerPage, studentPage, { lecturerEmail, studentEmail, classTitle, quizTitle });

    async function setupAssessmentInner(
      lp: import("@playwright/test").Page,
      sp: import("@playwright/test").Page,
      ids: { lecturerEmail: string; studentEmail: string; classTitle: string; quizTitle: string },
    ) {
      await registerUser(lp, ids.lecturerEmail, "lecturer", LECTURER_INVITE_CODE);
      const joinCode = await createClass(lp, ids.classTitle);
      await lp.getByText(ids.classTitle, { exact: true }).click();
      await expect(lp).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
      await lp.getByLabel("Quiz title").fill(ids.quizTitle);
      await lp.getByLabel("Mode").click();
      await lp.getByRole("option", { name: "Assessment" }).click();
      await lp.getByRole("button", { name: /create quiz|new quiz/i }).click();
      await expect(lp.getByText(ids.quizTitle, { exact: true })).toBeVisible();
      await lp.getByText(ids.quizTitle, { exact: true }).click();
      await expect(lp).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);
      await lp.getByRole("textbox", { name: "Question" }).fill("What is 3+3?");
      await lp.getByLabel("Option 1").fill("5");
      await lp.getByLabel("Option 2").fill("6");
      await lp.getByRole("button", { name: /add question/i }).click();
      const publishButton = lp.getByRole("button", { name: /publish/i });
      await expect(publishButton).toBeEnabled();
      await publishButton.click();
      await expect(lp.getByText(/^Live/)).toBeVisible();

      await registerUser(sp, ids.studentEmail, "student", LECTURER_INVITE_CODE);
      await joinClass(sp, joinCode, ids.classTitle);
      await installFakeFaceTracker(sp);
      await enrollViaFacePage(sp);
      await expect(sp.getByText(ids.quizTitle, { exact: true })).toBeVisible();
      await setFaceVerifyMode(sp, "match");
      await sp.getByRole("button", { name: "Start", exact: true }).click();
      await expect(sp).toHaveURL(/\/play\/[0-9a-f-]+/);
      // Fast cadence so post-recovery re-verifies land deterministically.
      await setFacePeriodic(sp, { minMs: 2500, maxMs: 3500 });

      // Pass the gate (explicit Begin + blink + 'start' verify).
      const begin = sp.getByRole("button", { name: "Begin assessment", exact: true });
      await expect(begin).toBeEnabled({ timeout: 15_000 });
      await begin.click();
      await triggerFaceBlink(sp);
      await expect(sp.getByText("What is 3+3?", { exact: true })).toBeVisible({
        timeout: 15_000,
      });

      return {
        lecturerCtx,
        studentCtx,
        lecturerPage: lp,
        studentPage: sp,
        quizTitle: ids.quizTitle,
        quizId: (lp.url().match(/\/lecturer\/quizzes\/([0-9a-f-]+)\/builder/) ?? [])[1] ?? "",
      };
    }
  }

  test("A — debounced blur pauses; 3rd confirmed focus loss flags", async ({ browser }, testInfo) => {
    testInfo.setTimeout(90_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const { lecturerCtx, studentCtx, studentPage, lecturerPage } = await setupAssessment(
      browser,
      "focus",
    );
    const returnBtn = studentPage.getByRole("button", { name: "Return to the exam", exact: true });
    const flaggedText = studentPage.getByText("Assessment flagged", { exact: false });
    // Simulated app-switch: the window stays VISIBLE but loses OS focus.
    // Retries cover the post-gate 'recovering' window (the handler bails
    // then); each iteration waits LONGER than FOCUS_BLUR_DEBOUNCE_MS so a
    // re-dispatch can't perpetually reset the debounce. On the 3rd strike
    // the RPC escalates to FLAGGED — accept that overlay too.
    async function blurUntilOverlay(acceptFlagged = false) {
      for (let i = 0; i < 8; i++) {
        await studentPage.evaluate(() => window.dispatchEvent(new Event("blur")));
        const paused = await returnBtn
          .waitFor({ state: "visible", timeout: 1300 })
          .then(() => true)
          .catch(() => false);
        if (paused) return;
        if (acceptFlagged && (await flaggedText.isVisible().catch(() => false))) return;
      }
      throw new Error("focus-loss pause overlay never appeared");
    }

    try {
      for (let strike = 1; strike <= 3; strike++) {
        await blurUntilOverlay(strike === 3);
        if (strike < 3) {
          // Dedicated focus-loss copy — NOT the generic camera message.
          await expect(
            studentPage.getByText("You left the exam window", { exact: false }),
          ).toBeVisible();
          await returnBtn.click();
          await triggerFaceBlink(studentPage);
          await expect(returnBtn).toBeHidden({ timeout: 15_000 });
        }
      }

      // 3rd strike → the RPC escalates to flagged.
      await expect(flaggedText).toBeVisible({ timeout: 15_000 });

      const sessionId = studentPage.url().split("/play/")[1];
      const lectStatus = await lecturerPage.evaluate(async (sid) => {
        const res = await fetch(`/api/sessions/${sid}`, { method: "GET" });
        return { status: res.status, body: await res.json().catch(() => ({})) };
      }, sessionId);
      expect(lectStatus.body.status).toBe("flagged");
    } finally {
      await lecturerCtx.close();
      await studentCtx.close();
    }
  });

  test("B — sustained second face → lecturer dashboard advisory chip", async ({ browser }, testInfo) => {
    testInfo.setTimeout(90_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const { lecturerCtx, studentCtx, lecturerPage, studentPage, quizId } =
      await setupAssessment(browser, "secondface");
    try {
      // Wait for the student's advisory POST to LAND before the lecturer
      // navigates — the results page is a static RSC render with no
      // auto-refresh, so navigating early would read an empty table.
      const advisoryPosted = studentPage.waitForResponse(
        (r) => r.url().includes("/advisory") && r.request().method() === "POST" && r.ok(),
        { timeout: 20_000 },
      );
      await setFacePose(studentPage, { facesSeen: 2 });
      await advisoryPosted;

      // Lecturer opens the quiz RESULTS (the "View results" path from the
      // class page — NOTE: /lecturer/quizzes does not exist as a route).
      await expect(studentPage.url()).toMatch(/\/play\/[0-9a-f-]+/);
      await lecturerPage.goto(`/lecturer/quizzes/${quizId}/results`);
      await expect(
        lecturerPage.getByText(/Second face detected|Muka kedua/).first(),
      ).toBeVisible({ timeout: 15_000 });
    } finally {
      await lecturerCtx.close();
      await studentCtx.close();
    }
  });
});
