// Phase 8 results & attendance: security/RLS/RPC verification harness — runs
// against live local Supabase. This harness — NOT FakeSupabase — is the SOLE
// authoritative check for the `reset_session` RPC + `lecturer_audit_view`
// predicate semantics. FakeSupabase branches are route-mapping stubs kept in
// lockstep with migration 0011_results.sql.
//
// Covers gate tests (PLAN_PHASE8 §6 / §9):
//   D13-reset — reset_session as the quiz lecturer → {ok:true} +
//     deleted_session_id; audit_events row with action='session_reset',
//     actor_id=lecturer, subject_id=student, metadata.session_id/quiz_id set.
//   I21-D (live) — after a reset the student can start_quiz_session again
//     (one-attempt slot released); cascade verified: session_answers/
//     face_checks for the deleted id → 0 rows.
//   authZ — student → not_lecturer; second lecturer (different class) →
//     not_owner; non-existent id → not_owner; anon execute → denied;
//     practice-mode session → not_assessment (status unchanged, no audit row).
//   Status matrix — reset of active/paused/flagged/completed assessment
//     sessions → {ok:true} + audit row each. Status arrival is already proven
//     by verify-face.mjs's FLAT-window probes, so the target statuses are
//     SEEDED DIRECTLY via the service-role client (explicit + legitimate —
//     this harness tests only reset-on-status; noted in the plan header).
//   D-view — lecturer reads lecturer_audit_view:
//     (a) sees rows for THEIR class's student (both event_quiz_id and NULL-
//         event_quiz_id branches);
//     (b) projection key-absence (mirror D42's star-select): `select("*")`
//         returns exactly {id, actor_id, subject_id, action, created_at,
//         event_quiz_id, event_session_id} and metadata is ABSENT;
//     (c) cross-class isolation: student in BOTH classes, L2 resets a session
//         → L's read of that row → 0 rows (quiz-attributable branch gates it);
//     (d) documented legacy cross-lecturer visibility: the shared student's
//         legacy (NULL-event_quiz_id) unlock row IS visible to both L and L2
//         while enrolled — asserted + pinned as the subject-granular trade-off;
//     (e) self-unenroll: legacy rows become invisible; session_reset rows
//         (event_quiz_id set) remain visible;
//     (f) the student reads the view → 0 rows; raw audit_events SELECT as
//         lecturer → denied (privilege layer).
//   Race pin — reset concurrent with an in-flight answer_question: whichever
//     way the race resolves, the outcome is clean — a winning assessment
//     answer returns the keyless {recorded:true} ack, a losing one gets
//     not_owner (or session_not_active), and there is never a 500 / partial
//     write (atomic `for update`).
//   RPC error surface — the RPC's typed errors return cleanly (not_owner /
//     not_lecturer / not_assessment), never a thrown payload. The
//     503-on-transport/RPC-raise mapping is ROUTE-TEST-ONLY (a Node harness
//     cannot invoke Next.js route handlers) — see results-sessions-routes.test.ts.
//
// NOT a unit test; run manually: node scripts/verify-results.mjs
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertLocalTarget } from "./lib/target-guard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../.env.local");
const env = fs
  .readFileSync(envPath, "utf8")
  .split(/\r?\n/)
  .filter((l) => l && !l.trim().startsWith("#"))
  .reduce((acc, l) => {
    const idx = l.indexOf("=");
    if (idx > 0) acc[l.slice(0, idx).trim()] = l.slice(idx + 1).trim();
    return acc;
  }, {});

const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !ANON || !SERVICE) {
  console.error("Missing .env.local keys (NEXT_PUBLIC_SUPABASE_URL / ANON / SERVICE_ROLE).");
  process.exit(1);
}

assertLocalTarget(URL, "verify-results.mjs");

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const results = [];
const createdUsers = [];
const createdClassIds = [];
const createdQuizIds = [];

function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function createUser(email) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "hunter2!Secure",
    email_confirm: true,
    user_metadata: { full_name: email.split("@")[0] },
  });
  if (error) throw error;
  createdUsers.push(data.user.id);
  return data.user;
}

async function asUser(email) {
  const client = createClient(URL, ANON, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({
    email,
    password: "hunter2!Secure",
  });
  if (error) throw error;
  return client;
}

async function promoteLecturer(userId) {
  const { error } = await admin
    .from("profiles")
    .update({ role: "lecturer" })
    .eq("id", userId);
  if (error) throw error;
}

const JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeJoinCode() {
  let c = "";
  for (let i = 0; i < 6; i++) {
    c += JOIN_CODE_ALPHABET[Math.floor(Math.random() * JOIN_CODE_ALPHABET.length)];
  }
  return c;
}

function assertNoError(step, { error }) {
  if (error) throw new Error(`${step}: ${error.message}`);
}

async function main() {
  // ── Provision: lecturers L + L2, students S1/S2/S3 ─────────────────
  const lecturerL = await createUser(`resL-${stamp}@innovision.test`);
  const lecturerL2 = await createUser(`resL2-${stamp}@innovision.test`);
  const studentS1 = await createUser(`resS1-${stamp}@innovision.test`);
  await createUser(`resS2-${stamp}@innovision.test`);
  await promoteLecturer(lecturerL.id);
  await promoteLecturer(lecturerL2.id);

  const clientL = await asUser(`resL-${stamp}@innovision.test`);
  const clientL2 = await asUser(`resL2-${stamp}@innovision.test`);
  const clientS1 = await asUser(`resS1-${stamp}@innovision.test`);
  const clientS2 = await asUser(`resS2-${stamp}@innovision.test`);

  // ── L's class A (S1/S2/S3). L2's class B (S1 only — shared student) ──
  const codeA = makeJoinCode();
  const codeB = makeJoinCode();
  const { data: clsA, error: errA } = await clientL
    .from("classes")
    .insert({ title: "L's Results Class", lecturer_id: lecturerL.id, join_code: codeA })
    .select("id")
    .single();
  assertNoError("create class A", { error: errA });
  createdClassIds.push(clsA.id);
  const { data: clsB, error: errB } = await clientL2
    .from("classes")
    .insert({ title: "L2's Results Class", lecturer_id: lecturerL2.id, join_code: codeB })
    .select("id")
    .single();
  assertNoError("create class B", { error: errB });
  createdClassIds.push(clsB.id);

  for (const [client, code] of [[clientS1, codeA], [clientS2, codeA], [clientS1, codeB]]) {
    const { error } = await client.rpc("join_class", { code });
    assertNoError("join class", { error });
  }

  async function makeQuiz(lecturerClient, classId, lecturerId, title, { mode = "assessment", questions = ["a", "b", "c", "d"] } = {}) {
    const { data: quiz, error } = await lecturerClient
      .from("quizzes")
      .insert({ class_id: classId, created_by: lecturerId, title, status: "draft", mode, time_limit_sec: null })
      .select("id, class_id")
      .single();
    assertNoError("create quiz", { error });
    createdQuizIds.push(quiz.id);
    for (let i = 0; i < questions.length; i++) {
      const { error: qErr } = await lecturerClient
        .from("questions")
        .insert({ quiz_id: quiz.id, order_index: i, type: "mcq", prompt: `Q${i} of ${title}`, options: questions, correct_index: i % questions.length })
        .select("id")
        .single();
      assertNoError("insert question", { error: qErr });
    }
    return quiz;
  }

  async function publish(lecturerClient, quizId) {
    const { error } = await lecturerClient.from("quizzes").update({ status: "live" }).eq("id", quizId);
    assertNoError("publish", { error });
  }

  /** One question id of a quiz (for answer probes). */
  async function firstQuestionId(lecturerClient, quizId) {
    const { data } = await lecturerClient.from("questions").select("id").eq("quiz_id", quizId).limit(1);
    return data?.[0]?.id;
  }

  /** Start an assessment session for a student on a live quiz. */
  async function startSession(studentClient, quizId) {
    const start = await studentClient.rpc("start_quiz_session", { p_quiz_id: quizId });
    assertNoError("start session", { error: start.error });
    return start.data.session;
  }

  /**
   * Make a live assessment quiz + start a session for `studentClient`.
   * Returns { quizId, session }.
   */
  async function makeLiveAssessment(lecturerClient, classId, lecturerId, title, studentClient) {
    const quiz = await makeQuiz(lecturerClient, classId, lecturerId, title);
    await publish(lecturerClient, quiz.id);
    const session = await startSession(studentClient, quiz.id);
    return { quizId: quiz.id, session };
  }

  // The quiz's created_by is `lecturerClient`'s uid. Auth has no getUser here
  // (client-side) — record the owner explicitly at call sites.

  // ── D13-reset + I21-D: reset frees the one-attempt slot, cascades ──
  let resetOk = false;
  {
    const quiz = await makeQuiz(clientL, clsA.id, lecturerL.id, "D13 Reset");
    await publish(clientL, quiz.id);
    const session = await startSession(clientS1, quiz.id);
    // Seed an answer + a face check for the cascade assertion.
    const qid = await firstQuestionId(clientL, quiz.id);
    const ans = await clientS1.rpc("answer_question", { p_session_id: session.id, p_question_id: qid, p_selected_index: 0 });
    assertNoError("answer q", { error: ans.error });
    await admin.from("face_checks").insert({ session_id: session.id, matched: true, trigger: "start" });

    const rpc = await clientL.rpc("reset_session", { p_session_id: session.id });
    const payload = rpc.data ?? {};
    // Full pinned return shape (D2): ok + deleted_session_id + student_id + quiz_id.
    resetOk = payload.ok === true && payload.deleted_session_id === session.id &&
      payload.student_id === studentS1.id && payload.quiz_id === quiz.id;
    record("D13-reset lecturer reset → {ok, deleted_session_id, student_id, quiz_id}",
      resetOk, JSON.stringify(payload));

    const audit = await admin
      .from("audit_events")
      .select("actor_id, subject_id, action, metadata")
      .eq("action", "session_reset")
      .eq("subject_id", studentS1.id)
      .order("created_at", { ascending: false })
      .limit(1);
    const row = audit.data?.[0];
    record("D13-reset audit row (session_reset, actor=lecturer, metadata.session_id/quiz_id)",
      row?.actor_id === lecturerL.id && row?.subject_id === studentS1.id &&
        row?.metadata?.session_id === session.id && row?.metadata?.quiz_id === quiz.id,
      JSON.stringify(row ?? null));

    const { data: answers } = await admin
      .from("session_answers")
      .select("id").eq("session_id", session.id);
    const { data: checks } = await admin
      .from("face_checks")
      .select("id").eq("session_id", session.id);
    record("I21-D cascade: session_answers + face_checks for deleted id → 0 rows",
      (answers ?? []).length === 0 && (checks ?? []).length === 0,
      `answers=${(answers ?? []).length} checks=${(checks ?? []).length}`);

    // I21-D slot release: the student can start the SAME quiz again.
    const restart = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    record("I21-D one-attempt slot released after reset (restart succeeds)",
      restart.data?.session?.id && !restart.data?.error,
      JSON.stringify(restart.data ?? restart.error?.message));
    // Clean the restarted session so the quiz's state is predictable later.
    await clientL.rpc("reset_session", { p_session_id: restart.data.session.id });
  }

  // ── authZ ─────────────────────────────────────────────────────────
  {
    const quiz = await makeQuiz(clientL, clsA.id, lecturerL.id, "AuthZ Reset");
    await publish(clientL, quiz.id);
    const session = await startSession(clientS1, quiz.id);
    // A different class's quiz owned by L2 (S1 is enrolled in B).
    const zacQuiz = await makeQuiz(clientL2, clsB.id, lecturerL2.id, "AuthZ L2 Quiz");
    await publish(clientL2, zacQuiz.id);
    const zacSession = await startSession(clientS1, zacQuiz.id);

    // Student call → not_lecturer.
    const stuReset = await clientS2.rpc("reset_session", { p_session_id: session.id });
    record("authZ student reset_session → not_lecturer",
      stuReset.data?.error === "not_lecturer", JSON.stringify(stuReset.data));

    // Second lecturer (different class) → not_owner (no oracle).
    const l2Reset = await clientL2.rpc("reset_session", { p_session_id: session.id });
    record("authZ lecturer of another class → not_owner",
      l2Reset.data?.error === "not_owner", JSON.stringify(l2Reset.data));

    // Non-existent id → not_owner (same fold as not-owned).
    const ghost = "00000000-0000-4000-8000-00000000dead";
    const gReset = await clientL.rpc("reset_session", { p_session_id: ghost });
    record("authZ non-existent id → not_owner",
      gReset.data?.error === "not_owner", JSON.stringify(gReset.data));

    // Anon execute → denied (grant-level).
    const anon = createClient(URL, ANON, { auth: { persistSession: false } });
    const anonReset = await anon.rpc("reset_session", { p_session_id: session.id });
    record("authZ anon execute → denied",
      Boolean(anonReset.error), anonReset.error?.message ?? JSON.stringify(anonReset.data));

    // Practice-mode session → not_assessment; status unchanged; no audit row.
    const pQuiz = await makeQuiz(clientL, clsA.id, lecturerL.id, "AuthZ Practice", { mode: "practice", questions: ["x", "y"] });
    await publish(clientL, pQuiz.id);
    const pStart = await startSession(clientS1, pQuiz.id);
    const auditBefore = (await admin.from("audit_events").select("id").eq("action", "session_reset").eq("subject_id", studentS1.id)).data ?? [];
    const pReset = await clientL.rpc("reset_session", { p_session_id: pStart.id });
    const pRow = (await admin.from("quiz_sessions").select("status").eq("id", pStart.id).single()).data;
    const auditAfter = (await admin.from("audit_events").select("id").eq("action", "session_reset").eq("subject_id", studentS1.id)).data ?? [];
    record("authZ practice-mode reset → not_assessment (status unchanged, no audit)",
      pReset.data?.error === "not_assessment" && pRow.status === "active" && auditAfter.length === auditBefore.length,
      `rpc=${JSON.stringify(pReset.data)} status=${pRow?.status} auditBefore=${auditBefore.length} auditAfter=${auditAfter.length}`);

    // ── Status matrix: reset each assessment status directly-seeded ──
    let statusMatrixOk = true;
    const matrixDetails = [];
    for (const status of ["active", "paused", "flagged", "completed"]) {
      const { session } = await makeLiveAssessment(clientL, clsA.id, lecturerL.id, `Matrix-${status}`, clientS1);
      if (status !== "active") {
        await admin.from("quiz_sessions").update({ status }).eq("id", session.id);
      }
      const r = await clientL.rpc("reset_session", { p_session_id: session.id });
      const audit = await admin
        .from("audit_events")
        .select("id").eq("action", "session_reset").eq("subject_id", studentS1.id)
        .eq("metadata->>session_id", session.id);
      const ok = r.data?.ok === true && (audit.data ?? []).length >= 1;
      if (!ok) statusMatrixOk = false;
      matrixDetails.push(`${status}:${r.data?.ok === true ? "ok" : JSON.stringify(r.data)}`);
    }
    record("Status matrix reset active/paused/flagged/completed → ok + audit each",
      statusMatrixOk, matrixDetails.join(" "));

    // ── Race pin: reset concurrent with an in-flight answer ─────────
    const { quizId: raceQuiz, session: raceSession } = await makeLiveAssessment(clientL, clsA.id, lecturerL.id, "Race", clientS1);
    const raceQid = await firstQuestionId(clientL, raceQuiz);
    const [answerRes, resetRes] = await Promise.all([
      clientS1.rpc("answer_question", { p_session_id: raceSession.id, p_question_id: raceQid, p_selected_index: 0 }),
      clientL.rpc("reset_session", { p_session_id: raceSession.id }),
    ]);
    const answerPayload = answerRes.data ?? {};
    // Assessment answers are keyless ({recorded:true} — 0012 reveal-gate);
    // is_correct only appears on practice-mode sessions.
    const loserClean = answerPayload.error === undefined
      ? answerPayload.recorded === true || answerPayload.is_correct !== undefined
      : ["not_owner", "session_not_active"].includes(answerPayload.error);
    const resetWon = resetRes.data?.ok === true;
    // After the dust settles, the session is gone (atomic for update — no
    // partial row survives).
    const { data: raceRows } = await admin.from("quiz_sessions").select("id").eq("id", raceSession.id);
    record("Race pin: concurrent answer+reset → typed loser, no partial write, no 500",
      loserClean && resetWon && (raceRows ?? []).length === 0,
      `answer=${JSON.stringify(answerPayload)} reset=${JSON.stringify(resetRes.data)} remainingRows=${(raceRows ?? []).length}`);

    // ── D-view ────────────────────────────────────────────────────────
    // Build a LEGACY (NULL-event_quiz_id) row for the shared student S1: a
    // flagged session unlocked by L (unlock_session writes no session/quiz
    // metadata → the view's legacy branch). Status is direct-seeded (proven
    // by verify-face); this harness needs only the row the view must filter.
    {
      const { session: lgSession } = await makeLiveAssessment(clientL, clsA.id, lecturerL.id, "LegacyUnlock", clientS1);
      await admin.from("quiz_sessions").update({ status: "flagged" }).eq("id", lgSession.id);
      await clientL.rpc("unlock_session", { p_session_id: lgSession.id });
      // Library quiz owned by L2, reset BY L2 → must be invisible to L.
      const crossReset = await clientL2.rpc("reset_session", { p_session_id: zacSession.id });
      assertNoError("cross-class reset", { error: crossReset.error });
      // Non-vacuous: prove the reset actually happened (ok:true + a row was
      // written) BEFORE asserting L's 0-row read below — otherwise a silent
      // not_owner here would make the isolation probe pass vacuously.
      if (crossReset.data?.ok !== true) {
        throw new Error(`cross-class reset did not succeed: ${JSON.stringify(crossReset.data)}`);
      }

      // (f) student reads the view → 0 rows (is_lecturer() false). Also assert
      // the query was PERMITTED (no `error`) — otherwise a future grant removal
      // would pass this check vacuously as "0 rows".
      const stuView = await clientS2.from("lecturer_audit_view").select("*").eq("subject_id", studentS1.id);
      record("D-view student reads lecturer_audit_view → permitted + 0 rows",
        !stuView.error && (stuView.data ?? []).length === 0,
        `count=${(stuView.data ?? []).length} err=${stuView.error?.message ?? "none"}`);

      // (b) projection key-absence (D42-style): select(*) returns exactly the
      // curated keys and NO metadata.
      const lectStar = await clientL.from("lecturer_audit_view").select("*").eq("subject_id", studentS1.id).limit(1);
      const keys = lectStar.data?.[0] ? Object.keys(lectStar.data[0]).sort() : [];
      record("D-view projection: select(*) keys = curated set, metadata absent",
        JSON.stringify(keys) === JSON.stringify(["action", "actor_id", "created_at", "event_quiz_id", "event_session_id", "id", "subject_id"].sort()),
        keys.join(","));

      // (a) L sees BOTH branches for S1: a quiz-attributable session_reset row
      // (event_quiz_id set) and the legacy unlock row (event_quiz_id NULL).
      const lView = await clientL.from("lecturer_audit_view").select("*").eq("subject_id", studentS1.id);
      const actions = (lView.data ?? []).map((r) => r.action);
      const hasLegacyUnlock = actions.includes("unlock");
      const hasResetWithQuiz = (lView.data ?? []).some((r) => r.action === "session_reset" && r.event_quiz_id !== null);
      record("D-view lecturer sees S1's rows: legacy unlock + quiz-attributable session_reset",
        hasLegacyUnlock && hasResetWithQuiz,
        `actions=${actions.join(",")}`);

      // (c) cross-class isolation: L2's reset of the SAME shared student in a
      // quiz L doesn't own → invisible to L (quiz-attributable branch gates).
      const lCross = await clientL.from("lecturer_audit_view").select("*").eq("event_session_id", zacSession.id);
      record("D-view cross-class: L2 reset row invisible to L",
        (lCross.data ?? []).length === 0, `count=${(lCross.data ?? []).length}`);

      // Raw audit_events SELECT as a lecturer → denied (privilege layer).
      const raw = await clientL.from("audit_events").select("id").limit(1);
      record("D-view raw audit_events SELECT as lecturer → denied",
        Boolean(raw.error), raw.error?.message ?? JSON.stringify(raw.data));

      // (d) legacy cross-lecturer visibility while enrolled: BOTH L and L2
      // see the shared student's legacy unlock row (documented trade-off).
      const l2Legacy = await clientL2.from("lecturer_audit_view").select("*").eq("action", "unlock").eq("subject_id", studentS1.id);
      record("D-view documented legacy cross-lecturer visibility (L2 sees unlock while enrolled)",
        (l2Legacy.data ?? []).length >= 1, `count=${(l2Legacy.data ?? []).length}`);
    }

    // (e) self-unenroll: S1 leaves class A. Legacy rows vanish; quiz-
    // attributable session_reset rows (event_quiz_id set) survive.
    const { error: unenrollErr } = await clientS1
      .from("class_enrollments")
      .delete()
      .eq("student_id", studentS1.id)
      .eq("class_id", clsA.id);
    assertNoError("self-unenroll from class A", { error: unenrollErr });

    const lAfter = await clientL.from("lecturer_audit_view").select("*").eq("subject_id", studentS1.id);
    const afterActions = (lAfter.data ?? []).map((r) => r.action);
    const legacyGone = !afterActions.includes("unlock");
    const resetSurvives = afterActions.includes("session_reset");
    record("D-view self-unenroll: legacy rows invisible, session_reset rows survive",
      legacyGone && resetSurvives, `actions=${afterActions.join(",")}`);
  }

  // ── Summary ──────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  const passed = results.filter((r) => r.pass).length;
  console.log(`${passed}/${results.length} checks passed`);
  return passed === results.length ? 0 : 1;
}

async function cleanup() {
  try {
    for (const qid of createdQuizIds) {
      if (qid) await admin.from("quizzes").delete().eq("id", qid);
    }
    for (const cid of createdClassIds) {
      if (cid) await admin.from("classes").delete().eq("id", cid);
    }
    // Delete this run's audit rows (session_reset/unlock/etc. have no FK to
    // quizzes — without this they accumulate in the local DB across runs).
    if (createdUsers.length) {
      await admin.from("audit_events").delete().in("subject_id", createdUsers);
    }
    for (const uid of createdUsers) {
      await admin.auth.admin.deleteUser(uid);
    }
  } catch (err) {
    console.warn("Cleanup warning:", err.message);
  }
}

main()
  .then(async (code) => {
    await cleanup();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error("Fatal:", err);
    await cleanup();
    process.exit(1);
  });