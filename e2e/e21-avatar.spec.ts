import { test, expect } from "@playwright/test";
import { registerUser } from "./helpers";

/**
 * E21 — Profile photo (avatar) end-to-end (plan F3, badge redesign).
 * The camera BADGE on the topbar avatar opens the file picker DIRECTLY
 * (upload/replace in one click); removal lives inside the account menu;
 * removal restores initials. Self-only surface. Also pins the READ-ONLY
 * matric display (self-edit removed by policy).
 */

const stamp = Date.now();
const USER = `avatar-${stamp}@e2e.test`;

test("badge uploads avatar → menu shows it; remove → initials return; matric is read-only", async ({
  page,
}) => {
  await registerUser(page, USER, "student", "");

  // The badge sits on the topbar avatar (aria-label = media.upload).
  const badge = page.getByRole("button", { name: /upload photo/i });
  await expect(badge).toBeVisible();

  // One click → file picker → instant upload.
  const chooserPromise = page.waitForEvent("filechooser");
  await badge.click();
  const chooser = await chooserPromise;
  await chooser.setFiles("e2e/fixtures/tiny.png");

  // The trigger button itself renders an <img> once the signed URL loads.
  const trigger = page.getByRole("button", { name: /your innovision account/i });
  await expect(trigger.locator("img")).toBeVisible({ timeout: 15_000 });

  // Menu shows the photo block with ONLY a remove control (no upload button,
  // no empty-state hint).
  await trigger.click();
  await expect(page.getByText(/profile photo/i)).toBeVisible();
  await expect(page.getByText(/shown only to you/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /^remove$/i })).toBeVisible();

  // Matric block is READ-ONLY: no edit pencil anywhere in the menu.
  if (await page.getByText(/matric number/i).isVisible().catch(() => false)) {
    expect(await page.getByRole("button", { name: /^edit$/i }).count()).toBe(0);
  }

  // Remove → initials return.
  await page.getByRole("button", { name: /^remove$/i }).click();
  await page.keyboard.press("Escape");
  await expect(trigger.locator("img")).toHaveCount(0, { timeout: 15_000 });
});
