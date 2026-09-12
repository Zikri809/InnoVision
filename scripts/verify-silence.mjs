// Silence-cron live harness (audit-1 §5 top-5 item 1: the 0042/0044/0045
// silence predicates had ZERO live pins). Runs the REAL
// flag_verify_silent_sessions() against live local Supabase with
// admin-backdated timestamps and pins:
//
//   SV1  answering + checks stale + ZERO checks ever (coalesce headline) → flagged
//   SV2  GRACE POLARITY: exactly ONE post-check answer (honest mid-capture
//        returner) → NOT flagged. The 0044 baseline shipped this term
//        inverted (`<= 1`): it flagged the one-answer returner and excluded
//        the suppressed session. 0045 §4 fixes the direction to `>= 2` —
//        SV2/SV3 are the pins that would have caught it on day one.
//   SV3  suppression: TWO post-check answers within the 300s silence → flagged
//        + attributed audit row (auto_flag_verify_silence).
//   SV4  a REAL (fresh) verify suppresses flagging (300s term resets);
//        a STALE backfilled check does not.
//   SV5  answering freshness: answers older than 90s → never flagged.
//   SV6  0045 stale-unavailable: a FRESH face_unavailable_at claim exempts;
//        a STALE (>10 min) claim flows into the normal predicates.
//   SV7  0044 §8 advisory-touch throttle: a throttled (≤55s) direct-RPC
//        advisory does NOT touch last_activity_at.
//
// NOT a unit test; run manually: node scripts/verify-silence.mjs
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
const SERVICE = env.NEXT_PUBLIC_SUPABASE_URL ? env.SUPABASE_SERVICE_ROLE_KEY : undefined;

if (!URL || !ANON || !SERVICE) {
  console.error("Missing .env.local keys (NEXT_PUBLIC_SUPABASE_URL / ANON / SERVICE_ROLE).");
  process.exit(1);
}

assertLocalTarget(URL, "verify-silence.mjs");

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const results = [];
const createdUsers = [];
const createdClassIds = [];
const createdQuizIds = [];

// Fixture roots (assigned in main; the helpers close over them).
let lecturerL;
let clsA;
let joinCode;

function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

function assertNoError(step, { error }) {
  if (error) throw new Error(`${step}: ${error.message}`);
}

const minsAgo = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();
const secsAgo = (s) => new Date(Date.now() - s * 1000).toISOString();

async function asUser(email) {
  const client = createClient(URL, ANON, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: "hunter2!Secure" });
  if (error) throw error;
  return client;
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

const JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeJoinCode() {
  let c = "";
  for (let i = 0; i < 6; i++) {
    c += JOIN_CODE_ALPHABET[Math.floor(Math.random() * JOIN_CODE_ALPHABET.length)];
  }
  return c;
}

/**
 * One fresh ACTIVE assessment session for a fresh student on a fresh live
 * quiz — the minimal silence-cron fixture (quiz live + enrolled + active +
 * face_exempt false). `answerCount` answers are inserted directly via the
 * service role so answered_at can be backdated precisely.
 */
async function makeSilenceSession(label, { startedMinsAgo = 0, answerCount = 0, answerSecsAgo = 30 } = {}) {
  const student = await createUser(`sil-${label}-${stamp}@innovision.test`);
  const client = await asUser(student.email);
  const { error: joinErr } = await client.rpc("join_class", { code: joinCode });
  assertNoError(`${label} join`, { error: joinErr });

  const { data: quiz, error: quizErr } = await admin
    .from("quizzes")
    .insert({
      class_id: clsA.id,
      created_by: lecturerL.id,
      title: `Silence ${label}`,
      status: "draft",
      mode: "assessment",
      time_limit_sec: null,
    })
    .select("id")
    .single();
  assertNoError(`${label} quiz`, { error: quizErr });
  createdQuizIds.push(quiz.id);

  // Three questions: publish enforces a minimum count (0017). Each answer
  // fixture targets a DIFFERENT question — (session_id, question_id) is
  // UNIQUE, so multi-answer pins need distinct rows.
  const questionIds = [];
  for (let i = 0; i < 3; i++) {
    const { data: q, error: qErr } = await admin
      .from("questions")
      .insert({ quiz_id: quiz.id, order_index: i, type: "mcq", prompt: `Q${i}`, options: ["a", "b"], correct_index: 0 })
      .select("id")
      .single();
    assertNoError(`${label} question ${i}`, { error: qErr });
    questionIds.push(q.id);
  }

  const { error: pubErr } = await admin.from("quizzes").update({ status: "live" }).eq("id", quiz.id);
  assertNoError(`${label} publish`, { error: pubErr });

  const startRes = await client.rpc("start_quiz_session", { p_quiz_id: quiz.id });
  if (!startRes.data?.session) {
    throw new Error(`${label} start failed: ${JSON.stringify(startRes)}`);
  }
  const sessionId = startRes.data.session.id;

  if (startedMinsAgo > 0) {
    await admin.from("quiz_sessions").update({ started_at: minsAgo(startedMinsAgo) }).eq("id", sessionId);
  }

  for (let i = 0; i < answerCount; i++) {
    const { error: aErr } = await admin.from("session_answers").insert({
      session_id: sessionId,
      question_id: questionIds[i % questionIds.length],
      selected_index: 0,
      is_correct: true,
      answered_at: secsAgo(answerSecsAgo + i), // distinct, all fresh by default
    });
    assertNoError(`${label} answer ${i}`, { error: aErr });
  }

  return { student, client, quizId: quiz.id, sessionId, questionIds };
}

async function runCron() {
  const { data, error } = await admin.rpc("flag_verify_silent_sessions");
  assertNoError("cron run", { error });
  return data;
}

async function statusOf(sessionId) {
  return (await admin.from("quiz_sessions").select("status").eq("id", sessionId).single()).data.status;
}

async function main() {
  // ── Provision: lecturer + class ──────────────────────────────────
  lecturerL = await createUser(`sil-lect-${stamp}@innovision.test`);
  await admin.from("profiles").update({ role: "lecturer" }).eq("id", lecturerL.id);
  const clientL = await asUser(lecturerL.email);

  joinCode = makeJoinCode();
  const { data: createdClass, error: clsErr } = await clientL
    .from("classes")
    .insert({ title: "Silence Class", lecturer_id: lecturerL.id, join_code: joinCode })
    .select("id")
    .single();
  assertNoError("create class", { error: clsErr });
  clsA = createdClass;
  createdClassIds.push(clsA.id);

  // ── SV1: zero checks ever + answering + stale start → flagged ────
  {
    const { sessionId } = await makeSilenceSession("sv1", { startedMinsAgo: 7, answerCount: 3 });
    await runCron();
    record("SV1 zero-check answering session (coalesce headline) → flagged",
      (await statusOf(sessionId)) === "flagged", `status=${await statusOf(sessionId)}`);
  }

  // ── SV2/SV3: the GRACE POLARITY (0045 §4 inversion fix) ──────────
  {
    // SV2 — exactly ONE post-check answer: the honest mid-capture returner.
    // The grace must SKIP her (judged next tick); the inverted 0044 term
    // flagged exactly this shape.
    const one = await makeSilenceSession("sv2", { startedMinsAgo: 7, answerCount: 1 });
    await runCron();
    record("SV2 grace: ONE post-check answer (honest mid-capture) → NOT flagged",
      (await statusOf(one.sessionId)) === "active", `status=${await statusOf(one.sessionId)}`);

    // SV3 — the SECOND post-check answer exhausts the grace: suppressed
    // verification is flagged from that moment (count resets only on a real
    // verify, so pacing cannot clear it).
    const two = await makeSilenceSession("sv3", { startedMinsAgo: 7, answerCount: 2 });
    await runCron();
    const audits = await admin
      .from("audit_events")
      .select("action, metadata")
      .eq("subject_id", two.student.id)
      .eq("action", "auto_flag_verify_silence");
    record("SV3 suppression: SECOND post-check answer → flagged + attributed audit row",
      (await statusOf(two.sessionId)) === "flagged" && (audits.data ?? []).some((a) => a.metadata?.session_id === two.sessionId),
      `status=${await statusOf(two.sessionId)} audits=${(audits.data ?? []).length}`);
  }

  // ── SV4: a fresh real check suppresses; a stale one does not ─────
  {
    const fresh = await makeSilenceSession("sv4a", { startedMinsAgo: 7, answerCount: 2 });
    await admin.from("face_checks").insert({
      session_id: fresh.sessionId,
      matched: true,
      distance: 0,
      trigger: "periodic",
      checked_at: secsAgo(10),
    });
    await runCron();
    record("SV4a fresh verify committed → NOT flagged (300s term resets)",
      (await statusOf(fresh.sessionId)) === "active", `status=${await statusOf(fresh.sessionId)}`);

    const stale = await makeSilenceSession("sv4b", { startedMinsAgo: 7, answerCount: 2 });
    await admin.from("face_checks").insert({
      session_id: stale.sessionId,
      matched: true,
      distance: 0,
      trigger: "periodic",
      checked_at: minsAgo(6),
    });
    await runCron();
    record("SV4b only a STALE check (answers after it) → flagged",
      (await statusOf(stale.sessionId)) === "flagged", `status=${await statusOf(stale.sessionId)}`);
  }

  // ── SV5: answering freshness — stale answers never flag ──────────
  {
    const { sessionId } = await makeSilenceSession("sv5", { startedMinsAgo: 7, answerCount: 3, answerSecsAgo: 120 });
    await runCron();
    record("SV5 answers older than 90s (not currently answering) → NOT flagged",
      (await statusOf(sessionId)) === "active", `status=${await statusOf(sessionId)}`);
  }

  // ── SV6: 0045 stale-unavailable freshness (P0-3 kill-switch expiry) ──
  {
    const freshClaim = await makeSilenceSession("sv6a", { startedMinsAgo: 7, answerCount: 2 });
    await admin.from("quiz_sessions").update({ face_unavailable_at: minsAgo(3) }).eq("id", freshClaim.sessionId);
    await runCron();
    record("SV6a FRESH face_unavailable claim (<10 min) → exempt",
      (await statusOf(freshClaim.sessionId)) === "active", `status=${await statusOf(freshClaim.sessionId)}`);

    const staleClaim = await makeSilenceSession("sv6b", { startedMinsAgo: 7, answerCount: 2 });
    await admin.from("quiz_sessions").update({ face_unavailable_at: minsAgo(15) }).eq("id", staleClaim.sessionId);
    await runCron();
    record("SV6b STALE face_unavailable claim (>10 min) → flagged",
      (await statusOf(staleClaim.sessionId)) === "flagged", `status=${await statusOf(staleClaim.sessionId)}`);
  }

  // ── SV7: 0044 §8 — throttled advisory does NOT touch last_activity_at ──
  {
    const { client, sessionId } = await makeSilenceSession("sv7");
    const before = (await admin.from("quiz_sessions").select("last_activity_at").eq("id", sessionId).single()).data.last_activity_at;
    // First advisory: a real occurrence (throttle window empty) → touches.
    const first = await client.rpc("report_session_advisory", { p_session_id: sessionId, p_type: "voice_activity" });
    assertNoError("sv7 first advisory", { error: first.error });
    const afterFirst = (await admin.from("quiz_sessions").select("last_activity_at").eq("id", sessionId).single()).data.last_activity_at;
    // Second within the 55s window: throttled → found=false → NO touch.
    const second = await client.rpc("report_session_advisory", { p_session_id: sessionId, p_type: "voice_activity" });
    assertNoError("sv7 second advisory", { error: second.error });
    const afterSecond = (await admin.from("quiz_sessions").select("last_activity_at").eq("id", sessionId).single()).data.last_activity_at;
    record("SV7 advisory: first occurrence touches last_activity_at, throttled repeat does not",
      afterFirst !== null && afterSecond === afterFirst,
      `before=${before} after1=${afterFirst} after2=${afterSecond}`);
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
