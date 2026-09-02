import { test, expect } from "@playwright/test";
import { registerUser, createClass, createQuizWithQuestions } from "./helpers";

/**
 * E23 — Builder mutations: option surgery, reorder, delete, explanation.
 * All four are marks-integrity surfaces with zero prior e2e coverage:
 *  - Removing/moving OPTIONS must keep the correct-answer key honest
 *    (clamping/swap in quiz-builder-client setOption helpers) — a silent
 *    regression here misgrades every student.
 *  - Reorder drives student play order AND the Excel export Q-columns; it
 *    must persist across reloads and disable at the ends.
 *  - Delete must confirm, persist, and re-disable Publish at 0 questions.
 *  - Explanation edits round-trip through the edit dialog (incl. reload).
 */

const stamp = Date.now();
const LECTURER_EMAIL = `lecturer-e23-${stamp}@innovision.test`;
const INVITE = process.env.LECTURER_INVITE_CODE ?? "";

test.describe.configure({ mode: "serial" });

test.describe("E23 — builder mutations", () => {
  let builder: import("@playwright/test").Page;

  test.beforeAll(async ({ browser }) => {
    test.skip(!INVITE, "LECTURER_INVITE_CODE not set");
    const ctx = await browser.newContext();
    builder = await ctx.newPage();
    await registerUser(builder, LECTURER_EMAIL, "lecturer", INVITE);
    await createClass(builder, "E23 Mutations");
  });

  test("option surgery: deleting an option above the key clamps the answer", async () => {
    await createQuizWithQuestions(builder, {
      classTitle: "E23 Mutations",
      quizTitle: "E23 Option Surgery",
      questions: [],
    });
    const form = builder.locator("form").filter({
      has: builder.getByRole("textbox", { name: "Question prompt" }),
    });
    await form.getByRole("textbox", { name: "Question prompt" }).fill("Pick the second?");
    await form.getByLabel("Option 1").fill("Aa");
    await form.getByLabel("Option 2").fill("Bb");
    // Mark option 2 as the answer… (dropdown items read "Option N")
    await builder.getByLabel("Correct answer").click();
    await builder.getByRole("option", { name: "Option 2" }).click();
    // …then add a third and DELETE OPTION 1 (aria-label `${deleteBtn} ${n}`).
    await builder.getByRole("button", { name: /add option/i }).click();
    await form.getByRole("textbox", { name: "Option 3" }).fill("Cc");
    await builder.getByRole("button", { name: "Delete 1", exact: true }).click();

    // The key must have SHIFTED with the options: Bb (was #2) is now #1.
    await expect(form.getByLabel("Option 1")).toHaveValue("Bb");
    await expect(form.getByLabel("Option 2")).toHaveValue("Cc");

    await builder.getByRole("button", { name: /add this question/i }).click();
    await expect(builder.getByRole("textbox", { name: "Question prompt" })).toHaveValue("");
    const row = builder.locator("li").filter({ hasText: "Pick the second?" });
    await expect(row).toBeVisible();
    await expect(row.getByText(/Correct answer: Option 1/)).toBeVisible(); // clamped to Bb
    await expect(row.getByText(/Bb · Cc/)).toBeVisible(); // old Aa is gone
  });

  test("reorder up/down persists after reload and disables at the ends", async () => {
    await createQuizWithQuestions(builder, {
      classTitle: "E23 Mutations",
      quizTitle: "E23 Reorder",
      questions: [
        { prompt: "Q-one alpha?", options: ["a1", "a2"] },
        { prompt: "Q-two beta?", options: ["b1", "b2"] },
        { prompt: "Q-three gamma?", options: ["c1", "c2"] },
      ],
    });
    // Move Q-two up → order becomes [beta, alpha, gamma].
    const qTwo = builder.locator("li").filter({ hasText: "Q-two beta?" });
    await qTwo.getByRole("button", { name: /move up/i }).click();
    await expect(
      builder.locator("li").filter({ hasText: "Q-two beta?" }).getByText(/^1\./),
    ).toBeVisible();

    // Persistence: survive a full reload.
    await builder.reload();
    const first = builder.locator("ul > li").first();
    await expect(first).toContainText("Q-two beta?");

    // End-guards: first row cannot move up, last cannot move down.
    await expect(first.getByRole("button", { name: /move up/i })).toBeDisabled();
    await expect(
      builder.locator("ul > li").last().getByRole("button", { name: /move down/i }),
    ).toBeDisabled();
  });

  test("delete question confirms, persists, and Publish re-disables at zero", async () => {
    await createQuizWithQuestions(builder, {
      classTitle: "E23 Mutations",
      quizTitle: "E23 Delete",
      questions: [{ prompt: "Delete me?", options: ["x1", "x2"] }],
    });
    await expect(
      builder.getByRole("button", { name: /publish/i }),
    ).toBeEnabled();

    // Delete flows through the AlertDialog confirmation now — click Delete,
    // then Confirm inside the dialog.
    await builder
      .locator("li")
      .filter({ hasText: "Delete me?" })
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await builder.getByRole("alertdialog").getByRole("button", { name: "Confirm", exact: true }).click();

    await expect(builder.getByText("Delete me?", { exact: true })).toHaveCount(0);
    // Empty-state copy + zero-count chip replace the question list.
    await expect(
      builder.getByText(/add questions using the form/i),
    ).toBeVisible();
    await expect(builder.getByText(/0 questions/).first()).toBeVisible();

    // The publish gate must re-engage at zero questions.
    await expect(builder.getByRole("button", { name: /publish/i })).toBeDisabled();

    // Persisted (not just optimistic).
    await builder.reload();
    await expect(builder.getByText("Delete me?", { exact: true })).toHaveCount(0);
  });

  test("explanation edits via the dialog persist after reload", async () => {
    await createQuizWithQuestions(builder, {
      classTitle: "E23 Mutations",
      quizTitle: "E23 Explanation",
      questions: [
        { prompt: "Why does velocity change?", options: ["force", "color"], explanation: "v = d/t" },
      ],
    });
    const row = builder.locator("li").filter({ hasText: "Why does velocity change?" });
    await expect(row.getByText("v = d/t")).toBeVisible(); // seeded value rendered

    await row.getByRole("button", { name: "Edit", exact: true }).click();
    const dialog = builder.getByRole("dialog");
    const expBox = dialog.getByLabel(/explanation/i);
    await expect(expBox).toHaveValue("v = d/t"); // prefilled from the row
    await expBox.fill("Force changes velocity via F=ma");
    await dialog.getByRole("button", { name: /save changes/i }).click();
    await expect(dialog).not.toBeVisible();

    await expect(row.getByText(/F=ma/)).toBeVisible();
    await builder.reload();
    await expect(
      builder.locator("li").filter({ hasText: "Why does velocity change?" }).getByText(/F=ma/),
    ).toBeVisible();
  });

  test("double-click idempotency: one add-question POST, publish stays live", async () => {
    await createQuizWithQuestions(builder, {
      classTitle: "E23 Mutations",
      quizTitle: "E23 Double-Click",
      questions: [{ prompt: "Solo?", options: ["x1", "x2"] }],
    });

    // Add a question and rapid double-click the submit (the `saving` lock must
    // swallow the second event — exactly ONE /questions POST and ONE row).
    const form = builder.locator("form").filter({
      has: builder.getByRole("textbox", { name: "Question prompt" }),
    });
    const posts: string[] = [];
    const onReq = (req: { url(): string; method(): string }) => {
      if (req.method() === "POST" && /\/api\/quizzes\/[^/]+\/questions$/.test(req.url())) {
        posts.push(req.url());
      }
    };
    builder.on("request", onReq);
    await form.getByRole("textbox", { name: "Question prompt" }).fill("Second?");
    await form.getByLabel("Option 1").fill("y1");
    await form.getByLabel("Option 2").fill("y2");
    const addBtn = form.getByRole("button", { name: /add this question/i });
    // force: a successful submit resets the form and DISABLES the button, so a
    // naive second click would just wait forever. Force-dispatch both clicks to
    // simulate a genuine rapid double-click landing in the same tick.
    await addBtn.click();
    await addBtn.click({ force: true });
    await expect(builder.getByText("Second?", { exact: true })).toBeVisible();
    builder.off("request", onReq);
    expect(posts.length).toBe(1);
    await expect(builder.getByText("Second?", { exact: true })).toHaveCount(1);

    // Publish: double-click stays live with a single chip (no error alert).
    const publishBtn = builder.getByRole("button", { name: /publish/i });
    await publishBtn.click();
    await publishBtn.click({ force: true });
    await expect(builder.getByText("Live", { exact: true })).toBeVisible();
    await expect(builder.getByText("Live", { exact: true })).toHaveCount(1);
    await expect(builder.getByRole("button", { name: /publish/i })).toHaveCount(0);
    await expect(
      builder.getByRole("alert").filter({ hasText: /could not/i }),
    ).toHaveCount(0);
  });
});
