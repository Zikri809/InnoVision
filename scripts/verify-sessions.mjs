// Phase 5 security/RLS/RPC verification harness — runs against live local Supabase.
// This harness — NOT FakeSupabase — is the SOLE authoritative check for RPC
// semantics (timer, ownership, grading, unique-index behavior). FakeSupabase
// branches are route-mapping stubs kept in lockstep with migration
// 0008_sessions.sql.
// Covers gate tests:
//   D1   — two PARALLEL start_quiz_session (assessment) → exactly one row;
//          the other returns {error:'already_attempted', session_id}
//   D1b  — assessment re-answer → {error:'already_answered'}; first answer
//          unchanged (is_correct/selected_index intact)
//   D2   — practice: two sequential starts → two distinct sessions; a start
//          while an ACTIVE practice session exists returns the SAME session id
//   D3   — start on a non-live quiz (draft/closed) → {error:'quiz_not_live'}
//   D4   — start on a live quiz in a class the student is not enrolled in →
//          {error:'not_enrolled'}
//   D7   — student A SELECT quiz_sessions/session_answers → only their own
//          rows; student B's → 0 rows; lecturer reads own quiz's → visible
//   D9   — practice duplicate answer → upsert (updated selected_index/
//          is_correct/answered_at), one row
//   D42  — student reads student_question_view for a live quiz → row count
//          equals the seeded count AND key-absence on the returned object keys
//          (no correct_index / explanation); owner lecturer reads questions →
//          correct_index present (D6 stays green)
//   D43  — answer_question with p_selected_index >= options length (and NULL)
//          → {error:'invalid_selected_index'}
//   D44  — answer Q1 correctly + Q2 incorrectly → stored is_correct per row,
//          submit_session returns score=1/total=N, per-mode jsonb shapes
//          ({is_correct} vs {is_correct, correct_index, explanation})
//   D44b — answer_question with a question id from a DIFFERENT quiz →
//          {error:'invalid_question'}
//   D45  — sleep >= time_limit_sec + 5s + 1s before a late answer_question →
//          {error:'time_expired'}; then submit past deadline → SUCCEEDS
//          (deviation pin); assert the rejected answer created NO answer row
//   D46  — lecturer reads own quiz's sessions + answers; a second student
//          cannot read another student's answers; submit then answer_question
//          on the same session → {error:'session_not_active'}
//   D47  — raw-anon PostgREST call to the RPCs → denied (execute revoked);
//          anon SELECT on quiz_sessions/session_answers → 0 rows (RLS/grants)
//   D48/D49/D50/D51 — results matrix, practice results, one-way reveal,
//          auto-reveal (see sections below)
//   D52  — retake spawn: attempt increments; default config byte-identical
//          to legacy one-attempt (already_attempted + latest completed
//          session_id); budget exhaustion; practice untouched.
//   D53  — stale-paused sealing: passed window → stale session sealed
//          completed (evidence preserved), spawn window-stopped; windowless
//          quiz keeps normal already_attempted blocking.
//   D54  — retake-aware auto-reveal: fresh completed student with budget
//          remaining keeps the quiz unrevealed; final submit reveals.
//   D55  — quiz_completed_all digest counts DISTINCT students: one student's
//          two attempts don't fire it; the second distinct student does
//          (exactly once — dedupe key holds).
//
// NOTE: D41 (quiz-delete guard) is deliberately NOT here — a Node Supabase
// client cannot invoke Next.js route handlers, and at the DB layer the FK is
// `on delete cascade` (delete succeeds). The quiz-DELETE guard is owned
// entirely by route test I-S12 (with/without sessions).
//
// NOT a unit test; run manually: node scripts/verify-sessions.mjs
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

assertLocalTarget(URL, "verify-sessions.mjs");

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ── Provision: lecturer A, students S1 (enrolled), S2 (not), S3 (enrolled) ──
  const lecturerA = await createUser(`sessA-${stamp}@innovision.test`);
  const studentS1 = await createUser(`sessS1-${stamp}@innovision.test`);
  await createUser(`sessS2-${stamp}@innovision.test`);
  await createUser(`sessS3-${stamp}@innovision.test`);
  await promoteLecturer(lecturerA.id);

  const clientA = await asUser(`sessA-${stamp}@innovision.test`);
  const clientS1 = await asUser(`sessS1-${stamp}@innovision.test`);
  const clientS2 = await asUser(`sessS2-${stamp}@innovision.test`);
  const clientS3 = await asUser(`sessS3-${stamp}@innovision.test`);

  // ── Lecturer A creates a class + S1/S3 enroll ──────────────────
  const joinCode = makeJoinCode();
  const { data: clsA, error: createErr } = await clientA
    .from("classes")
    .insert({ title: "A's Session Class", lecturer_id: lecturerA.id, join_code: joinCode })
    .select("id")
    .single();
  assertNoError("create class", { error: createErr });
  createdClassIds.push(clsA.id);
  const { error: joinErr1 } = await clientS1.rpc("join_class", { code: joinCode });
  assertNoError("S1 join", { error: joinErr1 });
  const { error: joinErr3 } = await clientS3.rpc("join_class", { code: joinCode });
  assertNoError("S3 join", { error: joinErr3 });

  // A second class for D4 (not enrolled) + a separate class for the cross-quiz D44b.
  const otherJoin = makeJoinCode();
  const { data: clsOther, error: otherErr } = await clientA
    .from("classes")
    .insert({ title: "Other Class", lecturer_id: lecturerA.id, join_code: otherJoin })
    .select("id")
    .single();
  assertNoError("create other class", { error: otherErr });
  createdClassIds.push(clsOther.id);

  async function makeQuiz({ title, mode, time_limit_sec = null, class_id = clsA.id }) {
    const { data: quiz, error } = await clientA
      .from("quizzes")
      .insert({ class_id, created_by: lecturerA.id, title, status: "draft", mode, time_limit_sec })
      .select("id, mode, time_limit_sec")
      .single();
    assertNoError("create quiz", { error });
    createdQuizIds.push(quiz.id);
    return quiz;
  }

  async function addQuestions(quizId, questions) {
    const rows = [];
    for (let i = 0; i < questions.length; i++) {
      const { data, error } = await clientA
        .from("questions")
        .insert({ quiz_id: quizId, order_index: i, ...questions[i] })
        .select("id, order_index, correct_index, options")
        .single();
      assertNoError("insert question", { error });
      rows.push(data);
    }
    return rows;
  }

  async function publish(quizId) {
    const { error } = await clientA
      .from("quizzes")
      .update({ status: "live" })
      .eq("id", quizId);
    assertNoError("publish quiz", { error });
  }

  // Default 3-question set (D19-style).
  const QUESTION_TEMPLATE = [
    { type: "mcq", prompt: "Q1: What is velocity?", options: ["Speed", "Distance"], correct_index: 0, explanation: "Velocity is speed with direction." },
    { type: "mcq", prompt: "Q2: Unit of force?", options: ["Joule", "Newton", "Watt"], correct_index: 1 },
    { type: "true_false", prompt: "Q3: Light travels faster than sound.", options: ["True", "False"], correct_index: 0 },
  ];

  // ── D3: start on a non-live quiz → quiz_not_live ───────────────
  {
    const quiz = await makeQuiz({ title: "D3 Draft", mode: "assessment" });
    const { data } = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    record("D3 start on draft quiz → quiz_not_live",
      data?.error === "quiz_not_live", JSON.stringify(data));
  }

  // ── D1: two PARALLEL assessment starts → exactly one row ────────
  let assessmentQuiz = null;
  {
    assessmentQuiz = await makeQuiz({ title: "D1 Assessment", mode: "assessment" });
    await addQuestions(assessmentQuiz.id, QUESTION_TEMPLATE);
    await publish(assessmentQuiz.id);

    const [r1, r2] = await Promise.all([
      clientS1.rpc("start_quiz_session", { p_quiz_id: assessmentQuiz.id }),
      clientS1.rpc("start_quiz_session", { p_quiz_id: assessmentQuiz.id }),
    ]);
    const okSession = r1.data?.session ?? r2.data?.session;
    const okErr = r1.data?.error === "already_attempted" ? r1.data : r2.data;
    const rows = await clientS1.from("quiz_sessions").select("id, mode, status")
      .eq("quiz_id", assessmentQuiz.id).eq("student_id", studentS1.id);
    record("D1 concurrent assessment starts → exactly one row, other already_attempted",
      Boolean(okSession) && okErr?.error === "already_attempted" &&
        (rows.data ?? []).length === 1 &&
        rows.data[0].mode === "assessment",
      `sessions=${JSON.stringify(rows.data ?? [])} r1=${JSON.stringify(r1.data)} r2=${JSON.stringify(r2.data)}`);
  }

  // ── D1b: assessment re-answer → already_answered, first unchanged ──
  {
    const sessionId = assessmentQuiz ? (await clientS1.from("quiz_sessions").select("id")
      .eq("quiz_id", assessmentQuiz.id).eq("student_id", studentS1.id).single()).data.id : null;
    const qs = (await clientA.from("questions").select("id, correct_index")
      .eq("quiz_id", assessmentQuiz.id).order("order_index")).data;
    const q1 = qs[0];

    const first = await clientS1.rpc("answer_question", {
      p_session_id: sessionId, p_question_id: q1.id, p_selected_index: q1.correct_index,
    });
    const second = await clientS1.rpc("answer_question", {
      p_session_id: sessionId, p_question_id: q1.id, p_selected_index: q1.correct_index === 0 ? 1 : 0,
    });
    const answers = await clientA.from("lecturer_answers_view").select("question_id, selected_index, is_correct")
      .eq("session_id", sessionId).eq("question_id", q1.id);
    record("D1b assessment re-answer → already_answered, first answer unchanged",
      first.data?.recorded === true &&
        second.data?.error === "already_answered" &&
        (answers.data ?? []).length === 1 &&
        answers.data[0].selected_index === q1.correct_index &&
        answers.data[0].is_correct === true,
      `first=${JSON.stringify(first.data)} second=${JSON.stringify(second.data)} stored=${JSON.stringify(answers.data ?? [])}`);
  }

  // ── D4: start on a live quiz in a class NOT enrolled → not_enrolled ──
  {
    const quiz = await makeQuiz({ title: "D4 Unenrolled", mode: "assessment" });
    await addQuestions(quiz.id, QUESTION_TEMPLATE);
    await publish(quiz.id);
    const { data } = await clientS2.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    record("D4 start on live quiz, not enrolled → not_enrolled",
      data?.error === "not_enrolled", JSON.stringify(data));
  }

  // ── D2: practice rejoin semantics ──────────────────────────────
  {
    const quiz = await makeQuiz({ title: "D2 Practice", mode: "practice" });
    await addQuestions(quiz.id, QUESTION_TEMPLATE);
    await publish(quiz.id);

    const first = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    const second = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    record("D2 practice: active session is REJOINED (same id)",
      Boolean(first.data?.session?.id) && first.data.session.id === second.data?.session?.id,
      `first=${first.data?.session?.id} second=${second.data?.session?.id}`);

    // Complete the first session, then a fresh start creates a NEW session
    // (two distinct practice sessions — D2's "two sequential starts → two
    // distinct sessions" clause, since the first is terminal and never rejoined).
    const firstId = first.data.session.id;
    const { data: submitRes } = await clientS1.rpc("submit_session", { p_session_id: firstId });
    const third = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    const rows = await clientS1.from("quiz_sessions").select("id, status")
      .eq("quiz_id", quiz.id).eq("student_id", studentS1.id).order("started_at");
    record("D2 practice: two sequential starts → two DISTINCT sessions (completed never rejoined)",
      submitRes?.session?.status === "completed" &&
        Boolean(third.data?.session?.id) &&
        third.data.session.id !== firstId &&
        (rows.data ?? []).length === 2 &&
        rows.data.some((r) => r.id === firstId && r.status === "completed") &&
        rows.data.some((r) => r.id === third.data.session.id && r.status === "active"),
      `rows=${JSON.stringify(rows.data ?? [])} third=${third.data?.session?.id}`);
  }

  // ── D42: student_question_view secrecy + D6 owner read ─────────
  {
    const quiz = await makeQuiz({ title: "D42 Secrecy", mode: "assessment" });
    const qs = await addQuestions(quiz.id, QUESTION_TEMPLATE);
    await publish(quiz.id);

    const { data: rows, error: viewErr } = await clientS1
      .from("student_question_view")
      .select("id, quiz_id, order_index, type, prompt, options, created_at")
      .eq("quiz_id", quiz.id)
      .order("order_index");
    const okCount = !viewErr && (rows ?? []).length === qs.length;
    const okKeys = Array.isArray(rows) && rows.length > 0 &&
      !("correct_index" in rows[0]) && !("explanation" in rows[0]);
    record("D42 student_question_view: seeded count + NO correct_index/explanation on keys",
      okCount && okKeys,
      `count=${Array.isArray(rows) ? rows.length : "?"}/${qs.length} keys=${Array.isArray(rows) && rows.length ? Object.keys(rows[0]).join(",") : "?"}`);

    // A `select("*")` regression that adds correct_index to the view must be
    // caught on the returned object keys (explicit-column selects would mask it).
    const { data: starRows } = await clientS1
      .from("student_question_view")
      .select("*")
      .eq("quiz_id", quiz.id);
    const starOk = Array.isArray(starRows) && starRows.length > 0 &&
      !("correct_index" in starRows[0]) && !("explanation" in starRows[0]);
    record("D42 select(*) on student_question_view → no correct_index/explanation keys",
      Boolean(starOk),
      `keys=${Array.isArray(starRows) && starRows.length ? Object.keys(starRows[0]).join(",") : "?"}`);

    const { data: ownerRows } = await clientA
      .from("questions")
      .select("id, correct_index")
      .eq("quiz_id", quiz.id)
      .order("order_index");
    record("D6/D42 owner lecturer reads questions with correct_index (stays green)",
      (ownerRows ?? []).length === qs.length &&
        ownerRows.every((q) => typeof q.correct_index === "number"),
      JSON.stringify(ownerRows ?? []));
  }

  // ── D9: practice duplicate answer → upsert, one row ────────────
  {
    const quiz = await makeQuiz({ title: "D9 Upsert", mode: "practice" });
    const qs = await addQuestions(quiz.id, QUESTION_TEMPLATE);
    await publish(quiz.id);
    const start = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    const sessionId = start.data.session.id;
    const q1 = qs[0];

    const first = await clientS1.rpc("answer_question", {
      p_session_id: sessionId, p_question_id: q1.id, p_selected_index: q1.correct_index,
    });
    const second = await clientS1.rpc("answer_question", {
      p_session_id: sessionId,
      p_question_id: q1.id,
      p_selected_index: q1.correct_index === 0 ? 1 : 0,
    });
    const rows = await clientS1.from("student_answers_view").select("selected_index, is_correct, answered_at")
      .eq("session_id", sessionId).eq("question_id", q1.id);
    record("D9 practice duplicate answer → upsert (updated), one row",
      first.data?.is_correct === true &&
        second.data?.is_correct === (q1.correct_index === 0 ? false : true) &&
        (rows.data ?? []).length === 1 &&
        rows.data[0].selected_index === (q1.correct_index === 0 ? 1 : 0),
      `first=${JSON.stringify(first.data)} second=${JSON.stringify(second.data)} rows=${JSON.stringify(rows.data ?? [])}`);
  }

  // ── D44: grading pinned against the real DB + per-mode shapes ──
  {
    const quiz = await makeQuiz({ title: "D44 Grading", mode: "assessment" });
    const qs = await addQuestions(quiz.id, QUESTION_TEMPLATE);
    await publish(quiz.id);
    const start = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    const sessionId = start.data.session.id;

    const r1 = await clientS1.rpc("answer_question", {
      p_session_id: sessionId, p_question_id: qs[0].id, p_selected_index: qs[0].correct_index,
    });
    const r2 = await clientS1.rpc("answer_question", {
      p_session_id: sessionId,
      p_question_id: qs[1].id,
      p_selected_index: qs[1].correct_index === 0 ? 1 : 0,
    });
    const stored = await clientA.from("lecturer_answers_view").select("question_id, is_correct")
      .eq("session_id", sessionId);

    // Assessment answers are KEYLESS pre-reveal ('recorded' ack, no is_correct).
    const submitHidden = await clientS1.rpc("submit_session", { p_session_id: sessionId });
    const shapeAssessment = r1.data && "recorded" in r1.data && !("is_correct" in r1.data);
    const hiddenShape =
      submitHidden.data?.score === null && submitHidden.data?.total === null;
    record("D44 assessment: stored is_correct + keyless ack + hidden submit",
      r1.data?.recorded === true &&
        r2.data?.recorded === true &&
        (stored.data ?? []).length === 2 &&
        stored.data.find((a) => a.question_id === qs[0].id)?.is_correct === true &&
        stored.data.find((a) => a.question_id === qs[1].id)?.is_correct === false &&
        Boolean(hiddenShape) &&
        submitHidden.data?.session?.status === "completed" &&
        Boolean(shapeAssessment),
      `submitHidden=${JSON.stringify(submitHidden.data)} shape=${JSON.stringify(r1.data)}`);

    // Reveal → re-submit (already_submitted) now returns the numeric score.
    const { error: revealErr } = await clientA
      .from("quizzes")
      .update({ results_revealed_at: new Date().toISOString() })
      .eq("id", quiz.id);
    assertNoError("D44 reveal", { error: revealErr });
    const submitRevealed = await clientS1.rpc("submit_session", { p_session_id: sessionId });
    record("D44 post-reveal submit → score/total returned",
      submitRevealed.data?.score === 1 &&
        submitRevealed.data?.total === 3 &&
        submitRevealed.data?.already_submitted === true,
      JSON.stringify(submitRevealed.data));

    // Practice shape includes correct_index + explanation.
    const pQuiz = await makeQuiz({ title: "D44 Practice Shape", mode: "practice" });
    await addQuestions(pQuiz.id, QUESTION_TEMPLATE);
    await publish(pQuiz.id);
    const pStart = await clientS1.rpc("start_quiz_session", { p_quiz_id: pQuiz.id });
    const pSession = pStart.data.session.id;
    const pQ = (await clientA.from("questions").select("id, correct_index").eq("quiz_id", pQuiz.id).order("order_index")).data[0];
    const pAns = await clientS1.rpc("answer_question", {
      p_session_id: pSession, p_question_id: pQ.id, p_selected_index: pQ.correct_index,
    });
    record("D44 practice shape: {is_correct, correct_index, explanation}",
      pAns.data?.is_correct === true &&
        typeof pAns.data?.correct_index === "number" &&
        typeof pAns.data?.explanation === "string",
      JSON.stringify(pAns.data));
  }

  // ── D44b: answer with a question from a DIFFERENT quiz → invalid_question ──
  {
    const quizA = await makeQuiz({ title: "D44b A", mode: "practice" });
    await addQuestions(quizA.id, QUESTION_TEMPLATE);
    await publish(quizA.id);
    const quizB = await makeQuiz({ title: "D44b B", mode: "practice" });
    const qsB = await addQuestions(quizB.id, QUESTION_TEMPLATE);
    await publish(quizB.id);

    const start = await clientS1.rpc("start_quiz_session", { p_quiz_id: quizA.id });
    const sessionId = start.data.session.id;
    const foreign = qsB[0]; // belongs to quizB, not quizA
    const { data } = await clientS1.rpc("answer_question", {
      p_session_id: sessionId, p_question_id: foreign.id, p_selected_index: 0,
    });
    record("D44b answer with foreign-question id → invalid_question",
      data?.error === "invalid_question", JSON.stringify(data));
  }

  // ── D43: invalid selected_index (>= options length and NULL) ──
  {
    const quiz = await makeQuiz({ title: "D43 Bounds", mode: "practice" });
    const qs = await addQuestions(quiz.id, QUESTION_TEMPLATE);
    await publish(quiz.id);
    const start = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    const sessionId = start.data.session.id;
    const q1 = qs[0]; // 2 options → index >= 2 invalid
    const tooBig = await clientS1.rpc("answer_question", {
      p_session_id: sessionId, p_question_id: q1.id, p_selected_index: 2,
    });
    const nullIdx = await clientS1.rpc("answer_question", {
      p_session_id: sessionId, p_question_id: q1.id, p_selected_index: null,
    });
    record("D43 out-of-range + NULL selected_index → invalid_selected_index",
      tooBig.data?.error === "invalid_selected_index" &&
        nullIdx.data?.error === "invalid_selected_index",
      `tooBig=${JSON.stringify(tooBig.data)} null=${JSON.stringify(nullIdx.data)}`);
  }

  // ── D45: late answer rejected, late SUBMIT allowed ─────────────
  {
    // time_limit_sec = 6 → deadline = 6 + 5 grace = 11s. Sleep 12s.
    const quiz = await makeQuiz({ title: "D45 Timer", mode: "assessment", time_limit_sec: 6 });
    await addQuestions(quiz.id, QUESTION_TEMPLATE);
    await publish(quiz.id);
    const start = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    const sessionId = start.data.session.id;
    const qs = (await clientA.from("questions").select("id, correct_index").eq("quiz_id", quiz.id).order("order_index")).data;

    // Answer one question correctly while still in time.
    await clientS1.rpc("answer_question", {
      p_session_id: sessionId, p_question_id: qs[0].id, p_selected_index: qs[0].correct_index,
    });

    // Sleep past deadline (limit 6 + grace 5 + 1 margin).
    await sleep(12_000);

    const late = await clientS1.rpc("answer_question", {
      p_session_id: sessionId, p_question_id: qs[1].id, p_selected_index: 0,
    });
    const lateAnswers = await clientS1.from("session_answers").select("question_id")
      .eq("session_id", sessionId);
    const submitHidden = await clientS1.rpc("submit_session", { p_session_id: sessionId });

    // Reveal then re-submit → the stored (hidden → shown) score surfaces.
    const { error: revealErr } = await clientA
      .from("quizzes")
      .update({ results_revealed_at: new Date().toISOString() })
      .eq("id", quiz.id);
    assertNoError("D45 reveal", { error: revealErr });
    const submit = await clientS1.rpc("submit_session", { p_session_id: sessionId });
    record("D45 late answer → time_expired, NO answer row; late submit SUCCEEDS",
      late.data?.error === "time_expired" &&
        (lateAnswers.data ?? []).length === 1 && // only the in-time answer
        submitHidden.data?.score === null && // hidden pre-reveal
        submit.data?.score === 1 && submit.data?.total === 3 &&
        submit.data?.session?.status === "completed",
      `late=${JSON.stringify(late.data)} answerRows=${(lateAnswers.data ?? []).length} hidden=${JSON.stringify(submitHidden.data)} submit=${JSON.stringify(submit.data)}`);
  }

  // ── D46: RLS cross-student + answer-after-submit → session_not_active ──
  {
    const quiz = await makeQuiz({ title: "D46 RLS", mode: "assessment" });
    await addQuestions(quiz.id, QUESTION_TEMPLATE);
    await publish(quiz.id);

    // S1 starts + answers + submits.
    const start = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    const s1Session = start.data.session.id;
    const qs = (await clientA.from("questions").select("id, correct_index").eq("quiz_id", quiz.id).order("order_index")).data;
    await clientS1.rpc("answer_question", {
      p_session_id: s1Session, p_question_id: qs[0].id, p_selected_index: qs[0].correct_index,
    });
    await clientS1.rpc("submit_session", { p_session_id: s1Session });

    // S1 reads own session+answers → visible; S2 reads S1's → 0 rows.
    const s1Sessions = await clientS1.from("quiz_sessions").select("id").eq("id", s1Session);
    const s1Answers = await clientS1.from("session_answers").select("id").eq("session_id", s1Session);
    const s2Sessions = await clientS2.from("quiz_sessions").select("id").eq("id", s1Session);
    const s2Answers = await clientS2.from("session_answers").select("id").eq("session_id", s1Session);

    // Lecturer reads own quiz's sessions + answers → visible.
    const lectSessions = await clientA.from("quiz_sessions").select("id, student_id").eq("quiz_id", quiz.id);
    const lectAnswers = await clientA.from("session_answers").select("id").eq("session_id", s1Session);

    // Answer after submit → session_not_active.
    const lateAnswer = await clientS1.rpc("answer_question", {
      p_session_id: s1Session, p_question_id: qs[1].id, p_selected_index: 0,
    });

    record("D46 RLS: own visible, cross-student hidden, lecturer visible, answer-after-submit blocked",
      (s1Sessions.data ?? []).length === 1 &&
        (s1Answers.data ?? []).length === 1 &&
        (s2Sessions.data ?? []).length === 0 &&
        (s2Answers.data ?? []).length === 0 &&
        (lectSessions.data ?? []).length >= 1 &&
        lectSessions.data.some((s) => s.student_id === studentS1.id) &&
        (lectAnswers.data ?? []).length === 1 &&
        lateAnswer.data?.error === "session_not_active",
      `s1sess=${(s1Sessions.data ?? []).length} s1ans=${(s1Answers.data ?? []).length} s2sess=${(s2Sessions.data ?? []).length} s2ans=${(s2Answers.data ?? []).length} lectSess=${(lectSessions.data ?? []).length} lectAns=${(lectAnswers.data ?? []).length} late=${JSON.stringify(lateAnswer.data)}`);
  }

  // ── D7: cross-student session/answer reads (fresh quiz) ────────
  {
    const quiz = await makeQuiz({ title: "D7 Cross", mode: "assessment" });
    await addQuestions(quiz.id, QUESTION_TEMPLATE);
    await publish(quiz.id);
    const s1 = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    const s1Session = s1.data.session.id;
    const qs = (await clientA.from("questions").select("id, correct_index").eq("quiz_id", quiz.id).order("order_index")).data;
    await clientS1.rpc("answer_question", {
      p_session_id: s1Session, p_question_id: qs[0].id, p_selected_index: qs[0].correct_index,
    });

    // S3 (enrolled, different student) cannot see S1's session/answers.
    const s3Sessions = await clientS3.from("quiz_sessions").select("id").eq("id", s1Session);
    const s3Answers = await clientS3.from("session_answers").select("id").eq("session_id", s1Session);
    // S3 starts their OWN attempt (assessment, per-student) and sees only their own.
    const s3 = await clientS3.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    const s3Session = s3.data.session.id;
    const s3Own = await clientS3.from("quiz_sessions").select("id").eq("id", s3Session);
    const s1OwnAll = await clientS1.from("quiz_sessions").select("id").eq("quiz_id", quiz.id);
    record("D7 cross-student isolation: own rows only",
      (s3Sessions.data ?? []).length === 0 &&
        (s3Answers.data ?? []).length === 0 &&
        (s3Own.data ?? []).length === 1 &&
        (s1OwnAll.data ?? []).filter((s) => s.id === s1Session).length === 1,
      `s3seesS1=${(s3Sessions.data ?? []).length}/${(s3Answers.data ?? []).length} s3own=${(s3Own.data ?? []).length}`);
  }

  // ── D47: raw anon PostgREST calls denied + anon SELECT 0 rows ──
  {
    const anonClient = createClient(URL, ANON, { auth: { persistSession: false } });
    // A live quiz (reuse the D44b A practice quiz which is live).
    const quiz = (await clientA.from("quizzes").select("id").eq("title", "D44b A").single()).data;
    const ghostSession = "00000000-0000-4000-8000-0000000000aa";

    const startDenied = await anonClient.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    const answerDenied = await anonClient.rpc("answer_question", {
      p_session_id: ghostSession, p_question_id: ghostSession, p_selected_index: 0,
    });
    const submitDenied = await anonClient.rpc("submit_session", { p_session_id: ghostSession });

    const anonSessions = await anonClient.from("quiz_sessions").select("id");
    const anonAnswers = await anonClient.from("session_answers").select("id");
    const anonView = await anonClient.from("student_question_view").select("id");

    const denied = (r) => Boolean(r.error) &&
      (r.error.message?.includes("permission denied") ||
        r.error.message?.includes("JWT") ||
        r.error.message?.includes("not found") ||
        r.error.message?.includes("function") ||
        r.error.message?.includes("does not exist"));

    record("D47 raw-anon RPC calls denied (execute revoked)",
      denied(startDenied) && denied(answerDenied) && denied(submitDenied),
      `start=${startDenied.error?.message ?? JSON.stringify(startDenied.data)} answer=${answerDenied.error?.message ?? ""} submit=${submitDenied.error?.message ?? ""}`);

    record("D47 anon SELECT quiz_sessions/session_answers → 0 rows; question view → 0 rows",
      (anonSessions.data ?? []).length === 0 &&
        (anonAnswers.data ?? []).length === 0 &&
        (anonView.data ?? []).length === 0,
      `sessions=${(anonSessions.data ?? []).length} answers=${(anonAnswers.data ?? []).length} view=${(anonView.data ?? []).length}`);
  }

  // ── D48: student_results matrix (PLAN v4 §6) ────────────────────
  {
    const quiz = await makeQuiz({ title: "D48 Results", mode: "assessment" });
    const qs = await addQuestions(quiz.id, QUESTION_TEMPLATE);
    await publish(quiz.id);

    // Enrolled student S1 answers + submits.
    const start = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    const sessionId = start.data.session.id;
    await clientS1.rpc("answer_question", {
      p_session_id: sessionId, p_question_id: qs[0].id, p_selected_index: qs[0].correct_index,
    });
    await clientS1.rpc("submit_session", { p_session_id: sessionId });

    // Hidden → not_revealed (single no-oracle).
    const hidden = await clientS1.rpc("student_results", { p_quiz_id: quiz.id });
    record("D48 hidden assessment → student_results not_revealed",
      hidden.data?.error === "not_revealed", JSON.stringify(hidden.data));

    // Reveal → score + breakdown (questions, options, selected_index,
    // correct_index, explanation — D10-safe POST-reveal disclosure).
    const { error: revealErr } = await clientA
      .from("quizzes")
      .update({ results_revealed_at: new Date().toISOString() })
      .eq("id", quiz.id);
    assertNoError("D48 reveal", { error: revealErr });
    const revealed = await clientS1.rpc("student_results", { p_quiz_id: quiz.id });
    const js = revealed.data?.questions ?? [];
    record("D48 revealed → score/total + ordered breakdown",
      revealed.data?.score === 1 &&
        revealed.data?.total === 3 &&
        Array.isArray(js) && js.length === 3 &&
        js.every((q, i) => q.order_index === i) &&
        js.some((q) => q.correct_index !== undefined) &&
        js.some((q) => typeof q.explanation === "string"),
      JSON.stringify(revealed.data));

    // Non-enrolled S2 → not_revealed even post-reveal.
    const nonEnrolled = await clientS2.rpc("student_results", { p_quiz_id: quiz.id });
    record("D48 non-enrolled student → student_results not_revealed",
      nonEnrolled.data?.error === "not_revealed", JSON.stringify(nonEnrolled.data));
  }

  // ── D49: practice student_results → most recent completed session ──
  {
    const quiz = await makeQuiz({ title: "D49 Practice Results", mode: "practice" });
    await addQuestions(quiz.id, QUESTION_TEMPLATE);
    await publish(quiz.id);
    const sA = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    await clientS1.rpc("submit_session", { p_session_id: sA.data.session.id });
    const sB = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    const qs = (await clientA.from("questions").select("id, correct_index").eq("quiz_id", quiz.id).order("order_index")).data;
    await clientS1.rpc("answer_question", {
      p_session_id: sB.data.session.id, p_question_id: qs[0].id, p_selected_index: qs[0].correct_index,
    });
    await clientS1.rpc("submit_session", { p_session_id: sB.data.session.id });
    const res = await clientS1.rpc("student_results", { p_quiz_id: quiz.id });
    record("D49 practice → most recent completed session (score from session 2)",
      res.data?.score === 1 && res.data?.total === 3,
      JSON.stringify(res.data));
  }

  // ── D50: one-way reveal trigger ────────────────────────────────
  {
    const quiz = await makeQuiz({ title: "D50 One-Way", mode: "assessment" });
    await addQuestions(quiz.id, QUESTION_TEMPLATE);
    await publish(quiz.id);
    const { error: revealErr } = await clientA
      .from("quizzes")
      .update({ results_revealed_at: new Date().toISOString() })
      .eq("id", quiz.id);
    assertNoError("D50 first reveal", { error: revealErr });

    // Changing the revealed timestamp → trigger raises reveal_once_only.
    const { error: revertErr } = await clientA
      .from("quizzes")
      .update({ results_revealed_at: new Date().toISOString() })
      .eq("id", quiz.id);
    record("D50 reveal is one-way (trigger rejects a change from non-null)",
      revertErr != null &&
        (revertErr.message?.includes("reveal_once_only") ||
          revertErr.message?.includes("revert")),
      revertErr?.message ?? "no error");

    // Same-value no-op passes (idempotent).
    const row = (await clientA.from("quizzes").select("results_revealed_at").eq("id", quiz.id)).data?.[0];
    const { error: sameErr } = await clientA
      .from("quizzes")
      .update({ results_revealed_at: row.results_revealed_at })
      .eq("id", quiz.id);
    record("D50 same-value reveal update is a no-op (idempotent)",
      !sameErr, sameErr?.message ?? "");
  }

  // ── D51: auto-reveal fires exactly once on the LAST submit ────
  {
    const quiz = await makeQuiz({ title: "D51 AutoReveal", mode: "assessment" });
    const qs = await addQuestions(quiz.id, QUESTION_TEMPLATE);
    await publish(quiz.id);
    // Lecturer enables auto_reveal_on_complete (live quiz — editable flag).
    const { error: flagErr } = await clientA
      .from("quizzes")
      .update({ auto_reveal_on_complete: true })
      .eq("id", quiz.id);
    assertNoError("D51 flag", { error: flagErr });

    // Two enrolled students S1 + S3 both start; S3 finishes LAST → reveal fires.
    const s1 = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    const s3 = await clientS3.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    const q1 = qs[0];
    await clientS1.rpc("answer_question", {
      p_session_id: s1.data.session.id, p_question_id: q1.id, p_selected_index: q1.correct_index,
    });
    const sub1 = await clientS1.rpc("submit_session", { p_session_id: s1.data.session.id });
    const s1RevealState = (await clientA.from("quizzes").select("results_revealed_at").eq("id", quiz.id)).data?.[0];
    record("D51 first submit: active session remains → NOT revealed",
      sub1.data?.score === null && s1RevealState?.results_revealed_at == null,
      `score=${sub1.data?.score} revealed=${s1RevealState?.results_revealed_at ?? "null"}`);

    // S3 answers correctly too — score 1 is what the auto-reveal must surface.
    await clientS3.rpc("answer_question", {
      p_session_id: s3.data.session.id, p_question_id: q1.id, p_selected_index: q1.correct_index,
    });
    const sub3 = await clientS3.rpc("submit_session", { p_session_id: s3.data.session.id });
    const s3State = (await clientA.from("quizzes").select("results_revealed_at").eq("id", quiz.id)).data?.[0];
    record("D51 last submit → auto-reveal fires, score returned in same response",
      sub3.data?.score === 1 && s3State?.results_revealed_at != null,
      `score=${sub3.data?.score} revealed=${s3State?.results_revealed_at ?? "null"}`);
  }

  // ── D52: retake spawn — attempt increments, default config invisible ──
  {
    const quiz = await makeQuiz({ title: "D52 Retake", mode: "assessment" });
    const qs = await addQuestions(quiz.id, QUESTION_TEMPLATE);
    await publish(quiz.id);

    // S1 completes attempt 1.
    const s1a = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    assertNoError("D52 start attempt 1", s1a);
    await clientS1.rpc("answer_question", {
      p_session_id: s1a.data.session.id, p_question_id: qs[0].id, p_selected_index: qs[0].correct_index,
    });
    await clientS1.rpc("submit_session", { p_session_id: s1a.data.session.id });

    // Default config (allow_retake=false, max_attempts=1): restart → already_attempted
    // WITH the latest session_id (legacy 0008 shape — the client lands on the
    // completed session's EndScreen; e5 pins the journey).
    const blocked = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    record("D52 default config: completed attempt blocks restart (byte-identical legacy behavior)",
      blocked.data?.error === "already_attempted" && blocked.data?.session_id === s1a.data.session.id,
      JSON.stringify(blocked.data));

    // Lecturer enables retakes live (outside the edit-freeze) with max 2 attempts.
    const { error: retakeErr } = await clientA
      .from("quizzes")
      .update({ allow_retake: true, max_attempts: 2 })
      .eq("id", quiz.id);
    assertNoError("D52 enable retake on live quiz", { error: retakeErr });

    // Attempt 2 spawns with attempt=2; attempt-1 row still exists (evidence preserved).
    const s1b = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    record("D52 retake spawn → new session, attempt=2",
      Boolean(s1b.data?.session) && s1b.data.session.attempt === 2 &&
        s1b.data.session.id !== s1a.data.session.id,
      JSON.stringify(s1b.data));
    const allRows = await clientS1.from("quiz_sessions").select("id, attempt, status")
      .eq("quiz_id", quiz.id).eq("student_id", studentS1.id).order("attempt");
    record("D52 both attempts coexist (completed attempt-1 + active attempt-2)",
      (allRows.data ?? []).length === 2 && allRows.data[0].attempt === 1 &&
        allRows.data[0].status === "completed" && allRows.data[1].attempt === 2,
      JSON.stringify(allRows.data ?? []));

    // Concurrent second ACTIVE attempt rejected (one-active invariant).
    const s1c = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    record("D52 active attempt-2 blocks a third concurrent start (resume-or-error)",
      s1c.data?.error === "already_attempted" && s1c.data?.session_id === s1b.data.session.id,
      JSON.stringify(s1c.data));

    // Budget exhausted: complete attempt 2 → third start rejected WITH the
    // latest completed session id (legacy shape — EndScreen landing).
    await clientS1.rpc("submit_session", { p_session_id: s1b.data.session.id });
    const exhausted = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    record("D52 budget exhausted (2 of 2 used) → already_attempted, latest completed session_id",
      exhausted.data?.error === "already_attempted" &&
        (exhausted.data?.session_id === s1a.data.session.id ||
         exhausted.data?.session_id === s1b.data.session.id),
      JSON.stringify(exhausted.data));

    // Practice quizzes are untouched by the retake machinery.
    const pQuiz = await makeQuiz({ title: "D52 Practice Untouched", mode: "practice" });
    await addQuestions(pQuiz.id, QUESTION_TEMPLATE);
    await publish(pQuiz.id);
    const p1 = await clientS1.rpc("start_quiz_session", { p_quiz_id: pQuiz.id });
    const p2 = await clientS1.rpc("start_quiz_session", { p_quiz_id: pQuiz.id });
    record("D52 practice rejoin unchanged (same session id, attempt=1)",
      p1.data?.session?.id === p2.data?.session?.id && p2.data.session.attempt === 1,
      JSON.stringify(p2.data));
    void qs;
  }

  // ── D53: stale-paused sealing — passed window preserves evidence ──
  {
    const quiz = await makeQuiz({ title: "D53 Stale Seal", mode: "assessment" });
    await addQuestions(quiz.id, QUESTION_TEMPLATE);
    await publish(quiz.id);

    // S1 starts attempt 1, then the window passes while the session is active.
    const s1a = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    assertNoError("D53 start attempt 1", s1a);
    await clientA.from("quizzes").update({ closes_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", quiz.id);

    // Restart attempt: the stale session is sealed completed (scored as-is,
    // evidence preserved — unconditional, no budget requirement) and the
    // spawn is window-stopped.
    const s1b = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    record("D53 stale active session from a PASSED window → sealed, spawn window-stopped",
      s1b.data?.error === "quiz_window_closed",
      JSON.stringify(s1b.data));
    const rows = await clientS1.from("quiz_sessions").select("id, attempt, status, submitted_at")
      .eq("quiz_id", quiz.id).eq("student_id", studentS1.id).order("attempt");
    record("D53 sealed attempt-1 marked completed (never deleted — evidence preserved)",
      (rows.data ?? []).length === 1 && rows.data[0].status === "completed" &&
        rows.data[0].submitted_at != null,
      JSON.stringify(rows.data ?? []));

    // No-budget case behaves identically (sealing is unconditional).
    const quiz2 = await makeQuiz({ title: "D53 No Budget", mode: "assessment" });
    await addQuestions(quiz2.id, QUESTION_TEMPLATE);
    await publish(quiz2.id);
    const s3a = await clientS3.rpc("start_quiz_session", { p_quiz_id: quiz2.id });
    assertNoError("D53 no-budget start", s3a);
    await clientA.from("quizzes").update({ closes_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", quiz2.id);
    const s3b = await clientS3.rpc("start_quiz_session", { p_quiz_id: quiz2.id });
    record("D53 no retake budget: stale session sealed identically (window-stopped, not stranded)",
      s3b.data?.error === "quiz_window_closed",
      JSON.stringify(s3b.data));

    // Without a passed window, an active session blocks normally (no sealing).
    const quiz3 = await makeQuiz({ title: "D53 Windowless", mode: "assessment" });
    await addQuestions(quiz3.id, QUESTION_TEMPLATE);
    await publish(quiz3.id);
    const s1c = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz3.id });
    assertNoError("D53 windowless start", s1c);
    const s1d = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz3.id });
    record("D53 windowless quiz: active session blocks normally (no seal)",
      s1d.data?.error === "already_attempted" && s1d.data?.session_id === s1c.data.session.id,
      JSON.stringify(s1d.data));
  }

  // ── D54: retake-aware auto-reveal (QC-4 pre-flight decision 1) ──
  {
    const quiz = await makeQuiz({ title: "D54 Retake Reveal", mode: "assessment" });
    await addQuestions(quiz.id, QUESTION_TEMPLATE);
    await publish(quiz.id);
    await clientA.from("quizzes").update({ auto_reveal_on_complete: true }).eq("id", quiz.id);
    await clientA.from("quizzes").update({ allow_retake: true, max_attempts: 2 }).eq("id", quiz.id);

    // S1 completes attempt 1 of an allowed 2 → auto-reveal must NOT fire.
    const s1a = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    assertNoError("D54 start attempt 1", s1a);
    const sub1 = await clientS1.rpc("submit_session", { p_session_id: s1a.data.session.id });
    const after1 = (await clientA.from("quizzes").select("results_revealed_at").eq("id", quiz.id)).data?.[0];
    record("D54 fresh completed student with retake budget remaining → NOT revealed",
      sub1.data?.score === null && after1?.results_revealed_at == null,
      `score=${sub1.data?.score} revealed=${after1?.results_revealed_at ?? "null"}`);

    // S3 (no retake interest, single completion) — S1 still holds budget, so no reveal.
    const s3a = await clientS3.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    assertNoError("D54 S3 start", s3a);
    await clientS3.rpc("submit_session", { p_session_id: s3a.data.session.id });
    const afterS3 = (await clientA.from("quizzes").select("results_revealed_at").eq("id", quiz.id)).data?.[0];
    record("D54 S3 completion alone does not reveal (S1 budget outstanding)",
      afterS3?.results_revealed_at == null,
      `revealed=${afterS3?.results_revealed_at ?? "null"}`);

    // S1 completes their final attempt → budget exhausted everywhere → reveal fires.
    const s1b = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    assertNoError("D54 start attempt 2", s1b);
    await clientS1.rpc("submit_session", { p_session_id: s1b.data.session.id });
    const after2 = (await clientA.from("quizzes").select("results_revealed_at").eq("id", quiz.id)).data?.[0];
    record("D54 budget exhausted on final submit → auto-reveal fires",
      after2?.results_revealed_at != null,
      `revealed=${after2?.results_revealed_at ?? "null"}`);
  }

  // ── D55: quiz_completed_all digest counts DISTINCT students (QC-4) ──
  {
    const quiz = await makeQuiz({ title: "D55 Digest Distinct", mode: "assessment" });
    await addQuestions(quiz.id, QUESTION_TEMPLATE);
    await publish(quiz.id);
    // Exactly 2 enrolled students in this harness (S1 + S3). Enable retakes
    // (max 3) so S1's second attempt alone CANNOT satisfy the inequality.
    await clientA.from("quizzes").update({ allow_retake: true, max_attempts: 3 }).eq("id", quiz.id);

    // S1 completes TWO attempts (a session-row count of 2 would have fired
    // the 0022 digest under the old count(*) against enrollment=2).
    const s1a = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    assertNoError("D55 S1 attempt 1", s1a);
    await clientS1.rpc("submit_session", { p_session_id: s1a.data.session.id });
    const s1b = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    assertNoError("D55 S1 attempt 2", s1b);
    await clientS1.rpc("submit_session", { p_session_id: s1b.data.session.id });

    const digestAfterS1 = await clientA.from("notifications").select("id, dedupe_key")
      .eq("type", "quiz_completed_all").like("dedupe_key", `quiz_completed_all:${quiz.id}%`);
    record("D55 two attempts by ONE student do NOT fire the digest (distinct-student count)",
      (digestAfterS1.data ?? []).length === 0,
      JSON.stringify(digestAfterS1.data ?? []));

    // S3 completes once → distinct students = 2 = enrollment → digest fires once.
    const s3a = await clientS3.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    assertNoError("D55 S3 attempt 1", s3a);
    await clientS3.rpc("submit_session", { p_session_id: s3a.data.session.id });
    const digestFinal = await clientA.from("notifications").select("id, dedupe_key")
      .eq("type", "quiz_completed_all").like("dedupe_key", `quiz_completed_all:${quiz.id}%`);
    record("D55 second DISTINCT student completes → digest fires exactly once",
      (digestFinal.data ?? []).length === 1 &&
        digestFinal.data[0].dedupe_key === `quiz_completed_all:${quiz.id}`,
      JSON.stringify(digestFinal.data ?? []));
  }

  // ── QT1: multi-select grading, storage, secrecy (0036/0037) ─────
  {
    // One practice quiz, one multi question PER grading case (practice
    // upserts would otherwise overwrite the same row between cases).
    const quiz = await makeQuiz({ title: "QT1 Multi", mode: "practice" });
    const qs = await addQuestions(quiz.id, [
      { type: "multi_select", prompt: "exact-set case", options: ["2", "3", "4", "5"], correct_index: null, correct_indices: [0, 1, 3], explanation: "2, 3, 5." },
      { type: "multi_select", prompt: "wrong-set case", options: ["a", "b", "c"], correct_index: null, correct_indices: [0, 1] },
      { type: "multi_select", prompt: "subset case", options: ["a", "b", "c"], correct_index: null, correct_indices: [0, 1, 2] },
      { type: "multi_select", prompt: "superset case", options: ["a", "b", "c"], correct_index: null, correct_indices: [0, 1] },
      { type: "multi_select", prompt: "full-set case", options: ["a", "b"], correct_index: null, correct_indices: [0, 1] },
    ]);
    await publish(quiz.id);
    const s1 = await clientS1.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    const qtSession = s1.data.session.id;

    const answer = (qid, set, extra = {}) =>
      clientS1.rpc("answer_question", {
        p_session_id: qtSession, p_question_id: qid, p_selected_indices: set, ...extra,
      });

    const exact = await answer(qs[0].id, [3, 0, 1]); // order-insensitive
    const wrong = await answer(qs[1].id, [0, 2]);
    const subset = await answer(qs[2].id, [0, 1]);
    const superset = await answer(qs[3].id, [0, 1, 2]);
    const fullSet = await answer(qs[4].id, [0, 1]);

    record("QT1-D3 practice multi: exact set (order-insensitive) → correct + set echo",
      exact.data?.is_correct === true &&
        JSON.stringify(exact.data?.correct_indices) === JSON.stringify([0, 1, 3]) &&
        exact.data?.correct_index === null &&
        exact.data?.explanation === "2, 3, 5.",
      JSON.stringify(exact.data));
    record("QT1-D3 wrong set → false",
      wrong.data?.is_correct === false && wrong.data?.correct_index === null,
      JSON.stringify(wrong.data));
    record("QT1-D3 subset → false (all-or-nothing, no partial credit)",
      subset.data?.is_correct === false, JSON.stringify(subset.data));
    record("QT1-D3 superset → false",
      superset.data?.is_correct === false, JSON.stringify(superset.data));
    record("QT1-D3 full set (all options correct) → true",
      fullSet.data?.is_correct === true, JSON.stringify(fullSet.data));

    // QT1-D4: validation matrix (errors do not consume the answer slot).
    const eQuiz = await makeQuiz({ title: "QT1 Multi Errors", mode: "practice" });
    const eqs = await addQuestions(eQuiz.id, [
      { type: "multi_select", prompt: "bounds case", options: ["a", "b", "c"], correct_index: null, correct_indices: [0, 1] },
      { type: "mcq", prompt: "scalar case", options: ["a", "b"], correct_index: 0 },
    ]);
    await publish(eQuiz.id);
    const es1 = await clientS1.rpc("start_quiz_session", { p_quiz_id: eQuiz.id });
    const eSession = es1.data.session.id;
    const mq = eqs[0].id;
    const scalarQ = eqs[1].id;
    const tryAnswer = (args) => clientS1.rpc("answer_question", { p_session_id: eSession, ...args });

    const oob = await tryAnswer({ p_question_id: mq, p_selected_indices: [0, 9] });
    const empty = await tryAnswer({ p_question_id: mq, p_selected_indices: [] });
    const nullElem = await tryAnswer({ p_question_id: mq, p_selected_indices: [1, null] });
    const both = await tryAnswer({ p_question_id: mq, p_selected_index: 0, p_selected_indices: [0] });
    const setOnScalar = await tryAnswer({ p_question_id: scalarQ, p_selected_indices: [0] });
    const scalarOnMulti = await tryAnswer({ p_question_id: mq, p_selected_index: 0 });

    record("QT1-D4 OOB element → invalid_selected_indices",
      oob.data?.error === "invalid_selected_indices", JSON.stringify(oob.data));
    record("QT1-D4 empty set → invalid_selected_indices",
      empty.data?.error === "invalid_selected_indices", JSON.stringify(empty.data));
    record("QT1-D4 SQL NULL element → invalid_selected_indices ('{1,NULL}' trap)",
      nullElem.data?.error === "invalid_selected_indices", JSON.stringify(nullElem.data));
    record("QT1-D4 scalar AND set together → invalid_selected_indices",
      both.data?.error === "invalid_selected_indices", JSON.stringify(both.data));
    record("QT1-D4 set submitted for a scalar question → invalid_selected_indices",
      setOnScalar.data?.error === "invalid_selected_indices", JSON.stringify(setOnScalar.data));
    record("QT1-D4 scalar submitted for a multi question → invalid_selected_indices",
      scalarOnMulti.data?.error === "invalid_selected_indices", JSON.stringify(scalarOnMulti.data));

    // QT1-D5: assessment keyless ack + stored canonical set + key via lecturer view.
    const aQuiz = await makeQuiz({ title: "QT1 Multi Assessment", mode: "assessment" });
    const aqs = await addQuestions(aQuiz.id, [
      { type: "multi_select", prompt: "assessment multi", options: ["p", "q", "r"], correct_index: null, correct_indices: [0, 2] },
    ]);
    await publish(aQuiz.id);
    const as1 = await clientS1.rpc("start_quiz_session", { p_quiz_id: aQuiz.id });
    const aSession = as1.data.session.id;
    const ack = await clientS1.rpc("answer_question", {
      p_session_id: aSession, p_question_id: aqs[0].id, p_selected_indices: [2, 0],
    });
    const lectRow = await clientA
      .from("lecturer_answers_view")
      .select("selected_index, selected_indices, is_correct")
      .eq("session_id", aSession)
      .maybeSingle();
    record("QT1-D5 assessment multi: keyless ack + stored canonical set via lecturer_answers_view",
      ack.data?.recorded === true && !("is_correct" in (ack.data ?? {})) &&
        lectRow.data?.selected_index === null &&
        JSON.stringify(lectRow.data?.selected_indices) === JSON.stringify([0, 2]) &&
        lectRow.data?.is_correct === true,
      `ack=${JSON.stringify(ack.data)} row=${JSON.stringify(lectRow.data)}`);

    // QT1-D5b: re-answer of an assessment multi question → keyless
    // already_answered (no is_correct / correct_indices leak) and the
    // FIRST answer stays stored.
    const replay = await clientS1.rpc("answer_question", {
      p_session_id: aSession, p_question_id: aqs[0].id, p_selected_indices: [1],
    });
    const lectRow2 = await clientA
      .from("lecturer_answers_view")
      .select("selected_indices, is_correct")
      .eq("session_id", aSession)
      .maybeSingle();
    record("QT1-D5b assessment multi re-answer → keyless already_answered, first answer intact",
      replay.data?.error === "already_answered" &&
        !("is_correct" in (replay.data ?? {})) &&
        !("correct_indices" in (replay.data ?? {})) &&
        JSON.stringify(lectRow2.data?.selected_indices) === JSON.stringify([0, 2]) &&
        lectRow2.data?.is_correct === true,
      `replay=${JSON.stringify(replay.data)} row=${JSON.stringify(lectRow2.data)}`);

    // QT1-D5c: a 6-element set (direct-RPC adversarial path — Zod cannot
    // be relied on) → invalid_selected_indices; a 3-named-arg call (the
    // historical call shape) still resolves through the new signature.
    const six = await clientS1.rpc("answer_question", {
      p_session_id: aSession, p_question_id: aqs[0].id,
      p_selected_indices: [0, 1, 2, 3, 4, 5],
    });
    const legacyShape = await clientS1.rpc("answer_question", {
      p_session_id: aSession, p_question_id: aqs[0].id, p_selected_index: 0,
    });
    record("QT1-D5c 6-element set rejected; legacy 3-arg call shape resolves (to the multi branch here)",
      six.data?.error === "invalid_selected_indices" &&
        legacyShape.data?.error === "invalid_selected_indices",
      `six=${JSON.stringify(six.data)} legacy=${JSON.stringify(legacyShape.data)}`);

    // QT1-D6: practice upsert overwrites BOTH key columns.
    await clientS1.rpc("answer_question", {
      p_session_id: qtSession, p_question_id: qs[1].id, p_selected_indices: [0],
    });
    const up2 = await clientS1.rpc("answer_question", {
      p_session_id: qtSession, p_question_id: qs[1].id, p_selected_indices: [0, 1],
    });
    const upRow = await clientS1
      .from("student_answers_view")
      .select("selected_index, selected_indices, is_correct")
      .eq("session_id", qtSession)
      .eq("question_id", qs[1].id)
      .maybeSingle();
    record("QT1-D6 practice re-answer upserts the set (no stale scalar)",
      up2.data?.is_correct === true &&
        upRow.data?.selected_index === null &&
        JSON.stringify(upRow.data?.selected_indices) === JSON.stringify([0, 1]),
      `row=${JSON.stringify(upRow.data)}`);

    // QT1-D8a: student_question_view select(*) omits BOTH key columns on a
    // multi-question quiz (extends D42).
    const starMulti = await clientS1
      .from("student_question_view")
      .select("*")
      .eq("quiz_id", quiz.id);
    record("QT1-D8a select(*) on student_question_view → no correct_index/correct_indices keys",
      Array.isArray(starMulti.data) && starMulti.data.length > 0 &&
        !("correct_index" in starMulti.data[0]) &&
        !("correct_indices" in starMulti.data[0]) &&
        !("explanation" in starMulti.data[0]),
      `keys=${Array.isArray(starMulti.data) && starMulti.data.length ? Object.keys(starMulti.data[0]).join(",") : "?"}`);

    // QT1-D7: student_results rows carry the set keys (practice auto-reveals).
    await clientS1.rpc("submit_session", { p_session_id: qtSession });
    const results = await clientS1.rpc("student_results", { p_quiz_id: quiz.id });
    const rows = results.data?.questions ?? [];
    const multiRow = rows.find((r) => r.question_id === qs[0].id);
    const canonicalSet = JSON.stringify([0, 1, 3]);
    record("QT1-D7 student_results: correct_indices + selected_indices arrays present",
      Array.isArray(multiRow?.correct_indices) &&
        JSON.stringify(multiRow.correct_indices) === canonicalSet &&
        JSON.stringify([...(multiRow.selected_indices ?? [])].sort((a, b) => a - b)) === canonicalSet,
      JSON.stringify(multiRow ? [multiRow.correct_indices, multiRow.selected_indices] : multiRow));
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
