import { type APIRequestContext, type Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { fakeHandTrackerInit } from "./fake-hand-tracker";
import { fakeFaceInit } from "./fake-face-tracker";

export const E2E_PASSWORD = "testpass123";

/**
 * Register a user via the UI (role radio + consent checkbox + lecturer invite
 * code when applicable), then wait for the role-based landing page.
 *
 * Students additionally fill the REQUIRED 6-digit matric field (0027),
 * deterministically derived from the email's trailing digits so reruns of the
 * same spec produce the same account, different specs never collide. The
 * matric used is returned (null for lecturers) so specs can assert exports.
 */
export async function registerUser(
  page: Page,
  email: string,
  role: "lecturer" | "student",
  inviteCode: string,
): Promise<{ matric: string | null }> {
  await page.goto("/register");
  // The label was renamed "Full name" (no "(optional)") by the i18n pass —
  // match loosely so either era of the form works.
  await page.getByLabel(/Full name/).fill(`${role}-${email.split("@")[0]}`);
  await page.getByLabel(/Email/).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);

  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
  await page.getByRole("radio", { name: roleLabel }).check();

  let matric: string | null = null;
  const landing =
    role === "lecturer" ? /\/lecturer\/classes/ : /\/student\/classes/;
  // The styled form-level error paragraph (role=alert). Next's route
  // announcer also renders role=alert, hence the text filter.
  const formAlert = page
    .getByRole("alert")
    .filter({ hasText: /could not create|matric number is already/i });

  // Submit and wait for EITHER the role landing page or a rendered signup
  // error — never the full 45s blind wait, which blew the 30s default test
  // timeout before the recovery path could run when signup was rejected.
  const submit = async (): Promise<"landing" | "error"> => {
    await page
      .getByRole("button", { name: /create account|register/i })
      .click();
    return Promise.race([
      page
        .waitForURL(landing, { timeout: 45_000 })
        .then(() => "landing" as const)
        .catch(() => "landing" as const),
      formAlert
        .waitFor({ state: "visible", timeout: 45_000 })
        .then(() => "error" as const)
        .catch(() => "error" as const),
    ]);
  };

  // Poisoned-retry recovery: a prior attempt (this run's retry, or a
  // duplicate-email serial spec) often created the account BEFORE this
  // navigation resolved — the retried registration can never succeed
  // ("already registered"). Fall back to signing in with the shared E2E
  // password; the landing assertion below stays authoritative. The proxy
  // bounces authenticated users off /login → drop any session cookie a
  // partial signup set before signing in.
  const recoverAndSignIn = async () => {
    await page.context().clearCookies();
    await page.goto("/login");
    await page.getByLabel(/Email/).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(landing, { timeout: 45_000 });
  };

  await page.getByRole("checkbox").check();

  if (role === "lecturer") {
    await page.getByLabel("Lecturer invite code").fill(inviteCode);
    const outcome = await submit();
    if (outcome === "error") await recoverAndSignIn();
  } else {
    // Matric (0027): REQUIRED for students. Derived from a cheap string HASH
    // of the whole email so two accounts minted in the SAME run from the same
    // timestamp base (e.g. `x-<stamp>@` creator/player pairs) never collide,
    // while reruns of the same spec stay deterministic. The salt bumps on a
    // "matric already registered" rejection — the helper DB is persistent, so
    // a 5-digit space eventually collides with a row from an earlier run.
    // Prefix "8" stays clear of the reserved 99xxxx range.
    const matricFor = (salt: number): string => {
      let h = 0;
      const source = `${email}#${salt}`;
      for (let i = 0; i < source.length; i++) {
        h = (h * 31 + source.charCodeAt(i)) % 100000;
      }
      return `8${String(h).padStart(5, "0")}`;
    };

    let salt = 0;
    for (;;) {
      const candidate = matricFor(salt);
      await page.getByLabel(/Matric number/i).fill(candidate);
      const outcome = await submit();
      if (outcome === "landing") {
        matric = candidate;
        break;
      }
      const alertText = (await formAlert.textContent().catch(() => "")) ?? "";
      if (/matric number is already/i.test(alertText) && salt < 5) {
        salt++;
        continue;
      }
      await recoverAndSignIn();
      break;
    }
  }
  return { matric };
}

/**
 * Fast registration: If local admin seam is available (via resolveServiceClient),
 * creates user and profile directly via DB admin API, then signs in cleanly via /login.
 * Avoids long /register multi-field typing and reduces setup time from ~3s to <0.5s.
 */
export async function fastRegisterUser(
  page: Page,
  email: string,
  role: "lecturer" | "student",
  inviteCode: string,
): Promise<{ matric: string | null }> {
  const admin = resolveServiceClient();
  const landing = role === "lecturer" ? /\/lecturer\/classes/ : /\/student\/classes/;

  let matric: string | null = null;
  if (role === "student") {
    let h = 0;
    const source = `${email}#0`;
    for (let i = 0; i < source.length; i++) {
      h = (h * 31 + source.charCodeAt(i)) % 100000;
    }
    matric = `8${String(h).padStart(5, "0")}`;
  }

  if (admin) {
    try {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password: E2E_PASSWORD,
        email_confirm: true,
        user_metadata: {
          role,
          full_name: `${role}-${email.split("@")[0]}`,
          matric_no: matric,
          consent_given_at: new Date().toISOString(),
        },
      });

      if (!error && data.user) {
        await admin.from("profiles").upsert({
          id: data.user.id,
          role,
          full_name: `${role}-${email.split("@")[0]}`,
          matric_no: matric,
          consent_given_at: new Date().toISOString(),
        });

        await page.goto("/login");
        await page.getByLabel(/Email/).fill(email);
        await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
        await page.getByRole("button", { name: /sign in/i }).click();
        await page.waitForURL(landing, { timeout: 15_000 });
        return { matric };
      }
    } catch {
      // Fall through to UI registration on error
    }
  }

  return registerUser(page, email, role, inviteCode);
}

/**
 * Lecturer: create a class and return its join code (captured from the card).
 * Assumes the lecturer is already on /lecturer/classes.
 */
export async function createClass(page: Page, title: string): Promise<string> {
  await page.getByLabel("Class title").fill(title);
  // Strict match: a bare /create/i also hits the "Create a class" empty-state
  // tile once it renders — strict-mode race under load (observed in e38).
  await page.getByRole("button", { name: "Create class", exact: true }).click();
  await expect(page.getByText(title, { exact: true })).toBeVisible();

  const joinCode = await page
    .getByText(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
    .first()
    .textContent();
  expect(joinCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  return joinCode!;
}

/**
 * Student: join a class by code and confirm it appears in the class list.
 * Assumes the student is already on /student/classes.
 */
export async function joinClass(page: Page, joinCode: string, classTitle: string) {
  await page.getByLabel("Join code").fill(joinCode);
  await page.getByRole("button", { name: /join/i }).click();
  await expect(page.getByText(classTitle, { exact: true })).toBeVisible();
}

type QuestionInput = {
  type?: "mcq" | "true_false" | "multi_select";
  prompt: string;
  options: string[];
  correctIndex?: number;
  /** QT-1: multi-select answer key (sorted+distinct canonical set). */
  correctIndices?: number[];
  explanation?: string;
};

/**
 * Lecturer: open a class, create a quiz, open the builder, and add questions
 * by hand. Returns nothing (the builder is left open on the quiz).
 *
 * Extracted from the inlined E1b/E2 patterns so E4/E5/E10/E11 reuse it
 * (deliberate refactor to cut duplication).
 */
export async function createQuizWithQuestions(
  page: Page,
  opts: {
    classTitle: string;
    quizTitle: string;
    mode?: "practice" | "assessment";
    questions: QuestionInput[];
    publish?: boolean;
    /** QT-3: check "Shuffle question & option order" before creating. */
    shuffle?: boolean;
  },
) {
  // Open the class.
  await page.getByText(opts.classTitle, { exact: true }).click();
  await expect(page).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
  await expect(page.getByRole("heading", { name: opts.classTitle })).toBeVisible();

  // Create the quiz.
  await page.getByLabel("Quiz title").fill(opts.quizTitle);
  if (opts.mode === "assessment") {
    await page.getByLabel("Mode").click();
    await page.getByRole("option", { name: "Assessment" }).click();
  }
  if (opts.shuffle) {
    // Base UI Switch renders BOTH a role="switch" span and a hidden form
    // input, so getByLabel().check() strict-violates. The switch role is the
    // stable target (same pattern as e37).
    await page.getByRole("switch", { name: /shuffle question/i }).click();
  }
  await page.getByRole("button", { name: /create quiz|new quiz/i }).click();
  await expect(page.getByText(opts.quizTitle, { exact: true })).toBeVisible();
  await page.getByText(opts.quizTitle, { exact: true }).click();
  await expect(page).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);
  await expect(page.getByRole("heading", { name: opts.quizTitle })).toBeVisible();

  // Add each question.
  for (const q of opts.questions) {
    if (q.type === "true_false") {
      await page.getByLabel("Type").click();
      await page.getByRole("option", { name: "True / False" }).click();
    }
    if (q.type === "multi_select") {
      await page.getByLabel("Type").click();
      await page.getByRole("option", { name: "Multi-select" }).click();
    }
    await page.getByRole("textbox", { name: "Question prompt" }).fill(q.prompt);

    // Fill options 1..N, adding extra option inputs as needed. True/False
    // options are disabled (auto-filled True/False) — skip filling them.
    if (q.type !== "true_false") {
      await page.getByLabel("Option 1").fill(q.options[0] ?? "");
      if (q.options.length >= 2) await page.getByLabel("Option 2").fill(q.options[1] ?? "");
      for (let i = 2; i < q.options.length; i++) {
        await page.getByRole("button", { name: /add option/i }).click();
        await page.getByRole("textbox", { name: `Option ${i + 1}` }).fill(q.options[i]);
      }
    }

    if (q.type === "multi_select") {
      // QT-1: correct ANSWERS are a toggle-button group ("Correct answers");
      // switching to multi seeds Option 1 as marked, so toggle to the exact
      // target set.
      const target = q.correctIndices ?? [];
      const group = page.getByRole("group", { name: "Correct answers" });
      for (let i = 0; i < q.options.length; i++) {
        const toggle = group.getByRole("button", { name: `Option ${i + 1}` });
        const pressed = (await toggle.getAttribute("aria-pressed")) === "true";
        if (target.includes(i) !== pressed) {
          await toggle.click();
        }
      }
    } else if (q.correctIndex !== undefined && q.correctIndex !== 0 && q.type !== "true_false") {
      // Set the correct answer (defaults to option 1).
      await page.getByLabel("Correct answer").click();
      await page.getByRole("option", { name: String(q.correctIndex + 1) }).click();
    }

    // Optional explanation (practice disclosure assertions).
    if (q.explanation) {
      await page.getByLabel("Explanation (optional)").fill(q.explanation);
    }

    await page.getByRole("button", { name: /add this question/i }).click();
    // The save completes when the form resets (Question field cleared).
    await expect(page.getByRole("textbox", { name: "Question prompt" })).toHaveValue("");
    await expect(page.getByText(q.prompt, { exact: true })).toBeVisible();
  }

  if (opts.publish) {
    const publishButton = page.getByRole("button", { name: /publish/i });
    await expect(publishButton).toBeEnabled();
    await publishButton.click();
    await expect(page.getByText(/^Live/)).toBeVisible();
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
  }
}

// ── Phase 6 gesture helpers ─────────────────────────────────────────────

type FakeSegment = { present?: boolean; fingers: number; holdMs: number };

/**
 * Install the fake hand tracker. `addInitScript` alone is insufficient: the
 * student flow uses Next.js client-side (SPA) navigation, which does NOT
 * create a new document, so the init script would never run in the already-
 * loaded page. Therefore we BOTH:
 *  1. `addInitScript` — covers any future full page load (reloads, direct URL
 *     navigation) so the global survives across documents.
 *  2. `page.evaluate` — installs into the CURRENT document immediately (covers
 *     the SPA Start → /play navigation).
 * Must be called BEFORE the student clicks Start. E8/E9/E9b assert the global
 * exists after landing so an install-ordering regression fails loudly.
 */
export async function installFakeHandTracker(page: Page) {
  await page.addInitScript(fakeHandTrackerInit);
  await page.evaluate(fakeHandTrackerInit);
}

/**
 * Replay a scripted hand sequence via `window.__INNOVISION_FAKE_HAND_CONTROL__`.
 * Segments are `{ present?, fingers, holdMs }`; `present` defaults to
 * `fingers > 0` (a fist differs from a lost hand).
 */
export async function playGestureSequence(page: Page, segments: FakeSegment[]) {
  await page.evaluate((s) => {
    const ctrl = (window as unknown as {
      __INNOVISION_FAKE_HAND_CONTROL__?: { sequence(s: unknown): void };
    }).__INNOVISION_FAKE_HAND_CONTROL__;
    if (!ctrl) throw new Error("fake hand control not installed");
    ctrl.sequence(s);
  }, segments);
}

/** Push a continuous hand state (used for the pause-clear stabilization wait). */
export async function fakeHandFrame(page: Page, handPresent: boolean, fingerCount: number) {
  await page.evaluate(
    ([hp, fc]) => {
      const ctrl = (window as unknown as {
        __INNOVISION_FAKE_HAND_CONTROL__?: { frame(hp: boolean, fc: number): void };
      }).__INNOVISION_FAKE_HAND_CONTROL__;
      if (!ctrl) throw new Error("fake hand control not installed");
      ctrl.frame(hp, fc);
    },
    [handPresent, fingerCount] as const,
  );
}

/**
 * Assert the fake-tracker global is installed (fail loudly if the
 * install-ordering contract was violated).
 */
export async function assertFakeHandTrackerInstalled(page: Page) {
  const installed = await page.evaluate(
    () =>
      typeof (window as unknown as { __INNOVISION_FAKE_HAND_TRACKER__?: unknown })
        .__INNOVISION_FAKE_HAND_TRACKER__ === "object",
  );
  expect(installed).toBe(true);
}

/**
 * Complete the calibration panel: wait for Continue (enabled once the tracker
 * is ready) and click it. The first question has NO scan countdown, so there
 * is nothing to wait for after calibration.
 */
export async function completeCalibration(page: Page) {
  const continueBtn = page.getByRole("button", { name: "Continue", exact: true });
  await expect(continueBtn).toBeEnabled({ timeout: 15_000 });
  await continueBtn.click();
  // The calibration panel disappears once gestures go active.
  await expect(page.getByText("Hand gestures", { exact: true })).toBeHidden();
}

/**
 * Two-phase scan-clear wait on `data-testid="scan-overlay"`:
 * first wait for it to become VISIBLE (proving the scan actually started — a
 * bare hidden-wait would resolve immediately if the overlay hasn't mounted
 * yet), then wait for it to be hidden/detached. Call BEFORE every post-answer
 * sequence: the 1200ms scan would otherwise discard a 950ms hold.
 */
export async function waitForScanClear(page: Page) {
  const overlay = page.getByTestId("scan-overlay");
  await expect(overlay).toBeVisible({ timeout: 5_000 });
  await expect(overlay).toBeHidden({ timeout: 5_000 });
}

/**
 * Arm a collector for answer POST bodies (`/api/sessions/{id}/answer`).
 * Returns `{ bodies, clear, detach }` so the positive and negative assertions
 * share one implementation (extracted from E11's inline pattern).
 */
export function captureAnswerPosts(page: Page) {
  const bodies: string[] = [];
  const listener = (req: { url(): string; method(): string; postData(): string | null }) => {
    if (req.url().includes("/answer") && req.method() === "POST") {
      bodies.push(req.postData() ?? "");
    }
  };
  page.on("request", listener);
  return {
    bodies,
    detach() {
      page.off("request", listener);
    },
  };
}

/**
 * Assert NO answer POST with `"selectedIndex": forIndex` arrives within
 * `windowMs`. Returns the collected bodies so the positive assertion can
 * consume the same capture. (Used by E9's accidental-lock guard.)
 */
export async function expectNoAnswerPost(
  page: Page,
  { forIndex, windowMs }: { forIndex: number; windowMs: number },
) {
  const capture = captureAnswerPosts(page);
  await page.waitForTimeout(windowMs);
  capture.detach();
  const leaked = capture.bodies.some((b) => {
    try {
      return (JSON.parse(b) as { selectedIndex?: number }).selectedIndex === forIndex;
    } catch {
      return false;
    }
  });
  expect(leaked, `no answer POST should target index ${forIndex}`).toBe(false);
  return capture.bodies;
}

// ── Phase 7 face helpers ─────────────────────────────────────────────

/**
 * Install the fake face tracker (BOTH addInitScript for future full loads AND
 * page.evaluate for the current SPA document — mirrors installFakeHandTracker).
 * Must be called BEFORE the student clicks Start.
 */
export async function installFakeFaceTracker(page: Page) {
  await page.addInitScript(fakeFaceInit);
  await page.evaluate(fakeFaceInit);
}

/** Set the fake face verify mode: 'match' (V) or 'mismatch' (−V). */
export async function setFaceVerifyMode(page: Page, mode: "match" | "mismatch") {
  await page.evaluate((m) => {
    const ctrl = (window as unknown as {
      __INNOVISION_FAKE_FACE_CONTROL__?: { setVerifyMode(m: string): void };
    }).__INNOVISION_FAKE_FACE_CONTROL__;
    if (!ctrl) throw new Error("fake face control not installed");
    ctrl.setVerifyMode(m);
  }, mode);
}

/** Trigger a blink via the fake face control (resolves waitForBlink). */
export async function triggerFaceBlink(page: Page) {
  await page.evaluate(() => {
    const ctrl = (window as unknown as {
      __INNOVISION_FAKE_FACE_CONTROL__?: { triggerBlink(): void };
    }).__INNOVISION_FAKE_FACE_CONTROL__;
    if (!ctrl) throw new Error("fake face control not installed");
    ctrl.triggerBlink();
  });
}

/** Override the periodic cadence (E12 deterministic observation). */
export async function setFacePeriodic(page: Page, opts: { minMs: number; maxMs: number }) {
  await page.evaluate((o) => {
    const ctrl = (window as unknown as {
      __INNOVISION_FAKE_FACE_CONTROL__?: { setFacePeriodic(o: { minMs: number; maxMs: number }): void };
    }).__INNOVISION_FAKE_FACE_CONTROL__;
    if (!ctrl) throw new Error("fake face control not installed");
    ctrl.setFacePeriodic(o);
  }, opts);
}

/**
 * Script the fake tracker's pose state — drives the `second_face` /
 * `looked_away` advisories and the pipeline's lighting precheck in E2E.
 */
export async function setFacePose(
  page: Page,
  opts: {
    yaw?: number;
    centered?: boolean;
    faceDetected?: boolean;
    facesSeen?: number;
    lighting?: "good" | "too_dark" | "too_bright";
  },
) {
  await page.evaluate((o) => {
    const ctrl = (window as unknown as {
      __INNOVISION_FAKE_FACE_CONTROL__?: {
        setFacePose?(o: {
          yaw?: number;
          centered?: boolean;
          faceDetected?: boolean;
          facesSeen?: number;
          lighting?: "good" | "too_dark" | "too_bright";
        }): void;
      };
    }).__INNOVISION_FAKE_FACE_CONTROL__;
    if (!ctrl?.setFacePose) throw new Error("fake face control lacks setFacePose");
    ctrl.setFacePose(o);
  }, opts);
}

/** Enroll via the face-enroll page (consent + 3-angle capture + submit). */
export async function enrollViaFacePage(page: Page) {
  await page.goto("/student/face/enroll");
  // Consent (if not already given via registration) — the enroll page renders
  // a single consent CHECKBOX card pre-consent; checking it POSTs consent and
  // gates the camera boot.
  const consentBox = page.getByRole("checkbox");
  if (await consentBox.isVisible().catch(() => false)) {
    // The consent state flips only after the async consent POST resolves —
    // click (not check) and wait on the post-condition.
    await consentBox.click();
    await expect(page.getByText("Biometric consent", { exact: false }).first()).toBeHidden({
      timeout: 15_000,
    });
  }
  // Wait for the enroll panel to settle (the boot microtask flips `available`;
  // a button-only `isVisible()` can race the unavailable panel). Either the
  // capture button or the already-enrolled state appears.
  const startBtn = page.getByRole("button", { name: "Start capture", exact: true });
  await expect(startBtn.or(page.getByText("Face already enrolled", { exact: false }))).toBeVisible({
    timeout: 15_000,
  });
  if (await startBtn.isVisible().catch(() => false)) {
    await setFacePose(page, {
      yaw: 0,
      centered: true,
      faceDetected: true,
      facesSeen: 1,
      lighting: "good",
    });
    await startBtn.click();
    // 3 guided angles (front → left → right); one blink per angle, synced on
    // the EXACT per-angle prompt. The wizard also gates each SIDE angle on
    // head pose — the fake pose stream must turn with the prompt.
    const angleScript = [
      { label: "Front", yaw: 0 },
      { label: "Left", yaw: 25 },
      { label: "Right", yaw: -25 },
    ] as const;
    for (const angle of angleScript) {
      await setFacePose(page, {
        yaw: angle.yaw,
        centered: true,
        faceDetected: true,
        facesSeen: 1,
        lighting: "good",
      });
      await expect(
        page.getByText(new RegExp(`Blink now[^\\n]*${angle.label}`, "i")),
      ).toBeVisible({ timeout: 15_000 });
      await triggerFaceBlink(page);
    }
    // Capture completes (3 angles) → success panel (the wizard no longer
    // auto-redirects); land on quizzes for the caller.
    await expect(
      page.getByText("Enrolled successfully", { exact: false }),
    ).toBeVisible({ timeout: 30_000 });
    await page.goto("/student/quizzes");
  } else {
    // Already enrolled — nothing to do.
    await expect(page.getByText("Face already enrolled", { exact: false })).toBeVisible();
  }
}

/**
 * Click the explicit-Begin gate CTA and resolve its blink liveness via the
 * fake tracker. Parks the virtual cursor afterwards (same rationale as
 * `passAssessmentGate`) — use for RE-Entering the gate mid-quiz (fail-cycle
 * specs), where the parked cursor would otherwise sit on an option button's
 * hover-edge band and oscillate it ±2px every frame.
 */
export async function clickBeginAndBlink(page: Page) {
  const begin = page.getByRole("button", { name: "Begin assessment", exact: true });
  await expect(begin).toBeEnabled({ timeout: 15_000 });
  await begin.click();
  await triggerFaceBlink(page);
  await page.mouse.move(0, 0);
}

/** Pass the assessment gate: click Begin (beginGate waits for liveness), then trigger the blink. */
export async function passAssessmentGate(page: Page) {
  const begin = page.getByRole("button", { name: "Begin assessment", exact: true });
  await expect(begin).toBeEnabled({ timeout: 15_000 });
  await begin.click();
  // beginGate runs blink liveness first — the fake resolves it via triggerBlink.
  await triggerFaceBlink(page);
  // Gate disappears → the quiz content mounts.
  await expect(page.getByRole("button", { name: "Begin assessment", exact: true })).toBeHidden({
    timeout: 10_000,
  });
  // Park the virtual cursor at a neutral corner. The Begin click leaves it
  // where Begin was; if the post-gate reflow puts that point inside an option
  // button's 2px hover-edge band (`hover:-translate-y-0.5`), the lift moves
  // the edge past the cursor and the hover oscillates ±2px EVERY FRAME —
  // Playwright then reports "element is not stable" forever.
  await page.mouse.move(0, 0);
}

/** Capture face-verify POST bodies (`/api/face/verify`). */
export function captureFaceVerifyPosts(page: Page) {
  const bodies: string[] = [];
  const listener = (req: { url(): string; method(): string; postData(): string | null }) => {
    if (req.url().includes("/api/face/verify") && req.method() === "POST") {
      bodies.push(req.postData() ?? "");
    }
  };
  page.on("request", listener);
  return {
    bodies,
    detach() {
      page.off("request", listener);
    },
  };
}

/** Wait for the paused overlay (face mismatch → blink recovery). */
export async function waitForPauseOverlay(page: Page) {
  await expect(page.getByText("Face check paused", { exact: true })).toBeVisible({ timeout: 15_000 });
}

/** Click "Blink to recover", then trigger the fake blink to recover from paused. */
export async function recoverFromPause(page: Page) {
  const btn = page.getByRole("button", { name: "Blink to recover", exact: true });
  await expect(btn).toBeVisible({ timeout: 10_000 });
  await btn.click();
  // runRecovery calls waitForBlink — resolve it via the fake.
  await triggerFaceBlink(page);
  // The paused overlay clears once recovered.
  await expect(page.getByText("Face check paused", { exact: true })).toBeHidden({ timeout: 10_000 });
}

/** Wait for the flagged overlay (3 fails → lecturer decision). */
export async function waitForFlaggedOverlay(page: Page) {
  await expect(page.getByText("Assessment flagged", { exact: true })).toBeVisible({ timeout: 20_000 });
}

// ── Phase 8 results/attendance helpers ──────────────────────────────────

/**
 * Phase 8: create an UNTIMED assessment quiz with questions and publish it.
 * Wraps `createQuizWithQuestions` with the assessment mode (the raw helper
 * defaults to practice — used by E4/E8/E9/E9c; effort-2 builds the mode here).
 */
export async function createAssessmentAndPublish(
  page: Page,
  opts: {
    classTitle: string;
    quizTitle: string;
    questions: QuestionInput[];
  },
) {
  await createQuizWithQuestions(page, {
    classTitle: opts.classTitle,
    quizTitle: opts.quizTitle,
    mode: "assessment",
    questions: opts.questions,
    publish: true,
  });
}

/**
 * Phase 8: open the Results dashboard for a quiz from the lecturer's class
 * list. The Results link is only rendered for non-draft quizzes, so callers
 * must publish first. Navigates deterministically: My Classes → class → quiz
 * builder → Results (the header link is only present on the builder).
 */
export async function openResults(page: Page, classTitle: string, quizTitle: string) {
  // Return to the class list first (the caller may be on the builder).
  await page.goto("/lecturer/classes");
  await expect(page.getByRole("heading", { name: /My Classes|Kelas Saya/i })).toBeVisible();
  await page.getByText(classTitle, { exact: true }).click();
  await expect(page).toHaveURL(/\/lecturer\/classes\/[^/]+$/);

  const directResultsLink = page.getByRole("link", { name: new RegExp(`results.*${quizTitle}|${quizTitle}.*results`, "i") });
  if (await directResultsLink.count() > 0) {
    await directResultsLink.first().click();
  } else {
    await page.getByText(quizTitle, { exact: true }).click();
    await expect(page).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);
    await page.getByRole("link", { name: /results/i }).first().click();
  }
  await expect(page).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/results/);
}

/**
 * Phase 13: lecturer reveals the assessment's results on the results page.
 * Opens /lecturer/quizzes/[id]/results, confirms the reveal dialog, and waits
 * for the "Results revealed" chip. Reveal is ONE-WAY (no un-reveal).
 */
export async function revealQuiz(page: Page, classTitle: string, quizTitle: string) {
  await openResults(page, classTitle, quizTitle);
  const revealButton = page.getByRole("button", { name: /reveal to students/i });
  await expect(revealButton).toBeVisible();
  await revealButton.click();
  // The confirm button reuses the same label ("Reveal to students") inside
  // the dialog — pick the one that is now ENABLED.
  const confirmBtn = page.getByRole("button", { name: /reveal/i }).last();
  await expect(confirmBtn).toBeEnabled();
  await confirmBtn.click();
  await expect(page.getByText("Results revealed", { exact: true })).toBeVisible({ timeout: 10_000 });
}

/**
 * QC-1: lecturer closes a LIVE quiz from the results dashboard. Opens the
 * close dialog, confirms, and waits for the Close control to disappear
 * (status flipped → terminal). Close is ONE-WAY (no re-open).
 *
 * Selector note: the dialog renders an X dismiss button whose sr-only label
 * is `common.close` ("Close") — a bare /close/i .last() would hit the X, not
 * the destructive confirm. Match the confirm's actual labels instead.
 */
export async function closeQuiz(page: Page, classTitle: string, quizTitle: string) {
  await openResults(page, classTitle, quizTitle);
  const closeBtn = page.getByRole("button", { name: /close quiz/i });
  await expect(closeBtn).toBeVisible();
  await closeBtn.click();
  const dialog = page.getByRole("dialog");
  const confirmBtn = dialog.getByRole("button", { name: /close quiz|close anyway/i });
  await expect(confirmBtn).toBeEnabled();
  await confirmBtn.click();
  await expect(page.getByRole("button", { name: /close quiz/i })).toBeHidden({ timeout: 10_000 });
}

/**
 * Phase 8 service-role client for E2E seeding/cleanup. Two-gated seam:
 *  1. Node-context only (Playwright spec files run in Node, never in the
 *     browser — NOT a security gate by itself).
 *  2. Equality check that the service URL host is in the explicit allow-list
 *     `{127.0.0.1, localhost}` (NOT a substring match). This is the real gate.
 * App code never references this; only E2E specs do.
 */
export function resolveServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  const host: string = new URL(url).hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.warn(`resolveServiceClient: refusing non-local host "${host}"`);
    return null;
  }
  // Dynamic import to avoid pulling supabase-js into the spec's static graph
  // when the environment can't support it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createClient } = require("@supabase/supabase-js") as typeof import("@supabase/supabase-js");
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

/**
 * Phase 8: deterministically mark an existing assessment session as abandoned
 * (E13b's D-student). MUST be an UPDATE (never INSERT — the 0032 partial
 * unique index `one_active_assessment_attempt` forbids a second NON-completed
 * assessment session for an existing (quiz, student)). Returns the admin
 * client so callers can reuse the same connection for cleanup; returns null
 * when the seam is unavailable (the spec skips the abandoned sub-assertion —
 * belt-and-braces).
 */
export async function staleActiveSession(
  admin: ReturnType<typeof resolveServiceClient> | null,
  { sessionId, lastActivityAt }: { sessionId: string; lastActivityAt: string },
) {
  if (!admin) return null;
  const { error } = await admin
    .from("quiz_sessions")
    .update({ last_activity_at: lastActivityAt, status: "active" })
    .eq("id", sessionId);
  return error ? null : sessionId;
}

// ── RA-1 / SQ-2 shared helpers (e39/e40) ────────────────────────────────

/**
 * Complete the CURRENT quiz in the play UI: answer every question, then
 * Finish. Each `answers[i]` is the option TEXT to click (option buttons'
 * accessible names are "<letter> <text>", e.g. "B 4" — e18/e13 convention:

 * match by unique option text, never by letter or index). Assumes the page
 * is on /play/[sessionId] with the first question rendered. Returns the
 * session id parsed from the URL. Fail-fast: every await uses the spec's
 * `fast` budget — no fixed sleeps.
 */
export async function completeQuiz(
  page: Page,
  answers: string[],
  labels: { next: string; finish: string },
) {
  const sessionId = currentSessionId(page);
  for (let i = 0; i < answers.length; i++) {
    await page.getByRole("button", { name: answers[i] }).click();
    if (i < answers.length - 1) {
      await page.getByRole("button", { name: labels.next, exact: true }).click();
    } else {
      await page.getByRole("button", { name: labels.finish, exact: true }).click();
    }
  }
  return sessionId;
}

/**
 * Start a SPECIFIC quiz from the student quiz list by scoping to its card
 * (quizzes render created_at DESC, so a bare .first() is whatever is
 * newest — never rely on ordering).
 */
export async function startQuizByTitle(page: Page, quizTitle: string) {
  await page
    .locator("li")
    .filter({ hasText: quizTitle })
    .getByRole("button", { name: "Start", exact: true })
    .click();
  await expect(page).toHaveURL(/\/play\/[0-9a-f-]+/);
}

/**
 * Parse the /play/[uuid] session id from the page's current URL (e36/e37
 * pattern, extracted so specs stop re-inlining the regex).
 */
export function currentSessionId(page: Page): string {
  const match = /\/play\/([0-9a-f-]{36})/i.exec(page.url());
  if (!match) throw new Error(`currentSessionId: not on a /play/[uuid] URL — ${page.url()}`);
  return match[1];
}

/**
 * Enable retakes via the class-detail quiz-creation form — QC-4 config is a
 * CREATION-time setting (class-detail-client.tsx), not a builder dialog.
 * Call BEFORE clicking create: checks "Allow retake" and picks the attempts
 * count on the class page's quiz form.
 */
export async function configureRetakesOnCreate(page: Page, maxAttempts: number) {
  await page.getByLabel(/allow retake/i).check();
  await page.getByLabel(/max attempts/i).selectOption(String(maxAttempts));
}

/**
 * Turn on auto-reveal-on-complete for a quiz via the reveal-settings API from
 * the lecturer's AUTHENTICATED context (no UI dependency). e40 case 3.
 */
export async function setAutoReveal(request: APIRequestContext, quizId: string) {
  const res = await request.patch(`/api/quizzes/${quizId}/reveal-settings`, {
    data: { auto_reveal_on_complete: true },
  });
  if (!res.ok()) {
    throw new Error(`setAutoReveal failed: ${res.status()} ${await res.text()}`);
  }
}

/**
 * Flag the CURRENT in-progress session by driving 3 face-check mismatches
 * (wraps setFaceVerifyMode + waitForFlaggedOverlay). Requires the fake face
 * tracker to be installed and an assessment in progress.
 */
export async function flagCurrentSession(page: Page) {
  await setFaceVerifyMode(page, "mismatch");
  await waitForFlaggedOverlay(page);
}

/**
 * Parse an xlsx buffer/Path into an ExcelJS workbook (e18 pattern, extracted).
 */
export async function loadWorkbook(path: string) {
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return wb;
}

