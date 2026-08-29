import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  createQuizWithQuestions,
  completeQuiz,
  startQuizByTitle,
  currentSessionId,
  resolveServiceClient,
} from "./helpers";
import { optionScope, shufflePlan } from "../src/lib/sessions/shuffle";

const TEST_TIMESTAMP = Date.now();
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E42 Shuffle Physics";
const QUIZ_PRACTICE = "E42 Shuffled Practice";
const QUIZ_ASSESSMENT = "E42 Shuffled Assessment";

// Creation order = canonical order (order_index 0..2). Option texts are
// unique across the whole quiz AND non-overlapping as substrings —
// completeQuiz matches buttons by accessible-name substring.
const QUESTIONS: { prompt: string; options: string[]; correctIndex: number }[] = [
  {
    prompt: "E42 Which quantity is a vector?",
    options: ["Temperature", "Velocity", "Mass", "Energy"],
    correctIndex: 1,
  },
  {
    prompt: "E42 What does a Newton measure?",
    options: ["Force", "Power", "Current", "Pressure", "Frequency"],
    correctIndex: 0,
  },
  {
    prompt: "E42 Sound cannot travel through?",
    options: ["Steel", "Water", "Vacuum", "Air"],
    correctIndex: 2,
  },
];

type CanonicalQuestion = {
  id: string;
  prompt: string;
  options: string[];
  correct_index: number;
  order_index: number;
};

const letters = ["A", "B", "C", "D", "E"];

/**
 * QT-3 — per-student question/option shuffling.
 *
 * Every ordering assertion is plan-RELATIVE (rendered order must equal the
 * DERIVED plan), so the identity permutation — a legitimate outcome for a
 * correct feature — passes everywhere; a dead feature (e.g. a missed
 * select-list edit) renders canonical order and fails whenever the derived
 * plan is not identity, which is 143/144 sessions. All probes run
 * unconditionally.
 *
 * Verifies:
 *  1. The create-form toggle persists (service-role probe of
 *     quizzes.shuffle_questions).
 *  2. PRACTICE positive ordering: the spec imports the shared shuffle
 *     module, parses the sessionId from the URL, re-derives the expected
 *     permutation, and asserts the rendered first prompt + ordered option
 *     accessible names EQUAL the derived plan (also after a reload —
 *     determinism across loads).
 *  3. Deterministic translation probe: answering by unique option TEXT, then
 *     comparing persisted session_answers.selected_index against the
 *     canonical correct_index (admin client) — P(false pass) = 0.
 *  4. RESUME translation: answer everything, reload BEFORE submitting, and
 *     the resumed view must show the first PRESENTED question with the
 *     presented slot of the canonical correct option pressed (the page-side
 *     canonical→presented seed translation, otherwise untestable — seeded
 *     answers suppress the correct/incorrect paint but keep aria-pressed).
 *  5. ASSESSMENT: same click-first journey with shuffle on (keyless acks —
 *     no feedback chips), pinned by the same persisted-canonical probe.
 *  6. EndScreen breakdown renders rows in the derived presented order
 *     (catches a skipped/mis-wired breakdown transform — canonical rows are
 *     internally self-consistent so ✓-text assertions alone cannot) with ✓
 *     on each correct option.
 */
test.describe("E42 — per-session question/option shuffling", () => {
  test("practice: derived order, canonical wire, resume translation, presented review", async ({
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

    // ── 1. Lecturer: class + SHUFFLED practice quiz + publish ──
    await registerUser(lecturerPage, `lecturer-e42-p-${TEST_TIMESTAMP}@innovision.test`, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);

    await createQuizWithQuestions(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_PRACTICE,
      publish: true,
      shuffle: true,
      questions: QUESTIONS.map((q) => ({ type: "mcq" as const, ...q })),
    });

    // quizId from the builder URL for the service-role probes.
    const quizId = /\/lecturer\/quizzes\/([0-9a-f-]{36})\/builder/.exec(lecturerPage.url())?.[1];
    expect(quizId, "builder URL carries the quiz id").toBeTruthy();

    // (1) Toggle persisted.
    const { data: quizRow, error: quizErr } = await admin!
      .from("quizzes")
      .select("shuffle_questions")
      .eq("id", quizId!)
      .single();
    expect(quizErr).toBeNull();
    expect(quizRow?.shuffle_questions).toBe(true);

    // Canonical truth (creation order): questions + options straight from DB.
    const { data: canonical, error: qErr } = await admin!
      .from("questions")
      .select("id, prompt, options, correct_index, order_index, created_at")
      .eq("quiz_id", quizId!)
      .order("order_index", { ascending: true })
      .order("created_at", { ascending: true });
    expect(qErr).toBeNull();
    const canonicalQuestions = canonical as CanonicalQuestion[];
    expect(canonicalQuestions).toHaveLength(QUESTIONS.length);

    // ── 2. Student: register + join + start ──
    await registerUser(studentPage, `student-e42-p-${TEST_TIMESTAMP}@innovision.test`, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    await startQuizByTitle(studentPage, QUIZ_PRACTICE);

    const sessionId = currentSessionId(studentPage);

    // (2) POSITIVE ordering assertion — re-derive the session's plan.
    const questionPlan = shufflePlan(sessionId, "questions", canonicalQuestions.length);
    const presentedQuestions = questionPlan.map((i) => canonicalQuestions[i]);
    const first = presentedQuestions[0];
    const firstOptionPlan = shufflePlan(sessionId, optionScope(first.id), first.options.length);
    const expectedFirstOptions = firstOptionPlan.map((i) => first.options[i]);

    // Reload BEFORE answering: the same session must re-derive the identical
    // order (determinism across loads).
    await studentPage.reload();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    await expect(studentPage.getByText(first.prompt, { exact: true })).toBeVisible();
    await expect(studentPage.getByText("Q 1/3", { exact: true })).toBeVisible();

    // Rendered option buttons (accessible names are "<letter> <text>",
    // option-card.tsx — the finger glyph is aria-hidden) in DOM order —
    // position i must be exactly letters[i] + expected presented option.
    const optionButtons = studentPage.getByRole("button", { name: /^[A-E] / });
    await expect(optionButtons).toHaveCount(first.options.length);
    for (let i = 0; i < expectedFirstOptions.length; i++) {
      await expect(optionButtons.nth(i)).toHaveAccessibleName(
        `${letters[i]} ${expectedFirstOptions[i]}`,
      );
    }

    // (3) Answer every question by its CORRECT option TEXT, in the EXPECTED
    // presented question order (completeQuiz clicks answers[i] on question i).
    const correctTextOf = (q: CanonicalQuestion) => q.options[q.correct_index];
    const presentedAnswers = presentedQuestions.map(correctTextOf);
    const completedSessionId = await completeQuiz(studentPage, presentedAnswers, {
      next: "Next",
      finish: "Finish",
    });
    expect(completedSessionId).toBe(sessionId);

    // Full score: if translation were broken (presented index persisted),
    // the canonical grading would misfire — this is the loud failure.
    await expect(studentPage.getByText(/^3\s*\/\s*3$/)).toBeVisible({ timeout: 10_000 });
    await expect(studentPage.getByText("100% correct", { exact: true })).toBeVisible();

    // Deterministic persisted-index probe: session_answers must hold the
    // CANONICAL correct index for every question (P(false pass) = 0).
    const { data: answers, error: aErr } = await admin!
      .from("session_answers")
      .select("question_id, selected_index")
      .eq("session_id", sessionId);
    expect(aErr).toBeNull();
    expect(answers ?? []).toHaveLength(QUESTIONS.length);
    for (const row of answers ?? []) {
      const q = canonicalQuestions.find((c) => c.id === row.question_id)!;
      expect(
        row.selected_index,
        `persisted selected_index for ${q.prompt} must be canonical correct_index`,
      ).toBe(q.correct_index);
    }

    // (6) EndScreen breakdown (practice always reveals): rows render in the
    // DERIVED presented order, each prompt appears exactly once, and each
    // correct option's row carries the ✓ glyph.
    await expect(studentPage.getByText("Answer breakdown")).toBeVisible();
    const breakdownRows = studentPage.locator("ol > li");
    await expect(breakdownRows).toHaveCount(QUESTIONS.length);
    for (let i = 0; i < presentedQuestions.length; i++) {
      await expect(breakdownRows.nth(i)).toContainText(presentedQuestions[i].prompt);
    }
    for (const q of canonicalQuestions) {
      const row = studentPage.locator("ol > li").filter({ hasText: q.prompt });
      await expect(row).toHaveCount(1);
      await expect(row.locator("li").filter({ hasText: q.options[q.correct_index] })).toContainText("✓");
    }

    await lecturerCtx.close();
    await studentCtx.close();
  });

  test("resume: answered questions render the presented slot of the canonical answer", async ({
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

    await registerUser(lecturerPage, `lecturer-e42-r-${TEST_TIMESTAMP}@innovision.test`, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    await createQuizWithQuestions(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_PRACTICE,
      publish: true,
      shuffle: true,
      questions: QUESTIONS.map((q) => ({ type: "mcq" as const, ...q })),
    });
    const quizId = /\/lecturer\/quizzes\/([0-9a-f-]{36})\/builder/.exec(lecturerPage.url())?.[1];
    expect(quizId).toBeTruthy();
    const { data: canonical, error: qErr } = await admin!
      .from("questions")
      .select("id, prompt, options, correct_index, order_index, created_at")
      .eq("quiz_id", quizId!)
      .order("order_index", { ascending: true })
      .order("created_at", { ascending: true });
    expect(qErr).toBeNull();
    const canonicalQuestions = canonical as CanonicalQuestion[];

    await registerUser(studentPage, `student-e42-r-${TEST_TIMESTAMP}@innovision.test`, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    await startQuizByTitle(studentPage, QUIZ_PRACTICE);

    const sessionId = currentSessionId(studentPage);
    const questionPlan = shufflePlan(sessionId, "questions", canonicalQuestions.length);
    const presentedQuestions = questionPlan.map((i) => canonicalQuestions[i]);
    const presentedAnswers = presentedQuestions.map((q) => q.options[q.correct_index]);

    // Answer everything, then reload BEFORE submitting → the all-answered
    // resume state (initialIndex = -1 → engine lands on the first PRESENTED
    // question in feedback phase with seeded answers).
    for (let i = 0; i < presentedAnswers.length; i++) {
      await studentPage.getByRole("button", { name: presentedAnswers[i] }).click();
      if (i < presentedAnswers.length - 1) {
        await studentPage.getByRole("button", { name: "Next", exact: true }).click();
      } else {
        await expect(studentPage.getByRole("button", { name: "Finish", exact: true })).toBeVisible();
      }
    }
    await studentPage.reload();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);

    // Resumed view: first presented question, seeded highlight on the
    // PRESENTED slot of the canonical correct option. Seeded answers suppress
    // the correct/incorrect paint (question-card.tsx) but keep aria-pressed —
    // so this pins the page-side canonical→presented seed translation.
    const first = presentedQuestions[0];
    const firstOptionPlan = shufflePlan(sessionId, optionScope(first.id), first.options.length);
    const presentedCorrectPos = firstOptionPlan.indexOf(first.correct_index);
    await expect(studentPage.getByText(first.prompt, { exact: true })).toBeVisible();
    await expect(studentPage.getByText("Q 1/3", { exact: true })).toBeVisible();
    await expect(
      studentPage
        .getByRole("button", { name: /^[A-E] / })
        .nth(presentedCorrectPos),
    ).toHaveAttribute("aria-pressed", "true");

    await lecturerCtx.close();
    await studentCtx.close();
  });

  test("assessment: keyless acks with shuffle on still persist canonical indices", async ({
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

    await registerUser(lecturerPage, `lecturer-e42-a-${TEST_TIMESTAMP}@innovision.test`, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    await createQuizWithQuestions(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_ASSESSMENT,
      mode: "assessment",
      publish: true,
      shuffle: true,
      questions: QUESTIONS.map((q) => ({ type: "mcq" as const, ...q })),
    });
    const quizId = /\/lecturer\/quizzes\/([0-9a-f-]{36})\/builder/.exec(lecturerPage.url())?.[1];
    expect(quizId).toBeTruthy();
    const { data: canonical, error: qErr } = await admin!
      .from("questions")
      .select("id, prompt, options, correct_index, order_index, created_at")
      .eq("quiz_id", quizId!)
      .order("order_index", { ascending: true })
      .order("created_at", { ascending: true });
    expect(qErr).toBeNull();
    const canonicalQuestions = canonical as CanonicalQuestion[];

    await registerUser(studentPage, `student-e42-a-${TEST_TIMESTAMP}@innovision.test`, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    await startQuizByTitle(studentPage, QUIZ_ASSESSMENT);
    const sessionId = currentSessionId(studentPage);

    // Derived presented order; answer by correct TEXT (e5 pattern: assessment
    // acks are keyless — wait for Next/Finish, never for feedback chips).
    const questionPlan = shufflePlan(sessionId, "questions", canonicalQuestions.length);
    const presentedQuestions = questionPlan.map((i) => canonicalQuestions[i]);
    const presentedAnswers = presentedQuestions.map((q) => q.options[q.correct_index]);
    const firstOptionPlan = shufflePlan(
      sessionId,
      optionScope(presentedQuestions[0].id),
      presentedQuestions[0].options.length,
    );
    const expectedFirstOptions = firstOptionPlan.map((i) => presentedQuestions[0].options[i]);
    const optionButtons = studentPage.getByRole("button", { name: /^[A-E] / });
    await expect(optionButtons).toHaveCount(expectedFirstOptions.length);
    for (let i = 0; i < expectedFirstOptions.length; i++) {
      await expect(optionButtons.nth(i)).toHaveAccessibleName(
        `${letters[i]} ${expectedFirstOptions[i]}`,
      );
    }

    for (let i = 0; i < presentedAnswers.length; i++) {
      await studentPage.getByRole("button", { name: presentedAnswers[i] }).click();
      if (i < presentedAnswers.length - 1) {
        await studentPage.getByRole("button", { name: "Next", exact: true }).click();
      } else {
        await studentPage.getByRole("button", { name: "Finish", exact: true }).click();
      }
    }

    // Deterministic probe: canonical indices persisted despite the presented
    // click order (the mode-agnostic translation covers the keyless path).
    const { data: answers, error: aErr } = await admin!
      .from("session_answers")
      .select("question_id, selected_index")
      .eq("session_id", sessionId);
    expect(aErr).toBeNull();
    expect(answers ?? []).toHaveLength(QUESTIONS.length);
    for (const row of answers ?? []) {
      const q = canonicalQuestions.find((c) => c.id === row.question_id)!;
      expect(row.selected_index).toBe(q.correct_index);
    }

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
