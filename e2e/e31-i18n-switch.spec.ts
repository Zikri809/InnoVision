import { test, expect } from "@playwright/test";
import { registerUser, E2E_PASSWORD } from "./helpers";

/**
 * E31 — i18n switch (HIGH #5).
 * Serial tests:
 *   1. Login page: the "Switch language" toggle flips EN ↔ BM ("Welcome back!"
 *      → "Selamat kembali!").
 *   2. Authenticated chrome: toggling via the shell toggle flips the dashboard
 *      heading ("My Classes" → "Kelas Saya") and the choice PERSISTS across a
 *      goto + reload (cookie, helpers.ts:561 precedent).
 *   3. Raw-key sweep: body innerText across the core pages must not leak any
 *      untranslated `segment.token` i18n key (allowlist = the registered
 *      email, which legitimately contains `@<tld>`).
 */

const stamp = Date.now();
const LECTURER_EMAIL = `e31-lec-${stamp}@e2e.test`;
const STUDENT_EMAIL = `e31-stu-${stamp}@e2e.test`;
const INVITE = process.env.LECTURER_INVITE_CODE ?? "";

test.describe.configure({ mode: "serial" });

test("login page toggle flips the heading EN ↔ BM", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByText("Welcome back!", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Switch language", exact: true }).click();
  await expect(page.getByText("Selamat kembali!", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Tukar bahasa", exact: true }).click();
  await expect(page.getByText("Welcome back!", { exact: true })).toBeVisible();
});

test("authenticated toggle flips the dashboard and persists (cookie)", async ({
  page,
}) => {
  await registerUser(page, LECTURER_EMAIL, "lecturer", INVITE);
  await expect(page.getByRole("heading", { name: /My Classes|My classes/i })).toBeVisible();

  // Toggle to BM — the shell chrome toggle is always visible outside dialogs.
  await page.getByRole("button", { name: "Switch language", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Kelas Saya|Kelas saya/i })).toBeVisible();

  // Persistence: a fresh goto + reload keeps BM.
  await page.goto("/lecturer/classes");
  await page.reload();
  await expect(page.getByRole("heading", { name: /Kelas Saya|Kelas saya/i })).toBeVisible();
});

test("no raw i18n keys leak into page text", async ({ browser }) => {
  const KEY = /\b[a-z]+\.[a-zA-Z]{2,}\b/g;
  const allowlist = new Set([
    LECTURER_EMAIL,
    STUDENT_EMAIL,
    "e2e.test",
    "example.com",
    "gmail.com",
  ]);

  const checks: Array<{ path: string; page: import("@playwright/test").Page }> = [];

  // Lecturer-context pages.
  const lecCtx = await browser.newContext();
  const lec = await lecCtx.newPage();
  await registerUser(lec, LECTURER_EMAIL, "lecturer", INVITE);
  for (const path of [
    "/lecturer/classes",
    "/student/classes",
    "/student/my-quizzes",
    "/student/quizzes",
    "/login",
  ]) {
    await lec.goto(path);
    checks.push({ path, page: lec });
  }

  // Student-context page (fresh context, own account) + register page.
  const stuCtx = await browser.newContext();
  const stu = await stuCtx.newPage();
  await registerUser(stu, STUDENT_EMAIL, "student", "");
  await stu.goto("/student/classes");
  checks.push({ path: "/student/classes", page: stu });
  await stu.goto("/student/my-quizzes");
  checks.push({ path: "/student/my-quizzes", page: stu });
  await stu.goto("/register");
  checks.push({ path: "/register", page: stu });

  const failures: Array<{ path: string; match: string }> = [];
  for (const { path, page } of checks) {
    const text = await page.evaluate(() => document.body.innerText);
    for (const m of text.match(KEY) ?? []) {
      if (!allowlist.has(m)) {
        failures.push({ path, match: m });
        break;
      }
    }
  }

  expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);

  await lecCtx.close();
  await stuCtx.close();
});
