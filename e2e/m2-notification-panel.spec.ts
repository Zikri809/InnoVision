import { test, expect } from "@playwright/test";
import { createClass, fastRegisterUser, resolveServiceClient } from "./helpers";

/**
 * m2 — notification panel regressions (mobile project, phone viewport).
 *
 * Guards two defects found by hand on a phone:
 *
 *  1. A grouped digest row ("4 students joined …") renders ONE row for FOUR
 *     unread events. Tapping it used to mark only the newest event read, so the
 *     badge barely moved (18 → 17) and the row immediately re-rendered as a
 *     smaller group. Every event behind the row must be marked read.
 *  2. The panel's list must scroll once it overflows. The drawer's scroll
 *     container is only real when the height chain is bounded; when the list
 *     was shorter than the container there was simply nothing to scroll, which
 *     read as "the drawer won't scroll". This spec pins the overflowing case
 *     (a real touch drag moves scrollTop, and the drawer stays anchored).
 *
 * Seeding uses the service-role seam (resolveServiceClient) so the exact unread
 * shape is deterministic rather than inferred from suite leftovers. Row counts
 * stay UNDER the panel's 20-item first page so every seeded row is loaded —
 * a larger seed would push the grouped events past the page boundary and the
 * grouped-row assertion would silently have nothing to click.
 */

const UNIQUE = `m2-${Date.now()}`;
const EMAIL = `${UNIQUE}-notif@lecturer.innovision.test`;

const GROUPED = 4; // one grouped row
const VOLUME = 14; // 14 pinned rows → the sheet list overflows
const TOTAL_UNREAD = GROUPED + VOLUME;

test.describe.configure({ mode: "serial" });

test.describe("m2 — notification panel", () => {
  test("grouped row marks every event read; overflowing list scrolls", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile-only");

    const admin = resolveServiceClient();
    test.skip(!admin, "SUPABASE_SERVICE_ROLE_KEY not available (non-local run)");

    await fastRegisterUser(page, EMAIL, "lecturer", process.env.LECTURER_INVITE_CODE!);

    // Resolve the recipient through the admin API (the same identity the page
    // is signed in as), then insert the exact unread shape.
    const { data: userPage } = await admin!.auth.admin.listUsers({ perPage: 1000 });
    const recipientId = userPage?.users.find((u) => u.email === EMAIL)?.id;
    expect(recipientId, `seeded user ${EMAIL} must exist`).toBeTruthy();

    // A REAL class, so the grouped row's click-through resolves instead of
    // landing on the 404 page (which would tear the sheet down mid-test).
    const classTitle = `M2 Class ${UNIQUE}`;
    await createClass(page, classTitle);
    const { data: classRow } = await admin!
      .from("classes")
      .select("id")
      .eq("title", classTitle)
      .maybeSingle();
    const classId = classRow?.id as string | undefined;
    expect(classId, "created class must be resolvable").toBeTruthy();

    const rows = [
      // Volume first, so the grouped events land on the newest seq.
      ...Array.from({ length: VOLUME }, (_, i) => ({
        recipient_id: recipientId!,
        type: "session_flagged",
        payload: { quiz_title: `M2 Quiz ${i}`, class_id: `33333333-0000-0000-0000-00000000000${i}` },
        dedupe_key: `${UNIQUE}-flag-${i}`,
      })),
      ...Array.from({ length: GROUPED }, (_, i) => ({
        recipient_id: recipientId!,
        type: "student_joined",
        payload: {
          class_title: classTitle,
          class_id: classId,
          student_name: `Student ${i}`,
        },
        dedupe_key: `${UNIQUE}-joined-${i}`,
      })),
    ];
    const { error } = await admin!.from("notifications").insert(rows);
    expect(error, error?.message).toBeNull();

    await page.reload();
    const bellUnread = page.getByRole("button", {
      name: new RegExp(`^Notifications, ${TOTAL_UNREAD} unread`),
    });
    await expect(bellUnread).toBeVisible({ timeout: 15_000 });
    await bellUnread.click();

    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    // ── 1. Grouped row tap reads the WHOLE group ────────────────────────────
    const groupRow = sheet.getByRole("button", { name: /students joined/i });
    await expect(groupRow).toBeVisible();
    await groupRow.click();

    // Before the fix this landed on TOTAL_UNREAD - 1 (only `newest` was read).
    await expect(
      page.getByRole("button", { name: new RegExp(`^Notifications, ${VOLUME} unread`) }),
    ).toBeVisible({ timeout: 15_000 });

    // ── 2. The list scrolls when it overflows ───────────────────────────────
    await page.getByRole("button", { name: new RegExp(`^Notifications, ${VOLUME} unread`) }).click();
    await expect(sheet).toBeVisible();

    const list = sheet.locator('div[class*="min-h-0"][class*="overflow-y-auto"]').first();

    /** The sheet slides in over 500ms; measuring or dragging mid-animation
     *  targets a moving box, so the touch points miss the list entirely. Wait
     *  for two consecutive identical top offsets (a threshold is not enough —
     *  the animation can still be finishing just under it). */
    const drawerTop = () =>
      sheet.evaluate((el) => {
        const drawer = el.closest("[data-vaul-drawer]") ?? el;
        return Math.round(drawer.getBoundingClientRect().top);
      });
    await expect
      .poll(
        async () => {
          const a = await drawerTop();
          await page.waitForTimeout(80);
          const b = await drawerTop();
          return a === b ? a : NaN;
        },
        { timeout: 5_000 },
      )
      .not.toBeNaN();

    const metrics = await list.evaluate((el) => ({
      clientH: el.clientHeight,
      scrollH: el.scrollHeight,
    }));
    expect(
      metrics.scrollH,
      "list must overflow the sheet or the scroll assertion proves nothing",
    ).toBeGreaterThan(metrics.clientH + 1);

    await list.evaluate((el) => (el.scrollTop = 0));
    const box = await list.boundingBox();
    expect(box).not.toBeNull();
    const cx = Math.round(box!.x + box!.width / 2);
    const startY = Math.round(box!.y + box!.height * 0.75);
    const drawerTopBefore = await drawerTop();

    // Real touch drag — the phone gesture (a mouse wheel would bypass
    // touch-action and prove nothing about the mobile path).
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: cx, y: startY }],
    });
    for (let i = 1; i <= 8; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: cx, y: startY - i * 25 }],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(400);

    const scrolled = await list.evaluate((el) => el.scrollTop);
    expect(scrolled, "touch drag must move the list").toBeGreaterThan(0);

    // Scrolling the list must not drag the sheet off-screen (a small tolerance
    // absorbs subpixel drift; a dismiss would move it by hundreds of px).
    const drawerTopAfter = await drawerTop();
    expect(Math.abs(drawerTopAfter - drawerTopBefore)).toBeLessThanOrEqual(2);
  });
});
