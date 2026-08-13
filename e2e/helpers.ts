import { type Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { fakeHandTrackerInit } from "./fake-hand-tracker";

export const E2E_PASSWORD = "testpass123";

/**
 * Register a user via the UI (role radio + consent checkbox + lecturer invite
 * code when applicable), then wait for the role-based landing page.
 */
export async function registerUser(
  page: Page,
  email: string,
  role: "lecturer" | "student",
  inviteCode: string,
) {
  await page.goto("/register");
  await page.getByLabel("Full name (optional)").fill(`${role}-${email.split("@")[0]}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);

  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
  await page.getByRole("radio", { name: roleLabel }).check();

  if (role === "lecturer") {
    await page.getByLabel("Lecturer invite code").fill(inviteCode);
  }

  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /register/i }).click();

  // Wait for the role-based landing page (also settles the hydration race).
  await page.waitForURL(
    role === "lecturer" ? /\/lecturer\/classes/ : /\/student\/classes/,
    { timeout: 15_000 },
  );
}

/**
 * Lecturer: create a class and return its join code (captured from the card).
 * Assumes the lecturer is already on /lecturer/classes.
 */
export async function createClass(page: Page, title: string): Promise<string> {
  await page.getByLabel("Class title").fill(title);
  await page.getByRole("button", { name: /create/i }).click();
  await expect(page.getByText(title, { exact: true })).toBeVisible();

  const joinCode = await page
    .getByText(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
    .first()
    .textContent();
  expect(joinCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  return joinCode!;
}

/**
 * Student: join a class by code and confirm it appears in the class list.
 * Assumes the student is already on /student/classes.
 */
export async function joinClass(page: Page, joinCode: string, classTitle: string) {
  await page.getByLabel("Join code").fill(joinCode);
  await page.getByRole("button", { name: /join/i }).click();
  await expect(page.getByText(classTitle, { exact: true })).toBeVisible();
}

type QuestionInput = {
  type?: "mcq" | "true_false";
  prompt: string;
  options: string[];
  correctIndex?: number;
  explanation?: string;
};

/**
 * Lecturer: open a class, create a quiz, open the builder, and add questions
 * by hand. Returns nothing (the builder is left open on the quiz).
 *
 * Extracted from the inlined E1b/E2 patterns so E4/E5/E10/E11 reuse it
 * (deliberate refactor to cut duplication).
 */
export async function createQuizWithQuestions(
  page: Page,
  opts: {
    classTitle: string;
    quizTitle: string;
    questions: QuestionInput[];
    publish?: boolean;
  },
) {
  // Open the class.
  await page.getByText(opts.classTitle, { exact: true }).click();
  await expect(page).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
  await expect(page.getByRole("heading", { name: opts.classTitle })).toBeVisible();

  // Create the quiz.
  await page.getByLabel("Quiz title").fill(opts.quizTitle);
  await page.getByRole("button", { name: /new quiz/i }).click();
  await expect(page.getByText(opts.quizTitle, { exact: true })).toBeVisible();
  await page.getByText(opts.quizTitle, { exact: true }).click();
  await expect(page).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);
  await expect(page.getByRole("heading", { name: opts.quizTitle })).toBeVisible();

  // Add each question.
  for (const q of opts.questions) {
    if (q.type === "true_false") {
      await page.getByLabel("Type").click();
      await page.getByRole("option", { name: "True / False" }).click();
    }
    await page.getByRole("textbox", { name: "Question" }).fill(q.prompt);

    // Fill options 1..N, adding extra option inputs as needed. True/False
    // options are disabled (auto-filled True/False) — skip filling them.
    if (q.type !== "true_false") {
      await page.getByLabel("Option 1").fill(q.options[0] ?? "");
      if (q.options.length >= 2) await page.getByLabel("Option 2").fill(q.options[1] ?? "");
      for (let i = 2; i < q.options.length; i++) {
        await page.getByRole("button", { name: /add option/i }).click();
        await page.getByRole("textbox", { name: `Option ${i + 1}` }).fill(q.options[i]);
      }
    }

    // Set the correct answer (defaults to option 1).
    if (q.correctIndex !== undefined && q.correctIndex !== 0 && q.type !== "true_false") {
      await page.getByLabel("Correct answer").click();
      await page.getByRole("option", { name: String(q.correctIndex + 1) }).click();
    }

    // Optional explanation (practice disclosure assertions).
    if (q.explanation) {
      await page.getByLabel("Explanation (optional)").fill(q.explanation);
    }

    await page.getByRole("button", { name: /add question/i }).click();
    // The save completes when the form resets (Question field cleared).
    await expect(page.getByRole("textbox", { name: "Question" })).toHaveValue("");
    await expect(page.getByText(q.prompt, { exact: true })).toBeVisible();
  }

  if (opts.publish) {
    const publishButton = page.getByRole("button", { name: /publish/i });
    await expect(publishButton).toBeEnabled();
    await publishButton.click();
    await expect(page.getByText(/published/i)).toBeVisible();
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
  }
}

// ── Phase 6 gesture helpers ─────────────────────────────────────────────

type FakeSegment = { present?: boolean; fingers: number; holdMs: number };

/**
 * Install the fake hand tracker. `addInitScript` alone is insufficient: the
 * student flow uses Next.js client-side (SPA) navigation, which does NOT
 * create a new document, so the init script would never run in the already-
 * loaded page. Therefore we BOTH:
 *  1. `addInitScript` — covers any future full page load (reloads, direct URL
 *     navigation) so the global survives across documents.
 *  2. `page.evaluate` — installs into the CURRENT document immediately (covers
 *     the SPA Start → /play navigation).
 * Must be called BEFORE the student clicks Start. E8/E9/E9b assert the global
 * exists after landing so an install-ordering regression fails loudly.
 */
export async function installFakeHandTracker(page: Page) {
  await page.addInitScript(fakeHandTrackerInit);
  await page.evaluate(fakeHandTrackerInit);
}

/**
 * Replay a scripted hand sequence via `window.__INNOVISION_FAKE_HAND_CONTROL__`.
 * Segments are `{ present?, fingers, holdMs }`; `present` defaults to
 * `fingers > 0` (a fist differs from a lost hand).
 */
export async function playGestureSequence(page: Page, segments: FakeSegment[]) {
  await page.evaluate((s) => {
    const ctrl = (window as unknown as {
      __INNOVISION_FAKE_HAND_CONTROL__?: { sequence(s: unknown): void };
    }).__INNOVISION_FAKE_HAND_CONTROL__;
    if (!ctrl) throw new Error("fake hand control not installed");
    ctrl.sequence(s);
  }, segments);
}

/** Push a continuous hand state (used for the pause-clear stabilization wait). */
export async function fakeHandFrame(page: Page, handPresent: boolean, fingerCount: number) {
  await page.evaluate(
    ([hp, fc]) => {
      const ctrl = (window as unknown as {
        __INNOVISION_FAKE_HAND_CONTROL__?: { frame(hp: boolean, fc: number): void };
      }).__INNOVISION_FAKE_HAND_CONTROL__;
      if (!ctrl) throw new Error("fake hand control not installed");
      ctrl.frame(hp, fc);
    },
    [handPresent, fingerCount] as const,
  );
}

/**
 * Assert the fake-tracker global is installed (fail loudly if the
 * install-ordering contract was violated).
 */
export async function assertFakeHandTrackerInstalled(page: Page) {
  const installed = await page.evaluate(
    () =>
      typeof (window as unknown as { __INNOVISION_FAKE_HAND_TRACKER__?: unknown })
        .__INNOVISION_FAKE_HAND_TRACKER__ === "object",
  );
  expect(installed).toBe(true);
}

/**
 * Complete the calibration panel: wait for Continue (enabled once the tracker
 * is ready) and click it. The first question has NO scan countdown, so there
 * is nothing to wait for after calibration.
 */
export async function completeCalibration(page: Page) {
  const continueBtn = page.getByRole("button", { name: "Continue", exact: true });
  await expect(continueBtn).toBeEnabled({ timeout: 15_000 });
  await continueBtn.click();
  // The calibration panel disappears once gestures go active.
  await expect(page.getByText("Hand gestures", { exact: true })).toBeHidden();
}

/**
 * Two-phase scan-clear wait on `data-testid="scan-overlay"`:
 * first wait for it to become VISIBLE (proving the scan actually started — a
 * bare hidden-wait would resolve immediately if the overlay hasn't mounted
 * yet), then wait for it to be hidden/detached. Call BEFORE every post-answer
 * sequence: the 1200ms scan would otherwise discard a 950ms hold.
 */
export async function waitForScanClear(page: Page) {
  const overlay = page.getByTestId("scan-overlay");
  await expect(overlay).toBeVisible({ timeout: 5_000 });
  await expect(overlay).toBeHidden({ timeout: 5_000 });
}

/**
 * Arm a collector for answer POST bodies (`/api/sessions/{id}/answer`).
 * Returns `{ bodies, clear, detach }` so the positive and negative assertions
 * share one implementation (extracted from E11's inline pattern).
 */
export function captureAnswerPosts(page: Page) {
  const bodies: string[] = [];
  const listener = (req: { url(): string; method(): string; postData(): string | null }) => {
    if (req.url().includes("/answer") && req.method() === "POST") {
      bodies.push(req.postData() ?? "");
    }
  };
  page.on("request", listener);
  return {
    bodies,
    detach() {
      page.off("request", listener);
    },
  };
}

/**
 * Assert NO answer POST with `"selectedIndex": forIndex` arrives within
 * `windowMs`. Returns the collected bodies so the positive assertion can
 * consume the same capture. (Used by E9's accidental-lock guard.)
 */
export async function expectNoAnswerPost(
  page: Page,
  { forIndex, windowMs }: { forIndex: number; windowMs: number },
) {
  const capture = captureAnswerPosts(page);
  await page.waitForTimeout(windowMs);
  capture.detach();
  const leaked = capture.bodies.some((b) => {
    try {
      return (JSON.parse(b) as { selectedIndex?: number }).selectedIndex === forIndex;
    } catch {
      return false;
    }
  });
  expect(leaked, `no answer POST should target index ${forIndex}`).toBe(false);
  return capture.bodies;
}

