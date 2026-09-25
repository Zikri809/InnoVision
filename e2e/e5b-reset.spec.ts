import { test, expect, type Page } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  createAssessmentAndPublish,
  openResults,
  revealQuiz,
  resolveServiceClient,
} from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e5b-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_EMAIL = `student-e5b-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E5b Reset";
const QUIZ_TITLE = "E5b Assessment";

type ServiceClient = NonNullable<ReturnType<typeof resolveServiceClient>>;

/**
 * Click a play-view option and wait for the advance control (Next/Finish).
 * Wrapped in toPass because BOTH failure modes are otherwise unrecoverable
 * mid-test: a dev-mode click lost to the hydration race never selects, and a
 * transient answer-POST failure drops the phase back to "question". Re-click
 * re-POSTs safely (selectOption no-ops while locked/already-answered).
 */
async function answerAndAwaitAdvance(page: Page, option: RegExp) {
  await expect(async () => {
    await page.getByRole("button", { name: option }).click();
    await expect(
      page.getByRole("button", { name: /^(Next|Finish)$/, exact: true }),
    ).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 45_000 });
}

/**
 * Navigate with one retry budget: the Next.js dev server occasionally drops
 * connections mid-run (net::ERR_CONNECTION_REFUSED) while staying alive, and a
 * bare page.goto has no recovery. Every caller below is idempotent navigation.
 */
async function gotoWithRetry(page: Page, url: string) {
  await expect(async () => {
    await page.goto(url);
  }).toPass({ timeout: 30_000 });
}

/** Service-role lookup: the quiz id for a (class title, quiz title) pair.
 * Prior E2E runs leave identically-titled rows behind, so take the newest. */
async function resolveQuizId(
  admin: ServiceClient,
  classTitle: string,
  quizTitle: string,
): Promise<string | null> {
  const { data } = await admin
    .from("quizzes")
    .select("id, classes!inner(title)")
    .eq("title", quizTitle)
    .eq("classes.title", classTitle)
    .order("created_at", { ascending: false })
    .limit(1);
  return (data as { id: string }[] | null)?.[0]?.id ?? null;
}

/**
 * E5b (Phase 8 gate) — lecturer resets an attempt → the one-attempt slot is
 * released → the student re-takes; mid-flight reset surfaces the D13 dead
 * screen; every reset is audited.
 *
 * Flow:
 * 1. Student starts attempt 1 and answers Q1 — left ACTIVE (not submitted).
 * 2. Lecturer: results → Reset (destructive confirm dialog) → the row
 *    disappears.
 * 3. Student: Start again → SUCCEEDS (slot released — the E5b gate) → answers
 *    Q1 (the re-take is functionally live).
 * 4. Lecturer: resets the in-progress re-take row mid-flight.
 * 5. Student: answers Q2 → the next answer POST surfaces the TERMINAL dead
 *    screen "This attempt was reset by your lecturer" (D13 — NOT a 404 loop,
 *    NOT "Answered", NOT a redirect back to the question). An EndScreen-parked
 *    tab cannot exercise this (overlays/POSTs are suppressed there) — the
 *    assertion is mid-quiz.
 * 6. Audit: via the service-role client, `audit_events` has `session_reset`
 *    rows carrying `metadata.session_id`/`quiz_id` (D13 route-level).
 * 7. M-07 (audit-2): a COMPLETED attempt is append-only — the same reset on
 *    the finished record is refused (409 `session_not_active`), the row
 *    survives, and nothing is audited. Steps 1–5 must therefore run on
 *    non-completed rows: resetting a graded session used to destroy the
 *    score evidence AND silently restore the retake budget.
 */
test.describe("E5b — lecturer resets attempt", () => {
  test("reset releases the slot; mid-flight reset surfaces the D13 dead screen", async ({ browser }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const admin = resolveServiceClient();

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    // ── 0. Lecturer: class + UNTIMED assessment + publish ────────────
    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    await createAssessmentAndPublish(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_TITLE,
      // 0067: this spec pins reset/audit semantics, not identity. Gestures OFF
      // bypasses the answer-commit face gate so fixtures answer click-first.
      gesturesOff: true,
      questions: [
        { prompt: "What is 2+2?", options: ["3", "4"], correctIndex: 1 },
        { prompt: "Capital of France?", options: ["Paris", "London"], correctIndex: 0 },
      ],
    });
    await revealQuiz(lecturerPage, CLASS_TITLE, QUIZ_TITLE);

    // ── 1. Student: start attempt 1 and answer Q1 — deliberately NOT
    //    submitted, so the row is the resettable `active` state. (audit-2
    //    M-07: `reset_session` REFUSES `completed` sessions — deleting one
    //    destroyed graded evidence AND silently restored the retake budget.
    //    active/paused/flagged remain resettable; the refusal is pinned at
    //    the end of this spec.)
    await registerUser(studentPage, STUDENT_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    // Click-then-assert pairs are retried via toPass: a lost dev-mode click
    // (hydration race) must not strand the flow before the play view.
    await expect(async () => {
      if (!studentPage.url().includes("/student/quizzes")) {
        await studentPage.getByRole("link", { name: /View quizzes/i }).click();
      }
      await expect(studentPage).toHaveURL(/\/student\/quizzes/, { timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    await expect(async () => {
      if (!/\/play\/[0-9a-f-]+/.test(studentPage.url())) {
        await studentPage.getByRole("button", { name: "Start", exact: true }).click();
      }
      await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/, { timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    const session1Id = studentPage.url().split("/play/")[1];
    await expect(studentPage.getByText("What is 2+2?", { exact: true })).toBeVisible();
    await answerAndAwaitAdvance(studentPage, /4/i);
    // Stop here — the attempt stays `active` (no submit).

    // ── 2. Lecturer: results → Reset (confirm dialog) → row gone ─────
    await expect(async () => {
      await openResults(lecturerPage, CLASS_TITLE, QUIZ_TITLE);
    }).toPass({ timeout: 60_000 });
    const studentList1 = lecturerPage.getByRole("list");
    await expect(studentList1.getByText("In progress", { exact: true })).toHaveCount(1);
    // Reset lives in the row's "Session actions" overflow menu (the row keeps
    // one primary action + overflow for the rare admin ones), so the menu must
    // be opened first. The whole open-then-click is retried (guarded on the
    // dialog not already being up) so a lost click cannot strand the reset.
    const resetDialogHeading = lecturerPage
      .getByRole("dialog")
      .getByRole("heading", { name: "Reset", exact: true });
    await expect(async () => {
      if (!(await resetDialogHeading.isVisible())) {
        await studentList1
          .getByRole("button", { name: /Session actions/i })
          .first()
          .click();
        await lecturerPage.getByRole("menuitem", { name: "Reset", exact: true }).click();
      }
      await expect(resetDialogHeading).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    await lecturerPage.getByRole("dialog").getByRole("button", { name: "Reset", exact: true }).click();
    // The row disappears after refresh.
    await expect(studentList1.getByText("In progress", { exact: true })).toHaveCount(0);

    // Deterministic barrier: the lecturer's dashboard refreshing does NOT
    // prove a fresh student RSC render sees the released slot (separate
    // reads, separate commits — and e14's earlier reset would otherwise
    // satisfy an unscoped count). Wait until a session_reset audited against
    // THIS quiz is durable — same commit as the slot release — so the
    // student's reload below can never resurrect the deleted attempt.
    if (admin) {
      await expect
        .poll(async () => {
          const quizId = await resolveQuizId(admin, CLASS_TITLE, QUIZ_TITLE);
          if (!quizId) return 0;
          const { count } = await admin
            .from("audit_events")
            .select("*", { count: "exact", head: true })
            .eq("action", "session_reset")
            .eq("metadata->>quiz_id", quizId);
          return count ?? 0;
        }, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(1);
    }

    // ── 3. Student: Start again → SUCCEEDS (slot released) ──────────
    await gotoWithRetry(studentPage, "/student/quizzes");
    await expect(studentPage.getByText("Available quizzes", { exact: false })).toBeVisible();
    await expect(studentPage.getByRole("list").getByText("In progress", { exact: true })).toHaveCount(0);
    await expect(async () => {
      if (!/\/play\/[0-9a-f-]+/.test(studentPage.url())) {
        await studentPage.getByRole("button", { name: "Start", exact: true }).click();
      }
      await expect(studentPage).toHaveURL(new RegExp(`/play/(?!${session1Id})[0-9a-f-]+`), {
        timeout: 5_000,
      });
    }).toPass({ timeout: 30_000 });
    await expect(studentPage.getByText("What is 2+2?", { exact: true })).toBeVisible();
    await answerAndAwaitAdvance(studentPage, /4/i);

    // ── 4. Lecturer: reset the re-take row mid-flight ────────────────
    await expect(async () => {
      await openResults(lecturerPage, CLASS_TITLE, QUIZ_TITLE);
    }).toPass({ timeout: 60_000 });
    const studentList2 = lecturerPage.getByRole("list");
    await expect(studentList2.getByText("In progress", { exact: true })).toHaveCount(1);
    const resetDialogHeading2 = lecturerPage
      .getByRole("dialog")
      .getByRole("heading", { name: "Reset", exact: true });
    await expect(async () => {
      if (!(await resetDialogHeading2.isVisible())) {
        await studentList2
          .getByRole("button", { name: /Session actions/i })
          .first()
          .click();
        await lecturerPage.getByRole("menuitem", { name: "Reset", exact: true }).click();
      }
      await expect(resetDialogHeading2).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    await lecturerPage.getByRole("dialog").getByRole("button", { name: "Reset", exact: true }).click();
    await expect(studentList2.getByText("In progress", { exact: true })).toHaveCount(0);

    // ── 5. Student: next answer POST → D13 dead screen (NOT a 404 loop) ──
    await studentPage.getByRole("button", { name: "Next", exact: true }).click();
    await expect(studentPage.getByText("Capital of France?", { exact: true })).toBeVisible();
    // The answer POST returns 404 (session gone) → the client surfaces the
    // terminal dead screen. Retried: a transient network failure (NOT a 404)
    // drops the phase back to "question"; re-clicking re-POSTs and then hits
    // the 404 — the assertion still proves the terminal D13 screen.
    await expect(async () => {
      await studentPage.getByRole("button", { name: /Paris/i }).click();
      await expect(
        studentPage.getByText(
          "This attempt was reset by your lecturer — ask them to restart you.",
          { exact: false },
        ),
      ).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    // NOT stuck in a recoverable state: no "Answered", no Finish submit.
    await expect(studentPage.getByText("Your score", { exact: true })).toHaveCount(0);

    // ── 6. Audit: session_reset rows with attributable metadata ──────
    if (admin) {
      const { data: resets, error } = await admin
        .from("audit_events")
        .select("action, metadata")
        .eq("action", "session_reset")
        .order("created_at", { ascending: false })
        .limit(5);
      expect(error).toBeNull();
      expect((resets ?? []).length).toBeGreaterThanOrEqual(2);
      for (const r of resets ?? []) {
        expect(r.metadata?.session_id).toBeTruthy();
        expect(r.metadata?.quiz_id).toBeTruthy();
      }
    } else {
      test.info().annotations.push({
        type: "skip",
        description: "service-role seam unavailable — audit assertion skipped",
      });
    }

    // ── 7. M-07 (audit-2): a COMPLETED attempt is append-only ───────
    // The reset above released the slot, so the student can start once more;
    // complete it fully and then prove the terminal record is NOT deletable.
    // This is the security property M-07 exists for: deleting a graded
    // session destroyed the score evidence AND silently restored the retake
    // budget (the budget counts `completed` attempts).
    await gotoWithRetry(studentPage, "/student/quizzes");
    await expect(async () => {
      if (!/\/play\/[0-9a-f-]+/.test(studentPage.url())) {
        await studentPage.getByRole("button", { name: "Start", exact: true }).click();
      }
      await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/, { timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    await expect(studentPage.getByText("What is 2+2?", { exact: true })).toBeVisible();
    await answerAndAwaitAdvance(studentPage, /4/i);
    await studentPage.getByRole("button", { name: "Next", exact: true }).click();
    await expect(studentPage.getByText("Capital of France?", { exact: true })).toBeVisible();
    await answerAndAwaitAdvance(studentPage, /Paris/i);
    await studentPage.getByRole("button", { name: "Finish", exact: true }).click();
    await expect(
      studentPage.locator("p:visible", { hasText: "Assessment complete" }),
    ).toBeVisible({ timeout: 10_000 });
    const completedSessionId = studentPage.url().split("/play/")[1];

    const refused = await lecturerPage.request.delete(`/api/sessions/${completedSessionId}/reset`);
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error).toBe("session_not_active");

    // The terminal record survived: the session row is still there, still
    // completed, and no reset was audited against it.
    if (admin) {
      const { data: survivor } = await admin
        .from("quiz_sessions")
        .select("id, status, score")
        .eq("id", completedSessionId)
        .single();
      expect(survivor?.status).toBe("completed");
      const { count: refusedAudits } = await admin
        .from("audit_events")
        .select("*", { count: "exact", head: true })
        .eq("action", "session_reset")
        .eq("metadata->>session_id", completedSessionId);
      expect(refusedAudits ?? 0).toBe(0);
    }

    void session1Id;
    await lecturerCtx.close();
    await studentCtx.close();
  });
});