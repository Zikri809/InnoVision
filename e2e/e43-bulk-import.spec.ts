import { test, expect } from "@playwright/test";
import { registerUser, createClass, createQuizWithQuestions } from "./helpers";

/**
 * E43 — AP-1 bulk import (PLAN_R_AUTHORING_PRODUCTIVITY): paste-and-commit
 * journey plus the atomic-reject UX contract.
 *  - A mixed paste (trailing-letter mcq, asterisk-marked mcq, true/false)
 *    previews 3 rows and commits in ONE batch through the import route.
 *  - One invalid row rejects the WHOLE batch (preview problems visible,
 *    commit disabled) until fixed — nothing may half-commit.
 *  - Imported questions land on the builder (survives a reload → server
 *    truth via router.refresh).
 */

const stamp = Date.now();
const LECTURER_EMAIL = `lecturer-e43-${stamp}@innovision.test`;
const INVITE = process.env.LECTURER_INVITE_CODE ?? "";

test.describe.configure({ mode: "serial" });

test.describe("E43 — bulk import", () => {
  let builder: import("@playwright/test").Page;

  test.beforeAll(async ({ browser }) => {
    test.skip(!INVITE, "LECTURER_INVITE_CODE not set");
    const ctx = await browser.newContext();
    builder = await ctx.newPage();
    await registerUser(builder, LECTURER_EMAIL, "lecturer", INVITE);
    await createClass(builder, "E43 Import");
  });

  test("paste mixed rows → preview → commit appends all questions at once", async () => {
    await createQuizWithQuestions(builder, {
      classTitle: "E43 Import",
      quizTitle: "E43 Import Target",
      questions: [],
    });

    await builder.getByRole("button", { name: "Import questions", exact: true }).click();
    const dialog = builder.getByRole("dialog");
    await expect(dialog.getByText(/30 slots remaining/i)).toBeVisible();

    await dialog.getByLabel("Question list").fill(
      [
        "What is 2+2? | 1 | 2 | 3 | 4 | *C",
        "Capital of France? | London | *B) Paris",
        "The Earth orbits the Sun | true",
      ].join("\n"),
    );

    // Preview rows: prompt + type + answer chips. Exact matchers — the
    // textarea's pasted content also contains these strings.
    await expect(dialog.getByText("Preview (3 questions)")).toBeVisible();
    await expect(dialog.getByText("What is 2+2?", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Paris", { exact: true })).toBeVisible();

    await dialog.getByRole("button", { name: "Import 3 questions" }).click();
    // Toasts render in the sonner portal (outside the dialog).
    await expect(builder.getByText("3 questions imported")).toBeVisible();
    await expect(dialog).toBeHidden(); // toast → refresh → close → reset

    // Builder reflects the imported questions (router.refresh server truth).
    await expect(builder.getByText("What is 2+2?", { exact: true })).toBeVisible();
    await expect(builder.getByText("Capital of France?", { exact: true })).toBeVisible();
    await expect(builder.getByText("The Earth orbits the Sun", { exact: true })).toBeVisible();
  });

  test("one invalid row rejects the whole batch atomically until fixed", async () => {
    // The serial page sits on the previous builder — the create helper's
    // class navigation needs the classes list, not a builder page.
    await builder.goto("/lecturer/classes");
    await createQuizWithQuestions(builder, {
      classTitle: "E43 Import",
      quizTitle: "E43 Atomic Reject",
      questions: [],
    });

    await builder.getByRole("button", { name: "Import questions", exact: true }).click();
    const dialog = builder.getByRole("dialog");

    await dialog.getByLabel("Question list").fill(
      [
        "Good row | a | b | *A",
        "Broken row | a | b",
      ].join("\n"),
    );

    // The per-row problem names the ORIGINAL line number; commit is disabled.
    await expect(dialog.getByText("Line 2: no correct answer marked — add *A or *true.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Import \d+ question/ })).toBeDisabled();

    // Fix the row inline → problems clear, commit re-enables.
    await dialog.getByLabel("Question list").fill(
      [
        "Good row | a | b | *A",
        "Broken row | a | b | *B",
      ].join("\n"),
    );
    await expect(dialog.getByText(/Line 2:/)).toBeHidden();
    await dialog.getByRole("button", { name: "Import 2 questions" }).click();
    await expect(builder.getByText("2 questions imported")).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(builder.getByText("Good row", { exact: true })).toBeVisible();
    await expect(builder.getByText("Broken row", { exact: true })).toBeVisible();
  });

  test("imported questions persist across a reload (server truth)", async () => {
    // The serial page is on the Atomic Reject builder; verify the FIRST
    // quiz's import on its own builder after a full reload. The classes
    // list renders class cards only — navigate class-first, then quiz.
    await builder.goto("/lecturer/classes");
    await builder.getByText("E43 Import", { exact: true }).click();
    await expect(builder.getByRole("heading", { name: "E43 Import" })).toBeVisible();
    await builder.getByText("E43 Import Target", { exact: true }).click();
    await expect(builder).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);
    await expect(builder.getByRole("heading", { name: "E43 Import Target" })).toBeVisible();
    await expect(builder.getByText("What is 2+2?", { exact: true })).toBeVisible();
    await expect(builder.getByText("Capital of France?", { exact: true })).toBeVisible();
    await expect(builder.getByText("The Earth orbits the Sun", { exact: true })).toBeVisible();
  });

  test("file upload loads the same parser path and commits", async () => {
    await builder.goto("/lecturer/classes");
    await createQuizWithQuestions(builder, {
      classTitle: "E43 Import",
      quizTitle: "E43 File Upload",
      questions: [],
    });

    await builder.getByRole("button", { name: "Import questions", exact: true }).click();
    const dialog = builder.getByRole("dialog");

    // In-memory file (no fixture needed): the hidden input's read path.
    await dialog.getByTestId("bulk-import-file-input").setInputFiles({
      name: "import.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("File Q? | one | two | *B\nFile TF? | benar"),
    });

    await expect(dialog.getByText("Preview (2 questions)")).toBeVisible();
    await dialog.getByRole("button", { name: "Import 2 questions" }).click();
    await expect(dialog).toBeHidden();
    await expect(builder.getByText("File Q?", { exact: true })).toBeVisible();
    await expect(builder.getByText("File TF?", { exact: true })).toBeVisible();
  });
});
