import { test, expect } from "@playwright/test";
import { registerUser, createClass, createQuizWithQuestions } from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e15-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E15 Metadata Edit Class";
const INITIAL_QUIZ_TITLE = "Initial E15 Quiz";

test.describe("E15 — Quiz Metadata Editing (Title, Mode, Time Limit)", () => {
  test("E15-1..E15-10 Full lifecycle of inline editing and EditQuizDialog settings modal", async ({
    page,
  }) => {
    // 1. Register lecturer & create class
    await registerUser(page, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);

    await createClass(page, CLASS_TITLE);
    await page.getByText(CLASS_TITLE, { exact: true }).click();
    await expect(page).toHaveURL(/\/lecturer\/classes\/[^/]+$/);

    // 2. Create an assessment quiz with initial time limit 30 min
    await page.getByLabel("Quiz title").fill(INITIAL_QUIZ_TITLE);
    await page.getByLabel("Mode").click();
    await page.getByRole("option", { name: "Assessment" }).click();
    // The create form uses h/min spinbuttons (sr-only labels "h"/"min").
    await page.getByLabel("h", { exact: true }).fill("0");
    await page.getByLabel("min", { exact: true }).fill("30");
    await page.getByRole("button", { name: /create quiz|new quiz/i }).click();

    await expect(page.getByText(INITIAL_QUIZ_TITLE, { exact: true })).toBeVisible();
    await page.getByText(INITIAL_QUIZ_TITLE, { exact: true }).click();
    await expect(page).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);

    // 3. E15-1: Inline title edit fast path
    // Double-click the title heading
    await page.getByRole("heading", { level: 1, name: INITIAL_QUIZ_TITLE }).dblclick();
    const titleInput = page.getByRole("textbox", { name: "Edit settings" });
    await expect(titleInput).toBeVisible();
    await expect(titleInput).toBeFocused();

    // Cancel with Escape
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { level: 1, name: INITIAL_QUIZ_TITLE })).toBeVisible();

    // Re-enter inline edit and save with Enter
    await page.getByRole("heading", { level: 1, name: INITIAL_QUIZ_TITLE }).dblclick();
    await page.getByRole("textbox", { name: "Edit settings" }).fill("Renamed Inline Title");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Renamed Inline Title" })).toBeVisible();

    // 4. E15-2 & E15-3: Open EditQuizDialog via Mode pill and change time limit
    await page.getByRole("button", { name: /Quiz mode: Assessment/i }).click();
    await expect(page.getByRole("dialog", { name: "Edit quiz settings" })).toBeVisible();
    await expect(page.getByLabel("Title")).toHaveValue("Renamed Inline Title");

    // Change title and update time limit to 1h 15m
    await page.getByLabel("Title").fill("Final Comprehensive Exam");
    await page.getByLabel("h", { exact: true }).fill("1");
    await page.getByLabel("min", { exact: true }).fill("15");

    const patchPromise = page.waitForResponse(
      (res) => res.url().includes("/api/quizzes/") && res.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "Save changes" }).click();
    const patchRes = await patchPromise;
    expect(patchRes.status()).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.quiz.title).toBe("Final Comprehensive Exam");
    expect(patchBody.quiz.time_limit_sec).toBe(4500);

    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByRole("heading", { level: 1, name: "Final Comprehensive Exam" })).toBeVisible();
    await expect(page.getByText("1h 15m")).toBeVisible();

    // 5. E15-4 & E15-5: Open dialog via Mode pill, toggle to Practice, and save
    await page.getByRole("button", { name: /Quiz mode: Assessment/i }).click();
    await expect(page.getByRole("dialog", { name: "Edit quiz settings" })).toBeVisible();

    // Select practice mode
    await page.getByRole("dialog").getByRole("combobox", { name: "Quiz mode" }).click();
    await page.getByRole("option", { name: "Practice" }).click();
    await expect(page.getByText("No time limit").first()).toBeVisible();
    await expect(page.getByLabel("h", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("min", { exact: true })).toBeDisabled();

    const patchPromisePractice = page.waitForResponse(
      (res) => res.url().includes("/api/quizzes/") && res.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "Save changes" }).click();
    const practiceRes = await patchPromisePractice;
    expect(practiceRes.status()).toBe(200);
    const practiceBody = await practiceRes.json();
    expect(practiceBody.quiz.mode).toBe("practice");
    expect(practiceBody.quiz.time_limit_sec).toBeNull();

    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByText("1h 15m")).toBeHidden();
    await expect(page.getByRole("button", { name: /Quiz mode: Practice/i })).toBeVisible();

    // 6. E15-6: Reopen dialog, switch back to Assessment, set Hours = 2 (max cap)
    await page.getByRole("button", { name: /Quiz mode: Practice/i }).click();
    await page.getByRole("dialog").getByRole("combobox", { name: "Quiz mode" }).click();
    await page.getByRole("option", { name: "Assessment" }).click();

    await page.getByLabel("h", { exact: true }).fill("2");
    await expect(page.getByLabel("min", { exact: true })).toBeDisabled();
    await expect(
      page.getByText("Maximum 2h."),
    ).toBeVisible();

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();

    // 7. E15-7: Mutual exclusion between inline edit and settings modal
    await page.getByRole("heading", { level: 1, name: "Final Comprehensive Exam" }).dblclick();
    await expect(page.getByRole("textbox", { name: "Edit settings" })).toBeVisible();
    // Clicking settings cancels inline title edit and opens modal
    await page.getByRole("button", { name: /Quiz mode: Practice/i }).click();
    await expect(page.getByRole("dialog", { name: "Edit quiz settings" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("textbox", { name: "Edit settings" })).toBeHidden();

    // 8. E15-8 & E15-9: Add a question, publish quiz, and verify edit locks
    await page.getByLabel("Question prompt").fill("What is 10 x 10?");
    await page.getByLabel("Option 1").fill("100");
    await page.getByLabel("Option 2").fill("20");
    await page.getByRole("button", { name: /add question/i }).click();
    await expect(page.getByText("What is 10 x 10?")).toBeVisible();

    await page.getByRole("button", { name: /publish/i }).click();

    // Once live, the settings gear and mode chip are unmounted, but the QC-3
    // schedule chip REMAINS as the settings entry (live window management):
    // opening it shows metadata fields disabled while windows stay editable.
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Quiz mode:/i })).toBeHidden();

    const liveSettingsBtn = page.getByRole("button", { name: "Quiz settings" });
    await expect(liveSettingsBtn).toBeVisible();
    await liveSettingsBtn.click();
    const liveDialog = page.getByRole("dialog", { name: "Edit quiz settings" });
    await expect(liveDialog).toBeVisible();
    // Metadata is draft-only server-side — the inputs must be disabled.
    await expect(liveDialog.getByLabel("Title")).toBeDisabled();
    await liveDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(liveDialog).toBeHidden();

    // Out-of-band PATCH attempt on live quiz returns 409
    const quizId = page.url().split("/builder")[0].split("/").pop()!;
    const directPatchRes = await page.evaluate(async (qid) => {
      const res = await fetch(`/api/quizzes/${qid}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Hacked Live Title" }),
      });
      return { status: res.status, body: await res.json() };
    }, quizId);

    expect(directPatchRes.status).toBe(409);
    expect(directPatchRes.body.error).toBe("quiz_not_draft");
  });

  test("E15-11: practice → assessment + time chip appears and persists", async ({
    page,
  }) => {
    // Fresh class + practice quiz with one question (the plan's MEDIUM g: the
    // chip only renders for assessment quizzes, so this starts practice).
    await registerUser(page, `lecturer-e15b-${TEST_TIMESTAMP}@innovision.test`, "lecturer", LECTURER_INVITE_CODE);
    await createClass(page, `${CLASS_TITLE} B`);
    await createQuizWithQuestions(page, {
      classTitle: `${CLASS_TITLE} B`,
      quizTitle: "E15B Practice",
      questions: [{ prompt: "What is 5 + 5?", options: ["10", "9"] }],
    });

    // Open settings via the Mode pill, switch to Assessment, set 1h 15m, save.
    await page.getByRole("button", { name: /Quiz mode: Practice/i }).click();
    await expect(page.getByRole("dialog", { name: "Edit quiz settings" })).toBeVisible();
    await page.getByRole("dialog").getByRole("combobox", { name: "Quiz mode" }).click();
    await page.getByRole("option", { name: "Assessment" }).click();
    await page.getByLabel("h", { exact: true }).fill("1");
    await page.getByLabel("min", { exact: true }).fill("15");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();

    // Chip "1h 15m" appears (assessment + time limit).
    await expect(page.getByText("1h 15m")).toBeVisible();

    // Persists across a full reload.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "E15B Practice" })).toBeVisible();
    await expect(page.getByText("1h 15m")).toBeVisible();

    // Flip back to Practice → chip gone.
    await page.getByRole("button", { name: /Quiz mode: Assessment/i }).click();
    await page.getByRole("dialog").getByRole("combobox", { name: "Quiz mode" }).click();
    await page.getByRole("option", { name: "Practice" }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByText("1h 15m")).toBeHidden();
    await expect(page.getByRole("button", { name: /Quiz mode: Practice/i })).toBeVisible();
  });
});
