import { test, expect } from "@playwright/test";
import { registerUser } from "./helpers";

/**
 * E21 — Profile photo (avatar) end-to-end (plan F3, badge redesign).
 * The camera BADGE sits on the profile avatar INSIDE the account menu and
 * opens the file picker DIRECTLY (upload/replace in one click); removal
 * lives in the menu's photo card; removal restores initials. Self-only
 * surface. Also pins the READ-ONLY matric display (self-edit removed by
 * policy).
 */

const stamp = Date.now();
const USER = `avatar-${stamp}@e2e.test`;

test("badge uploads avatar → menu shows it; remove → initials return; matric is read-only", async ({
  page,
}) => {
  await registerUser(page, USER, "student", "");

  // Open the account menu — the badge overlays the profile avatar in the
  // modal header (aria-label = media.upload).
  const trigger = page.getByRole("button", { name: /your innovision account/i });
  await trigger.click();

  const badge = page
    .getByRole("dialog")
    .getByRole("button", { name: /upload photo/i });
  await expect(badge).toBeVisible();

  // One click → file picker → instant upload.
  const chooserPromise = page.waitForEvent("filechooser");
  await badge.click();
  const chooser = await chooserPromise;
  await chooser.setFiles("e2e/fixtures/tiny.png");

  // The trigger button behind the modal renders an <img> once the signed
  // URL loads; the menu's photo card appears with ONLY a remove control
  // (no upload button, no empty-state hint).
  await expect(trigger.locator("img")).toBeVisible({ timeout: 15_000 });

  // Menu (already open) shows the photo block with ONLY a remove control
  // (no upload button, no empty-state hint).
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
