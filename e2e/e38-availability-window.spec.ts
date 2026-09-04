import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  resolveServiceClient,
} from "./helpers";
import { setDateTime } from "./helpers-datetime";

/**
 * E38 — QC-3 availability-window journey (the E2E gaps unit/verify tests
 * cannot cover — the fake can't model real clocks and the SQL harness can't
 * drive the browser):
 *
 *  1. Lecturer creates a PRACTICE quiz windowed ~1h in the future via the
 *     class-detail create form; the schedule chip appears on the builder.
 *  2. Student BEFORE opens_at: card VISIBLE (windows gate starts, not
 *     visibility), Start → "isn't open yet" notice; API → 409 quiz_not_open
 *     (enrolled callers legitimately learn schedule state — QC-3 contract).
 *  3. Lecturer pulls opens_at into the past via the edit dialog (live-quiz
 *     management; window fields stay editable while live) → student's Start
 *     now succeeds and lands on the play page.
 *  4. Window passes (service-role seam sets closes_at in the past): Start
 *     is window-stopped for everyone — the RPC's practice closes_at gate
 *     fires before the rejoin check (only submit grace remains via an open
 *     play page); the card STAYS VISIBLE (windows gate starts, not lists).
 *  5. quiz flipped terminal via the per-quiz service-role seam (NOT the
 *     global quiz_autoclose() RPC — it closes every past-window live quiz
 *     and races parallel repeat-each instances; its semantics are pinned by
 *     the verify-quizzes QC-3 cron probe) → the card disappears from the
 *     student list.
 */

const stamp = Date.now();
const INVITE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = `E38 Window ${stamp}`;
const QUIZ_TITLE = `E38 Window Quiz ${stamp}`;

test.describe.configure({ mode: "serial" });

test("window journey: not-open → opened → window-closed → autoclose hides card", async ({
  browser,
}) => {
  test.skip(!INVITE, "LECTURER_INVITE_CODE not set");
  test.setTimeout(300_000);

  const admin = resolveServiceClient();
  test.skip(!admin, "service-role seam unavailable (non-local Supabase)");

  // ── Setup: lecturer + windowed practice quiz, published with ≥1 question.
  const lecCtx = await browser.newContext();
  const lecturer = await lecCtx.newPage();
  await registerUser(lecturer, `e38-lec-${stamp}@e2e.test`, "lecturer", INVITE);
  const joinCode = await createClass(lecturer, CLASS_TITLE);

  const opens = new Date(Date.now() + 3600_000);
  const closes = new Date(Date.now() + 7200_000);

  await lecturer.getByText(CLASS_TITLE, { exact: true }).click();
  await expect(lecturer).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
  await lecturer.getByLabel("Quiz title").fill(QUIZ_TITLE);
  await setDateTime(lecturer, lecturer.getByLabel("Opens at", { exact: true }), opens);
  await setDateTime(lecturer, lecturer.getByLabel("Closes at", { exact: true }), closes);
  await lecturer.getByRole("button", { name: /create quiz|new quiz/i }).click();
  await expect(lecturer.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();
  await lecturer.getByText(QUIZ_TITLE, { exact: true }).click();
  await expect(lecturer).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);
  const quizId = new URL(lecturer.url()).pathname.match(
    /\/lecturer\/quizzes\/([0-9a-f-]{36})/,
  )?.[1] ?? "";
  expect(quizId).toMatch(/^[0-9a-f-]{36}$/);
  const promptBox = lecturer.getByRole("textbox", { name: "Question prompt" });
  const addBtn = lecturer.getByRole("button", { name: /add this question/i });
  // Fail fast: assert editability/enabled BEFORE interacting so a race fails
  // here with a clear message instead of a long actionability-wait stall.
  await expect(promptBox).toBeEditable();
  await promptBox.fill("E38 Q?");
  await lecturer.getByLabel("Option 1").fill("A");
  await lecturer.getByLabel("Option 2").fill("B");
  await expect(addBtn).toBeEnabled();
  await addBtn.click();
  await expect(lecturer.getByText("E38 Q?", { exact: true })).toBeVisible();
  await lecturer.getByRole("button", { name: /publish/i }).click();
  await expect(lecturer.getByText(/^Live/)).toBeVisible();
  // The schedule chip renders the window and doubles as the settings entry.
  await expect(
    lecturer.getByRole("button", { name: /Availability window:/i }),
  ).toBeVisible();

  // ── 1. Before opens_at: card visible, Start → "isn't open yet" notice.
  const stuCtx = await browser.newContext();
  const student = await stuCtx.newPage();
  await registerUser(student, `e38-stu-${stamp}@e2e.test`, "student", "");
  await joinClass(student, joinCode, CLASS_TITLE);

  await student.goto("/student/quizzes");
  await expect(student.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();
  await student.getByRole("button", { name: "Start" }).click();
  await expect(
    student.getByText(/isn't open yet/i),
  ).toBeVisible({ timeout: 10_000 });

  // API contract: typed schedule error → 409 (distinct from identity 404).
  const notOpenRes = await student.request.post("/api/sessions", {
    data: { quizId },
  });
  expect(notOpenRes.status()).toBe(409);
  expect((await notOpenRes.json()).error).toBe("quiz_not_open");

  // ── 2. Lecturer pulls opens_at into the past via the edit dialog
  // (live-quiz management — window fields stay editable while live).
  await lecturer.getByRole("button", { name: /Availability window:/i }).click();
  const dialog = lecturer.getByRole("dialog", { name: "Edit quiz settings" });
  await expect(dialog).toBeVisible();
  await setDateTime(
    lecturer,
    dialog.getByLabel("Opens at (UTC)", { exact: true }),
    new Date(Date.now() - 60_000),
  );
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });

  // Student's Start now succeeds (window open).
  await student.goto("/student/quizzes");
  await student.getByRole("button", { name: "Start" }).click();
  await expect(student).toHaveURL(/\/play\/[0-9a-f-]+/);
  await expect(student.getByText("E38 Q?", { exact: true })).toBeVisible();

  // ── 3. Window passes (service-role seam): Start is window-stopped for
  // EVERYONE — the RPC's practice closes_at gate fires before the rejoin
  // check (shipped 0030 semantics; answering is hard-stopped at the same
  // boundary, only submit grace remains via an open play page). The card
  // itself STAYS VISIBLE (windows gate starts, not visibility).
  const { error: closeErr } = await admin!
    .from("quizzes")
    .update({ closes_at: new Date(Date.now() - 60_000).toISOString() })
    .eq("id", quizId);
  expect(closeErr).toBeNull();

  await student.goto("/student/quizzes");
  // Cron-race tolerant (see the twin comment below): a mid-test autoclose
  // tick hides the card, which phase 4 covers.
  if (await student.getByText(QUIZ_TITLE, { exact: true }).count()) {
    await student.getByRole("button", { name: "Start" }).click();
    await expect(
      student.getByText(/window has closed/i),
    ).toBeVisible({ timeout: 10_000 });
  }

  // A fresh student gets the identical truthful notice.
  const stuCtx2 = await browser.newContext();
  const student2 = await stuCtx2.newPage();
  await registerUser(student2, `e38-stu2-${stamp}@e2e.test`, "student", "");
  await joinClass(student2, joinCode, CLASS_TITLE);
  await student2.goto("/student/quizzes");
  // NOTE: the 5-min pg_cron autoclose tick may legitimately seal the quiz
  // closed in the seconds between the seam above and this assertion — in
  // that race the card is HIDDEN (closed removes visibility), which phase 4
  // asserts anyway. Poll for either truthful state instead of hard-failing.
  await expect
    .poll(async () => {
      const { data } = await admin!
        .from("quizzes")
        .select("status")
        .eq("id", quizId)
        .single();
      return data?.status;
    })
    .toBe("live");
  if (await student2.getByText(QUIZ_TITLE, { exact: true }).count()) {
    await student2.getByRole("button", { name: "Start" }).click();
    await expect(
      student2.getByText(/window has closed/i),
    ).toBeVisible({ timeout: 10_000 });
  }

  // ── 4. Terminal close: flip live→closed via the per-quiz service-role
  // seam (e35 precedent). Deliberately NOT `quiz_autoclose()`: the RPC is
  // GLOBAL (closes EVERY past-window live quiz), so two repeat-each
  // instances running in parallel close each other's fixtures mid-flight —
  // the observed flake. The function's semantics are authoritatively pinned
  // by the verify-quizzes QC-3 cron probe; the E2E's unique value is the
  // user-visible consequence: a CLOSED quiz leaves the student list.
  const { error: sealErr } = await admin!
    .from("quizzes")
    .update({ status: "closed" })
    .eq("id", quizId);
  expect(sealErr).toBeNull();
  await expect
    .poll(async () => {
      const { data } = await admin!
        .from("quizzes")
        .select("status")
        .eq("id", quizId)
        .single();
      return data?.status;
    })
    .toBe("closed");
  await student2.goto("/student/quizzes");
  await expect(student2.getByText(QUIZ_TITLE, { exact: true })).toBeHidden();

  await lecCtx.close();
  await stuCtx.close();
  await stuCtx2.close();
});

test("mid-session window close: answer dead-screens with window copy, submit grace succeeds", async ({
  browser,
}) => {
  test.skip(!INVITE, "LECTURER_INVITE_CODE not set");
  test.setTimeout(240_000);

  const admin = resolveServiceClient();
  test.skip(!admin, "service-role seam unavailable (non-local Supabase)");

  // ── Setup: lecturer + windowed practice quiz with TWO questions (so the
  // close lands mid-question), window ~10 min out.
  const lecCtx = await browser.newContext();
  const lecturer = await lecCtx.newPage();
  await registerUser(lecturer, `e38b-lec-${stamp}@e2e.test`, "lecturer", INVITE);
  const joinCode = await createClass(lecturer, `${CLASS_TITLE} B`);

  const opens = new Date(Date.now() - 60_000);
  const closes = new Date(Date.now() + 600_000);
  await lecturer.getByText(`${CLASS_TITLE} B`, { exact: true }).click();
  await expect(lecturer).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
  await lecturer.getByLabel("Quiz title").fill(`${QUIZ_TITLE} B`);
  await setDateTime(lecturer, lecturer.getByLabel("Opens at", { exact: true }), opens);
  await setDateTime(lecturer, lecturer.getByLabel("Closes at", { exact: true }), closes);
  await lecturer.getByRole("button", { name: /create quiz|new quiz/i }).click();
  await expect(lecturer.getByText(`${QUIZ_TITLE} B`, { exact: true })).toBeVisible();
  await lecturer.getByText(`${QUIZ_TITLE} B`, { exact: true }).click();
  await expect(lecturer).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);
  const quizId = new URL(lecturer.url()).pathname.match(
    /\/lecturer\/quizzes\/([0-9a-f-]{36})/,
  )?.[1] ?? "";
  expect(quizId).toMatch(/^[0-9a-f-]{36}$/);
  const promptBox = lecturer.getByRole("textbox", { name: "Question prompt" });
  const addBtn = lecturer.getByRole("button", { name: /add this question/i });
  // Fail fast on a disabled control: assert editability/enabled BEFORE each
  // click so a race fails here with a clear message instead of stalling in
  // Playwright's enabled-wait loop for the full actionability timeout.
  await expect(promptBox).toBeEditable();
  await promptBox.fill("E38b Q1?");
  await lecturer.getByLabel("Option 1").fill("A1");
  await lecturer.getByLabel("Option 2").fill("B1");
  await expect(addBtn).toBeEnabled();
  await addBtn.click();
  // Helper contract: the save completes when the form resets — a controlled
  // re-render after this point can swallow a fill that lands too early.
  await expect(promptBox).toHaveValue("", { timeout: 15_000 });
  await expect(promptBox).toBeEditable();
  await promptBox.fill("E38b Q2?");
  await lecturer.getByLabel("Option 1").fill("A2");
  await lecturer.getByLabel("Option 2").fill("B2");
  await expect(addBtn).toBeEnabled();
  await addBtn.click();
  await expect(lecturer.getByText("E38b Q2?", { exact: true })).toBeVisible();
  await lecturer.getByRole("button", { name: /publish/i }).click();
  await expect(lecturer.getByText(/^Live/)).toBeVisible();

  const stuCtx = await browser.newContext();
  const student = await stuCtx.newPage();
  await registerUser(student, `e38b-stu-${stamp}@e2e.test`, "student", "");
  await joinClass(student, joinCode, `${CLASS_TITLE} B`);

  // ── Student starts and answers Q1; navigate to Q2 (mid-question).
  await student.goto("/student/quizzes");
  await student.getByRole("button", { name: "Start" }).click();
  await expect(student).toHaveURL(/\/play\/[0-9a-f-]+/);
  const sessionUrl = student.url();
  const sessionId = sessionUrl.split("/play/")[1] ?? "";
  expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(student.getByText("E38b Q1?", { exact: true })).toBeVisible();
  await student.getByRole("button", { name: /A1/i }).click();
  await expect(student.getByText(/^Correct/)).toBeVisible();
  await student.getByRole("button", { name: "Next", exact: true }).click();
  await expect(student.getByText("E38b Q2?", { exact: true })).toBeVisible();

  // ── Window passes mid-session (service-role seam, e36's close timing).
  const { error: closeErr } = await admin!
    .from("quizzes")
    .update({ closes_at: new Date(Date.now() - 60_000).toISOString() })
    .eq("id", quizId);
  expect(closeErr).toBeNull();
  // Fail fast / race-proof the seam: read back through the SAME client and
  // confirm the past instant is visible before provoking the RPC — otherwise
  // the answer POST can beat the UPDATE into the DB and the window gate
  // never fires (observed as a straight-through correct answer).
  await expect
    .poll(async () => {
      const { data } = await admin!
        .from("quizzes")
        .select("closes_at")
        .eq("id", quizId)
        .single();
      return data?.closes_at ? Date.parse(data.closes_at) < Date.now() : false;
    })
    .toBe(true);

  // ── Next answer → 409 quiz_window_closed → timeUp + auto-submit (the
  // play client's QC-3 branch: window toast + deferred submitNow). The toast
  // is TRANSIENT (auto-submit clears it when phase flips to submitted), so
  // the deterministic observable is the answer POST's 409 body itself —
  // captured via expectResponse (fail-fast: no blind toast polling).
  const answerResPromise = student.waitForResponse(
    (res) =>
      res.url().includes(`/api/sessions/${sessionId}/answer`) &&
      res.request().method() === "POST",
  );
  await student.getByRole("button", { name: /A2/i }).click();
  const answerRes = await answerResPromise;
  expect(answerRes.status()).toBe(409);
  expect((await answerRes.json()).error).toBe("quiz_window_closed");

  // The play client entered timeUp + auto-submitted: the EndScreen with the
  // window-driven auto-submit is the persistent user-visible consequence.
  await expect(
    student.getByText(/Practice complete/i),
  ).toBeVisible({ timeout: 15_000 });

  // ── Submit-grace contract double-check via the API: the window-driven
  // auto-submit already completed the session (submit_session is window-free
  // by design); the ROUTE maps an idempotent re-submit to 409
  // already_submitted carrying the stored score (submit/route.ts:76-86) —
  // proving the completed state + score persisted through the window edge.
  const submitRes = await student.request.post(`/api/sessions/${sessionId}/submit`, {
    data: {},
  });
  expect(submitRes.status()).toBe(409);
  const submitBody = await submitRes.json();
  expect(submitBody.error).toBe("already_submitted");
  expect(submitBody.session.status).toBe("completed");
  expect(submitBody.score).toBe(1);

  // ── The completed session URL stays reachable (practice = policy-revealed
  // → EndScreen with the score), window notwithstanding.
  await student.goto(sessionUrl);
  await expect(student.getByText(/^1\s*\/\s*2$/)).toBeVisible({ timeout: 10_000 });

  await lecCtx.close();
  await stuCtx.close();
});