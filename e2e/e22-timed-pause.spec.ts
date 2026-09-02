import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  installFakeFaceTracker,
  enrollViaFacePage,
  setFaceVerifyMode,
  setFacePeriodic,
  passAssessmentGate,
  waitForPauseOverlay,
  recoverFromPause,
  clickBeginAndBlink,
} from "./helpers";

/**
 * E22 — Pause during a TIMED assessment must not burn the quiz clock.
 * Every other pause spec (E6/E9b/E12/E16) runs UNTIMED, so the frozen-clock
 * contract — the client pauses its countdown interval while `paused`, and a
 * recovered session resumes ≈ where it froze instead of paying back the whole
 * paused wall-clock window — has zero coverage. A regression here silently
 * steals exam time from every flagged-and-recovered student.
 *
 * Contract under test (play-client.tsx countdown interval):
 *   limit 300s → mismatch → periodic verify fails → paused ~12s of WALL time
 *   → recover → remaining must be within ~8s of the pre-pause reading
 *   (active latencies only). An unfrozen clock would land ≥14s lower.
 */

const stamp = Date.now();
const LECTURER_EMAIL = `lecturer-e22-${stamp}@innovision.test`;
const STUDENT_EMAIL = `student-e22-${stamp}@innovision.test`;
const INVITE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E22 Timed Pause";
const QUIZ_TITLE = "E22 Frozen Clock";
const LIMIT_SEC = 300;

test.describe.configure({ mode: "serial" });

// Serial-shared state + contract knobs.
let joinCodeLocal = "";
let before = 0;
let resumed = 0;
const PAUSE_MS = 8_000; // wall-clock window held INSIDE the pause
// Healthy: only gate/verify/recovery latencies are charged. Broken (clock
// keeps running through the pause): charged ≥ PAUSE_MS → guaranteed breach.
const CHARGED_MAX = 5;

/** Read the HUD countdown ("m:ss", progress-hud.tsx formatMs) in seconds. */
async function readHudSeconds(page: import("@playwright/test").Page): Promise<number> {
  const hud = page.getByText(/^\d{1,2}:\d{2}$/);
  await expect(hud).toBeVisible({ timeout: 5_000 });
  const [m, s] = (await hud.textContent())!.split(":").map(Number);
  return m * 60 + s;
}

test("timed assessment: paused wall-time is not charged to the countdown", async ({ browser }, testInfo) => {
  testInfo.setTimeout(150_000);
  test.skip(!INVITE, "LECTURER_INVITE_CODE not set");

  // Milestone logging: on ANY failure the output shows the last reached step
  // and its elapsed time, so a stall is diagnosable without a trace.
  const t0 = Date.now();
  const mark = (label: string) =>
    console.log(`[e22 +${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);

  const lecturerCtx = await browser.newContext();
  const studentCtx = await browser.newContext();
  const lecturerPage = await lecturerCtx.newPage();
  const studentPage = await studentCtx.newPage();
  // A vanished renderer (WebGL/mediapipe wedge) presents as a click that
  // hangs until the test timeout — surface it immediately instead.
  studentPage.on("crash", () => mark("STUDENT PAGE CRASHED"));
  lecturerPage.on("crash", () => mark("LECTURER PAGE CRASHED"));

  await test.step("setup: lecturer builds + publishes 5-min assessment", async () => {
    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", INVITE);
    joinCodeLocal = await createClass(lecturerPage, CLASS_TITLE);

    // Mirror E10's createTimedAssessment: mode via UI, limit via PATCH.
    await lecturerPage.getByText(CLASS_TITLE, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
    await lecturerPage.getByLabel("Quiz title").fill(QUIZ_TITLE);
    await lecturerPage.getByLabel("Mode").click();
    await lecturerPage.getByRole("option", { name: "Assessment" }).click();
    await lecturerPage.getByRole("button", { name: /create quiz|new quiz/i }).click();
    await expect(lecturerPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();
    await lecturerPage.getByText(QUIZ_TITLE, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);
    const quizId = lecturerPage.url().split("/builder")[0].split("/").pop()!;
    await lecturerPage.evaluate(async ({ qid, limit }) => {
      await fetch(`/api/quizzes/${qid}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeLimitSec: limit }),
      });
    }, { qid: quizId, limit: LIMIT_SEC });

    await lecturerPage.getByRole("textbox", { name: "Question prompt" }).fill("What is 2+2?");
    await lecturerPage.getByLabel("Option 1").fill("3");
    await lecturerPage.getByLabel("Option 2").fill("4");
    await lecturerPage.getByRole("button", { name: /add this question/i }).click();
    await expect(lecturerPage.getByRole("textbox", { name: "Question prompt" })).toHaveValue("");
    // Second question so answering Q1 surfaces an explicit Next button
    // (a single-question assessment auto-submits instead).
    await lecturerPage.getByRole("textbox", { name: "Question prompt" }).fill("Sky color?");
    await lecturerPage.getByLabel("Option 1").fill("Red");
    await lecturerPage.getByLabel("Option 2").fill("Blue");
    await lecturerPage.getByRole("button", { name: /add this question/i }).click();
    await expect(lecturerPage.getByRole("textbox", { name: "Question prompt" })).toHaveValue("");
    const publishButton = lecturerPage.getByRole("button", { name: /publish/i });
    await expect(publishButton).toBeEnabled();
    await publishButton.click();
    await expect(lecturerPage.getByText(/^Live/)).toBeVisible();
    mark("quiz published");
  });

  await test.step("setup: student joins + enrolls", async () => {
    await registerUser(studentPage, STUDENT_EMAIL, "student", INVITE);
    await joinClass(studentPage, joinCodeLocal, CLASS_TITLE);
    await installFakeFaceTracker(studentPage);
    await enrollViaFacePage(studentPage);
    mark("student enrolled");
  });

  await test.step("gate pass + answer Q1 + baseline clock reading", async () => {
    await expect(studentPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible({ timeout: 10_000 });
    mark("quiz card visible");
    await studentPage.getByRole("button", { name: "Start", exact: true }).click({ timeout: 10_000 });
    mark("start clicked");
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/, { timeout: 10_000 });
    // Fast cadence so the mid-quiz periodic re-verify fails deterministically.
    await setFacePeriodic(studentPage, { minMs: 1200, maxMs: 2000 });
    await passAssessmentGate(studentPage);
    mark("gate passed");
    await expect(studentPage.getByText("What is 2+2?", { exact: true })).toBeVisible({
      timeout: 8_000,
    });
    mark("Q1 visible");

    // Functional probe FIRST (while the renderer is fresh): an answer records
    // its neutral ack and advances. Assessment answers are KEYLESS (E11).
    // Option buttons' accessible names are "<letter> <text>" (e.g. "B 4") —
    // an exact-name click can never match (see E18).
    await studentPage.getByRole("button", { name: /4/ }).click({ timeout: 10_000 });
    mark("Q1 answered");
    await expect(studentPage.getByRole("button", { name: "Next", exact: true })).toBeVisible({
      timeout: 8_000,
    });
    await studentPage.getByRole("button", { name: "Next", exact: true }).click({ timeout: 10_000 });
    mark("advanced to Q2");
    await expect(studentPage.getByText("Sky color?", { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    before = await readHudSeconds(studentPage);
    expect(before).toBeGreaterThan(LIMIT_SEC - 30); // ~2 answers in
    mark(`baseline ${before}s remaining`);
  });

  await test.step("mismatch → server-side pause", async () => {
    await setFaceVerifyMode(studentPage, "mismatch");
    await waitForPauseOverlay(studentPage);
    mark("paused");
  });

  await test.step("paused 8s wall-clock window", async () => {
    await studentPage.waitForTimeout(PAUSE_MS);
  });

  await test.step("recover → back on the question", async () => {
    await setFaceVerifyMode(studentPage, "match");
    await recoverFromPause(studentPage);
    // Recovery may land back IN the explicit-Begin gate or straight on the
    // question — handle both deterministically.
    const begin = studentPage.getByRole("button", { name: "Begin assessment", exact: true });
    if (await begin.isVisible().catch(() => false)) {
      await clickBeginAndBlink(studentPage);
      await expect(studentPage.getByText("Sky color?", { exact: true })).toBeVisible({
        timeout: 8_000,
      });
    }
    mark("recovered");
  });

  await test.step("contract: paused wall-time was NOT charged", async () => {
    resumed = await readHudSeconds(studentPage);
    const charged = before - resumed;
    mark(`resumed at ${resumed}s (charged ${charged}s)`);
    expect(
      charged,
      `paused ${PAUSE_MS / 1000}s wall-time must not be charged (charged=${charged}s)`,
    ).toBeLessThanOrEqual(CHARGED_MAX);
  });

  await test.step("clock ticks live afterwards (~1s/s)", async () => {
    // Liveness of the countdown on the recovered question IS the functional
    // probe — no further clicking needed after recovery.
    const tickBefore = await readHudSeconds(studentPage);
    mark(`tick-before ${tickBefore}s`);
    await studentPage.waitForTimeout(3_000);
    const tickAfter = await readHudSeconds(studentPage);
    mark(`tick-after ${tickAfter}s`);
    expect(tickAfter).toBeLessThan(tickBefore);
    expect(tickBefore - tickAfter).toBeLessThanOrEqual(5); // ~1/s, not a jump
  });

  await test.step("teardown", async () => {
    mark("done");

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
