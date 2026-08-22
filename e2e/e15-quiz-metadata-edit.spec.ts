import { test, expect } from "@playwright/test";
import { registerUser, createClass } from "./helpers";

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
    await page.getByLabel("Time limit (minutes)").fill("30");
    await page.getByRole("button", { name: /create quiz|new quiz/i }).click();

    await expect(page.getByText(INITIAL_QUIZ_TITLE, { exact: true })).toBeVisible();
    await page.getByText(INITIAL_QUIZ_TITLE, { exact: true }).click();
    await expect(page).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);

    // 3. E15-1: Inline title edit fast path
    // Click pencil icon next to title
    await page.getByLabel(`Rename quiz: ${INITIAL_QUIZ_TITLE}`).click();
    const titleInput = page.getByLabel("Quiz title");
    await expect(titleInput).toBeVisible();
    await expect(titleInput).toBeFocused();

    // Cancel with Escape
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { level: 1, name: INITIAL_QUIZ_TITLE })).toBeVisible();

    // Re-enter inline edit and save with Enter
    await page.getByLabel(`Rename quiz: ${INITIAL_QUIZ_TITLE}`).click();
    await page.getByLabel("Quiz title").fill("Renamed Inline Title");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Renamed Inline Title" })).toBeVisible();

    // 4. E15-2 & E15-3: Open EditQuizDialog via Settings button and change time limit
    await page.getByLabel("Edit quiz settings").click();
    await expect(page.getByRole("dialog", { name: "Quiz settings" })).toBeVisible();
    await expect(page.getByLabel("Quiz Title")).toHaveValue("Renamed Inline Title");

    // Change title and update time limit to 1h 15m
    await page.getByLabel("Quiz Title").fill("Final Comprehensive Exam");
    await page.getByLabel("Hours", { exact: true }).fill("1");
    await page.getByLabel("Minutes", { exact: true }).fill("15");

    const patchPromise = page.waitForResponse(
      (res) => res.url().includes("/api/quizzes/") && res.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "Save settings" }).click();
    const patchRes = await patchPromise;
    expect(patchRes.status()).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.quiz.title).toBe("Final Comprehensive Exam");
    expect(patchBody.quiz.time_limit_sec).toBe(4500);

    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByRole("heading", { level: 1, name: "Final Comprehensive Exam" })).toBeVisible();
    await expect(page.getByText("1h 15m limit")).toBeVisible();

    // 5. E15-4 & E15-5: Open dialog via Mode pill, toggle to Practice, and save
    await page.getByLabel(/Quiz mode: Assessment/i).click();
    await expect(page.getByRole("dialog", { name: "Quiz settings" })).toBeVisible();

    // Select practice mode
    await page.getByLabel("Quiz Mode").click();
    await page.getByRole("option", { name: "Practice" }).click();
    await expect(page.getByText("Practice quizzes are untimed.")).toBeVisible();
    await expect(page.getByLabel("Hours", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("Minutes", { exact: true })).toBeDisabled();

    const patchPromisePractice = page.waitForResponse(
      (res) => res.url().includes("/api/quizzes/") && res.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "Save settings" }).click();
    const practiceRes = await patchPromisePractice;
    expect(practiceRes.status()).toBe(200);
    const practiceBody = await practiceRes.json();
    expect(practiceBody.quiz.mode).toBe("practice");
    expect(practiceBody.quiz.time_limit_sec).toBeNull();

    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByText("1h 15m limit")).toBeHidden();
    await expect(page.getByLabel(/Quiz mode: Practice/i)).toBeVisible();

    // 6. E15-6: Reopen dialog, switch back to Assessment, set Hours = 2 (max cap)
    await page.getByLabel(/Quiz mode: Practice/i).click();
    await page.getByLabel("Quiz Mode").click();
    await page.getByRole("option", { name: "Assessment" }).click();

    await page.getByLabel("Hours", { exact: true }).fill("2");
    await expect(page.getByLabel("Minutes", { exact: true })).toBeDisabled();
    await expect(
      page.getByText("Maximum time limit reached (2 hours). Minutes are set to 0."),
    ).toBeVisible();

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();

    // 7. E15-7: Mutual exclusion between inline edit and settings modal
    await page.getByLabel(/Rename quiz/i).click();
    await expect(page.getByLabel("Quiz title")).toBeVisible();
    // Clicking settings cancels inline title edit and opens modal
    await page.getByLabel("Edit quiz settings").click();
    await expect(page.getByRole("dialog", { name: "Quiz settings" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByLabel("Quiz title")).toBeHidden();

    // 8. E15-8 & E15-9: Add a question, publish quiz, and verify edit locks
    await page.getByRole("textbox", { name: "Question" }).fill("What is 10 x 10?");
    await page.getByLabel("Option 1").fill("100");
    await page.getByLabel("Option 2").fill("20");
    await page.getByRole("button", { name: /add question/i }).click();
    await expect(page.getByText("What is 10 x 10?")).toBeVisible();

    await page.getByRole("button", { name: /publish quiz/i }).click();
    await expect(page.getByRole("dialog", { name: /publish/i })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Publish" }).click();

    // Once live, settings button and pencil icons are unmounted
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
    await expect(page.getByLabel(/Rename quiz/i)).toBeHidden();
    await expect(page.getByLabel("Edit quiz settings")).toBeHidden();

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
});
