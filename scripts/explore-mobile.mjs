// Mobile-grammar explorer (plan PLAN_MOBILE_REDESIGN W1/W2/W5) — the desktop
// explorers never touch the interactive mobile surfaces, so this script walks
// the app at phone viewports with touch emulation and *operates* them:
//
//   dock tabs + aria-current   account sheet (ResponsiveModal)
//   bell popover               keyboard-occlusion dock hide (data-keyboard-open)
//   zero-state join hero       gradebook per-quiz / per-student sheets
//   shared-quiz play stage     horizontal-overflow audit at 375 and 320
//
// The `full` mode (default) adds an every-surface sweep: landing page + auth
// pages + language toggle, every dialog/sheet/popover/confirm that can open —
// bell mark-all confirm, account sheet rows, my-quizzes share/delete dialogs,
// join-error state, practice player begin-gate, builder generate/import/
// duplicate/settings dialogs, question edit/regenerate, results reveal/exempt
// dialogs, class archive/restore confirms — each screenshotted while open.
//
// Uses the seed-scenarios accounts (scripts/seed-scenarios.mjs) — run the
// seeder first. Screenshots land in screenshots/explore_mobile/<theme>/ and
// report.json records console/page errors, failed checks, and overflow hits.
//
// Run:  node scripts/explore-mobile.mjs [light|dark|all|full]
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ROOT = path.resolve(process.cwd(), "screenshots/explore_mobile");
fs.mkdirSync(ROOT, { recursive: true });

const PASSWORD = "Password123!";
// Overridable so the explorer also works against seed-demo accounts:
//   MOBILE_STUDENT_EMAIL=student1@innovision.test node scripts/explore-mobile.mjs
const ACCOUNTS = {
  student: process.env.MOBILE_STUDENT_EMAIL || "norm-student@scenario.test",
  lecturer: process.env.MOBILE_LECTURER_EMAIL || "norm-lecturer@scenario.test",
  freshStudent: process.env.MOBILE_FIRST_EMAIL || "first-student@scenario.test",
};

const report = { checks: [], consoleIssues: [], pageErrors: [] };
let shotN = 1;
// Per-theme subdirectory (like explore-scenarios' `<scenario>-dark`), set by
// runPass — flat output would let the dark pass overwrite light shots.
let OUT_DIR = ROOT;

function check(name, ok, detail = "") {
  report.checks.push({ name, ok, detail });
  console.log(`    ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Hydration-safe sign-in (same pattern as explore-scenarios: real key
 *  events, never fill(), or the server action receives empty credentials). */
async function signIn(page, email) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="email"]', { timeout: 15000 });
  await page.click('input[type="email"]');
  await page.keyboard.type(email, { delay: 5 });
  await page.click('input[type="password"]');
  await page.keyboard.type(PASSWORD, { delay: 5 });
  await page.getByRole("button", { name: /sign in/i }).click();
  await page
    .waitForURL((u) => !u.pathname.includes("/login"), { timeout: 25000, waitUntil: "commit" })
    .catch(() => {
      throw new Error(`login did not navigate for ${email}`);
    });
  await page.waitForTimeout(1500);
}

async function shot(page, name, opts = {}) {
  const file = `${String(shotN++).padStart(2, "0")}_${name}.png`;
  await page.screenshot({ path: path.join(OUT_DIR, file), ...opts });
  console.log(`    📸 ${file}`);
}

/** Horizontal-overflow audit: scrollWidth beyond the viewport at this size. */
async function auditOverflow(page, label) {
  const m = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  const over = m.scroll - m.client;
  check(`no horizontal overflow @${label}`, over <= 0, `${m.scroll}px vs ${m.client}px viewport`);
  return over <= 0;
}

const dock = (page) => page.getByRole("navigation", { name: /mobile navigation/i });

/** Assert the dock marks exactly `href` as the current page. */
async function checkDockActive(page, href) {
  const current = await dock(page)
    .locator('[aria-current="page"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  check(`dock active tab = ${href}`, current.length === 1 && current[0] === href, `got [${current}]`);
}

async function newMobileContext(browser, theme) {
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    // Camera PIP / face surfaces render something instead of erroring;
    // clipboard so copy-join-code / share-copy take the success path.
    permissions: ["camera", "microphone", "clipboard-read", "clipboard-write"],
  });
  if (theme === "dark") {
    await context.addInitScript(() => {
      window.localStorage.setItem("innovision.theme", "dark");
    });
  }
  return context;
}

function wireDiagnostics(page, label) {
  page.on("pageerror", (err) => {
    report.pageErrors.push({ label, where: page.url(), text: err.message.slice(0, 200) });
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      report.consoleIssues.push({ label, where: page.url(), text: msg.text().slice(0, 200) });
    }
  });
}

async function walkStudentDock(page, label) {
  console.log(`  [${label}] student dock tabs`);
  const tabs = [
    ["/student/classes", "student_classes"],
    ["/student/quizzes", "student_quizzes"],
    ["/student/my-quizzes", "student_my_quizzes"],
    ["/student/face/enroll", "student_face"],
  ];
  for (const [href, name] of tabs) {
    await dock(page).locator(`a[href="${href}"]`).click();
    await page.waitForURL((u) => u.pathname === href, { timeout: 15000 });
    await page.waitForTimeout(1000);
    await checkDockActive(page, href);
    await shot(page, name);
    await auditOverflow(page, `375 ${name}`);
  }
}

/** Topbar bell (Popover on phones, capped to the viewport) open/Escape. */
async function walkBell(page, label) {
  console.log(`  [${label}] notification bell popover`);
  const trigger = page.getByRole("button", { name: /notifications/i });
  await trigger.click();
  await page.getByText(/stay on top of|you're all caught up|needs attention/i).first().waitFor({ timeout: 8000 });
  await page.waitForTimeout(500);
  await shot(page, "bell_popover");
  const box = await page.locator("div.animate-in").last().boundingBox().catch(() => null);
  if (box) {
    check("bell panel fits viewport", box.x >= 0 && box.x + box.width <= 375, `x=${box.x} w=${box.width}`);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
}

/** Account sheet: opens as a dialog <sm with the language/theme rows. */
async function walkAccountSheet(page, label) {
  console.log(`  [${label}] account sheet`);
  await page.getByRole("button", { name: /your innovision account|account/i }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 8000 });
  await page.waitForTimeout(600);
  await shot(page, "account_sheet");
  // W1: language/theme toggles live in the sheet's "quickSettings" row <sm
  // (en "Settings" / ms "Tetapan"); the toggles themselves are icon-only.
  const hasLang = await dialog
    .getByText(/^settings$|^tetapan$/i)
    .first()
    .isVisible()
    .catch(() => false);
  check("account sheet shows quick-settings row <sm", hasLang);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden", timeout: 8000 });
  check("account sheet closes on Escape", true);
}

/** Generic: click a trigger, screenshot whatever dialog/sheet opened, close.
 *  `dialog` false for actions with no dialog (clipboard copy → toast). */
async function openShotClose(page, trigger, name, { settle = 600, dialog = true } = {}) {
  try {
    await trigger.click({ timeout: 8000 });
    await page.waitForTimeout(settle);
    await shot(page, name);
    if (dialog) {
      const dlg = page.getByRole("dialog");
      await dlg.first().waitFor({ timeout: 8000 });
      await auditOverflow(page, name);
      await page.keyboard.press("Escape");
      await dlg.first().waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
    }
    check(`${name} opens`, true);
    return true;
  } catch (e) {
    check(`${name} opens`, false, String(e.message).split("\n")[0]);
    return false;
  }
}

/* ──────────────────────────────────────────────────────────────
   FULL SWEEP — landing, auth, and every openable surface.
   Each walk returns its own page so failures don't cascade.
   ────────────────────────────────────────────────────────────── */

/** Landing page (signed out): hero, anchors, language toggle to BM + back. */
async function sweepLanding(browser, label) {
  const context = await newMobileContext(browser, label);
  const page = await context.newPage();
  wireDiagnostics(page, `${label}/landing`);
  try {
    console.log(`  [${label}] landing page`);
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    await shot(page, "landing_top", { fullPage: false });
    await shot(page, "landing_full", { fullPage: true });
    await auditOverflow(page, "375 landing");

    // Anchor sections — at <sm no nav chip is visible (they hide below sm),
    // so jump via scrollIntoView instead of clicking an invisible link.
    await page.evaluate(() => document.querySelector("#features")?.scrollIntoView({ behavior: "instant", block: "start" }));
    await page.waitForTimeout(900);
    await shot(page, "landing_features");
    await page.evaluate(() => document.querySelector("#cta")?.scrollIntoView({ behavior: "instant", block: "start" }));
    await page.waitForTimeout(900);
    await shot(page, "landing_cta");

    // Language toggle EN→BM renders the whole landing in Malay. The toggle
    // fires router.refresh(); the dev server compiles the /ms route on first
    // hit, so poll for BM copy instead of a fixed wait.
    const langBtn = page.getByRole("button", { name: /switch language|tukar bahasa/i });
    await langBtn.click({ timeout: 10000 });
    // Assert on body text: getByText().first() can resolve to the anchor
    // chip that is display:none <sm, which pins isVisible() false forever.
    let bmVisible = false;
    for (let i = 0; i < 20 && !bmVisible; i++) {
      await page.waitForTimeout(500);
      bmVisible = await page.evaluate(() =>
        /masuk|bermain|daftar|lambaian/i.test(document.body.innerText),
      );
    }
    await shot(page, "landing_bahasa_malaysia", { fullPage: false });
    check("language toggle switches landing copy", bmVisible, bmVisible ? "BM copy visible" : "no BM text after 10s");
    await langBtn.click({ timeout: 10000 });
    await page.waitForTimeout(2000);

    // Auth pages.
    console.log(`  [${label}] auth pages`);
    await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    const eye = page.getByRole("button", { name: /show password|hide password/i });
    if (await eye.isVisible().catch(() => false)) {
      await eye.click({ timeout: 5000 });
      await page.waitForTimeout(400);
      await shot(page, "login_password_visible");
      const type = await page.locator('input[type="password"]').count();
      check("password eye toggle reveals text", type === 0, `${type} password inputs left`);
      await eye.click({ timeout: 5000 });
      await page.waitForTimeout(300);
    }
    await shot(page, "login_page");

    await page.goto(`${BASE_URL}/register`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    await shot(page, "register_page");
    await page.goto(`${BASE_URL}/forgot-password`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    await shot(page, "forgot_password");
    await page.goto(`${BASE_URL}/no-such-page-xyz`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    await shot(page, "404_page");
  } catch (e) {
    check("landing/auth sweep", false, String(e.message).split("\n")[0]);
  } finally {
    await context.close();
  }
}

/** Student openables: bell mark-all confirm, my-quizzes share + delete
 *  dialogs, join-error state, practice player gate + option pick. */
async function sweepStudentOpenables(browser, label) {
  const context = await newMobileContext(browser, label);
  const page = await context.newPage();
  wireDiagnostics(page, `${label}/student-openables`);
  try {
    await signIn(page, ACCOUNTS.student);

    // Bell mark-all-read confirm dialog (nested dialog over the panel).
    console.log(`  [${label}] bell mark-all confirm`);
    await page.getByRole("button", { name: /notifications/i }).click();
    await page.getByText(/stay on top of|you're all caught up/i).first().waitFor({ timeout: 8000 });
    const markAll = page.getByRole("button", { name: /mark all as read/i }).first();
    if (await markAll.isVisible().catch(() => false)) {
      await markAll.click();
      const confirm = page.getByRole("dialog").filter({ hasText: /mark all as read\?/i });
      await confirm.waitFor({ timeout: 8000 });
      await page.waitForTimeout(500);
      await shot(page, "bell_mark_all_confirm");
      // Cancel — don't actually mutate seed state.
      await confirm.getByRole("button", { name: /cancel/i }).click();
      await confirm.waitFor({ state: "hidden", timeout: 8000 });
      check("bell mark-all confirm opens + cancels", true);
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    // My-quizzes share dialog + delete confirm.
    console.log(`  [${label}] my-quizzes share/delete dialogs`);
    await page.goto(`${BASE_URL}/student/my-quizzes`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    await openShotClose(
      page,
      page.getByRole("button", { name: /^share$/i }).first(),
      "my_quiz_share_dialog",
    );
    await openShotClose(
      page,
      page.getByRole("button", { name: /^delete$/i }).first(),
      "my_quiz_delete_confirm",
    );

    // Join error state (invalid code) — inline alert rendering.
    console.log(`  [${label}] join error state`);
    await page.goto(`${BASE_URL}/student/classes`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#join-code", { timeout: 15000 });
    await page.fill("#join-code", "ZZZZZZ");
    await page.getByRole("button", { name: /^join class$|^join$/i }).click();
    await page.waitForTimeout(1800);
    await shot(page, "join_error_state");
    const err = await page.locator('[role="alert"]').count();
    check("invalid join code shows inline error", err > 0, `${err} alert nodes`);

    // Practice player via shared quiz: gate + first question interaction.
    console.log(`  [${label}] shared quiz player interactions`);
    await page.goto(`${BASE_URL}/s/STUDYHARD2`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    const start = page.getByRole("button", { name: /start|play/i }).first();
    if (await start.isVisible().catch(() => false)) {
      await start.click();
      await page.waitForTimeout(2200);
      await shot(page, "player_question_1", { fullPage: false });
      // Tap an option and screenshot the selected state.
      const option = page.locator("button[role='radio'], label:has(input[type='radio'])").first();
      if (await option.isVisible().catch(() => false)) {
        await option.click();
        await page.waitForTimeout(600);
        await shot(page, "player_option_selected", { fullPage: false });
        check("player option select works", true);
      }
    }
  } catch (e) {
    check("student openables sweep", false, String(e.message).split("\n")[0]);
  } finally {
    await context.close();
  }
}

/** Lecturer openables: builder dialogs (settings/generate/import/duplicate/
 *  question edit+regenerate), results reveal/exempt dialogs, class archive
 *  confirm, archived-page restore confirm, class duplicate-quiz dialog. */
async function sweepLecturerOpenables(browser, classId, label) {
  const context = await newMobileContext(browser, label);
  const page = await context.newPage();
  wireDiagnostics(page, `${label}/lecturer-openables`);
  try {
    await signIn(page, ACCOUNTS.lecturer);

    // ── Builder: quiz row → builder; draft quiz has all dialogs ──
    console.log(`  [${label}] builder dialogs`);
    await page.goto(`${BASE_URL}/lecturer/classes`, { waitUntil: "domcontentloaded" });
    await page.locator("li a, a").filter({ hasText: /—/ }).first().click({ timeout: 15000 });
    await page.waitForURL(/\/lecturer\/classes\/[^/]+$/, { timeout: 15000 });
    await page.waitForTimeout(1200);

    // Class hero: copy join code (clipboard + toast, no dialog), archive confirm.
    await openShotClose(
      page,
      page.getByRole("button", { name: /copy join code/i }).first(),
      "class_copy_join_code",
      { settle: 300, dialog: false },
    );
    await openShotClose(
      page,
      page.getByRole("button", { name: /archive class/i }).first(),
      "class_archive_confirm",
    );

    // Enter a quiz builder (draft quiz via title click, E40 pattern).
    await page.getByText(/Draft:|Assessment:|Practice:|Weekly Quiz/i).first().click({ timeout: 15000 });
    await page.waitForURL(/\/lecturer\/quizzes\/[^/]+\/builder/, { timeout: 15000 });
    await page.waitForTimeout(1500);
    await shot(page, "builder_top", { fullPage: false });

    await openShotClose(page, page.getByRole("button", { name: /quiz settings/i }).first(), "builder_settings_dialog");
    await openShotClose(page, page.getByRole("button", { name: /generate from file/i }).first(), "builder_generate_dialog");
    await openShotClose(page, page.getByRole("button", { name: /import questions/i }).first(), "builder_import_dialog");
    await openShotClose(page, page.getByRole("button", { name: /duplicate/i }).first(), "builder_duplicate_dialog");

    // Question row: edit dialog + regenerate confirm (first question).
    await openShotClose(
      page,
      page.getByRole("button", { name: /edit$/i }).first(),
      "builder_question_edit",
    );
    await openShotClose(
      page,
      page.getByRole("button", { name: /regenerate/i }).first(),
      "builder_question_regenerate",
    );

    // ── Results dashboard (published quiz): reveal + exempt dialogs ──
    console.log(`  [${label}] results dialogs`);
    await page.goto(`${BASE_URL}/lecturer/classes`, { waitUntil: "domcontentloaded" });
    await page.locator("li a, a").filter({ hasText: /—/ }).first().click({ timeout: 15000 });
    await page.waitForURL(/\/lecturer\/classes\/[^/]+$/, { timeout: 15000 });
    await page.locator('a[aria-label^="Results -"]').first().click({ timeout: 15000 });
    await page.waitForURL(/\/results/, { timeout: 15000 });
    await page.waitForTimeout(1500);
    await shot(page, "results_dashboard", { fullPage: false });

    // Reveal confirm only exists while results are still hidden — the seed
    // quiz may already be revealed ("Results revealed" chip instead).
    const revealBtn = page.getByRole("button", { name: /reveal to students/i });
    if (await revealBtn.isVisible().catch(() => false)) {
      await openShotClose(page, revealBtn.first(), "results_reveal_confirm");
    } else {
      const revealed = await page.getByText(/results revealed/i).first().isVisible().catch(() => false);
      check("results_reveal_confirm", true, revealed ? "quiz already revealed — state chip shown" : "no reveal control (state)");
    }

    const exempt = page.getByRole("button", { name: /face-exempt/i }).first();
    if (await exempt.isVisible().catch(() => false)) {
      await openShotClose(page, exempt, "results_exempt_dialog");
    } else {
      console.log("    (no face-exempt rows in seed — skipped)");
    }

    // ── Archived page: restore confirm ──
    console.log(`  [${label}] archived restore confirm`);
    await page.goto(`${BASE_URL}/lecturer/classes/archived`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    const restore = page.getByRole("button", { name: /^restore$/i }).first();
    if (await restore.isVisible().catch(() => false)) {
      await openShotClose(page, restore, "archived_restore_confirm");
    } else {
      console.log("    (no archived classes in seed — skipped)");
    }
  } catch (e) {
    check("lecturer openables sweep", false, String(e.message).split("\n")[0]);
  } finally {
    await context.close();
  }
}

/** W1 keyboard occlusion: focusing an input sets data-keyboard-open and the
 *  dock slides off-screen; blurring clears both. */
async function walkKeyboardOcclusion(page, label) {
  console.log(`  [${label}] keyboard occlusion vs dock`);
  await page.goto(`${BASE_URL}/student/classes`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#join-code", { timeout: 15000 });
  await page.click("#join-code");
  await page.waitForTimeout(500);
  const open = await page.evaluate(() => document.documentElement.hasAttribute("data-keyboard-open"));
  const dockBox = await dock(page).boundingBox();
  check("focus sets data-keyboard-open", open);
  check(
    "dock hides while input focused",
    !!dockBox && dockBox.y >= 812,
    dockBox ? `dock y=${Math.round(dockBox.y)}` : "dock not found",
  );
  await shot(page, "keyboard_open_dock_hidden");
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(800);
  const closed = await page.evaluate(() => !document.documentElement.hasAttribute("data-keyboard-open"));
  check("blur clears data-keyboard-open", closed);
}

/** W2 zero-state rule: empty classes page collapses the hero and embeds the
 *  join form — never zero stat cards. */
async function walkZeroState(page, label) {
  console.log(`  [${label}] zero-state join hero`);
  await page.goto(`${BASE_URL}/student/classes`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  const joinVisible = await page.locator("#join-code").isVisible().catch(() => false);
  check("join form reachable with zero classes", joinVisible);
  const zeroStats = await page.getByText(/0 classes/i).count();
  check("no zero stat cards <sm", zeroStats === 0, `${zeroStats} matches`);
  await shot(page, "student_zero_state");
  await auditOverflow(page, "375 zero-state");
}

/** W5 gradebook mobile composition: quiz chips + student rows open sheets. */
async function walkGradebookSheets(page, classId, label) {
  console.log(`  [${label}] gradebook mobile sheets`);
  await page.goto(`${BASE_URL}/lecturer/classes/${classId}/gradebook`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await shot(page, "gradebook_mobile_list");
  await auditOverflow(page, "375 gradebook");

  const quizChip = page.locator("div.overflow-x-auto button").first();
  if (await quizChip.isVisible().catch(() => false)) {
    await quizChip.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 8000 });
    await page.waitForTimeout(500);
    await shot(page, "gradebook_per_quiz_sheet");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 8000 });
    check("per-quiz sheet opens + Escape closes", true);
  } else {
    check("per-quiz sheet", false, "no quiz chips rendered");
  }

  const studentRow = page.locator("ul > li > button").first();
  if (await studentRow.isVisible().catch(() => false)) {
    await studentRow.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 8000 });
    await page.waitForTimeout(500);
    await shot(page, "gradebook_per_student_sheet");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 8000 });
    check("per-student sheet opens + Escape closes", true);
  } else {
    check("per-student sheet", false, "no student rows rendered");
  }
}

/** W3 play stage: shared practice quiz (/s/STUDYHARD2 from seed-demo) shows
 *  the mobile composition — compact sticky header, no title wall. */
async function walkSharedQuizPlay(page, label) {
  console.log(`  [${label}] shared quiz play stage`);
  await page.goto(`${BASE_URL}/s/STUDYHARD2`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await shot(page, "shared_quiz_begin_gate");
  const start = page.getByRole("button", { name: /start|play/i }).first();
  if (await start.isVisible().catch(() => false)) {
    await start.click();
    await page.waitForTimeout(2000);
    await shot(page, "shared_quiz_play_mobile", { fullPage: false });
    await auditOverflow(page, "375 play stage");
  } else {
    check("shared quiz playable", false, "no start button on /s/STUDYHARD2");
  }
}

async function runPass(browser, theme) {
  const dirName = theme === "dark" ? "dark" : "light";
  OUT_DIR = path.join(ROOT, dirName);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`\n=== MOBILE EXPLORER — ${dirName.toUpperCase()} ===`);
  const context = await newMobileContext(browser, theme);
  const page = await context.newPage();
  wireDiagnostics(page, dirName);

  try {
    // ── Student: dock, sheets, keyboard occlusion ──
    await signIn(page, ACCOUNTS.student);
    await checkDockActive(page, "/student/classes");
    await shot(page, "student_classes_375", { fullPage: true });
    await walkStudentDock(page, dirName);
    await walkBell(page, dirName);
    await walkAccountSheet(page, dirName);
    await walkKeyboardOcclusion(page, dirName);
    await walkSharedQuizPlay(page, dirName);

    // ── Lecturer: dock (2 tabs), class detail, gradebook sheets ──
    await context.clearCookies();
    await signIn(page, ACCOUNTS.lecturer);
    await checkDockActive(page, "/lecturer/classes");
    await shot(page, "lecturer_classes_375", { fullPage: true });
    await auditOverflow(page, "375 lecturer classes");

    await dock(page).locator('a[href="/lecturer/classes/archived"]').click();
    await page.waitForURL(/\/lecturer\/classes\/archived/, { timeout: 15000 });
    await page.waitForTimeout(1000);
    await checkDockActive(page, "/lecturer/classes/archived");
    await shot(page, "lecturer_archived_375");

    // Class detail via the classes list (first "Title — CODE" card link).
    await page.goto(`${BASE_URL}/lecturer/classes`, { waitUntil: "domcontentloaded" });
    await page.locator("li a, a").filter({ hasText: /—/ }).first().click({ timeout: 15000 });
    await page.waitForURL(/\/lecturer\/classes\/[^/]+$/, { timeout: 15000 });
    await page.waitForTimeout(1200);
    const classId = page.url().split("/").pop();
    await shot(page, "lecturer_class_detail_375", { fullPage: true });
    await auditOverflow(page, "375 class detail");

    await walkGradebookSheets(page, classId, dirName);
  } finally {
    await context.close();
  }

  // ── FULL sweep: landing/auth + every dialog, sheet, popover, confirm ──
  if (process.env.FULL || process.argv[2] === "full" || process.argv[2] === "all") {
    await sweepLanding(browser, dirName);
    await sweepStudentOpenables(browser, dirName);
    // Reuse the first class id — derive it in a fresh signed-in session.
    const ctxL = await newMobileContext(browser, theme);
    const pageL = await ctxL.newPage();
    let classId = null;
    try {
      await signIn(pageL, ACCOUNTS.lecturer);
      await pageL.goto(`${BASE_URL}/lecturer/classes`, { waitUntil: "domcontentloaded" });
      await pageL.locator("li a, a").filter({ hasText: /—/ }).first().click({ timeout: 15000 });
      await pageL.waitForURL(/\/lecturer\/classes\/[^/]+$/, { timeout: 15000 });
      classId = pageL.url().split("/").pop();
    } catch (e) {
      check("lecturer openables setup", false, String(e.message).split("\n")[0]);
    } finally {
      await ctxL.close();
    }
    if (classId) await sweepLecturerOpenables(browser, classId, dirName);
  }

  // ── Zero-state student (fresh account) ──
  const ctx2 = await newMobileContext(browser, theme);
  const page2 = await ctx2.newPage();
  wireDiagnostics(page2, `${dirName}/zero-state`);
  try {
    await signIn(page2, ACCOUNTS.freshStudent);
    await walkZeroState(page2, dirName);
  } catch (e) {
    check("zero-state pass", false, String(e.message).split("\n")[0]);
  } finally {
    await ctx2.close();
  }

  // ── 320px guard sweep (reuses student session) ──
  const ctx3 = await newMobileContext(browser, theme);
  await ctx3.setViewportSize?.({ width: 320, height: 700 });
  const page3 = await ctx3.newPage();
  await page3.setViewportSize({ width: 320, height: 700 });
  wireDiagnostics(page3, `${dirName}/320`);
  try {
    await signIn(page3, ACCOUNTS.student);
    for (const [p, name] of [
      ["/student/classes", "student_classes"],
      ["/student/quizzes", "student_quizzes"],
      ["/student/my-quizzes", "student_my_quizzes"],
    ]) {
      await page3.goto(`${BASE_URL}${p}`, { waitUntil: "domcontentloaded" });
      await page3.waitForTimeout(1000);
      await shot(page3, `w320_${name}`, { fullPage: true });
      await auditOverflow(page3, `320 ${name}`);
    }
  } catch (e) {
    check("320px sweep", false, String(e.message).split("\n")[0]);
  } finally {
    await ctx3.close();
  }
}

async function run() {
  const which = (process.argv[2] ?? "light").toLowerCase();
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  try {
    if (which === "dark") await runPass(browser, "dark");
    else if (which === "all" || which === "full") {
      await runPass(browser, "light");
      await runPass(browser, "dark");
    } else await runPass(browser, "light");
  } finally {
    await browser.close();
  }

  fs.writeFileSync(path.join(ROOT, "report.json"), JSON.stringify(report, null, 2), "utf8");
  const failed = report.checks.filter((c) => !c.ok);
  console.log(`\nDone. ${report.checks.length} checks, ${failed.length} failed.`);
  for (const c of failed) console.log(`  ✗ ${c.name} — ${c.detail}`);
  const issues = [...report.pageErrors, ...report.consoleIssues];
  if (issues.length) {
    console.log(`Console/page errors: ${issues.length}`);
    const seen = new Set();
    for (const c of issues) {
      const key = c.text.slice(0, 90);
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`  - [${c.label}] ${key}`);
    }
  }
  console.log(`Screenshots + report.json in ${OUT_DIR}`);
}

run().catch((e) => {
  console.error("Mobile explorer failed:", e);
  process.exit(1);
});
