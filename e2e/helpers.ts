import { type Page } from "@playwright/test";

export const E2E_PASSWORD = "testpass123";

/**
 * Register a user via the UI (role radio + consent checkbox + lecturer invite
 * code when applicable), then wait for the role-based landing page.
 */
export async function registerUser(
  page: Page,
  email: string,
  role: "lecturer" | "student",
  inviteCode: string,
) {
  await page.goto("/register");
  await page.getByLabel("Full name (optional)").fill(`${role}-${email.split("@")[0]}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);

  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
  await page.getByRole("radio", { name: roleLabel }).check();

  if (role === "lecturer") {
    await page.getByLabel("Lecturer invite code").fill(inviteCode);
  }

  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /register/i }).click();

  // Wait for the role-based landing page (also settles the hydration race).
  await page.waitForURL(
    role === "lecturer" ? /\/lecturer\/classes/ : /\/student\/classes/,
    { timeout: 15_000 },
  );
}
