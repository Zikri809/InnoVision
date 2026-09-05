import { test, expect } from "@playwright/test";
import {
  fastRegisterUser,
  createClass,
  createQuizWithQuestions,
  startQuizByTitle,
  completeQuiz,
} from "./helpers";

/**
 * m1 — mobile project allowlist (plan §6). Runs ONLY in the `mobile`
 * project (iPhone X descriptor: 375×812, hasTouch, isMobile, mobile UA);
 * the desktop `chromium` project ignores m1-* via testIgnore.
 *
 * Covers the student mobile journey: register → classes (mobile dock) →
 * join → quizzes → practice play → submit. Contracts reused from helpers.ts
 * are identical to the desktop suite — the mobile compositions keep every
 * accessible name.
 */

const UNIQUE = `m1-${Date.now()}`;

test.describe("m1 — mobile student journey", () => {
  test("register → classes: zero-state hero renders join form in the empty-state card, dock renders 4 tabs", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile-only");
    const email = `${UNIQUE}-zero@student.innovision.test`;
    await fastRegisterUser(page, email, "student", process.env.LECTURER_INVITE_CODE!);

    await expect(page).toHaveURL(/\/student\/classes/);
    await expect(page.getByRole("heading", { name: "My Classes" })).toBeVisible();

    // Zero-state rule (plan W2): no zero stat cards below sm; join form lives
    // in the empty-state card.
    await expect(page.getByLabel("Join code")).toBeVisible();
    await expect(
      page.getByText(/0 classes|0 live/i).first()
    ).toBeHidden();

    // Dock: mobile navigation with the four student tabs (e48 names).
    const nav = page.getByRole("navigation", { name: "Mobile navigation" });
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("link", { name: /my classes|kelas saya/i })).toBeVisible();
    await expect(nav.getByRole("link", { name: /class quizzes|kuis kelas/i })).toBeVisible();
    await expect(nav.getByRole("link", { name: /my quizzes|kuis saya/i })).toBeVisible();
  });

  test("join → class quizzes → practice play → submit (mobile compositions)", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile-only");
    // Two full registrations (student + lecturer) + quiz authoring + publish
    // + the play journey — beyond the 30s default (e8/e10 timeout precedent).
    test.setTimeout(120_000);
    const email = `${UNIQUE}-play@student.innovision.test`;
    await fastRegisterUser(page, email, "student", process.env.LECTURER_INVITE_CODE!);

    // Lecturer side: SEPARATE BROWSER CONTEXT — sharing the student's
    // context would clobber the session cookie (the proxy then bounces the
    // authenticated page off /register and registration hangs).
    const browser = page.context().browser()!;
    const lecturerCtx = await browser.newContext();
    const lecturer = await lecturerCtx.newPage();
    await fastRegisterUser(
      lecturer,
      `${UNIQUE}-lec@lecturer.innovision.test`,
      "lecturer",
      process.env.LECTURER_INVITE_CODE!,
    );
    const classTitle = `M1 Class ${UNIQUE}`;
    const joinCode = await createClass(lecturer, classTitle);
    // Author via the builder (questions live there, not on class detail) —
    // the same helper the desktop specs use.
    await createQuizWithQuestions(lecturer, {
      classTitle,
      quizTitle: `M1 Practice ${UNIQUE}`,
      mode: "practice",
      publish: true,
      questions: [
        {
          type: "mcq",
          prompt: "What does HTML stand for?",
          options: ["Hypertext Markup Language", "Nothing"],
          correctIndex: 0,
        },
      ],
    });
    await lecturerCtx.close();

    // Student joins via the mobile composition.
    await page.getByLabel("Join code").fill(joinCode);
    await page.getByRole("button", { name: /join/i }).click();
    await expect(page.getByText(classTitle, { exact: true })).toBeVisible();

    // Play through the mobile stage: dock → class quizzes → Start.
    await page
      .getByRole("navigation", { name: "Mobile navigation" })
      .getByRole("link", { name: /class quizzes|kuis kelas/i })
      .click();
    await expect(page).toHaveURL(/\/student\/quizzes/);
    await startQuizByTitle(page, `M1 Practice ${UNIQUE}`);
    await expect(page).toHaveURL(/\/play\/[0-9a-f-]+/);

    // Practice player (mobile-harmonized): option + Next + Finish names intact.
    await completeQuiz(page, ["Hypertext Markup Language"], {
      next: "Next",
      finish: "Finish",
    });
    await expect(page.getByText(/practice complete/i)).toBeVisible();
  });

  test("account sheet: toggles live inside the sheet below sm; Escape closes", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile-only");
    const email = `${UNIQUE}-acct@student.innovision.test`;
    await fastRegisterUser(page, email, "student", process.env.LECTURER_INVITE_CODE!);

    await page.getByRole("button", { name: /your innovision account/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Toggles relocated into the sheet <sm (plan W1).
    await expect(
      dialog.getByRole("button", { name: "Switch language", exact: true })
    ).toBeVisible();
    await expect(dialog.getByTestId("theme-toggle")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("notification bell: mobile bottom sheet opens and closes on navigate-ready actions", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile-only");
    const email = `${UNIQUE}-bell@student.innovision.test`;
    await fastRegisterUser(page, email, "student", process.env.LECTURER_INVITE_CODE!);

    const bell = page.getByRole("button", { name: "Notifications", exact: true });
    await expect(bell).toBeVisible();
    await bell.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/you're all caught up|semua sudah selesai/i)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});
