import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  registerUser,
  createClass,
  createAssessmentAndPublish,
  createQuizWithQuestions,
  startQuizByTitle,
  joinClass,
  openResults,
  installFakeFaceTracker,
  enrollViaFacePage,
  passAssessmentGate,
  setFaceVerifyMode,
  clickBeginAndBlink,
  waitForPauseOverlay,
  recoverFromPause,
  resolveServiceClient,
} from "./helpers";

/**
 * E-63 — the incident-clip route end to end (0020 R7 / audits 2-4 R2-INC).
 *
 * The CLIENT half of the recorder (`useIncidentRecorder` — ring buffer,
 * MediaRecorder capture, flush-on-incident) is deliberately DISABLED under
 * the e2e fake seam (play-client.tsx `!isFakeFace`): headless runs must not
 * exercise a real getUserMedia/MediaRecorder path. So the client-side
 * privacy contract (upload ONLY on an incident edge, discard on clean
 * submit) stays pinned by the unit suite (`incident-transition.test.ts`).
 *
 * What no test covered until now is the ROUTE half — the multipart wire
 * contract and everything a tampered/honest client hits after `fetch`:
 *   * POST /api/sessions/[id]/incident with a valid WebM blob lands:
 *     200 `{ok:true}`, an `incident_clips` row, and the object in the
 *     PRIVATE `incident-footage` bucket (asserted indirectly — the row's
 *     storage_path only ever becomes visible through the signed URL)
 *   * the `notify_incident_clip` trigger (0022) mints the lecturer
 *     notification `incident_clip_recorded` (hour-bucketed dedupe)
 *   * the magic-byte sniff rejects arbitrary bytes ("not a recognized video
 *     container") and an EMPTY file — mislabeled payloads never reach storage
 *   * practice sessions are refused (assessment-only channel)
 *   * a completed session no longer accepts clips (post-submit bloat guard)
 *   * a foreign/unknown session id 404s without an existence oracle
 *   * the lecturer's results dashboard renders the clip under the expanded
 *     row ("Incident footage…", reason + duration meta) with a signed URL
 *
 * The incident trigger is REAL where it can be (test 1: fake-tracker
 * mismatch cycles → paused, the same edge the client would flush on); the
 * upload itself is driven via the student's page.request — exactly the wire
 * the recorder's uploadClip() produces.
 */

const INVITE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E63 Incident";
const QUIZ_TITLE = "E63 Footage";

/**
 * Re-stamped for EVERY attempt (beforeEach), so a Playwright RETRY mints
 * fresh emails instead of colliding with the accounts its first attempt
 * already registered (a duplicate email would need the sign-in recovery
 * path). The quiz/class titles stay stable — the DB lookups below are
 * newest-first for exactly that reason.
 */
let stamp = Date.now();
test.beforeEach(() => {
  stamp = Date.now();
});

/** Multipart POST exactly like use-incident-recorder.ts uploadClip(). */
async function uploadClip(
  request: import("@playwright/test").APIRequestContext,
  sessionId: string,
  opts: { fixture: string; filename: string; reason: string; durationMs?: number },
) {
  const buffer = await readFile(opts.fixture);
  return request.post(`/api/sessions/${sessionId}/incident`, {
    multipart: {
      clip: {
        name: opts.filename,
        mimeType: opts.filename.endsWith(".mp4") ? "video/mp4" : "video/webm",
        buffer,
      },
      reason: opts.reason.slice(0, 40),
      durationMs: String(opts.durationMs ?? 5_000),
      recordedFrom: new Date(Date.now() - 30_000).toISOString(),
    },
  });
}

test.describe.configure({ mode: "serial" });

test.describe("E-63 — incident clip route", () => {
  test("real pause edge → valid clip lands, notification + dashboard footage", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(300_000);
    test.skip(!INVITE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    const lecturerEmail = `lecturer-e63-${stamp}@innovision.test`;
    const studentEmail = `student-e63-${stamp}@innovision.test`;
    await registerUser(lecturerPage, lecturerEmail, "lecturer", INVITE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    await createAssessmentAndPublish(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_TITLE,
      // FACE ON — the incident edge is a face-mismatch pause.
      questions: [{ prompt: "What is 2+2?", options: ["3", "4"], correctIndex: 1 }],
    });

    await registerUser(studentPage, studentEmail, "student", INVITE);
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await installFakeFaceTracker(studentPage);
    await enrollViaFacePage(studentPage);
    await expect(studentPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    const sessionId = /\/play\/([0-9a-f-]{36})/.exec(studentPage.url())?.[1];
    expect(sessionId, "the play URL must carry the session id").toBeTruthy();

    // The REAL incident edge, choreographed exactly like E6: mismatch BEFORE
    // Begin (the 'start' verify fails) → the paused overlay; a later recovery
    // lands back in the gate. The upload happens WHILE PAUSED (an accepted
    // collectable status — the route allows active/paused/flagged), exactly
    // as the client's flush would.
    await setFaceVerifyMode(studentPage, "mismatch");
    await clickBeginAndBlink(studentPage);
    await waitForPauseOverlay(studentPage);

    // Upload WHILE PAUSED (an accepted collectable status — the route allows
    // active/paused/flagged), exactly as the client's flush would.
    const res = await uploadClip(studentPage.request, sessionId!, {
      fixture: "e2e/fixtures/incident-clip.webm",
      filename: "clip.webm",
      reason: "face",
    });
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).ok).toBe(true);

    // One incident_clips row, owned by this session, with our reason.
    const admin = resolveServiceClient();
    if (!admin) throw new Error("service-role seam unavailable");
    const { data: clips } = await admin
      .from("incident_clips")
      .select("id, reason, duration_ms")
      .eq("session_id", sessionId!);
    expect(clips?.length).toBe(1);
    expect(clips![0].reason).toBe("face");
    expect(clips![0].duration_ms).toBe(5_000);

    // The 0022 trigger notified the quiz's lecturer (digest-tier type).
    // profiles carries NO email column — resolve the owner through the quiz's
    // class (classes.lecturer_id → profiles.id), which is also the id the
    // notification trigger selects (c.lecturer_id). Newest-first + limit(1):
    // a Playwright RETRY re-runs this test with the SAME timestamp-derived
    // title, so a second quiz row exists and maybeSingle() would error.
    const { data: quizOwnerRows } = await admin
      .from("quizzes")
      .select("id, class_id")
      .eq("title", QUIZ_TITLE)
      .order("created_at", { ascending: false })
      .limit(1);
    const quizOwnerRow = quizOwnerRows?.[0];
    expect(quizOwnerRow, "the quiz row must exist").toBeTruthy();
    const { data: classOwnerRow } = await admin
      .from("classes")
      .select("lecturer_id")
      .eq("id", quizOwnerRow!.class_id)
      .maybeSingle();
    const lecturerId = classOwnerRow?.lecturer_id as string | undefined;
    expect(lecturerId, "the quiz owner must resolve").toBeTruthy();
    const { data: notifications } = await admin
      .from("notifications")
      .select("type, payload")
      .eq("recipient_id", lecturerId!)
      .eq("type", "incident_clip_recorded");
    expect(
      (notifications ?? []).some((n) => (n.payload as { session_id?: string }).session_id === sessionId),
      "the incident clip must notify the lecturer",
    ).toBe(true);

    // Recover so the session can be submitted cleanly (proof that a LATER
    // clean submit does not block the already-stored clip). The recovery
    // from a 'start'-verify pause lands back IN the gate (E6 parity), so the
    // resume path is: match frames → blink-recover → Begin(+blink) → answer.
    await setFaceVerifyMode(studentPage, "match");
    await recoverFromPause(studentPage);
    await passAssessmentGate(studentPage);
    await studentPage.getByRole("button", { name: /4/ }).click();
    const nextBtn = studentPage.getByRole("button", { name: /^(finish|next)$/i });
    await expect(nextBtn).toBeVisible({ timeout: 30_000 });
    await nextBtn.click();
    await expect(
      studentPage.getByText(/results will be released|awaiting/i).first(),
    ).toBeVisible({ timeout: 30_000 });

    // The dashboard renders the clip under the expanded row with meta.
    await openResults(lecturerPage, CLASS_TITLE, QUIZ_TITLE);
    const row = lecturerPage
      .locator("li")
      .filter({ hasText: studentEmail.split("@")[0] })
      .first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    // The row's EXPANDER is the student-name button (aria-expanded); the
    // "Session actions" dropdown trigger also carries aria-expanded, so
    // exclude the menu trigger (aria-haspopup) to stay unambiguous.
    await row.locator("button[aria-expanded]:not([aria-haspopup])").click();
    await expect(
      lecturerPage.getByText("Incident footage (auto-recorded before the incident)"),
    ).toBeVisible();
    await expect(lecturerPage.getByText(/face · 5s · from/)).toBeVisible();
    // The <video> points at a SIGNED url (the bucket is private): Supabase's
    // signing shape is /object/sign/<bucket>/<path>?token=<jwt>.
    const videoSrc = await lecturerPage.locator("video").first().getAttribute("src");
    expect(videoSrc, "clips play through signed URLs").toMatch(
      /\/storage\/v1\/object\/sign\/incident-footage\/.+[?&]token=/,
    );

    await lecturerCtx.close();
    await studentCtx.close();
  });

  test("bad bytes, empty file, practice sessions, foreign ids, completed sessions", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(180_000);
    test.skip(!INVITE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await registerUser(
      lecturerPage,
      `lecturer-e63b-${stamp}@innovision.test`,
      "lecturer",
      INVITE,
    );
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    // Per-attempt titles: a RETRY re-runs this body, and a re-used class
    // title would strict-mode-violate the title clicks below (the practice
    // card also keeps a non-terminal session from the first attempt, which
    // flips its Start into a Resume).
    const classTitle = `${CLASS_TITLE} B ${stamp}`;
    const assessmentTitle = `${QUIZ_TITLE} B ${stamp}`;
    const practiceTitle = `${QUIZ_TITLE} Practice ${stamp}`;
    const joinCode = await createClass(lecturerPage, classTitle);
    // An ASSESSMENT (accepts clips) and a PRACTICE quiz (must refuse them).
    await createAssessmentAndPublish(lecturerPage, {
      classTitle,
      quizTitle: assessmentTitle,
      gesturesOff: true,
      questions: [{ prompt: "What is 2+2?", options: ["3", "4"], correctIndex: 1 }],
    });
    await createQuizWithQuestions(lecturerPage, {
      classTitle,
      quizTitle: practiceTitle,
      mode: "practice",
      publish: true,
      gesturesOff: true,
      questions: [{ prompt: "Practice q?", options: ["a", "b"], correctIndex: 0 }],
    });

    await registerUser(studentPage, `student-e63b-${stamp}@innovision.test`, "student", INVITE);
    await joinClass(studentPage, joinCode, classTitle);
    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    await startQuizByTitle(studentPage, assessmentTitle);
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    const assessmentSessionId = /\/play\/([0-9a-f-]{36})/.exec(studentPage.url())?.[1];
    expect(assessmentSessionId).toBeTruthy();

    // (1) Magic-byte sniff: bytes that are neither EBML nor ftyp.
    let res = await uploadClip(studentPage.request, assessmentSessionId!, {
      fixture: "e2e/fixtures/not-image.txt",
      filename: "clip.webm",
      reason: "face",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toMatch(/not a recognized video container/i);

    // (2) An EMPTY blob.
    res = await studentPage.request.post(`/api/sessions/${assessmentSessionId}/incident`, {
      multipart: {
        clip: { name: "clip.webm", mimeType: "video/webm", buffer: Buffer.alloc(0) },
        reason: "face",
        durationMs: "1000",
        recordedFrom: new Date().toISOString(),
      },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toMatch(/empty/i);

    // (3) Practice sessions never accept clips. The practice route is
    // /play/student/[quizId] and the student id is RANDOM (practice rejoin
    // mints a fresh session) — but the route gate only needs the quiz id to
    // be uuid-valid to reach the mode check; a random uuid session can't be
    // probed without an owner. Instead drive a REAL practice session id:
    // start the practice quiz and read its session from the DB by (quiz,
    // mode) — the RPC rejoin makes exactly one active row.
    //
    // Navigate back to the quiz LIST first: the assessment start above left
    // the student on /play, which carries no quiz cards.
    await studentPage.goto("/student/quizzes");
    await startQuizByTitle(studentPage, practiceTitle);
    // Class-owned practice quizzes play at /play/[sessionId] (the client
    // pushes body.session.id); /play/student/[quizId] is the student-authored
    // route (e27).
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    const adminEarly = resolveServiceClient();
    if (!adminEarly) throw new Error("service-role seam unavailable");
    const { data: practiceQuizRow } = await adminEarly
      .from("quizzes")
      .select("id")
      .eq("title", practiceTitle)
      .maybeSingle();
    // profiles has no email column — the practice quiz was created by THIS
    // student, so its (quiz, mode) pair identifies the session uniquely.
    const { data: practiceSessions } = await adminEarly
      .from("quiz_sessions")
      .select("id, mode")
      .eq("quiz_id", practiceQuizRow!.id)
      .eq("mode", "practice")
      .limit(1);
    const practiceSessionId = practiceSessions?.[0]?.id as string;
    expect(practiceSessionId, "the practice session must exist").toBeTruthy();
    res = await uploadClip(studentPage.request, practiceSessionId, {
      fixture: "e2e/fixtures/incident-clip.webm",
      filename: "clip.webm",
      reason: "face",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toMatch(/only recorded for assessments/i);

    // (4) A foreign/unknown session id: the student's OWN cookie against a
    // random UUID → 404 without an existence oracle (e29 parity).
    res = await uploadClip(studentPage.request, crypto.randomUUID(), {
      fixture: "e2e/fixtures/incident-clip.webm",
      filename: "clip.webm",
      reason: "face",
    });
    expect(res.status()).toBe(404);

    // (5) COMPLETE the assessment, then the route must refuse (the
    // post-submit storage-bloat guard). This assessment was created with
    // gestures OFF, so the resumed session renders the question directly —
    // no Begin gate to pass.
    await studentPage.goto(`/play/${assessmentSessionId}`);
    await expect(
      studentPage.getByText("What is 2+2?", { exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await studentPage.getByRole("button", { name: /4/ }).click();
    const nextBtn = studentPage.getByRole("button", { name: /^(finish|next)$/i });
    await expect(nextBtn).toBeVisible({ timeout: 30_000 });
    await nextBtn.click();
    await expect(
      studentPage.getByText(/results will be released|awaiting/i).first(),
    ).toBeVisible({ timeout: 30_000 });
    res = await uploadClip(studentPage.request, assessmentSessionId!, {
      fixture: "e2e/fixtures/incident-clip.webm",
      filename: "clip.webm",
      reason: "face",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toMatch(/no longer accepts incident clips/i);

    // Sanity: NONE of the rejected uploads stored a row for THIS quiz's
    // sessions (test 1's clip belongs to the other quiz).
    const admin = resolveServiceClient();
    if (!admin) throw new Error("service-role seam unavailable");
    const { data: quizRow } = await admin
      .from("quizzes")
      .select("id")
      .eq("title", assessmentTitle)
      .maybeSingle();
    const { data: sessions } = await admin
      .from("quiz_sessions")
      .select("id")
      .eq("quiz_id", quizRow!.id);
    const { count } = await admin
      .from("incident_clips")
      .select("id", { count: "exact", head: true })
      .in("session_id", (sessions ?? []).map((s) => s.id));
    expect(count, "rejected uploads must store nothing").toBe(0);

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
