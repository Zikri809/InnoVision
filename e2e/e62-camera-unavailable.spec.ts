import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  createAssessmentAndPublish,
  joinClass,
  openResults,
  resolveServiceClient,
} from "./helpers";

/**
 * E-62 — the camera-unavailable student journey (SQ-5 / audit-3 E-F5).
 *
 * Every other face spec installs the FAKE tracker; this one makes the REAL
 * boot fail the way a blocked classroom laptop fails and pins the
 * degrade-honestly contract end to end:
 *
 *   * enroll page: the boot failure renders the per-cause copy —
 *     `cameraFailure.permission.body` + the actionable hint ("Click the
 *     lock/camera icon …") — and a Retry button; the enroll wizard never
 *     starts (SQ-5: no more generic "unavailable" for a fixable denial)
 *   * a camera-less student can still JOIN and START the assessment; the
 *     play surface renders the SQ-5 degraded-proctoring banner
 *     (`[data-testid=face-degraded-banner]`, role=status, amber) and the
 *     quiz is FULLY clickable — proctoring degrades, the exam continues
 *   * the pipeline reports the gap once: POST /api/sessions/[id]/face-unavailable
 *     → the RPC stamps `face_unavailable_at` (re-armable, 0045 P0-3)
 *   * the lecturer's results dashboard shows "Camera unavailable (<time>)"
 *     on the row (results-dashboard-client.tsx) so the invigilator knows
 *     WHY no face checks exist for this student
 *
 * The seam: an init script replaces `navigator.mediaDevices.getUserMedia`
 * with a REJECTION carrying the exact `NotAllowedError` DOMException a
 * blocked camera produces. That is the one input the real code path keys on
 * (`classifyCameraFailure` → `permission`); everything downstream — the
 * tracker boot, the pipeline's unavailable transition, the report POST — is
 * the production code, not a mock. (Granting no permission and letting
 * headless Chromium fail on its own was tried first: with no camera DEVICE
 * present the boot times out to `unknown` instead of `permission`, which is
 * a different — and less actionable — branch.)
 */

const stamp = Date.now();
const INVITE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E62 Blocked Cam";
const QUIZ_TITLE = "E62 Degrade";

/**
 * Install a getUserMedia that rejects like a user-blocked camera. Runs
 * BEFORE any page script (addInitScript), so the tracker's boot sees the
 * denied camera from its first call.
 */
function denyCameraInit(): void {
  // `mediaDevices` is readonly on the Navigator interface — write through a
  // cast (the init script runs before any app code, so the replacement is
  // what the tracker's boot sees).
  const nav = navigator as unknown as { mediaDevices: MediaDevices };
  nav.mediaDevices.getUserMedia = async () => {
    throw new DOMException("Permission denied", "NotAllowedError");
  };
}

test.describe.configure({ mode: "serial" });

test.describe("E-62 — camera-unavailable journey", () => {
  test("denied camera renders per-cause copy on the enroll page", async ({ browser }, testInfo) => {
    testInfo.setTimeout(180_000);
    test.skip(!INVITE, "LECTURER_INVITE_CODE not set");

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript(denyCameraInit);
    await registerUser(page, `student-e62-${stamp}@innovision.test`, "student", INVITE);

    await page.goto("/student/face/enroll");
    // Consent first (the boot is gated on it) — registration usually granted
    // it already (e3's conditional pattern); click only when the card shows.
    const consentBox = page.getByRole("checkbox");
    if (await consentBox.isVisible().catch(() => false)) {
      await consentBox.click();
      await expect(page.getByText("Biometric consent", { exact: false }).first()).toBeHidden({
        timeout: 15_000,
      });
    }

    // The boot fails (denied permission) → the SQ-5 panel with the
    // permission-specific copy and the actionable hint.
    await expect(
      page.getByText("Camera access was blocked, so face enrollment can't run."),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByText(/Click the lock\/camera icon in your browser's address bar/),
    ).toBeVisible();
    // Retry affordance exists for the fix-and-retry flow.
    await expect(page.getByRole("button", { name: /retry/i })).toBeVisible();
    // The wizard never started: no capture button.
    await expect(
      page.getByRole("button", { name: "Start capture", exact: true }),
    ).toHaveCount(0);

    await ctx.close();
  });

  test("camera-less student: banner + held answers, then the lecturer's face-exempt unblocks", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(300_000);
    test.skip(!INVITE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentCtx = await browser.newContext();
    const studentPage = await studentCtx.newPage();
    await studentPage.addInitScript(denyCameraInit);

    await registerUser(lecturerPage, `lecturer-e62-${stamp}@innovision.test`, "lecturer", INVITE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    await createAssessmentAndPublish(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_TITLE,
      // Face ON (no gesturesOff) — the degraded path only exists for
      // face-gated assessments. 0062's start gate requires CONSENT (granted
      // at registration) but deliberately NOT enrollment — the documented
      // camera-off acceptance — so a camera-less student may start.
      questions: [
        { prompt: "What is 2+2?", options: ["3", "4"], correctIndex: 1 },
        { prompt: "Capital of France?", options: ["Paris", "London"], correctIndex: 0 },
      ],
    });

    await registerUser(studentPage, `student-e62b-${stamp}@innovision.test`, "student", INVITE);
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    await studentPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    const sessionId = /\/play\/([0-9a-f-]{36})/.exec(studentPage.url())?.[1];
    expect(sessionId, "the play URL must carry the session id").toBeTruthy();

    // ── The SQ-5 degraded banner replaces the gate ─────────────────────
    // role=status, amber, and it says what happens next: answers are ON
    // HOLD until verification recovers (the 0067 commit gate requires a
    // `ready` verdict — `unavailable` deliberately is not one).
    const banner = studentPage.getByTestId("face-degraded-banner");
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText("Face check unavailable — answers are on hold");
    await expect(banner).toContainText(/wait for verification to recover/i);

    // The question IS visible (no gate blocking the view) but an answer is
    // HELD: clicking an option produces the hold copy and no advance.
    await studentPage.getByRole("button", { name: /4/ }).click();
    await expect(
      studentPage.getByText("Your answer has not been submitted. Keep your face in frame and try again."),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      studentPage.getByRole("button", { name: /^(finish|next)$/i }),
    ).toHaveCount(0);

    // The pipeline reported the gap: face_unavailable_at is stamped (the RPC
    // is re-armable; asserted via the seam like the other integrity specs).
    const admin = resolveServiceClient();
    if (!admin) throw new Error("service-role seam unavailable");
    const { data: sessionRow } = await admin
      .from("quiz_sessions")
      .select("face_unavailable_at, status")
      .eq("id", sessionId!)
      .maybeSingle();
    expect(
      sessionRow?.face_unavailable_at,
      "the face-unavailable report must stamp the session",
    ).toBeTruthy();

    // ── The documented camera-off fallback: lecturer grants face-exempt ──
    // (ARCHITECTURE.md: "camera-off / camera-death students complete
    // click-first per PLAN risk 7"; EXHIBITION_MANUAL.md: "Exempt face —
    // lecturer-granted camera-off fallback; student completes click-first").
    await openResults(lecturerPage, CLASS_TITLE, QUIZ_TITLE);
    const row = lecturerPage.locator("li").filter({ hasText: /e62b/ }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    // The dashboard names the cause on the row (the invigilator's cue).
    await expect(row.getByText(/Camera unavailable/)).toBeVisible();
    await row.getByRole("button", { name: /Session actions/i }).click();
    await lecturerPage.getByRole("menuitem", { name: "Face-exempt", exact: true }).click();
    const dialog = lecturerPage.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Face-exempt", exact: true })).toBeVisible();
    // Reason is REQUIRED (confirm disabled until it is filled).
    const exemptBtn = dialog.getByRole("button", { name: "Face-exempt", exact: true });
    await expect(exemptBtn).toBeDisabled();
    await dialog.getByLabel("Reason").fill("Student laptop has no working camera.");
    await expect(exemptBtn).toBeEnabled();
    await exemptBtn.click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // ── The student completes click-first ─────────────────────────────
    // The exemption is server state on the session; the play page picks it
    // up on (re)load — reload the player and answer both questions.
    await studentPage.reload();
    await expect(
      studentPage.getByTestId("face-degraded-banner"),
      "an exempt session runs with no proctoring banner",
    ).toHaveCount(0, { timeout: 30_000 });
    await studentPage.getByRole("button", { name: /4/ }).click();
    const nextBtn = studentPage.getByRole("button", { name: /^(finish|next)$/i });
    await expect(nextBtn).toBeVisible({ timeout: 30_000 });
    await nextBtn.click();
    await expect(studentPage.getByText("Capital of France?", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await studentPage.getByRole("button", { name: /Paris/ }).click();
    await expect(nextBtn).toBeVisible({ timeout: 30_000 });
    await nextBtn.click();
    await expect(
      studentPage.getByText(/results will be released|awaiting/i).first(),
    ).toBeVisible({ timeout: 30_000 });

    // The exempted run actually graded: 2/2 recorded (both answers landed).
    const { data: graded } = await admin
      .from("quiz_sessions")
      .select("score, status, face_exempt")
      .eq("id", sessionId!)
      .maybeSingle();
    expect(graded?.status).toBe("completed");
    expect(graded?.face_exempt).toBe(true);
    expect(Number(graded?.score), "both answers must land after the exemption").toBe(2);

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
