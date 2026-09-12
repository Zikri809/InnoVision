import { test, expect } from "@playwright/test";
import { registerUser, createClass, matricForEmail, E2E_PASSWORD } from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const fast = expect.configure({ timeout: 5_000 });

/**
 * E52 — QR class join (scan-to-enroll), END TO END:
 *
 * 1. LECTURER: the class DETAIL page gains a QR affordance → dialog shows
 *    the QR and the resolved {origin}/join/{code} URL.
 * 2. STUDENT (logged in): /join/{code} renders the confirm card → join →
 *    lands on /student/classes with the class present.
 * 3. STUDENT (already enrolled): the typed already_enrolled copy renders.
 * 4. ANONYMOUS, EXISTING account: /join/{code} bounces through the login
 *    wall and RETURNS — password sign-in continues to the join page.
 * 5. ANONYMOUS, FIRST-DAY account: the register path (login → register →
 *    signup) also preserves the redirect and completes the join.
 * 6. INVALID malformed code: neutral card, no crash, no oracle.
 * 7. LECTURER scanning: the lecturerNotice info card renders (no join).
 * 8. ARCHIVED class: the detail page shows the archived badge and NO QR
 *    affordance.
 *
 * Locators are role/name-based (house style); data-testid is a backup for
 * the purely visual QR assertions.
 */

async function openClassDetail(lecturerPage: import("@playwright/test").Page, title: string) {
  // createClass leaves the lecturer on the classes LIST; the QR affordances
  // live only on the DETAIL page (openResults navigation pattern).
  await lecturerPage.getByText(title, { exact: true }).click();
  await expect(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
}

test.describe("E52 — QR class join", () => {
  test("lecturer QR dialog + student join + already-enrolled error", async ({ browser }, testInfo) => {
    testInfo.setTimeout(180_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerEmail = `lect-e52-${TEST_TIMESTAMP}@innovision.test`;
    const studentEmail = `stud-e52-${TEST_TIMESTAMP}@innovision.test`;

    // ── Lecturer: register, create a class, open its detail page, QR dialog ──
    const lecturerCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    await registerUser(lecturerPage, lecturerEmail, "lecturer", LECTURER_INVITE_CODE);
    const joinCode = await createClass(lecturerPage, `E52 QR Class ${TEST_TIMESTAMP}`);
    await openClassDetail(lecturerPage, `E52 QR Class ${TEST_TIMESTAMP}`);

    // Desktop card QR affordance → dialog with QR + URL text.
    const qrTrigger = lecturerPage.getByRole("button", { name: /show qr/i });
    await fast(qrTrigger).toBeVisible();
    await qrTrigger.click();
    const dialog = lecturerPage.getByRole("dialog");
    await fast(dialog).toBeVisible();
    await fast(dialog.getByTestId("join-qr-canvas")).toBeVisible();
    await fast(dialog.getByTestId("join-qr-url")).toContainText(`/join/${joinCode}`);
    await lecturerPage.keyboard.press("Escape");
    await fast(dialog).toHaveCount(0);

    await lecturerCtx.close();

    // ── Student (logged in): confirm-join via the deep link ──
    const studentCtx = await browser.newContext();
    const studentPage = await studentCtx.newPage();
    await registerUser(studentPage, studentEmail, "student", LECTURER_INVITE_CODE);

    await studentPage.goto(`/join/${joinCode}`);
    await fast(studentPage.getByTestId("join-code-display")).toHaveText(joinCode);
    await studentPage.getByRole("button", { name: /^join class$/i }).click();
    await studentPage.waitForURL(/\/student\/classes/, { timeout: 15_000 });
    await fast(studentPage.getByText(`E52 QR Class ${TEST_TIMESTAMP}`, { exact: true })).toBeVisible();

    // ── Already enrolled: typed, localized error (no double-join) ──
    await studentPage.goto(`/join/${joinCode}`);
    await fast(studentPage.getByTestId("join-code-display")).toHaveText(joinCode);
    await studentPage.getByRole("button", { name: /^join class$/i }).click();
    await fast(studentPage.getByText(/already enrolled/i)).toBeVisible();

    await studentCtx.close();
  });

  test("anonymous bounce: existing account logs back in and lands on the join", async ({ browser }, testInfo) => {
    testInfo.setTimeout(180_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerEmail = `lect-e52b-${TEST_TIMESTAMP}@innovision.test`;
    const studentEmail = `stud-e52b-${TEST_TIMESTAMP}@innovision.test`;

    // Lecturer + class (helper-based; identity irrelevant to this test).
    const lecturerCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    await registerUser(lecturerPage, lecturerEmail, "lecturer", LECTURER_INVITE_CODE);
    const joinCode = await createClass(lecturerPage, `E52b QR Class ${TEST_TIMESTAMP}`);
    await lecturerCtx.close();

    // Pre-register the student so the bounce exercises the PASSWORD LOGIN
    // return leg (the primary scan path for anyone who already signed up).
    const seedCtx = await browser.newContext();
    const seedPage = await seedCtx.newPage();
    await registerUser(seedPage, studentEmail, "student", LECTURER_INVITE_CODE);
    await seedCtx.close();

    // Anonymous scanner: middleware bounces /join/CODE → /login?redirect=…
    const anonCtx = await browser.newContext();
    const anonPage = await anonCtx.newPage();
    await anonPage.goto(`/join/${joinCode}`);
    await anonPage.waitForURL(/\/login/, { timeout: 15_000 });

    // Sign IN (not up) — the login form must carry ?redirect= through.
    await anonPage.getByLabel(/email/i).fill(studentEmail);
    await anonPage.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
    await anonPage.getByRole("button", { name: /sign in/i }).click();
    await anonPage.waitForURL(/\/join\//, { timeout: 15_000 });
    await fast(anonPage.getByTestId("join-code-display")).toHaveText(joinCode);
    await anonPage.getByRole("button", { name: /^join class$/i }).click();
    await anonPage.waitForURL(/\/student\/classes/, { timeout: 15_000 });
    await fast(anonPage.getByText(`E52b QR Class ${TEST_TIMESTAMP}`, { exact: true })).toBeVisible();

    await anonCtx.close();
  });

  test("first-day register path preserves the redirect through signup", async ({ browser }, testInfo) => {
    testInfo.setTimeout(180_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerEmail = `lect-e52c-${TEST_TIMESTAMP}@innovision.test`;
    const studentEmail = `stud-e52c-${TEST_TIMESTAMP}@innovision.test`;

    const lecturerCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    await registerUser(lecturerPage, lecturerEmail, "lecturer", LECTURER_INVITE_CODE);
    const joinCode = await createClass(lecturerPage, `E52c QR Class ${TEST_TIMESTAMP}`);
    await lecturerCtx.close();

    // Anonymous scanner hits the login wall, but has NO account — the
    // Register link must carry ?redirect= so signup continues the journey.
    const anonCtx = await browser.newContext();
    const anonPage = await anonCtx.newPage();
    await anonPage.goto(`/join/${joinCode}`);
    await anonPage.waitForURL(/\/login/, { timeout: 15_000 });
    await anonPage.getByRole("link", { name: /create one now|register/i }).click();
    await anonPage.waitForURL(/\/register\?redirect=/, { timeout: 15_000 });
    await anonPage.getByLabel(/Full name/).fill(`E52c Student`);
    await anonPage.getByLabel(/Email/).fill(studentEmail);
    await anonPage.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
    await anonPage.getByRole("radio", { name: "Student" }).check();
    // Inline fill is required here (registerUser's bare /register goto would
    // drop the ?redirect= contract under test), but the matric uses the
    // helper's email-hash derivation — the 8+timestamp-slice scheme collides
    // across reruns/specs (persistent DB), this never does.
    await anonPage.getByLabel(/matric/i).fill(matricForEmail(studentEmail));
    await anonPage.getByRole("checkbox").first().check();
    await anonPage.getByRole("button", { name: /create account|register/i }).click();
    // Post-signup bounce completes the join journey.
    await anonPage.waitForURL(/\/join\//, { timeout: 45_000 });
    await fast(anonPage.getByTestId("join-code-display")).toHaveText(joinCode);
    await anonPage.getByRole("button", { name: /^join class$/i }).click();
    await anonPage.waitForURL(/\/student\/classes/, { timeout: 15_000 });
    await fast(anonPage.getByText(`E52c QR Class ${TEST_TIMESTAMP}`, { exact: true })).toBeVisible();

    await anonCtx.close();
  });

  test("invalid code card + lecturer scan branch + archived class hides QR", async ({ browser }, testInfo) => {
    testInfo.setTimeout(150_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const studentEmail = `stud-e52d-${TEST_TIMESTAMP}@innovision.test`;
    const lecturerEmail = `lect-e52d-${TEST_TIMESTAMP}@innovision.test`;

    // ── Malformed code: neutral invalid card (student session) ──
    const studentCtx = await browser.newContext();
    const studentPage = await studentCtx.newPage();
    await registerUser(studentPage, studentEmail, "student", LECTURER_INVITE_CODE);
    await studentPage.goto("/join/zz");
    await fast(studentPage.getByText(/not valid|tidak sah/i)).toBeVisible();
    await studentCtx.close();

    // ── Lecturer scanning their own QR: info card, no join flow ──
    const lecturerCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    await registerUser(lecturerPage, lecturerEmail, "lecturer", LECTURER_INVITE_CODE);
    const joinCode = await createClass(lecturerPage, `E52d QR Class ${TEST_TIMESTAMP}`);

    await lecturerPage.goto(`/join/${joinCode}`);
    await fast(lecturerPage.getByText(/students scan this code|pensyarah/i)).toBeVisible();
    await fast(lecturerPage.getByRole("button", { name: /^join class$/i })).toHaveCount(0);

    // ── Archived class: detail page loses the QR affordance ──
    // (QR was previously shown on THIS page; assert here, not on the
    // archived list, so a gating regression actually fails.)
    await lecturerPage.goto("/lecturer/classes");
    await openClassDetail(lecturerPage, `E52d QR Class ${TEST_TIMESTAMP}`);
    await fast(lecturerPage.getByRole("button", { name: /show qr/i })).toBeVisible();
    await lecturerPage.getByRole("button", { name: /archive class/i }).first().click();
    const archiveDialog = lecturerPage.getByRole("dialog");
    await fast(archiveDialog).toBeVisible();
    await archiveDialog.getByRole("button", { name: /archive class/i }).last().click();
    // Archive navigates to the archived list; come back to the DETAIL page
    // via its "View audit" link (the archived list's title is not clickable).
    await lecturerPage.waitForURL(/\/lecturer\/classes\/archived/, { timeout: 15_000 });
    await lecturerPage
      .getByRole("link", { name: new RegExp(`view audit records for e52d qr class ${TEST_TIMESTAMP}`, "i") })
      .click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/classes\/(?!archived)[^/]+$/);
    await fast(lecturerPage.getByText(/archived/i).first()).toBeVisible();
    await fast(lecturerPage.getByRole("button", { name: /show qr/i })).toHaveCount(0);

    await lecturerCtx.close();
  });
});
