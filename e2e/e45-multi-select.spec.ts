import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  createQuizWithQuestions,
  startQuizByTitle,
  currentSessionId,
  resolveServiceClient,
  installFakeHandTracker,
  assertFakeHandTrackerInstalled,
  completeCalibration,
  playGestureSequence,
  fakeHandFrame,
  captureAnswerPosts,
  waitForScanClear,
} from "./helpers";
import { HOLD_MS } from "../src/lib/gestures/constants";
import { optionScope, shufflePlan } from "../src/lib/sessions/shuffle";

const TEST_TIMESTAMP = Date.now();
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E45 Multi Biology";
const QUIZ_PRACTICE = "E45 Multi Practice";
const QUIZ_ASSESSMENT = "E45 Multi Assessment";
const QUIZ_SHUFFLED = "E45 Multi Shuffled";
const MULTI_PROMPT = "E45 Which of these are mammals?";
const MULTI_PROMPT_2 = "E45 Which are prime?";
const MULTI_PROMPT_3 = "E45 Which are metals?";

/**
 * QT-1 — multi-select questions.
 *
 * Covering: (1) authoring via the toggle group + edit-dialog persistence +
 * the mcq→multi TYPE-SWITCH seed (correctIndex → correctIndices) in the edit
 * dialog; (2) practice journey (toggle set → Confirm → set feedback + EndScreen
 * ✓ set marks AND the wrong-selection journey → EndScreen ✕ + "Correct answer"
 * tag); (3) resume translation (aria-pressed on the persisted presented slots);
 * (4) assessment keyless acks + deterministic service-role probe of the stored
 * canonical set; (5) GESTURE-DISABLED contract (holds never answer; palm-next
 * still navigates); (6) SHUFFLE-ON multi journey (e42 pattern: plan-derived
 * rendering, reverse-order clicks → sorted canonical wire, resume set
 * translation, EndScreen presented-set ✓ marks — exercises the per-element
 * toCanonical/toPresented/translateSet paths that are dead when shuffle is
 * off).
 */

const MULTI = {
  prompt: MULTI_PROMPT,
  // 4 options max (QT-1 gesture amendment: palm-commit reserves 5 fingers).
  options: ["Dolphin", "Shark", "Bat", "Trout"],
  correctIndices: [0, 2],
};

test.describe("E45 — multi-select questions", () => {
  test("authoring: toggle group marks a set and the edit dialog persists it", async ({
    page,
  }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    await registerUser(page, `lecturer-e45-a-${TEST_TIMESTAMP}@innovision.test`, "lecturer", LECTURER_INVITE_CODE);
    await expect(page.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await createClass(page, CLASS_TITLE);
    await createQuizWithQuestions(page, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_PRACTICE,
      questions: [
        { ...MULTI, type: "multi_select" as const },
        { type: "mcq", prompt: MULTI_PROMPT_2, options: ["2", "3", "4", "9"], correctIndex: 3 },
      ],
    });

    // The builder row shows the SET in its summary line.
    const row = page.locator("li").filter({ hasText: MULTI_PROMPT });
    await expect(row).toBeVisible();
    await expect(row.getByText(/Correct answers: Option 1, Option 3/)).toBeVisible();

    // Re-open the edit dialog: both toggles are pressed.
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    const group = page.getByRole("group", { name: "Correct answers" });
    await expect(group.getByRole("button", { name: "Option 1" })).toHaveAttribute("aria-pressed", "true");
    await expect(group.getByRole("button", { name: "Option 3" })).toHaveAttribute("aria-pressed", "true");
    await expect(group.getByRole("button", { name: "Option 2" })).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    // TYPE-SWITCH seed: switching an existing mcq question TO multi must seed
    // the toggle group from the scalar mark (correctIndex 3 → Option 4
    // pressed) — the create-flow switch is exercised by the helper above, but
    // this edit-dialog branch (and the group's appearance) is UI-only.
    const scalarRow = page.locator("li").filter({ hasText: MULTI_PROMPT_2 });
    await scalarRow.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("dialog").getByLabel("Question type").click();
    await page.getByRole("option", { name: "Multi-select" }).click();
    const switchGroup = page.getByRole("group", { name: "Correct answers" });
    await expect(switchGroup.getByRole("button", { name: "Option 4" })).toHaveAttribute("aria-pressed", "true");
    await expect(switchGroup.getByRole("button", { name: "Option 1" })).toHaveAttribute("aria-pressed", "false");
    // Cancel — no save (this quiz's shape is asserted nowhere else).
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("practice: toggle set → Confirm → feedback + EndScreen ✓ set + resume", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(180_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await registerUser(lecturerPage, `lecturer-e45-p-${TEST_TIMESTAMP}@innovision.test`, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    await createQuizWithQuestions(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_PRACTICE,
      publish: true,
      questions: [
        { ...MULTI, type: "multi_select" as const },
        { type: "mcq", prompt: MULTI_PROMPT_2, options: ["2", "3", "4", "9"], correctIndex: 3 },
      ],
    });

    await registerUser(studentPage, `student-e45-p-${TEST_TIMESTAMP}@innovision.test`, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await startQuizByTitle(studentPage, QUIZ_PRACTICE);

    // Q1 is the multi question (creation order = play order).
    await expect(studentPage.getByText(MULTI_PROMPT, { exact: true })).toBeVisible();
    // The gesture-disabled hint chip is visible on unanswered multi questions.
    await expect(studentPage.getByText(/select every correct option/i)).toBeVisible();
    // The question-type chip reads "Multi-select" (QT-1's 3-way map — multi
    // must not fall through the old MCQ/TrueFalse else-branch).
    await expect(studentPage.getByText("Multi-select", { exact: true })).toBeVisible();

    // Toggle BOTH correct options (in presented order — no shuffle here),
    // then Confirm. The Confirm button is disabled until ≥1 selection.
    const confirm = studentPage.getByRole("button", { name: "Confirm answer" });
    await expect(studentPage.getByRole("button", { name: /^A / })).toHaveAttribute("aria-pressed", "false");
    await studentPage.getByRole("button", { name: /^A Dolphin/ }).click();
    await studentPage.getByRole("button", { name: /^C Bat/ }).click();
    await confirm.click();

    // Practice feedback: both correct options highlighted ✓; the wrong
    // options untouched. The feedback chip reads "Correct".
    await expect(studentPage.getByText("Correct! ✓")).toBeVisible();
    await expect(studentPage.getByRole("button", { name: /^A Dolphin/ })).toHaveAttribute("aria-pressed", "true");
    await expect(studentPage.getByRole("button", { name: /^C Bat/ })).toHaveAttribute("aria-pressed", "true");
    await expect(studentPage.getByRole("button", { name: /^B Shark/ })).toHaveAttribute("aria-pressed", "false");
    // The hint chip is question-phase-only: it unmounts once feedback lands.
    await expect(studentPage.getByText(/select every correct option/i)).toHaveCount(0);

    // Next → Q2 (scalar) → answer correct → Finish (practice auto-submits? No —
    // Finish click submits).
    await studentPage.getByRole("button", { name: "Next", exact: true }).click();
    await expect(studentPage.getByText(MULTI_PROMPT_2, { exact: true })).toBeVisible();
    // Scalar co-question: the type chip must NOT read "Multi-select".
    await expect(studentPage.getByText("Multi-select", { exact: true })).toHaveCount(0);
    await studentPage.getByRole("button", { name: /^D 9/ }).click();
    await studentPage.getByRole("button", { name: "Finish", exact: true }).click();
    await expect(studentPage.getByText("Practice complete! 🎉")).toBeVisible({ timeout: 15_000 });

    // ENDTSCREEN SET RENDERING: the multi row carries ✓ on BOTH correct
    // options (end-screen multi branch: correct_indices.includes) and neither
    // ✓ nor ✕ on the untouched wrong options; the scalar row keeps its single ✓.
    await expect(studentPage.getByText("Answer breakdown")).toBeVisible();
    const multiRow = studentPage.locator("ol > li").filter({ hasText: MULTI_PROMPT });
    await expect(multiRow).toHaveCount(1);
    await expect(multiRow.locator("li").filter({ hasText: "Dolphin" })).toContainText("✓");
    await expect(multiRow.locator("li").filter({ hasText: "Bat" })).toContainText("✓");
    await expect(multiRow.locator("li").filter({ hasText: "Shark" })).not.toContainText("✓");
    await expect(multiRow.locator("li").filter({ hasText: "Shark" })).not.toContainText("✕");
    const scalarEndRow = studentPage.locator("ol > li").filter({ hasText: MULTI_PROMPT_2 });
    await expect(scalarEndRow.locator("li").filter({ hasText: "9" })).toContainText("✓");

    // WRONG-SELECTION journey (fresh attempt): one correct + one wrong toggle →
    // practice feedback "Incorrect ✗" (all-or-nothing). The EndScreen must
    // render the row badge ✗, ✕ on the wrong selection, and ✓ PLUS the
    // "Correct answer" tag on the MISSED key option (selected-but-wrong and
    // correct-but-not-selected multi branches — never painted by the ✓-only
    // journey above).
    await studentPage.getByRole("button", { name: /Try again/i }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    await startQuizByTitle(studentPage, QUIZ_PRACTICE);
    await expect(studentPage.getByText(MULTI_PROMPT, { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /^A Dolphin/ }).click();
    await studentPage.getByRole("button", { name: /^B Shark/ }).click();
    await studentPage.getByRole("button", { name: "Confirm answer" }).click();
    await expect(studentPage.getByText("Incorrect ✗")).toBeVisible();
    // The wrong selection stays pressed; the missed key (Bat) was never selected.
    await expect(studentPage.getByRole("button", { name: /^B Shark/ })).toHaveAttribute("aria-pressed", "true");
    await expect(studentPage.getByRole("button", { name: /^C Bat/ })).toHaveAttribute("aria-pressed", "false");
    await studentPage.getByRole("button", { name: "Next", exact: true }).click();
    await expect(studentPage.getByText(MULTI_PROMPT_2, { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /^D 9/ }).click();
    await studentPage.getByRole("button", { name: "Finish", exact: true }).click();
    await expect(studentPage.getByText("Practice complete! 🎉")).toBeVisible({ timeout: 15_000 });
    await expect(studentPage.getByText("Answer breakdown")).toBeVisible();
    const wrongRow = studentPage.locator("ol > li").filter({ hasText: MULTI_PROMPT });
    await expect(wrongRow).toContainText("✗"); // row badge (options carry ✓ / ✕ / numbers only)
    await expect(wrongRow.locator("li").filter({ hasText: "Shark" })).toContainText("✕");
    await expect(wrongRow.locator("li").filter({ hasText: "Dolphin" })).toContainText("✓");
    await expect(wrongRow.locator("li").filter({ hasText: "Bat" })).toContainText("✓");
    await expect(wrongRow.locator("li").filter({ hasText: "Bat" })).toContainText("Correct answer");
    // 1/2 — no partial credit for the half-right set.
    await expect(studentPage.getByText("50% correct", { exact: true })).toBeVisible();

    // RESUME: the completed session renders the EndScreen (not the resume
    // path). Drive a FRESH practice attempt via the EndScreen "Try again" and
    // reload BEFORE submitting — the seeded answer keeps aria-pressed on the
    // presented slots.
    await studentPage.getByRole("button", { name: /Try again/i }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    await startQuizByTitle(studentPage, QUIZ_PRACTICE);
    await expect(studentPage.getByText(MULTI_PROMPT, { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /^A Dolphin/ }).click();
    await studentPage.getByRole("button", { name: /^C Bat/ }).click();
    await studentPage.getByRole("button", { name: "Confirm answer" }).click();
    await expect(studentPage.getByText("Correct! ✓")).toBeVisible();
    // Answer Q2 too, then reload BEFORE submitting → the all-answered resume
    // state lands back on the FIRST presented question with seeded answers
    // (e42's resume pattern).
    await studentPage.getByRole("button", { name: "Next", exact: true }).click();
    await expect(studentPage.getByText(MULTI_PROMPT_2, { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /^D 9/ }).click();
    await expect(studentPage.getByText("Correct! ✓")).toBeVisible();
    await studentPage.reload();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    // Seeded resume: both presented slots keep aria-pressed (the stored
    // canonical set was translated back by the play page).
    await expect(studentPage.getByText(MULTI_PROMPT, { exact: true })).toBeVisible();
    await expect(studentPage.getByRole("button", { name: /^A Dolphin/ })).toHaveAttribute("aria-pressed", "true");
    await expect(studentPage.getByRole("button", { name: /^C Bat/ })).toHaveAttribute("aria-pressed", "true");

    await lecturerCtx.close();
    await studentCtx.close();
  });

  test("assessment: keyless acks + stored canonical set (service-role probe)", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(180_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");
    const admin = resolveServiceClient();
    test.skip(!admin, "SUPABASE_SERVICE_ROLE_KEY not available (non-local run)");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await registerUser(lecturerPage, `lecturer-e45-a-${TEST_TIMESTAMP}@innovision.test`, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    await createQuizWithQuestions(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_ASSESSMENT,
      mode: "assessment",
      publish: true,
      questions: [
        { ...MULTI, type: "multi_select" as const },
        { type: "mcq", prompt: MULTI_PROMPT_2, options: ["2", "3", "4", "9"], correctIndex: 3 },
      ],
    });
    const quizId = /\/lecturer\/quizzes\/([0-9a-f-]{36})\/builder/.exec(lecturerPage.url())?.[1];
    expect(quizId).toBeTruthy();
    const { data: canonical, error: qErr } = await admin!
      .from("questions")
      .select("id, prompt, options, correct_index, correct_indices")
      .eq("quiz_id", quizId!)
      .order("order_index", { ascending: true });
    expect(qErr).toBeNull();
    const multiQ = (canonical as { id: string; prompt: string; correct_indices: number[] | null }[]).find(
      (q) => q.prompt === MULTI_PROMPT,
    );
    expect(multiQ?.correct_indices).toEqual([0, 2]);

    await registerUser(studentPage, `student-e45-a-${TEST_TIMESTAMP}@innovision.test`, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await startQuizByTitle(studentPage, QUIZ_ASSESSMENT);

    // Answer the multi question (deterministic: no shuffle → presented ==
    // canonical, so the clicked-text → canonical mapping is exact).
    await expect(studentPage.getByText(MULTI_PROMPT, { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /^A Dolphin/ }).click();
    await studentPage.getByRole("button", { name: /^C Bat/ }).click();
    await studentPage.getByRole("button", { name: "Confirm answer" }).click();
    // Assessment success is a KEYLESS neutral "answered" state (no Correct!).
    await expect(studentPage.getByText("Completed", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: "Next", exact: true }).click();
    await studentPage.getByRole("button", { name: /^D 9/ }).click();
    await studentPage.getByRole("button", { name: "Finish", exact: true }).click();

    // Deterministic probe: the stored canonical set matches the clicked
    // texts' canonical positions; the scalar stays NULL.
    const { data: session } = await admin!
      .from("quiz_sessions")
      .select("id")
      .eq("quiz_id", quizId!)
      .limit(1);
    expect(session).toHaveLength(1);
    const { data: answerRow } = await admin!
      .from("session_answers")
      .select("selected_index, selected_indices, is_correct")
      .eq("session_id", session![0].id)
      .eq("question_id", multiQ!.id)
      .single();
    expect(answerRow?.selected_index).toBeNull();
    expect(answerRow?.selected_indices).toEqual([0, 2]);
    expect(answerRow?.is_correct).toBe(true);

    await lecturerCtx.close();
    await studentCtx.close();
  });

  test("gesture: holds toggle options, palm commits the set, re-arm prevents double-toggle", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(180_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await registerUser(lecturerPage, `lecturer-e45-g-${TEST_TIMESTAMP}@innovision.test`, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    await createQuizWithQuestions(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_PRACTICE,
      publish: true,
      questions: [
        { ...MULTI, type: "multi_select" as const },
        { type: "mcq", prompt: MULTI_PROMPT_2, options: ["2", "3", "4", "9"], correctIndex: 3 },
      ],
    });

    await registerUser(studentPage, `student-e45-g-${TEST_TIMESTAMP}@innovision.test`, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await expect(studentPage.getByText(QUIZ_PRACTICE, { exact: true })).toBeVisible();

    // Install BEFORE Start (addInitScript is not retroactive — E8 convention).
    await installFakeHandTracker(studentPage);
    await studentPage.getByRole("button", { name: "Start" }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    await assertFakeHandTrackerInstalled(studentPage);
    await completeCalibration(studentPage);
    await expect(studentPage.getByText(MULTI_PROMPT, { exact: true })).toBeVisible();

    // 1. Hold 2 fingers → presented option B TOGGLES ON (no answer POST —
    //    a hold never submits in multi mode). The palm hint chip is visible.
    const capture = captureAnswerPosts(studentPage);
    await playGestureSequence(studentPage, [
      { fingers: 2, holdMs: HOLD_MS + 150 },
      { present: false, fingers: 0, holdMs: 300 },
    ]);
    await expect(studentPage.getByRole("button", { name: /^B Shark/ })).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: 5_000 },
    );
    await expect(studentPage.getByText(/hold .*to confirm/i)).toBeVisible();
    expect(capture.bodies).toEqual([]);

    // 2. RE-ARM + toggle OFF: the gate clears when the pose CHANGES. The
    //    fake tracker stops emitting after a sequence ends, so bridge with
    //    explicit absent frames (a real camera streams continuously), then
    //    hold 2 fingers again → B toggles back OFF. A sustained hold must
    //    never double-fire (re-arm gate) and a hold never submits.
    await fakeHandFrame(studentPage, false, 0);
    await studentPage.waitForTimeout(150);
    await playGestureSequence(studentPage, [
      { fingers: 2, holdMs: HOLD_MS + 150 },
      { present: false, fingers: 0, holdMs: 300 },
    ]);
    await expect(studentPage.getByRole("button", { name: /^B Shark/ })).toHaveAttribute(
      "aria-pressed",
      "false",
      { timeout: 5_000 },
    );
    expect(capture.bodies).toEqual([]);

    // 3. Hold 1 (A ON) + hold 3 (C ON) → the pending set is {A, C}; palm
    //    COMMITS it. The POST body carries the canonical set (no shuffle →
    //    presented == canonical), sorted ascending.
    // One sequence with INTERNAL gaps: frames flow between segments, so the
    // re-arm gate sees each pose change (1 → absent → 3).
    await playGestureSequence(studentPage, [
      { fingers: 1, holdMs: HOLD_MS + 150 },
      { present: false, fingers: 0, holdMs: 300 },
      { fingers: 3, holdMs: HOLD_MS + 150 },
      { present: false, fingers: 0, holdMs: 300 },
    ]);
    await expect(studentPage.getByRole("button", { name: /^A Dolphin/ })).toHaveAttribute("aria-pressed", "true");
    await expect(studentPage.getByRole("button", { name: /^C Bat/ })).toHaveAttribute("aria-pressed", "true");
    await playGestureSequence(studentPage, [{ fingers: 5, holdMs: HOLD_MS + 150 }]);
    const commitReq = await studentPage.waitForRequest(
      (req) => req.url().includes("/answer") && req.method() === "POST",
    );
    capture.detach();
    const commitBody = JSON.parse(commitReq.postData() ?? "{}") as {
      questionId: string;
      selectedIndex?: number;
      selectedIndices?: number[];
    };
    expect(commitBody.selectedIndices).toEqual([0, 2]);
    expect(commitBody.selectedIndex).toBeUndefined();

    // 4. Practice feedback lands (exact set → correct); palm = Next advances.
    //    The commit latch pinned the re-arm gate at 5 fingers and the fake
    //    tracker stops emitting between sequences — bridge with an absent
    //    frame (a real camera streams the hand-drop) so the gate re-arms,
    //    then palm-next advances to Q2 (the scan countdown fires on that
    //    transition; e8 ordering asserts it AFTER the advance).
    await expect(studentPage.getByText("Correct! ✓")).toBeVisible();
    await fakeHandFrame(studentPage, false, 0);
    await studentPage.waitForTimeout(150);
    await playGestureSequence(studentPage, [{ fingers: 5, holdMs: HOLD_MS + 150 }]);
    await expect(studentPage.getByText(MULTI_PROMPT_2, { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await waitForScanClear(studentPage);

    await lecturerCtx.close();
    await studentCtx.close();
  });

  test("shuffle-on: plan-derived rendering, sorted canonical wire, resume + EndScreen set translation", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(180_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");
    const admin = resolveServiceClient();
    test.skip(!admin, "SUPABASE_SERVICE_ROLE_KEY not available (non-local run)");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    // Two MULTI questions: the all-answered resume lands on the FIRST
    // presented question, and backward navigation does not exist — a scalar
    // co-question could land first and make the set-resume assertion
    // unreachable ~50% of the time. (Scalar×shuffle is e42's coverage.)
    await registerUser(lecturerPage, `lecturer-e45-s-${TEST_TIMESTAMP}@innovision.test`, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    await createQuizWithQuestions(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_SHUFFLED,
      publish: true,
      shuffle: true,
      questions: [
        { ...MULTI, type: "multi_select" as const },
        {
          type: "multi_select" as const,
          prompt: MULTI_PROMPT_3,
          options: ["Sodium", "Sulfur", "Zinc", "Neon"],
          correctIndices: [0, 2],
        },
      ],
    });
    const quizId = /\/lecturer\/quizzes\/([0-9a-f-]{36})\/builder/.exec(lecturerPage.url())?.[1];
    expect(quizId).toBeTruthy();
    const { data: canonical, error: qErr } = await admin!
      .from("questions")
      .select("id, prompt, options, correct_indices, order_index, created_at")
      .eq("quiz_id", quizId!)
      .order("order_index", { ascending: true })
      .order("created_at", { ascending: true });
    expect(qErr).toBeNull();
    const canonicalQuestions = canonical as {
      id: string;
      prompt: string;
      options: string[];
      correct_indices: number[];
      order_index: number;
    }[];
    expect(canonicalQuestions).toHaveLength(2);
    for (const q of canonicalQuestions) expect(q.correct_indices).toEqual([0, 2]);

    await registerUser(studentPage, `student-e45-s-${TEST_TIMESTAMP}@innovision.test`, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await startQuizByTitle(studentPage, QUIZ_SHUFFLED);
    const sessionId = currentSessionId(studentPage);

    // e42 pattern: every ordering assertion is plan-RELATIVE (re-derived from
    // the sessionId), so the identity permutation — a legitimate outcome —
    // passes, while a dead per-element translation fails on non-identity
    // plans (option plans are identity for only 1/120 and 1/24 sessions).
    const questionPlan = shufflePlan(sessionId, "questions", canonicalQuestions.length);
    const presentedQuestions = questionPlan.map((i) => canonicalQuestions[i]);
    const letters = ["A", "B", "C", "D", "E"];
    const first = presentedQuestions[0];
    const firstOptionPlan = shufflePlan(sessionId, optionScope(first.id), first.options.length);
    const expectedFirstOptions = firstOptionPlan.map((i) => first.options[i]);

    // Reload BEFORE answering: the same session must re-derive the identical
    // order (determinism across loads) — then assert rendered order EQUALS the
    // derived plan (positive ordering assertion).
    await studentPage.reload();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    await expect(studentPage.getByText(first.prompt, { exact: true })).toBeVisible();
    await expect(studentPage.getByText("Q 1/2", { exact: true })).toBeVisible();
    const optionButtons = studentPage.getByRole("button", { name: /^[A-E] / });
    await expect(optionButtons).toHaveCount(first.options.length);
    for (let i = 0; i < expectedFirstOptions.length; i++) {
      await expect(optionButtons.nth(i)).toHaveAccessibleName(
        `${letters[i]} ${expectedFirstOptions[i]}`,
      );
    }

    // Answer BOTH questions by clicking the correct PRESENTED slots in
    // REVERSE position order — the client must translate per element to
    // canonical, sort+dedupe, and POST the set; the practice feedback chip is
    // only "Correct! ✓" when the response's canonical key set is translated
    // back per element too (a broken toCanonical grades presented==canonical
    // → Incorrect on every non-identity option plan: the loud failure).
    for (let qi = 0; qi < presentedQuestions.length; qi++) {
      const q = presentedQuestions[qi];
      const plan = shufflePlan(sessionId, optionScope(q.id), q.options.length);
      const correctPositions = q.correct_indices
        .map((ci) => plan.indexOf(ci))
        .sort((a, b) => b - a); // descending presented positions
      const buttons = studentPage.getByRole("button", { name: /^[A-E] / });
      for (const pos of correctPositions) await buttons.nth(pos).click();
      await studentPage.getByRole("button", { name: "Confirm answer" }).click();
      await expect(studentPage.getByText("Correct! ✓")).toBeVisible();
      if (qi < presentedQuestions.length - 1) {
        await studentPage.getByRole("button", { name: "Next", exact: true }).click();
      } else {
        await studentPage.getByRole("button", { name: "Finish", exact: true }).click();
      }
    }
    await expect(studentPage.getByText(/^2\s*\/\s*2$/)).toBeVisible({ timeout: 10_000 });

    // ENDTSCREEN with shuffle ON: rows render in the DERIVED presented order
    // and ✓ marks land on the PRESENTED slots of the canonical key set
    // (applyBreakdownShuffle's per-element translateSet — canonical marks on a
    // presented options array would light the WRONG option texts).
    await expect(studentPage.getByText("Answer breakdown")).toBeVisible();
    const breakdownRows = studentPage.locator("ol > li");
    await expect(breakdownRows).toHaveCount(2);
    for (let i = 0; i < presentedQuestions.length; i++) {
      await expect(breakdownRows.nth(i)).toContainText(presentedQuestions[i].prompt);
    }
    for (const q of canonicalQuestions) {
      const row = studentPage.locator("ol > li").filter({ hasText: q.prompt });
      await expect(row).toHaveCount(1);
      for (const ci of q.correct_indices) {
        await expect(row.locator("li").filter({ hasText: q.options[ci] })).toContainText("✓");
      }
      // The untouched wrong option (index 1) stays unmarked.
      await expect(row.locator("li").filter({ hasText: q.options[1] })).not.toContainText("✓");
      await expect(row.locator("li").filter({ hasText: q.options[1] })).not.toContainText("✕");
    }

    // Deterministic persisted-set probe: session_answers must hold the
    // CANONICAL sorted set (selected_index stays NULL) despite the
    // reverse-order presented clicks.
    const { data: answers, error: aErr } = await admin!
      .from("session_answers")
      .select("question_id, selected_index, selected_indices, is_correct")
      .eq("session_id", sessionId);
    expect(aErr).toBeNull();
    expect(answers ?? []).toHaveLength(2);
    for (const row of answers ?? []) {
      const q = canonicalQuestions.find((c) => c.id === row.question_id)!;
      expect(row.selected_index).toBeNull();
      expect(
        row.selected_indices,
        `persisted selected_indices for ${q.prompt} must be the canonical set`,
      ).toEqual(q.correct_indices);
      expect(row.is_correct).toBe(true);
    }

    // RESUME set translation (second attempt — the all-answered reload of the
    // finished session renders the EndScreen, not the resume path): reload
    // BEFORE submitting → the all-answered resume lands on the FIRST
    // PRESENTED question in feedback phase with seeded answers (aria-pressed
    // survives; the correct/incorrect paint is suppressed). The play page must
    // translate the stored canonical set PER ELEMENT back to presented slots
    // (a broken per-element toPresented leaves canonical indices pressed on a
    // presented options array). Assert-and-stop, per the e42 resume pattern:
    // goNext onto an already-seeded question has no phase-correction, so
    // navigating forward is deliberately not exercised here.
    await studentPage.getByRole("button", { name: /Try again/i }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    await startQuizByTitle(studentPage, QUIZ_SHUFFLED);
    const resumeSessionId = currentSessionId(studentPage);
    expect(resumeSessionId).not.toBe(sessionId);
    const resumeQuestionPlan = shufflePlan(resumeSessionId, "questions", canonicalQuestions.length);
    const resumePresented = resumeQuestionPlan.map((i) => canonicalQuestions[i]);
    for (let qi = 0; qi < resumePresented.length; qi++) {
      const q = resumePresented[qi];
      const plan = shufflePlan(resumeSessionId, optionScope(q.id), q.options.length);
      const correctPositions = q.correct_indices
        .map((ci) => plan.indexOf(ci))
        .sort((a, b) => b - a);
      const buttons = studentPage.getByRole("button", { name: /^[A-E] / });
      for (const pos of correctPositions) await buttons.nth(pos).click();
      await studentPage.getByRole("button", { name: "Confirm answer" }).click();
      await expect(studentPage.getByText("Correct! ✓")).toBeVisible();
      if (qi < resumePresented.length - 1) {
        await studentPage.getByRole("button", { name: "Next", exact: true }).click();
      }
    }
    await studentPage.reload();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    const firstResume = resumePresented[0];
    const firstResumePlan = shufflePlan(resumeSessionId, optionScope(firstResume.id), firstResume.options.length);
    await expect(studentPage.getByText(firstResume.prompt, { exact: true })).toBeVisible();
    await expect(studentPage.getByText("Q 1/2", { exact: true })).toBeVisible();
    for (const ci of firstResume.correct_indices) {
      const presentedPos = firstResumePlan.indexOf(ci);
      await expect(
        studentPage.getByRole("button", { name: /^[A-E] / }).nth(presentedPos),
      ).toHaveAttribute("aria-pressed", "true");
    }

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
