import { test, expect } from "@playwright/test";
import { registerUser, createClass, createQuizWithQuestions } from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

/**
 * E2F-FLAGS — the flag-off escape hatch (grounded-search.md §9C).
 *
 * Runs ONLY on the `chromium-nowebsearch` project, whose server instance
 * sets TINYFISH_API_KEY="" explicitly (grounded-search.md escape hatch 1):
 * the "Web topic" source mode is hidden, and the classic file/paste flow is
 * byte-identical to a deployment without the feature.
 */

test.describe("E2F flags — web search disabled", () => {
  test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");
  test.setTimeout(120_000);

  test("no Web-topic option; paste flow reaches the payoff untouched", async ({
    page,
  }) => {
    await registerUser(
      page,
      `lecturer-e2f-flags-${TEST_TIMESTAMP}@innovision.test`,
      "lecturer",
      LECTURER_INVITE_CODE,
    );
    await createClass(page, "E2F Flags");
    await createQuizWithQuestions(page, {
      classTitle: "E2F Flags",
      quizTitle: "E2F Flags Draft",
      questions: [{ prompt: "Seeded draft question?", options: ["x1", "x2"] }],
    });

    await page.getByRole("button", { name: /generate from file/i }).click();
    const dialog = page.getByRole("dialog");

    // The whole chooser is absent (not just unchecked).
    await expect(dialog.getByTestId("source-mode-web")).toHaveCount(0);
    await expect(dialog.getByTestId("source-mode-material")).toHaveCount(0);

    // The classic paste flow still works end-to-end.
    await dialog.getByLabel(/paste your material/i).fill(
      "Velocity is displacement over time. Light travels faster than sound. " +
        "Force is measured in newtons.",
    );
    await dialog.getByRole("button", { name: /use pasted text/i }).click();
    await dialog.getByRole("button", { name: /generate quiz/i }).click();
    await expect(
      dialog.getByText(/questions forged|soalan dihasilkan/i),
    ).toBeVisible({ timeout: 30_000 });
  });
});
