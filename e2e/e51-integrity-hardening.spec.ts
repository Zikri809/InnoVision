import { expect, test } from "@playwright/test";

import {
  createClass,
  enrollViaFacePage,
  installFakeFaceTracker,
  joinClass,
  passAssessmentGate,
  registerUser,
} from "./helpers";

/**
 * e51 — integrity hardening (clipboard + fullscreen), OPT-IN.
 *
 * Run ONLY with E51_HARDENING_E2E=1 (dedicated job) against a server whose build did NOT bake
 * NEXT_PUBLIC_INTEGRITY_HARDENING_OFF=1, e.g.:
 *   NEXT_PUBLIC_E2E_FAKE_SEAM=1 FACE_MOCK_ENABLED=1 INSIGHTFACE_BASE_URL=http://localhost:8000 \
 *   SIGNUP_RATE_LIMIT=1000 INVITE_RATE_LIMIT=1000 E2E_RATE_LIMIT_DISABLED=1 \
 *   (plus the normal .env.local Supabase/invite env) npm run build && npm run start
 *   INTEGRITY_E2E=1 npx playwright test e2e/e51-integrity-hardening.spec.ts
 *
 * The main suite's webServer env sets the kill switch to "1"
 * (hardening-gate.ts), so under the standard harness the hardening is inert
 * and these tests would prove nothing — the skip IS the contract.
 */
// audit-1 §5.3 (skip-signal split): the skip gate is now its OWN variable —
// E51_HARDENING_E2E — set ONLY by the dedicated hardening-ON CI job.
// INTEGRITY_E2E still controls the webServer BUILD env (kill-switch omitted),
// but it is no longer what turns e51 on: a leaked INTEGRITY_E2E=1 in a
// local .env.local (dotenv loads it into the harness process) used to run
// e51 against a kill-switch build that proved nothing. The second guard
// fails the pairing outright if the kill switch is visible in the harness
// env — the build in that mode would bake hardening OFF and e51's
// assertions would be theatre.
test.skip(!process.env.E51_HARDENING_E2E, "opt-in: E51_HARDENING_E2E=1 (dedicated hardening-ON job)");
test.skip(
  process.env.NEXT_PUBLIC_INTEGRITY_HARDENING_OFF === "1",
  "NEXT_PUBLIC_INTEGRITY_HARDENING_OFF is set — this build bakes hardening OFF; e51 would prove nothing",
);

const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

test.describe("e51 — integrity hardening", () => {
  test("copy/cut/context-menu blocked on the question card (assessment mode)", async ({ page }) => {
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");
    test.setTimeout(120_000);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const lecturerEmail = `lecturer-e51-${stamp}@innovision.test`;
    const studentEmail = `student-e51-${stamp}@innovision.test`;
    const classTitle = `E51 Copy ${stamp}`;
    const quizTitle = `E51 Copy-guard ${stamp}`;

    const lecturerCtx = await page.context().browser()!.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    await registerUser(lecturerPage, lecturerEmail, "lecturer", LECTURER_INVITE_CODE);
    const joinCode = await createClass(lecturerPage, classTitle);

    // Untimed assessment, 1 question, published (manual builder flow — the
    // createAssessmentAndPublish helper assumes the same dialogs).
    await lecturerPage.getByText(classTitle, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
    await lecturerPage.getByLabel("Quiz title").fill(quizTitle);
    await lecturerPage.getByLabel("Mode").click();
    await lecturerPage.getByRole("option", { name: "Assessment" }).click();
    await lecturerPage.getByRole("button", { name: /create quiz|new quiz/i }).click();
    await lecturerPage.getByText(quizTitle, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);
    await lecturerPage.getByRole("textbox", { name: "Question prompt" }).fill("What is 7 times 8?");
    await lecturerPage.getByLabel("Option 1").fill("54");
    await lecturerPage.getByLabel("Option 2").fill("56");
    await lecturerPage.getByRole("button", { name: /add this question/i }).click();
    const publishButton = lecturerPage.getByRole("button", { name: /publish/i });
    await expect(publishButton).toBeEnabled();
    await publishButton.click();
    await expect(lecturerPage.getByText(/^Live/)).toBeVisible();

    await registerUser(page, studentEmail, "student", LECTURER_INVITE_CODE);
    await joinClass(page, joinCode, classTitle);
    await installFakeFaceTracker(page);
    await enrollViaFacePage(page);
    await expect(page.getByText(quizTitle, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page).toHaveURL(/\/play\/[0-9a-f-]+/);

    await passAssessmentGate(page);

    const card = page.locator("section[aria-labelledby='question-prompt']");
    await expect(card).toBeVisible();

    // user-select:none is enforced (inline style set by the hardening).
    const userSelect = await card.evaluate((el) => getComputedStyle(el).userSelect);
    expect(userSelect).toBe("none");

    // The copy event is cancelled by the hardening's onCopy. React delegates
    // at the root in the BUBBLE phase, and execCommand fires copy at the
    // FOCUSED element — so focus a button inside the card first, and probe at
    // DOCUMENT level (bubbles after React's root handler has run).
    const copyCancelled = await page.evaluate(() => {
      const card = document.querySelector("section[aria-labelledby='question-prompt']");
      if (!card) return false;
      const button = card.querySelector("button");
      if (button) button.focus();
      let prevented = false;
      document.addEventListener(
        "copy",
        (e) => {
          prevented = e.defaultPrevented;
        },
        { once: true },
      );
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(card);
        selection.addRange(range);
      }
      document.execCommand("copy");
      return prevented;
    });
    expect(copyCancelled).toBe(true);
  });

  test("fullscreen requested at Begin; a later exit pauses with reason fullscreen_exit", async ({ page }) => {
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");
    test.setTimeout(120_000);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const lecturerEmail = `lecturer-e51fs-${stamp}@innovision.test`;
    const studentEmail = `student-e51fs-${stamp}@innovision.test`;
    const classTitle = `E51 FS ${stamp}`;
    const quizTitle = `E51 Fullscreen ${stamp}`;

    const lecturerCtx = await page.context().browser()!.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    await registerUser(lecturerPage, lecturerEmail, "lecturer", LECTURER_INVITE_CODE);
    const joinCode = await createClass(lecturerPage, classTitle);

    await lecturerPage.getByText(classTitle, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
    await lecturerPage.getByLabel("Quiz title").fill(quizTitle);
    await lecturerPage.getByLabel("Mode").click();
    await lecturerPage.getByRole("option", { name: "Assessment" }).click();
    await lecturerPage.getByRole("button", { name: /create quiz|new quiz/i }).click();
    await lecturerPage.getByText(quizTitle, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);
    await lecturerPage.getByRole("textbox", { name: "Question prompt" }).fill("2 + 2 = ?");
    await lecturerPage.getByLabel("Option 1").fill("3");
    await lecturerPage.getByLabel("Option 2").fill("4");
    await lecturerPage.getByRole("button", { name: /add this question/i }).click();
    const publishButton = lecturerPage.getByRole("button", { name: /publish/i });
    await expect(publishButton).toBeEnabled();
    await publishButton.click();
    await expect(lecturerPage.getByText(/^Live/)).toBeVisible();

    await registerUser(page, studentEmail, "student", LECTURER_INVITE_CODE);
    await joinClass(page, joinCode, classTitle);
    await installFakeFaceTracker(page);
    await enrollViaFacePage(page);
    await expect(page.getByText(quizTitle, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page).toHaveURL(/\/play\/[0-9a-f-]+/);

    // Begin click → the hardening requests fullscreen inside the gesture.
    await passAssessmentGate(page);
    // requestFullscreen resolves a frame or two after the click; poll so a
    // scheduler hiccup retries instead of failing hard.
    await expect
      .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)), { timeout: 5_000 })
      .toBe(true);

    const pauseBodies: string[] = [];
    page.on("request", (req) => {
      if (
        req.url().includes("/api/sessions/") &&
        req.url().endsWith("/pause") &&
        req.method() === "POST"
      ) {
        pauseBodies.push(req.postData() ?? "");
      }
    });

    // Deliberate exit (the guard treats ANY exit while armed as an event).
    await page.evaluate(() => document.exitFullscreen());
    // pauseLocally('fullscreen_exit') renders the fullscreenExit copy — the
    // focusLost copy is a DIFFERENT reason ("another app took focus").
    await expect(page.getByText("Fullscreen was closed", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    expect(pauseBodies.some((b) => b.includes("fullscreen_exit"))).toBe(true);
  });
});
