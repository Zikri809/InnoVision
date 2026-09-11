import { test, expect } from "@playwright/test";
import { fastRegisterUser, createClass } from "./helpers";

/**
 * m4 — mobile authoring workflows.
 * Runs ONLY in the `mobile` project (iPhone X descriptor, 375×812).
 *
 * Covers:
 *  1. Lecturer Quiz Builder Mobile Workflow:
 *     - Hero action strip state swap (0 questions vs >=1 questions).
 *     - Bottom sheet question creation (<md, stays open across submissions for batch authoring until "Done").
 *     - Mobile question accordion: single-open expansion, option rows with emerald correct key highlighting.
 *     - Reviewed checklist filter toolbar: `builder-reviewed-${quizId}` in localStorage, All/To-review tabs,
 *       progress indicator (`X/Y checked`), celebration empty state ("All checked!"), and reload persistence.
 *     - Pinned footer publish bar: publishes draft quiz to Live.
 *  2. Student Practice-Quiz Editor Mobile Workflow:
 *     - Hero chips: Practice mode chip, Add description chip, question count badge.
 *     - Action strip state swap: Generate with AI primary on empty; Add question primary once populated.
 *     - Settings drawer: opened via description chip, updates title/description via pinned footer button.
 *     - Bottom sheet batch composer: stays open across questions until "Done", option clay chip selection.
 *     - Student checklist persistence: `student-editor-reviewed-${quizId}` in localStorage, All/To-review filters,
 *       progress indicator (`X/Y reviewed`), celebration empty state ("Everything reviewed!").
 */

const UNIQUE = `m4-${Date.now()}`;
const LECTURER_EMAIL = `${UNIQUE}-lec@innovision.test`;
const STUDENT_EMAIL = `${UNIQUE}-stu@innovision.test`;
const INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

test.describe("M4 — Mobile Quiz Authoring Workflows", () => {
  test("lecturer builder: bottom-sheet batch creation, accordion expansion with green key, reviewed checklist filter, and publish footer", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile-only");
    test.skip(!INVITE_CODE, "LECTURER_INVITE_CODE not set");
    test.setTimeout(120_000);

    // 1. Setup Lecturer & Class
    await fastRegisterUser(page, LECTURER_EMAIL, "lecturer", INVITE_CODE);
    await createClass(page, `LecClass ${UNIQUE}`);

    // Navigate to class and create quiz via mobile drawer
    await page.getByText(`LecClass ${UNIQUE}`, { exact: true }).click();
    await expect(page).toHaveURL(/\/lecturer\/classes\/[^/]+$/);

    // Click "+" in Quizzes tab bar to open create quiz drawer
    await page.getByRole("button", { name: /create quiz/i }).first().click();
    const createDrawer = page.getByRole("dialog");
    await expect(createDrawer).toBeVisible();
    await createDrawer.getByRole("textbox", { name: "Quiz title" }).fill(`LecQuiz ${UNIQUE}`);
    await createDrawer.getByRole("button", { name: /create quiz/i }).click();

    // Click created quiz link to open builder
    const quizLink = page.getByText(`LecQuiz ${UNIQUE}`, { exact: true });
    await expect(quizLink).toBeVisible();
    await quizLink.click();
    await expect(page).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);
    await expect(page.getByRole("heading", { name: `LecQuiz ${UNIQUE}` })).toBeVisible();

    // 2. Initial state: 0 questions
    // Mobile action strip: "Generate from file" is primary, "Add question" is in ⋯ menu
    await expect(page.getByRole("button", { name: /generate from file/i })).toBeVisible();
    await page.getByRole("button", { name: /more actions/i }).first().click();
    await page.getByRole("menuitem", { name: /add question/i }).click();

    // 3. Bottom Sheet Question Creation (Continuous Batch Authoring)
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "Add question" })).toBeVisible();

    // Question 1: MCQ
    const promptBox = sheet.getByRole("textbox", { name: /prompt/i });
    await promptBox.fill("What is the speed of light?");
    await sheet.getByLabel("Option 1", { exact: true }).fill("300,000 km/s");
    await sheet.getByLabel("Option 2", { exact: true }).fill("150,000 km/s");
    await sheet.getByRole("button", { name: /add option/i }).click();
    await sheet.getByRole("textbox", { name: "Option 3" }).fill("1,000 km/s");
    // Explanation
    await sheet.getByRole("textbox", { name: /explanation/i }).fill("Light travels at 300,000 km/s.");
    // Submit Q1
    await sheet.getByRole("button", { name: /add this question/i }).click();
    await expect(promptBox).toHaveValue("");

    // Verify sheet STAYS OPEN for batch authoring
    await expect(sheet).toBeVisible();

    // Question 2: True/False
    await sheet.getByLabel("Question type").click();
    await page.getByRole("option", { name: "True / False" }).click();
    await promptBox.fill("The Earth orbits the Sun.");
    // Submit Q2
    await sheet.getByRole("button", { name: /add this question/i }).click();
    await expect(promptBox).toHaveValue("");

    // Close the sheet via "Done" button
    await sheet.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Verify both questions appear in the list
    await expect(page.getByText("What is the speed of light?")).toBeVisible();
    await expect(page.getByText("The Earth orbits the Sun.")).toBeVisible();

    // 4. Action Strip State Swap: Now that questions > 0, "Add question" is primary
    await expect(page.getByRole("button", { name: "Add question", exact: true })).toBeVisible();

    // 5. Mobile Question Accordion & Option Rows with Green Key Highlight
    const q1AccordionBtn = page.getByRole("button", { name: /what is the speed of light\?/i });
    await expect(q1AccordionBtn).toHaveAttribute("aria-expanded", "false");
    await q1AccordionBtn.click();
    await expect(q1AccordionBtn).toHaveAttribute("aria-expanded", "true");

    // Expansion content: MCQ type label, green highlight on Option A (300,000 km/s), explanation
    const q1Item = page.locator("li").filter({ hasText: "What is the speed of light?" });
    await expect(q1Item.getByText(/Multiple Choice/i)).toBeVisible();
    await expect(q1Item.getByText("Light travels at 300,000 km/s.")).toBeVisible();

    const correctOptionRow = q1Item.locator("ul li").filter({ hasText: "300,000 km/s" });
    await expect(correctOptionRow).toHaveClass(/border-emerald-500\/70/);

    // Single-open accordion: expanding Q2 collapses Q1
    const q2AccordionBtn = page.getByRole("button", { name: /the earth orbits the sun\./i });
    await q2AccordionBtn.click();
    await expect(q2AccordionBtn).toHaveAttribute("aria-expanded", "true");
    await expect(q1AccordionBtn).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("True / False")).toBeVisible();

    // 6. Reviewed Checklist Filter Toolbar & LocalStorage Persistence
    const filterToolbar = page.getByRole("group", { name: /review filter/i });
    await expect(filterToolbar).toBeVisible();
    const allBtn = filterToolbar.getByRole("button", { name: /^all/i });
    const toReviewBtn = filterToolbar.getByRole("button", { name: /^to review/i });
    await expect(allBtn).toHaveAttribute("aria-pressed", "true");
    await expect(toReviewBtn).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByText("0/2 checked").first()).toBeVisible();

    // Mark Q1 reviewed
    const q1ReviewBtn = page.getByRole("button", { name: /mark checked — 1/i });
    await q1ReviewBtn.click();
    await expect(page.getByRole("button", { name: /checked — 1/i })).toBeVisible();
    await expect(page.getByText("1/2 checked").first()).toBeVisible();

    // Switch to "To review" filter
    await toReviewBtn.click();
    await expect(toReviewBtn).toHaveAttribute("aria-pressed", "true");
    // Q1 is hidden; only Q2 is visible
    await expect(page.getByText("What is the speed of light?")).toHaveCount(0);
    await expect(page.getByText("The Earth orbits the Sun.")).toBeVisible();

    // Mark Q2 reviewed while in "To review" filter
    const q2ReviewBtn = page.getByRole("button", { name: /mark checked — 2/i });
    await q2ReviewBtn.click();

    // All reviewed empty state appears
    await expect(page.getByText("All checked!")).toBeVisible();
    await expect(page.getByText("Every question has been reviewed. Ready to publish when you are.")).toBeVisible();

    // Switch back to "All"
    await allBtn.click();
    await expect(page.getByText("What is the speed of light?")).toBeVisible();
    await expect(page.getByText("The Earth orbits the Sun.")).toBeVisible();

    // Reload persistence test
    await page.reload();
    await expect(page.getByText("2/2 checked").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /checked — 1/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /checked — 2/i })).toBeVisible();

    // 7. Fixed Footer Publish Bar
    const publishBtn = page.getByRole("button", { name: "Publish quiz", exact: true });
    await expect(publishBtn).toBeVisible();
    await publishBtn.click();
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
  });

  test("student editor: hero band chips, action strip state swap, and settings drawer update", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile-only");
    test.skip(!INVITE_CODE, "LECTURER_INVITE_CODE not set");
    test.setTimeout(120_000);

    await fastRegisterUser(page, STUDENT_EMAIL, "student", INVITE_CODE);
    await page.goto("/student/my-quizzes");
    await page.getByRole("link", { name: /create quiz/i }).click();
    await page.getByLabel("Title").fill(`StudentQuiz ${UNIQUE}`);
    await page.getByRole("button", { name: /create quiz/i }).click();
    await page.waitForURL(/\/student\/my-quizzes\/[^/]+\/edit/);

    // 1. Verify Hero Chips
    await expect(page.getByText("Practice", { exact: true })).toBeVisible();
    const addDescChip = page.getByRole("button", { name: /add description/i });
    await expect(addDescChip).toBeVisible();
    await expect(page.locator("span").filter({ hasText: /^0 questions$/ })).toBeVisible();

    // 2. Verify Action Strip (Empty Quiz)
    await expect(page.getByRole("button", { name: /generate with ai/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /preview/i })).toBeVisible();
    await page.getByRole("button", { name: /more actions/i }).first().click();
    await expect(page.getByRole("menuitem", { name: /add question/i })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /quiz details/i })).toBeVisible();
    await page.keyboard.press("Escape");

    // 3. Open Settings Drawer via "Add description" chip
    await addDescChip.click();
    const settingsDrawer = page.getByRole("dialog");
    await expect(settingsDrawer).toBeVisible();
    await expect(settingsDrawer.getByRole("heading", { name: /quiz details/i })).toBeVisible();

    // Update title and description
    const titleInput = settingsDrawer.getByLabel("Title");
    await titleInput.fill(`StudentQuiz ${UNIQUE} Renamed`);
    const descInput = settingsDrawer.getByLabel(/description/i);
    await descInput.fill("Comprehensive practice for midterm.");

    // Submit via pinned footer button
    await settingsDrawer.getByRole("button", { name: /save details/i }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Verify Hero reflects changes
    await expect(page.getByRole("heading", { name: `StudentQuiz ${UNIQUE} Renamed` })).toBeVisible();
    await expect(page.getByText("Comprehensive practice for midterm.")).toBeVisible();
  });

  test("student editor: bottom-sheet batch creation, accordion green key highlight, and reviewed checklist filter", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile-only");
    test.skip(!INVITE_CODE, "LECTURER_INVITE_CODE not set");
    test.setTimeout(120_000);

    const email = `${UNIQUE}-stu2@innovision.test`;
    await fastRegisterUser(page, email, "student", INVITE_CODE);
    await page.goto("/student/my-quizzes");
    await page.getByRole("link", { name: /create quiz/i }).click();
    await page.getByLabel("Title").fill(`EditorBatch ${UNIQUE}`);
    await page.getByRole("button", { name: /create quiz/i }).click();
    await page.waitForURL(/\/student\/my-quizzes\/[^/]+\/edit/);

    // Open Add Question Sheet from ⋯ menu
    await page.getByRole("button", { name: /more actions/i }).first().click();
    await page.getByRole("menuitem", { name: /add question/i }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    // Question 1: MCQ (select Option 2 as correct using clay chip)
    const promptBox = sheet.getByRole("textbox", { name: /prompt/i });
    await promptBox.fill("What is the capital of Japan?");
    await sheet.getByLabel("Option 1", { exact: true }).fill("Kyoto");
    await sheet.getByLabel("Option 2", { exact: true }).fill("Tokyo");
    // Select Option 2 as correct using clay button chip
    await sheet.getByRole("button", { name: "Correct answer: Option 2" }).click();
    await sheet.getByRole("textbox", { name: /explanation/i }).fill("Tokyo became the capital in 1868.");

    await sheet.getByRole("button", { name: /add this question/i }).click();
    await expect(promptBox).toHaveValue("");

    // Sheet STAYS OPEN for Question 2
    await expect(sheet).toBeVisible();

    // Question 2: True / False
    await sheet.getByLabel("Question type").click();
    await page.getByRole("option", { name: "True / False" }).click();
    await promptBox.fill("Mount Fuji is an active volcano.");
    await sheet.getByRole("button", { name: /add this question/i }).click();
    await expect(promptBox).toHaveValue("");

    // Dismiss with "Done"
    await sheet.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Action strip has swapped: "Add question" is now primary
    await expect(page.getByRole("button", { name: "Add question", exact: true })).toBeVisible();
    await expect(page.locator("span").filter({ hasText: /^2 questions$/ })).toBeVisible();

    // Accordion Expansion & Green Key
    const q1Btn = page.getByRole("button", { name: /what is the capital of japan\?/i });
    await q1Btn.click();
    await expect(q1Btn).toHaveAttribute("aria-expanded", "true");
    const q1Item = page.locator("li").filter({ hasText: "What is the capital of Japan?" });
    await expect(q1Item.getByText(/Multiple Choice/i)).toBeVisible();
    // Option B (Tokyo) has green key highlight
    const tokyoRow = q1Item.locator("ul li").filter({ hasText: "Tokyo" });
    await expect(tokyoRow).toHaveClass(/border-emerald-500\/70/);

    // Reviewed checklist & filter toolbar
    const filterToolbar = page.getByRole("group", { name: /review filter/i });
    await expect(filterToolbar).toBeVisible();
    await expect(page.getByText("0/2 reviewed")).toBeVisible();

    // Mark Q1 reviewed
    await page.getByRole("button", { name: /mark reviewed — 1/i }).click();
    await expect(page.getByRole("button", { name: /mark unreviewed — 1/i })).toBeVisible();
    await expect(page.getByText("1/2 reviewed")).toBeVisible();

    // Filter "To review"
    const toReviewBtn = filterToolbar.getByRole("button", { name: /to review 1/i });
    await toReviewBtn.click();
    await expect(page.getByText("What is the capital of Japan?")).toHaveCount(0);
    await expect(page.getByText("Mount Fuji is an active volcano.")).toBeVisible();

    // Mark Q2 reviewed -> "Everything reviewed!" empty state
    await page.getByRole("button", { name: /mark reviewed — 2/i }).click();
    await expect(page.getByText("Everything reviewed!")).toBeVisible();
    await expect(page.getByText("Every question has been checked off. You're ready to play.")).toBeVisible();

    // Reload persistence
    await page.reload();
    await expect(page.getByText("2/2 reviewed")).toBeVisible();
    await expect(page.getByRole("button", { name: /mark unreviewed — 1/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /mark unreviewed — 2/i })).toBeVisible();
  });
});
