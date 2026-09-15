import { expect, test } from "@playwright/test";

import {
  createClass,
  enrollViaFacePage,
  installFakeFaceTracker,
  joinClass,
  passAssessmentGate,
  registerUser,
  setFaceVerifyMode,
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
    await lecturerCtx.close();

    await registerUser(page, studentEmail, "student", LECTURER_INVITE_CODE);
    await joinClass(page, joinCode, classTitle);
    await installFakeFaceTracker(page);
    await enrollViaFacePage(page);
    await expect(page.getByText(quizTitle, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page).toHaveURL(/\/play\/[0-9a-f-]+/);

    await setFaceVerifyMode(page, "match");
    await passAssessmentGate(page);

    const card = page.locator("section[aria-labelledby='question-prompt']");
    await expect(card).toBeVisible();

    // user-select:none is enforced (inline style set by the hardening).
    const userSelect = await card.evaluate((el) => getComputedStyle(el).userSelect);
    expect(userSelect).toBe("none");

    // The hardening blocks copy, cut, and context-menu events on the question card.
    const { copyCancelled, cutCancelled, contextMenuCancelled } = await page.evaluate(() => {
      const card = document.querySelector("section[aria-labelledby='question-prompt']");
      if (!card) return { copyCancelled: false, cutCancelled: false, contextMenuCancelled: false };
      const prompt = card.querySelector("#question-prompt") || card;

      const copyEvent = new Event("copy", { bubbles: true, cancelable: true });
      prompt.dispatchEvent(copyEvent);

      const cutEvent = new Event("cut", { bubbles: true, cancelable: true });
      prompt.dispatchEvent(cutEvent);

      const contextMenuEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      prompt.dispatchEvent(contextMenuEvent);

      return {
        copyCancelled: copyEvent.defaultPrevented,
        cutCancelled: cutEvent.defaultPrevented,
        contextMenuCancelled: contextMenuEvent.defaultPrevented,
      };
    });
    expect(copyCancelled).toBe(true);
    expect(cutCancelled).toBe(true);
    expect(contextMenuCancelled).toBe(true);

    // Negative control: events dispatched outside the card (e.g. document body) are not prevented.
    const outsideEvents = await page.evaluate(() => {
      const outsideCopy = new Event("copy", { bubbles: true, cancelable: true });
      document.body.dispatchEvent(outsideCopy);

      const outsideCut = new Event("cut", { bubbles: true, cancelable: true });
      document.body.dispatchEvent(outsideCut);

      const outsideContextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      document.body.dispatchEvent(outsideContextMenu);

      return {
        copyNotPrevented: !outsideCopy.defaultPrevented,
        cutNotPrevented: !outsideCut.defaultPrevented,
        contextMenuNotPrevented: !outsideContextMenu.defaultPrevented,
      };
    });
    expect(outsideEvents.copyNotPrevented).toBe(true);
    expect(outsideEvents.cutNotPrevented).toBe(true);
    expect(outsideEvents.contextMenuNotPrevented).toBe(true);
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
    await lecturerCtx.close();

    await registerUser(page, studentEmail, "student", LECTURER_INVITE_CODE);
    await joinClass(page, joinCode, classTitle);
    await installFakeFaceTracker(page);
    await enrollViaFacePage(page);
    await expect(page.getByText(quizTitle, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page).toHaveURL(/\/play\/[0-9a-f-]+/);

    await setFaceVerifyMode(page, "match");
    const verifyPromise = page.waitForResponse(
      (res) => res.url().includes("/api/face/verify") && res.status() === 200,
      { timeout: 15_000 },
    );

    // Begin click → the hardening requests fullscreen inside the gesture.
    await passAssessmentGate(page);
    await verifyPromise;

    // requestFullscreen resolves a frame or two after the click; poll so a
    // scheduler hiccup retries instead of failing hard.
    await expect
      .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)), { timeout: 5_000 })
      .toBe(true);

    const card = page.locator("section[aria-labelledby='question-prompt']");
    await expect(card).toBeVisible();
    await expect(page.getByRole("alertdialog")).toBeHidden({ timeout: 10_000 });

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
    await expect
      .poll(() => pauseBodies.some((b) => b.includes("fullscreen_exit")), { timeout: 10_000 })
      .toBe(true);
  });
});
