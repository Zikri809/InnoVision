import type { Page, Locator } from "@playwright/test";

/**
 * Set a DateTimePicker (clay calendar popover) to a specific Date.
 *
 * Drives the real user path: open the popover via the labeled trigger,
 * navigate the calendar month grid, click the day cell, type the time.
 * Day buttons carry `data-day="<YYYY-MM-DD>"` (react-day-picker v10), which
 * is stable regardless of locale formatting or "Today, …" label prefixes.
 */
export async function setDateTime(
  page: Page,
  trigger: Locator,
  target: Date,
): Promise<void> {
  await trigger.click();

  const pad = (n: number) => String(n).padStart(2, "0");
  const iso = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`;
  const year = target.getFullYear();
  const monthIdx = target.getMonth();

  // Navigate until the target month is displayed. React-day-picker's prev/next
  // buttons are labeled "Go to the Previous/Next Month".
  for (let i = 0; i < 24; i++) {
    const dayBtn = page.locator(`[data-day="${iso}"]`);
    if (await dayBtn.count()) {
      // data-day renders for outside (adjacent-month) cells too; only click
      // when it belongs to the displayed month grid we navigated to.
      await dayBtn.first().click();
      break;
    }
    // Compare the visible month caption against the target year/month using
    // the grid's rendered day cells: pick navigation direction from the first
    // in-month day cell's data-day.
    const firstInMonth = page.locator("[data-day]:not([data-month])").first();
    const currentIso = await firstInMonth.getAttribute("data-day");
    if (!currentIso) throw new Error("Calendar grid not rendered");
    const current = new Date(currentIso + "T00:00:00");
    const dir =
      year * 12 + monthIdx > current.getFullYear() * 12 + current.getMonth()
        ? "Next"
        : "Previous";
    await page.getByRole("button", { name: new RegExp(`Go to the ${dir} Month`, "i") }).click();
  }

  // Time inputs are labeled "<trigger label> — hours/minutes". Escape the
  // label: it can contain regex metacharacters ("Opens at (UTC)").
  const label = (await trigger.getAttribute("aria-label")) ?? "";
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hh = String(target.getHours()).padStart(2, "0");
  const mm = String(target.getMinutes()).padStart(2, "0");
  const hoursInput = page.getByRole("textbox", { name: new RegExp(`^${esc} — hours$`) });
  await hoursInput.fill(hh);
  await hoursInput.blur();
  const minutesInput = page.getByRole("textbox", { name: new RegExp(`^${esc} — minutes$`) });
  await minutesInput.fill(mm);
  await minutesInput.blur();

  // Close the popover so sibling interactions are not blocked.
  await trigger.click();
}
