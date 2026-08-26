import { test, expect } from "@playwright/test";
import { registerUser } from "./helpers";

/**
 * E21 — Profile photo (avatar) end-to-end (plan F3, badge redesign).
 * The camera BADGE sits on the profile avatar INSIDE the account menu and
 * opens the file picker DIRECTLY (upload/replace in one click); removal
 * lives in the menu's photo card; removal restores initials. Self-only
 * surface. Also pins the READ-ONLY matric display (self-edit removed by
 * policy).
 *
 * A11y note (account-menu polish): while the modal menu is open, the shell
 * behind it (including the account trigger button) is marked aria-hidden,
 * so the trigger leaves the ROLE-based query tree — the in-menu <img> must
 * be asserted via getByRole("dialog"), and the trigger's own avatar only
 * after the menu is dismissed.
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

  // One click → file picker → instant upload. Sync on the POST response so a
  // rejected upload fails HERE with its status instead of masquerading as a
  // missing <img> below (dev servers compile this route on first hit, which
  // alone can eat a chunk of the assertion windows under full-suite load).
  const chooserPromise = page.waitForEvent("filechooser");
  await badge.click();
  const chooser = await chooserPromise;
  await chooser.setFiles("e2e/fixtures/tiny.png");
  const uploadRes = await page.waitForResponse(
    (res) =>
      res.url().includes("/api/profile/avatar") &&
      res.request().method() === "POST",
  );
  expect(uploadRes.status()).toBe(200);

  // Menu (still open) shows the uploaded photo: the header profile badge
  // swaps its placeholder icon for the signed-URL image once it loads
  // (30s window — the GET + image load trail the POST, and dev-server
  // route compilation can be slow when the whole suite runs at once).
  await expect(page.getByRole("dialog").locator("img")).toBeVisible({
    timeout: 30_000,
  });

  // The menu's photo card carries ONLY a remove control (no upload button,
  // no empty-state hint).
  await expect(page.getByText(/profile photo/i)).toBeVisible();
  await expect(page.getByText(/shown only to you/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /^remove$/i })).toBeVisible();

  // Matric block is READ-ONLY: rendered for students ("Matric No." since
  // the i18n pass) with NO edit control anywhere in the menu.
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/matric no\b/i)).toBeVisible();
  expect(await dialog.getByRole("button", { name: /^edit$/i }).count()).toBe(0);

  // Dismiss the menu — the shell re-enters the accessibility tree and the
  // account trigger now renders the avatar image.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 5_000 });
  await expect(trigger.locator("img")).toBeVisible({ timeout: 15_000 });

  // Reopen the menu and remove the photo.
  await trigger.click();
  await page.getByRole("button", { name: /^remove$/i }).click();

  // Dismiss again — initials return (the trigger's <img> unmounts).
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 5_000 });
  await expect(trigger.locator("img")).toHaveCount(0, { timeout: 15_000 });
});

test("oversized photo and non-image upload surface inline alerts", async ({
  page,
}) => {
  await registerUser(page, `avatar-err-${stamp}@e2e.test`, "student", "");

  const trigger = page.getByRole("button", { name: /your innovision account/i });
  await trigger.click();
  const badge = page
    .getByRole("dialog")
    .getByRole("button", { name: /upload photo/i });
  await expect(badge).toBeVisible();

  // >2MB PNG → client-side size gate fires BEFORE any network (app-user-menu.tsx:138-141).
  let chooserPromise = page.waitForEvent("filechooser");
  await badge.click();
  let chooser = await chooserPromise;
  await chooser.setFiles("e2e/fixtures/big-avatar.png");
  await expect(
    page.getByRole("alert").filter({ hasText: "Photo exceeds the 2 MB limit." }),
  ).toBeVisible({ timeout: 15_000 });

  // Bad type .txt → NO client-side MIME gate exists; the POST round-trips and
  // surfaces the server's raw rejection message. (TODO: add a client MIME
  // check so the localized media.uploadFailed copy is used instead of the
  // English server message.)
  chooserPromise = page.waitForEvent("filechooser");
  await badge.click();
  chooser = await chooserPromise;
  await chooser.setFiles("e2e/fixtures/not-image.txt");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "The file is not a recognized image (PNG, JPEG, or WebP)." }),
  ).toBeVisible({ timeout: 15_000 });
});
