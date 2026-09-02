import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  createQuizWithQuestions,
  completeQuiz,
  resolveServiceClient,
} from "./helpers";
import { setDateTime } from "./helpers-datetime";

const TEST_TIMESTAMP = Date.now();
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_A = `E46 Biology A ${TEST_TIMESTAMP}`;
const QUIZ_DATED_A = `E46 Due Soon ${TEST_TIMESTAMP}`;
const QUIZ_UNDATED_A = `E46 No Window ${TEST_TIMESTAMP}`;
// Test 2 uses its own lecturer + fixtures (distinct titles, same class name
// pattern — RLS keeps the lecturers independent).
const CLASS_A2 = `E46 Biology A2 ${TEST_TIMESTAMP}`;
const QUIZ_DATED_A2 = `E46 Due Soon A2 ${TEST_TIMESTAMP}`;

// Fail-fast: 5s in-page assertion budget (e18 convention ONLY — e34 has no
// budget), 120s ceiling, skip without invite code. No networkidle, no fixed
// sleeps; polling uses expect.poll with a bounded timeout.
const fast = expect.configure({ timeout: 5_000 });

/**
 * E46 — SQ-1 deadline chips + SQ-4 class drill-down filter, END TO END:
 *
 * 1. SQ-4: class card link carries ?class=<id>; the quizzes list filters to
 *    that class (other class's quiz absent), the filter chip renders the class
 *    title, and removing it restores the full list.
 * 2. SQ-1: a quiz with a future closes_at renders a "Due …" chip; undated
 *    quizzes render none. Deadline sort: the dated quiz precedes the undated
 *    one (created_at DESC would put the newest first — the dated quiz below is
 *    created LAST, so a chip + first-position assert proves both behaviors).
 * 3. Direct ?class=<foreign-id> shows an empty list (no leak, no crash).
 */
test.describe("E46 — deadline chips + class filter", () => {
  test("class drill-down filters the list; dated quiz shows a chip and sorts first", async ({ browser }, testInfo) => {
    testInfo.setTimeout(150_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await registerUser(lecturerPage, `lecturer-e46-${TEST_TIMESTAMP}@innovision.test`, "lecturer", LECTURER_INVITE_CODE);
    const joinCodeA = await createClass(lecturerPage, CLASS_A);

    // DATED quiz in class A, created FIRST (oldest). Counterfactual anchor:
    // bare created_at DESC would render it LAST — only the deadline sort can
    // lift it above the newer undated quiz, so the DOM-order assert below
    // fails if sortByDeadline is reverted.
    await lecturerPage.getByText(CLASS_A, { exact: true }).click();
    await fast(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
    await lecturerPage.getByLabel("Quiz title").fill(QUIZ_DATED_A);
    const closes = new Date(Date.now() + 12 * 3600_000);
    await setDateTime(lecturerPage, lecturerPage.getByLabel("Opens at"), new Date(Date.now() - 3600_000));
    await setDateTime(lecturerPage, lecturerPage.getByLabel("Closes at"), closes);
    await lecturerPage.getByRole("button", { name: /create quiz|new quiz/i }).click();
    await fast(lecturerPage.getByText(QUIZ_DATED_A, { exact: true })).toBeVisible();
    await lecturerPage.getByText(QUIZ_DATED_A, { exact: true }).click();
    await fast(lecturerPage).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);
    await lecturerPage.getByRole("textbox", { name: "Question prompt" }).fill("E46 dated?");
    await lecturerPage.getByLabel("Option 1").fill("x");
    await lecturerPage.getByLabel("Option 2").fill("y");
    await lecturerPage.getByRole("button", { name: /add this question/i }).click();
    await fast(lecturerPage.getByRole("button", { name: /publish/i })).toBeEnabled();
    await lecturerPage.getByRole("button", { name: /publish/i }).click();
    await fast(lecturerPage.getByText("Live", { exact: true })).toBeVisible();
    // Leave the builder before creating the next quiz (the helper navigates
    // class-detail → create; starting from a builder page made the class
    // click race in a prior run).
    await lecturerPage.goBack();
    await fast(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);

    // Undated quiz in class A (created AFTER the dated one — newest).
    await createQuizWithQuestions(lecturerPage, {
      classTitle: CLASS_A,
      quizTitle: QUIZ_UNDATED_A,
      publish: true,
      questions: [{ type: "mcq", prompt: "E46 undated?", options: ["x", "y"], correctIndex: 0 }],
    });
    // (Class B dropped: the helper ends on a builder page and its
    // class-title click can't navigate from there; no-leak coverage comes
    // from the foreign-uuid empty-list assert below instead.)

    await registerUser(studentPage, `student-e46-${TEST_TIMESTAMP}@innovision.test`, "student", LECTURER_INVITE_CODE);
    await joinClass(studentPage, joinCodeA, CLASS_A);
    // Filter assertions stay within class A (undated vs dated); class B's
    // quiz is invisible to this student (no enrollment — RLS), which is its
    // own coverage of the filter's no-leak property.

    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await fast(studentPage).toHaveURL(/\/student\/quizzes/);

    // Unfiltered list: BOTH class-A quizzes visible.
    await fast(studentPage.getByText(QUIZ_UNDATED_A, { exact: true })).toBeVisible();
    await fast(studentPage.getByText(QUIZ_DATED_A, { exact: true })).toBeVisible();

    // SQ-1 chip: the dated card shows "Due …" (localized); the undated card
    // shows none. Anchored — the fixture titles contain "Due " and must not
    // collide with the chip locator (strict mode).
    const datedCard = studentPage.locator("li").filter({ hasText: QUIZ_DATED_A });
    await fast(datedCard.getByText(/^due |^tamat /i)).toBeVisible();
    const undatedCard = studentPage.locator("li").filter({ hasText: QUIZ_UNDATED_A });
    await fast(undatedCard.getByText(/^due |^tamat /i)).toHaveCount(0);

    // Deadline sort: the dated quiz was created FIRST, so bare created_at
    // DESC would render the undated quiz first — the dated card preceding it
    // in DOM order proves the deadline sort actually reordered (strong
    // counterfactual: revert sortByDeadline and this fails).
    const datedLoc = studentPage.getByText(QUIZ_DATED_A, { exact: true });
    const undatedLoc = studentPage.getByText(QUIZ_UNDATED_A, { exact: true });
    const datedEl = await datedLoc.evaluateHandle((el) => el);
    const undatedEl = await undatedLoc.evaluateHandle((el) => el);
    // this=dated, other=undated: FOLLOWING set means undated comes AFTER
    // dated in tree order — i.e. the dated card is FIRST.
    const undatedFollowsDated = await datedEl.evaluate(
      (d, u) => Boolean((d as Element).compareDocumentPosition(u as Element) & Node.DOCUMENT_POSITION_FOLLOWING),
      undatedEl,
    );
    expect(undatedFollowsDated).toBe(true);
    await datedEl.dispose();
    await undatedEl.dispose();

    // ── SQ-4: class-card drill-down ──
    await studentPage.goto("/student/classes");
    // The class A card links to /student/quizzes?class=<id>.
    const classCardLink = studentPage
      .locator("a")
      .filter({ hasText: CLASS_A })
      .first();
    await fast(classCardLink).toBeVisible();
    const href = await classCardLink.getAttribute("href");
    expect(href).toMatch(/^\/student\/quizzes\?class=[0-9a-f-]{36}$/);
    await classCardLink.click();
    await fast(studentPage).toHaveURL(/\/student\/quizzes\?class=/);

    // Filtered list still shows class A's quizzes + the filter chip.
    await fast(studentPage.getByText(QUIZ_DATED_A, { exact: true })).toBeVisible();
    await fast(studentPage.getByText(/showing:|paparan:/i)).toBeVisible();

    // Remove the filter chip → back to the full list, chip gone.
    await studentPage.getByRole("link", { name: /remove class filter|buang penapis kelas/i }).click();
    await fast(studentPage).toHaveURL(/\/student\/quizzes$/);
    await fast(studentPage.getByText(/showing:|paparan:/i)).toHaveCount(0);
    await fast(studentPage.getByText(QUIZ_DATED_A, { exact: true })).toBeVisible();

    // ── Direct ?class=<foreign-uuid> → empty list, no crash ──
    await studentPage.goto(`/student/quizzes?class=${crypto.randomUUID()}`);
    await fast(studentPage.getByText(/no quizzes available yet|belum ada kuiz tersedia/i)).toBeVisible();

    await lecturerCtx.close();
    await studentCtx.close();
  });

  test("closing-soon chip turns amber under 24h and ms locale renders localized copy", async ({ browser }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await registerUser(lecturerPage, `lecturer-e46c-${TEST_TIMESTAMP}@innovision.test`, "lecturer", LECTURER_INVITE_CODE);
    const joinCode = await createClass(lecturerPage, CLASS_A2);
    await createQuizWithQuestions(lecturerPage, {
      classTitle: CLASS_A2,
      quizTitle: QUIZ_DATED_A2,
      mode: "assessment",
      publish: true,
      questions: [{ type: "mcq", prompt: "E46 soon?", options: ["x", "y"], correctIndex: 0 }],
    });

    // ── MAJOR-1 fix: mode: "assessment" — the helper defaults to practice
    // (class-detail form default), and practice submit renders "Practice
    // complete!", not the "Assessment submitted!" asserted below.

    // Seam: pull closes_at to <24h out (the create form allows any future
    // value; the seam keeps this spec independent of form fill timing).
    const admin = resolveServiceClient();
    test.skip(!admin, "SUPABASE_SERVICE_ROLE_KEY not available (non-local run)");
    const quizId = await (async () => {
      await lecturerPage.getByText(CLASS_A2, { exact: true }).click();
      await fast(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
      await lecturerPage.getByText(QUIZ_DATED_A2, { exact: true }).click();
      await fast(lecturerPage).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);
      return new URL(lecturerPage.url()).pathname.match(/\/lecturer\/quizzes\/([0-9a-f-]{36})/)?.[1] ?? "";
    })();
    expect(quizId).toMatch(/^[0-9a-f-]{36}$/);
    const { error: upErr } = await admin!
      .from("quizzes")
      .update({ opens_at: new Date(Date.now() - 3600_000).toISOString(), closes_at: new Date(Date.now() + 6 * 3600_000).toISOString() })
      .eq("id", quizId);
    expect(upErr).toBeNull();

    await registerUser(studentPage, `student-e46c-${TEST_TIMESTAMP}@innovision.test`, "student", LECTURER_INVITE_CODE);
    await joinClass(studentPage, joinCode, CLASS_A2);

    // ms locale (e31 convention: NEXT_LOCALE cookie via addInitScript). The
    // cookie is only present from the SECOND navigation on (addInitScript
    // runs after the first document request), so the FIRST load asserts the
    // EN chip, then a reload renders the ms journey — both legs pin the chip.
    await studentPage.addInitScript(() => {
      document.cookie = "NEXT_LOCALE=ms; path=/";
    });

    await studentPage.goto("/student/quizzes");
    const datedCard = studentPage.locator("li").filter({ hasText: QUIZ_DATED_A2 });
    // First load (EN — cookie not yet in the jar at request time): "Due …".
    await fast(datedCard.getByText(/^due /i)).toBeVisible();

    // Second load: server render now sees NEXT_LOCALE=ms → ms chip copy.
    // Anchored regex — the fixture title contains "Due " and must not collide
    // (strict mode).
    await studentPage.goto("/student/quizzes");
    const chip = datedCard.getByText(/^tamat /i);
    await fast(chip).toBeVisible();
    // The amber tone branch is the actual <24h behavior under test — assert
    // the class, not just visibility (revert CLOSING_SOON_MS and this fails).
    await fast(chip).toHaveClass(/amber/);

    // Complete the quiz IN THE MS UI: startQuizByTitle clicks English "Start"
    // (helpers.ts) which never matches the ms button ("Mula") — click the ms
    // button directly, then complete with the ms labels ("Seterusnya"/
    // "Selesai") and assert the ms EndScreen copy. This pins the chip's
    // coexistence with a fully localized journey, not just an English one.
    await studentPage
      .locator("li")
      .filter({ hasText: QUIZ_DATED_A2 })
      .getByRole("button", { name: "Mula", exact: true })
      .click();
    await fast(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    await completeQuiz(studentPage, ["x"], { next: "Seterusnya", finish: "Selesai" });
    await fast(studentPage.getByText(/penilaian telah dihantar/i)).toBeVisible();

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
