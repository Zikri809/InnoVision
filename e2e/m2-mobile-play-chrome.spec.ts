import { test, expect } from "@playwright/test";
import {
  fastRegisterUser,
  createClass,
  createQuizWithQuestions,
  startQuizByTitle,
  installFakeHandTracker,
  assertFakeHandTrackerInstalled,
  playGestureSequence,
} from "./helpers";
import { HOLD_MS } from "../src/lib/gestures/constants";

/**
 * m2 — mobile play chrome & mobile end screen.
 * Runs ONLY in the `mobile` project (iPhone X descriptor, 375×812).
 *
 * Covers:
 *  1. Mobile play surface chrome:
 *     - Sticky compact header: progress strip, timer countdown chip (role="timer").
 *     - Info (ⓘ) button -> quiz-info ResponsiveModal (mode, time limit, camera status).
 *     - Fixed bottom action bar: collapses when unanswered; mounts Next/Finish in feedback.
 *  2. Mobile gestures & PIP camera:
 *     - Mobile calibration hero + CalibrationHud (status, lighting, finger tray) + dock.
 *     - Skip calibration fallback -> "Gestures unavailable — click to answer".
 *     - Active mode PIP camera dot -> expand to centered preview in feedback -> collapse via Escape.
 *     - Gesture hold-to-answer (finger 1) and palm-next (finger 5) navigation.
 *  3. Mobile EndScreen:
 *     - ScoreRing celebration banner with SVG ring, score calculation, and praise tier.
 *     - Vertically stacked full-width buttons ("Try again" primary, "Back to quizzes" outline).
 *     - Verdict Accordion: rendered as ol > li; wrong questions default OPEN;
 *       tapping closed correct questions mounts options and explanation card.
 *     - "Try again" routes to a new session (SQ-3 contract).
 */

const UNIQUE = `m2-${Date.now()}`;

test.describe("M2 — Mobile Play Chrome & EndScreen", () => {
  test("mobile play chrome: sticky header, timer countdown, quiz info modal, and fixed bottom action bar", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile-only");
    test.skip(!process.env.LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");
    test.setTimeout(120_000);

    const email = `${UNIQUE}-chrome@student.innovision.test`;
    await fastRegisterUser(page, email, "student", process.env.LECTURER_INVITE_CODE!);

    // Lecturer setup in isolated context
    const browser = page.context().browser()!;
    const lecturerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const lecturer = await lecturerCtx.newPage();
    await fastRegisterUser(lecturer, `${UNIQUE}-lec1@lecturer.innovision.test`, "lecturer", process.env.LECTURER_INVITE_CODE!);
    const classTitle = `M2 Chrome Class ${UNIQUE}`;
    const joinCode = await createClass(lecturer, classTitle);
    const quizTitle = `M2 Chrome Quiz ${UNIQUE}`;

    await createQuizWithQuestions(lecturer, {
      classTitle,
      quizTitle,
      mode: "assessment",
      publish: false,
      // 0067: mobile chrome composition, not identity — bypass the face gate
      // (no fake face seam is installed on this student).
      gesturesOff: true,
      questions: [
        {
          type: "mcq",
          prompt: "What is the primary gas in Earth's atmosphere?",
          options: ["Nitrogen", "Oxygen"],
          correctIndex: 0,
          explanation: "Nitrogen makes up approximately 78% of Earth's atmosphere.",
        },
        {
          type: "mcq",
          prompt: "Which planet is known as the Red Planet?",
          options: ["Venus", "Mars"],
          correctIndex: 1,
          explanation: "Mars appears reddish due to iron oxide on its surface.",
        },
      ],
    });

    // Set 60s timer limit via PATCH on draft quiz, then publish
    const builderUrl = lecturer.url();
    const quizId = builderUrl.split("/builder")[0].split("/").pop()!;
    await lecturer.evaluate(async ({ qid }) => {
      const res = await fetch(`/api/quizzes/${qid}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeLimitSec: 60 }),
      });
      if (!res.ok) throw new Error(`PATCH timeLimitSec failed: ${res.status}`);
    }, { qid: quizId });

    const publishBtn = lecturer.getByRole("button", { name: /publish/i });
    await expect(publishBtn).toBeEnabled();
    await publishBtn.click();
    await expect(lecturer.getByText(/^Live/)).toBeVisible();
    await lecturerCtx.close();

    // Student joins class
    await page.getByRole("button", { name: /^enter a join code$/i }).click();
    await page.getByLabel("Join code").fill(joinCode);
    await page.getByRole("button", { name: /^join class$/i }).click();
    await expect(page.getByText(classTitle, { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5_000 });

    // Navigate to quizzes and start
    await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("link", { name: /class quizzes|kuis kelas/i }).click();
    await startQuizByTitle(page, quizTitle);
    await expect(page).toHaveURL(/\/play\/[0-9a-f-]+/);

    // 1. Sticky Header & Progress Hud
    const header = page.locator("header.sticky");
    await expect(header).toBeVisible();
    await expect(header.getByText(/Q 1\/2/)).toBeVisible();

    // Timer chip
    const timerChip = page.locator("span[role='timer']").first();
    await expect(timerChip).toBeVisible();
    await expect(timerChip).toHaveAttribute("aria-label", /time remaining/i);
    await expect(timerChip).toHaveClass(/tabular-nums/);
    const initialTime = await timerChip.textContent();
    expect(initialTime).toMatch(/0:5\d|1:00/);

    // 2. Info (ⓘ) Button -> ResponsiveModal
    const infoBtn = page.getByRole("button", { name: "Quiz info" });
    await expect(infoBtn).toBeVisible();
    await infoBtn.click();

    const modal = page.getByRole("dialog");
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("heading", { name: "Quiz info" })).toBeVisible();
    await expect(modal.getByText(quizTitle)).toBeVisible();
    await expect(modal.getByText("Mode")).toBeVisible();
    await expect(modal.getByText("Assessment", { exact: true })).toBeVisible();
    await expect(modal.getByText("Time limit")).toBeVisible();
    await expect(modal.getByText("Camera")).toBeVisible();
    await expect(modal.getByText("Off", { exact: true })).toBeVisible();

    // Dismiss modal via Escape
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();

    // 3. Fixed Bottom Action Bar (Unanswered State -> Empty/Collapsed)
    const bottomContainer = page.locator("div.fixed.bottom-0");
    await expect(bottomContainer.getByRole("button", { name: "Next" })).toHaveCount(0);
    await expect(bottomContainer.getByRole("button", { name: "Finish" })).toHaveCount(0);

    // 4. Answer Q1 -> Feedback State -> Action Bar Mounts Next Button
    await page.getByRole("button", { name: /Nitrogen/i }).click();

    const nextBtn = bottomContainer.getByRole("button", { name: "Next", exact: true });
    await expect(nextBtn).toBeVisible();
    await nextBtn.click();

    // 5. Question 2 -> Counter Updates & Finish Button on Feedback
    await expect(header.getByText(/Q 2\/2/)).toBeVisible();
    await page.getByRole("button", { name: /Venus/i }).click();

    const finishBtn = bottomContainer.getByRole("button", { name: "Finish", exact: true });
    await expect(finishBtn).toBeVisible();
    await finishBtn.click();

    // Reaches EndScreen — both layouts mount (CSS-gated), so scope to <p>.
    await expect(
      page.locator("p:visible", { hasText: /assessment complete|assessment submitted/i }),
    ).toBeVisible();
  });

  test("mobile gestures: calibration mobile layout and skip fallback", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile-only");
    test.skip(!process.env.LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");
    test.setTimeout(120_000);

    const email = `${UNIQUE}-skip@student.innovision.test`;
    await fastRegisterUser(page, email, "student", process.env.LECTURER_INVITE_CODE!);

    const browser = page.context().browser()!;
    const lecturerCtx = await browser.newContext();
    const lecturer = await lecturerCtx.newPage();
    await fastRegisterUser(lecturer, `${UNIQUE}-lec2@lecturer.innovision.test`, "lecturer", process.env.LECTURER_INVITE_CODE!);
    const classTitle = `M2 Skip Class ${UNIQUE}`;
    const joinCode = await createClass(lecturer, classTitle);
    const quizTitle = `M2 Skip Quiz ${UNIQUE}`;

    await createQuizWithQuestions(lecturer, {
      classTitle,
      quizTitle,
      mode: "practice",
      publish: true,
      questions: [
        {
          type: "mcq",
          prompt: "Water boils at what temperature at sea level?",
          options: ["100°C", "90°C"],
          correctIndex: 0,
        },
      ],
    });
    await lecturerCtx.close();

    await page.getByRole("button", { name: /^enter a join code$/i }).click();
    await page.getByLabel("Join code").fill(joinCode);
    await page.getByRole("button", { name: /^join class$/i }).click();
    await expect(page.getByText(classTitle, { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5_000 });

    await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("link", { name: /class quizzes|kuis kelas/i }).click();

    // Install fake hand tracker before start
    await installFakeHandTracker(page);
    await startQuizByTitle(page, quizTitle);
    await expect(page).toHaveURL(/\/play\/[0-9a-f-]+/);
    await assertFakeHandTrackerInstalled(page);

    // Verify Calibration Mobile Layout: viewfinder hero + CalibrationHud
    const videoContainer = page.locator('[data-testid="gesture-video-container"]');
    await expect(videoContainer).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /no hand detected|waiting for hand/i })).toBeVisible();

    // Push a fake hand frame with hand present so lighting chip mounts
    await playGestureSequence(page, [{ fingers: 2, holdMs: 300 }]);
    await expect(page.getByRole("status").filter({ hasText: /lighting: good/i })).toBeVisible();

    // Fixed dock buttons
    const continueBtn = page.getByRole("button", { name: "Continue", exact: true });
    const skipBtn = page.getByRole("button", { name: /skip/i });
    await expect(continueBtn).toBeVisible();
    await expect(skipBtn).toBeVisible();

    // Skip calibration -> Gestures off
    await skipBtn.click();
    await expect(page.getByText("Gestures unavailable — click to answer")).toBeVisible({ timeout: 10_000 });

    // Quiz interactive via tap
    await page.getByRole("button", { name: /100°C/i }).click();
    await expect(page.getByText("Correct! ✓")).toBeVisible();
  });

  test("mobile gestures: hold-to-answer, palm-next, and PIP camera expand/collapse", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile-only");
    test.skip(!process.env.LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");
    test.setTimeout(120_000);

    const email = `${UNIQUE}-gest@student.innovision.test`;
    await fastRegisterUser(page, email, "student", process.env.LECTURER_INVITE_CODE!);

    const browser = page.context().browser()!;
    const lecturerCtx = await browser.newContext();
    const lecturer = await lecturerCtx.newPage();
    await fastRegisterUser(lecturer, `${UNIQUE}-lec3@lecturer.innovision.test`, "lecturer", process.env.LECTURER_INVITE_CODE!);
    const classTitle = `M2 Gest Class ${UNIQUE}`;
    const joinCode = await createClass(lecturer, classTitle);
    const quizTitle = `M2 Gest Quiz ${UNIQUE}`;

    await createQuizWithQuestions(lecturer, {
      classTitle,
      quizTitle,
      mode: "practice",
      publish: true,
      questions: [
        {
          type: "mcq",
          prompt: "First letter of alphabet?",
          options: ["A", "B", "C", "D"],
          correctIndex: 0,
        },
        {
          type: "mcq",
          prompt: "Second letter of alphabet?",
          options: ["A", "B", "C", "D"],
          correctIndex: 1,
        },
      ],
    });
    await lecturerCtx.close();

    await page.getByRole("button", { name: /^enter a join code$/i }).click();
    await page.getByLabel("Join code").fill(joinCode);
    await page.getByRole("button", { name: /^join class$/i }).click();
    await expect(page.getByText(classTitle, { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5_000 });

    await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("link", { name: /class quizzes|kuis kelas/i }).click();

    await installFakeHandTracker(page);
    await startQuizByTitle(page, quizTitle);
    await expect(page).toHaveURL(/\/play\/[0-9a-f-]+/);
    await assertFakeHandTrackerInstalled(page);

    // Complete calibration
    const continueBtn = page.getByRole("button", { name: "Continue", exact: true });
    await expect(continueBtn).toBeEnabled({ timeout: 15_000 });
    await continueBtn.click();

    // PIP Camera dot renders in collapsed mode
    const pipBtn = page.locator('button[data-testid="gesture-video-container"]');
    await expect(pipBtn).toBeVisible();
    await expect(pipBtn).toHaveAttribute("aria-expanded", "false");
    await expect(pipBtn).toHaveAttribute("aria-label", /expand self view/i);

    // 1. Gesture Hold-to-Answer: 1 finger holds Option 1 ("A")
    await playGestureSequence(page, [{ fingers: 1, holdMs: HOLD_MS + 150 }]);
    await expect(page.getByText("Correct! ✓")).toBeVisible();

    // 2. Feedback Phase: PIP preview can be expanded
    await pipBtn.click();
    await expect(pipBtn).toHaveAttribute("aria-expanded", "true");
    await expect(pipBtn).toHaveAttribute("aria-label", /collapse self view/i);
    await expect(page.getByText(/hold hand at chest level/i)).toBeVisible();

    // Collapse via Escape
    await page.keyboard.press("Escape");
    await expect(pipBtn).toHaveAttribute("aria-expanded", "false");

    // 3. Palm-Next: 5 fingers holds open palm in feedback -> advances to Q2
    await playGestureSequence(page, [{ fingers: 5, holdMs: HOLD_MS + 150 }]);
    await expect(page.getByText("Second letter of alphabet?", { exact: true })).toBeVisible({ timeout: 10_000 });
  });

  test("mobile end screen: ScoreRing, praise tiers, stacked action buttons, and verdict accordion", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile-only");
    test.skip(!process.env.LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");
    test.setTimeout(120_000);

    const email = `${UNIQUE}-end@student.innovision.test`;
    await fastRegisterUser(page, email, "student", process.env.LECTURER_INVITE_CODE!);

    const browser = page.context().browser()!;
    const lecturerCtx = await browser.newContext();
    const lecturer = await lecturerCtx.newPage();
    await fastRegisterUser(lecturer, `${UNIQUE}-lec4@lecturer.innovision.test`, "lecturer", process.env.LECTURER_INVITE_CODE!);
    const classTitle = `M2 End Class ${UNIQUE}`;
    const joinCode = await createClass(lecturer, classTitle);
    const quizTitle = `M2 End Quiz ${UNIQUE}`;

    await createQuizWithQuestions(lecturer, {
      classTitle,
      quizTitle,
      mode: "practice",
      publish: true,
      questions: [
        {
          type: "mcq",
          prompt: "What is 5 x 5?",
          options: ["20", "25"],
          correctIndex: 1,
          explanation: "5 multiplied by 5 equals 25.",
        },
        {
          type: "mcq",
          prompt: "What is the freezing point of water?",
          options: ["0°C", "100°C"],
          correctIndex: 0,
          explanation: "Water freezes at 0°C at standard pressure.",
        },
      ],
    });
    await lecturerCtx.close();

    await page.getByRole("button", { name: /^enter a join code$/i }).click();
    await page.getByLabel("Join code").fill(joinCode);
    await page.getByRole("button", { name: /^join class$/i }).click();
    await expect(page.getByText(classTitle, { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5_000 });

    await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("link", { name: /class quizzes|kuis kelas/i }).click();
    await startQuizByTitle(page, quizTitle);
    await expect(page).toHaveURL(/\/play\/[0-9a-f-]+/);

    // Answer Q1 correctly (25)
    await page.getByRole("button", { name: /25/i }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // Answer Q2 incorrectly (100°C) -> 1/2 score (50%)
    await page.getByRole("button", { name: /100°C/i }).click();
    await page.getByRole("button", { name: "Finish", exact: true }).click();

    // 1. Celebration Banner & ScoreRing — the end screen mounts BOTH layouts
    // (CSS-gated lg:hidden / lg:block), so text matches twice: scope each
    // assertion to the visible mobile-layout element.
    await expect(page.locator("p:visible", { hasText: "Practice complete! 🎉" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: quizTitle }).locator("visible=true")).toBeVisible();

    // ScoreRing renders 1 and / 2
    const scoreRing = page.locator("div.size-\\[152px\\]");
    await expect(scoreRing).toBeVisible();
    await expect(scoreRing.locator("span.text-4xl")).toHaveText("1");
    await expect(scoreRing.locator("span.text-lg")).toHaveText("/ 2");

    // Percentage & Praise tier (praise line is mobile-only; pct renders in
    // both layouts → scope to the mobile <p class="relative ..."> sibling)
    await expect(page.locator("p:visible", { hasText: "50% correct" })).toBeVisible();
    await expect(page.locator("p:visible", { hasText: "Solid effort — a few more to go." })).toBeVisible();

    // 2. Stacked Action Buttons
    const buttonStack = page.locator("div.mt-5.flex.flex-col.items-stretch");
    await expect(buttonStack).toBeVisible();
    const tryAgainBtn = buttonStack.getByRole("button", { name: /try again/i });
    const backToQuizzesBtn = buttonStack.getByRole("button", { name: /back to quizzes/i });
    await expect(tryAgainBtn).toBeVisible();
    await expect(tryAgainBtn).toHaveClass(/w-full/);
    await expect(backToQuizzesBtn).toBeVisible();
    await expect(backToQuizzesBtn).toHaveClass(/w-full/);

    // 3. Verdict Accordion: ol > li items (h2 also renders in the hidden
    // wide layout — locate the visible one)
    const breakdownHeading = page.locator("h2:visible", { hasText: "Answer breakdown" });
    await expect(breakdownHeading).toBeVisible();
    const accordion = page.locator('ol[data-slot="accordion"]');
    await expect(accordion).toBeVisible();
    const items = accordion.locator("> li");
    await expect(items).toHaveCount(2);

    // Item 2 (Wrong question - Q2) starts DEFAULT OPEN
    const wrongItem = items.filter({ hasText: "freezing point of water" });
    const wrongTrigger = wrongItem.getByRole("button");
    await expect(wrongTrigger).toHaveAttribute("aria-expanded", "true");
    await expect(wrongItem.getByText("✗")).toBeVisible(); // Wrong disc
    // Mounted without clicking:
    await expect(wrongItem.getByText("Explanation:")).toBeVisible();
    await expect(wrongItem.getByText(/Water freezes at 0°C/i)).toBeVisible();
    await expect(wrongItem.locator("li").filter({ hasText: "100°C" })).toContainText("✕");
    await expect(wrongItem.locator("li").filter({ hasText: /\b0°C/ })).toContainText("✓");

    // Item 1 (Correct question - Q1) starts DEFAULT CLOSED
    const correctItem = items.filter({ hasText: "5 x 5" });
    const correctTrigger = correctItem.getByRole("button");
    await expect(correctTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(correctItem.getByText("✓")).toBeVisible(); // Correct disc
    // Content unmounted while closed:
    await expect(correctItem.getByText(/5 multiplied by 5 equals 25/i)).toHaveCount(0);

    // Tap-to-expand closed correct item
    await correctTrigger.click();
    await expect(correctTrigger).toHaveAttribute("aria-expanded", "true");
    await expect(correctItem.getByText("Explanation:")).toBeVisible();
    await expect(correctItem.getByText(/5 multiplied by 5 equals 25/i)).toBeVisible();
    await expect(correctItem.locator("li").filter({ hasText: "25" })).toContainText("✓");

    // 4. "Try again" starts a new session (SQ-3 contract)
    const previousUrl = page.url();
    await tryAgainBtn.click();
    await expect.poll(() => page.url(), { timeout: 10_000 }).not.toBe(previousUrl);
    await expect(page).toHaveURL(/\/play\/[0-9a-f-]+/);
    await expect(page.getByText("What is 5 x 5?", { exact: true })).toBeVisible();
  });
});
