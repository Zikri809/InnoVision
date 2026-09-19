import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  createQuizWithQuestions,
  readGesturesToggle,
  setGesturesToggle,
  resolveServiceClient,
} from "./helpers";

/**
 * E-57 — clone fidelity + the live flag freeze (v4.9).
 *
 * Two independent contracts:
 *
 *  1. `clone_quiz` must carry the NEW question columns. A clone that dropped
 *     `answer_key` would produce a short_text question the AI marker cannot
 *     grade — silently, because the row still looks valid. Same for the
 *     quiz-level `gestures_enabled`: a gestures-OFF quiz that comes back
 *     gesture-ON changes the assessment's modality without anyone deciding
 *     to.
 *
 *  2. `gestures_enabled` is DRAFT-FROZEN. The route's `hasNonWindowFields`
 *     check returns 409 before the DB trigger has to reject it, and the
 *     trigger (`quiz_status_transition`) is the backstop for a direct write.
 *     This mirrors the existing `shuffle_questions` freeze, so the spec also
 *     pins that the two behave identically.
 */

const TEST_TIMESTAMP = Date.now();
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

test.describe("E-57 — clone + live flag freeze", () => {
  test("a clone carries gestures_enabled and the short_text rubric", async ({
    page,
  }, testInfo) => {
    testInfo.setTimeout(300_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const CLASS_TITLE = `E57 Class ${TEST_TIMESTAMP}`;
    const QUIZ_TITLE = `E57 Clone ${TEST_TIMESTAMP}`;
    const TEXT_PROMPT = `E57 rubric ${TEST_TIMESTAMP}`;
    const RUBRIC = "Mentions both the cause and the effect.";

    await registerUser(
      page,
      `lecturer-e57-${TEST_TIMESTAMP}@innovision.test`,
      "lecturer",
      LECTURER_INVITE_CODE,
    );
    await expect(page.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await createClass(page, CLASS_TITLE);
    await createQuizWithQuestions(page, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_TITLE,
      questions: [
        {
          type: "short_text" as const,
          prompt: TEXT_PROMPT,
          options: [],
          answerKey: RUBRIC,
        },
      ],
    });

    // Turn gestures OFF (draft-only, so before publish).
    await setGesturesToggle(page, false);
    expect(await readGesturesToggle(page)).toBe(false);

    const publish = page.getByRole("button", { name: /publish/i });
    await expect(publish).toBeEnabled();
    await publish.click();
    await expect(page.getByText("Live", { exact: true })).toBeVisible();

    const quizId = /\/lecturer\/quizzes\/([0-9a-f-]{36})\/builder/.exec(page.url())?.[1];
    expect(quizId).toBeTruthy();

    // ── Duplicate via the API (the dialog flow is E44's job; this spec is
    //    about what the CLONE carries).
    const admin = resolveServiceClient();
    if (!admin) throw new Error("service-role seam unavailable");
    const { data: srcQuiz } = await admin
      .from("quizzes")
      .select("id, class_id, gestures_enabled")
      .eq("id", quizId!)
      .maybeSingle();
    expect(srcQuiz?.gestures_enabled, "the source quiz is gesture-OFF").toBe(false);

    const dupRes = await page.request.post(`/api/quizzes/${quizId}/duplicate`, {
      data: { destClassId: srcQuiz!.class_id },
    });
    // 201 Created with `{ quizId, images }` (the duplicate route's contract).
    expect(dupRes.status(), await dupRes.text()).toBe(201);
    const dupBody = (await dupRes.json()) as { quizId?: string };
    const cloneId = dupBody.quizId;
    expect(cloneId, "the duplicate response must carry the new quiz id").toBeTruthy();

    // ── The clone's quiz-level flag ───────────────────────────────────
    const { data: cloneQuiz } = await admin
      .from("quizzes")
      .select("gestures_enabled, status")
      .eq("id", cloneId!)
      .maybeSingle();
    expect(cloneQuiz?.status).toBe("draft");
    expect(
      cloneQuiz?.gestures_enabled,
      "the clone must inherit gestures_enabled (a dropped flag silently re-enables gestures)",
    ).toBe(false);

    // ── The clone's question keys ─────────────────────────────────────
    const { data: cloneQuestions } = await admin
      .from("questions")
      .select("type, prompt, answer_key, options, max_score")
      .eq("quiz_id", cloneId!);
    const textRow = cloneQuestions?.find((q) => q.prompt === TEXT_PROMPT);
    expect(textRow, "the short_text question must be cloned").toBeTruthy();
    expect(textRow?.type).toBe("short_text");
    expect(
      textRow?.answer_key,
      "the rubric must survive the clone — a dropped key makes the question ungradeable",
    ).toBe(RUBRIC);
    expect(textRow?.options).toEqual([]);
    expect(Number(textRow?.max_score)).toBe(1);
  });

  test("a LIVE quiz rejects a gestures flag flip with 409", async ({ page }, testInfo) => {
    testInfo.setTimeout(300_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const CLASS_TITLE = `E57b Class ${TEST_TIMESTAMP}`;
    const QUIZ_TITLE = `E57b Freeze ${TEST_TIMESTAMP}`;

    await registerUser(
      page,
      `lecturer-e57b-${TEST_TIMESTAMP}@innovision.test`,
      "lecturer",
      LECTURER_INVITE_CODE,
    );
    await expect(page.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await createClass(page, CLASS_TITLE);
    await createQuizWithQuestions(page, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_TITLE,
      publish: true,
      questions: [{ prompt: "E57b q?", options: ["A", "B"], correctIndex: 0 }],
    });

    const quizId = /\/lecturer\/quizzes\/([0-9a-f-]{36})\/builder/.exec(page.url())?.[1];
    expect(quizId).toBeTruthy();

    // A direct PATCH bypassing the UI (the UI also disables the switch).
    const res = await page.request.patch(`/api/quizzes/${quizId}`, {
      data: { gesturesEnabled: false },
    });
    expect(
      res.status(),
      "a live quiz must reject the gesture flip (draft-frozen, D9)",
    ).toBe(409);

    // The same freeze applies to shuffle_questions — pinned together so the
    // two cannot drift apart.
    const shuffleRes = await page.request.patch(`/api/quizzes/${quizId}`, {
      data: { shuffleQuestions: true },
    });
    expect(shuffleRes.status(), "shuffle_questions shares the freeze").toBe(409);

    // A window/retake-only PATCH is still allowed on a live quiz (the
    // deliberate carve-out), proving the 409s above are about the FROZEN
    // fields rather than a blanket live-quiz rejection.
    const windowRes = await page.request.patch(`/api/quizzes/${quizId}`, {
      data: { allowRetake: true, maxAttempts: 2 },
    });
    expect(
      windowRes.status(),
      "live quiz management (retake config) must still work",
    ).toBe(200);
  });
});
