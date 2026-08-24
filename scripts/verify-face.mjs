// Phase 7 CompreFace migration: security/RLS/RPC verification harness — runs
// against live local Supabase. This harness — NOT FakeSupabase — is the SOLE
// authoritative check for face-RPC semantics (consent gate, guard trigger,
// nonce rotation, FLAT window, RLS). FakeSupabase branches are route-mapping
// stubs kept in lockstep with migration 0010_compreface.sql.
//
// Covers gate tests (PLAN_PHASE7_COMPREFACE_MIGRATION §5/§9):
//   D10  — face_checks owner insert visible / other → not_owner; direct INSERT
//          denied; student B SELECT of A's rows → 0 rows via RLS
//   D11  — enroll for self; others unchanged; re-enroll audit; first-time
//          mid-active allowed; revoke→re-enroll while live → live_assessment
//   D13  — audit rows for unlock / exempt / self-recover / consent_revoked
//   D14  — verify nonce rotates; old-nonce replay → nonce_mismatch
//   D-col-priv — direct PATCH profiles.face_enrollment_status → blocked
//   Plus new pins: consent gate; direct face_enrollment_status UPDATE blocked;
//   duplicate-detected enrollment → pending_review; pending_review verify →
//   not_enrolled; lecturer reject_face_enrollment → status null + re-enroll;
//   multi-frame majority vote (2-of-3 pass / 1-of-3 fail / lookalike-top1
//   still passes — the margin rule is GONE as of 0020); submit from flagged →
//   session_not_active + status unchanged; unlock/exempt/self-recover of
//   completed → session_not_active; self-recover of active → idempotent
//   no-op; not_enrolled; not_assessment; consent_required after revocation +
//   in-progress assessment flagged on revocation + re-consent does not
//   un-flag; suspected_replay/too_frequent advisory flags (server-computed
//   frame hash over the concatenated frames); focus-loss pause escalation
//   (3rd strike → flagged + attributed audit row; paused_at cleared; unlock
//   resets the counter); report_session_advisory upsert + direct-RPC spam
//   throttle; report_face_unavailable idempotence; window tie-break (two
//   checks with identical checked_at ordered by id DESC).
//
// Audit-loop additions:
//   I-window — FLAT last-5 semantics against the REAL SQL: (a) a pass NEVER
//     flags the current check (4 backfilled fails + live match → active); (b)
//     a fail AFTER that pass re-flags (standing fails survive); (c) F,P,F,P,F
//     → flagged; (d) fails spread over 8 (≤2 per 5-window) → never flagged.
//   I-vote — multi-frame majority against the REAL SQL: strict majority of
//     per-frame similarities ≥ 0.5 over the SUBMITTED frames; distance =
//     1 − max(similarity); a lookalike ranking top-1 in the gallery can no
//     longer fail the check (1:1 by lookup; margin rule removed in 0020).
//   I-threshold — FACE_SIMILARITY_MIN boundary: similarity exactly 0.5 → match;
//     0.49 → no match.
//   I-numeric — NULL array element / out-of-range (> 1) / |similarities| ≠
//     |frames| → typed invalid_frame (never a raw 500; NaN in Postgres
//     compares > every number, so it MUST be rejected, not trusted).
//     (never a raw 500; NaN in Postgres compares > every number, so it MUST be
//     rejected, not trusted).
//   I-exempt — exempt short-circuit against the SQL: matched:true + distance
//     null + NO face_checks row + NO nonce rotation.
//   I-quiz-closed / I-class-removal — verify after quiz close / class removal
//     → quiz_not_live.
//
// NOTE: the RPC now receives CompreFace METADATA (subject/similarity) — not an
// embedding. `record_face_check` computes `matched` itself from SQL constants.
// A direct caller can forge metadata for their OWN uid (residual risk,
// documented in PLAN_PHASE7_COMPREFACE_MIGRATION §7); the `p_subject =
// auth.uid()` check means they can only pass as themselves.
//
// NOT a unit test; run manually: node scripts/verify-face.mjs
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

assertLocalTarget(URL, "verify-face.mjs");

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

async function setConsent(userId) {
  const { error } = await admin
    .from("profiles")
    .update({ consent_given_at: new Date().toISOString() })
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

/**
 * Match probe: CompreFace returns the caller's OWN uid with high similarity
 * (single-frame vote — majority-of-1 passes).
 */
function matchProbe(subjectUid, frame = "test-frame-match") {
  return {
    p_subject: subjectUid,
    p_similarities: [0.9],
    p_frames: [frame],
  };
}

/** Mismatch probe: CompreFace returns no self reading / low similarity. */
function mismatchProbe(frame = "test-frame-mismatch") {
  return {
    p_subject: "00000000-0000-0000-0000-000000000000",
    p_similarities: [0.1],
    p_frames: [frame],
  };
}

async function main() {
  // ── Provision: lecturer A, students S1/S2/S3 ─────────────────────
  const lecturerA = await createUser(`faceA-${stamp}@innovision.test`);
  const studentS1 = await createUser(`faceS1-${stamp}@innovision.test`);
  await createUser(`faceS2-${stamp}@innovision.test`);
  const studentS3 = await createUser(`faceS3-${stamp}@innovision.test`);
  await promoteLecturer(lecturerA.id);

  const clientA = await asUser(`faceA-${stamp}@innovision.test`);
  const clientS1 = await asUser(`faceS1-${stamp}@innovision.test`);
  const clientS2 = await asUser(`faceS2-${stamp}@innovision.test`);
  const clientS3 = await asUser(`faceS3-${stamp}@innovision.test`);

  // ── Lecturer A creates a class + S1/S3 enroll ──────────────────
  const joinCode = makeJoinCode();
  const { data: clsA, error: createErr } = await clientA
    .from("classes")
    .insert({ title: "A's Face Class", lecturer_id: lecturerA.id, join_code: joinCode })
    .select("id")
    .single();
  assertNoError("create class", { error: createErr });
  createdClassIds.push(clsA.id);
  const { error: joinErr1 } = await clientS1.rpc("join_class", { code: joinCode });
  assertNoError("S1 join", { error: joinErr1 });
  const { error: joinErr3 } = await clientS3.rpc("join_class", { code: joinCode });
  assertNoError("S3 join", { error: joinErr3 });

  async function makeQuiz({ title, mode, time_limit_sec = null }) {
    const { data: quiz, error } = await clientA
      .from("quizzes")
      .insert({ class_id: clsA.id, created_by: lecturerA.id, title, status: "draft", mode, time_limit_sec })
      .select("id, mode, time_limit_sec")
      .single();
    assertNoError("create quiz", { error });
    createdQuizIds.push(quiz.id);
    return quiz;
  }

  async function addQuestions(quizId, count = 3) {
    for (let i = 0; i < count; i++) {
      const { error } = await clientA
        .from("questions")
        .insert({ quiz_id: quizId, order_index: i, type: "mcq", prompt: `Q${i}`, options: ["a", "b"], correct_index: 0 })
        .select("id")
        .single();
      assertNoError("insert question", { error });
    }
  }

  async function publish(quizId) {
    const { error } = await clientA
      .from("quizzes")
      .update({ status: "live" })
      .eq("id", quizId);
    assertNoError("publish quiz", { error });
  }

  async function makeLiveAssessment(title, studentClient = clientS1) {
    const quiz = await makeQuiz({ title, mode: "assessment" });
    await addQuestions(quiz.id);
    await publish(quiz.id);
    const start = await studentClient.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    assertNoError("start session", { error: start.error });
    return { quiz, sessionId: start.data.session.id };
  }

  async function currentNonce(studentClient, sessionId) {
    const { data } = await studentClient
      .from("quiz_sessions")
      .select("verify_nonce")
      .eq("id", sessionId)
      .single();
    return data.verify_nonce;
  }

  // ── D11a: enroll requires consent → consent_required ───────────
  {
    const { sessionId } = await makeLiveAssessment("D11a No Consent");
    const { data } = await clientS1.rpc("enroll_face", {
      p_duplicate_subject: null,
      p_duplicate_similarity: 0,
    });
    record("D11a enroll without consent → consent_required",
      data?.error === "consent_required", JSON.stringify(data));
    const { data: verifyData } = await clientS1.rpc("record_face_check", {
      p_session_id: sessionId,
      ...matchProbe(studentS1.id),
      p_trigger: "start",
      p_nonce: "00000000-0000-4000-8000-000000000000",
    });
    record("D14b verify without consent → consent_required",
      verifyData?.error === "consent_required", JSON.stringify(verifyData));
  }

  // ── Set consent for S1 (service-role, as register flow does) ───
  await setConsent(studentS1.id);

  // ── D-col-priv + D11b: enrollment status guards ────────────────
  {
    // Give S3 consent NOW so the duplicate-detect + re-enroll tests below work.
    await setConsent(studentS3.id);

    // Direct PATCH face_enrollment_status by the student (no GUC) → blocked
    // (column-level privilege revoke — checked before RLS).
    const direct = await clientS1
      .from("profiles")
      .update({ face_enrollment_status: "enrolled" })
      .eq("id", studentS1.id);
    record("D-col-priv direct PATCH face_enrollment_status blocked",
      Boolean(direct.error) && (direct.error?.message?.includes("not_authorized") || direct.error?.code === "42501"),
      direct.error?.message ?? JSON.stringify(direct.data));

    // Other student (S2) updating S1's face_enrollment_status → 0 rows
    // (RLS self-only filter — a cross-student write is filtered, not errored).
    const other = await clientS2
      .from("profiles")
      .update({ face_enrollment_status: "enrolled" })
      .eq("id", studentS1.id);
    const s1AfterOther = (await admin.from("profiles").select("face_enrollment_status").eq("id", studentS1.id).single()).data;
    record("D-col-priv OTHER student PATCH → no effect (RLS)",
      (other.data ?? []).length === 0 && s1AfterOther.face_enrollment_status === null,
      `other.data=${JSON.stringify(other.data)} s1.status=${s1AfterOther.face_enrollment_status}`);

    // Service-role write is INTENTIONALLY blocked (auth.uid() NULL in the
    // guard trigger) — even though service role bypasses RLS, the trigger fires.
    const svc = await admin
      .from("profiles")
      .update({ face_enrollment_status: "enrolled" })
      .eq("id", studentS1.id);
    record("D-col-priv service-role PATCH blocked (actor-bound guard)",
      Boolean(svc.error) && svc.error.message?.includes("not_authorized"),
      svc.error?.message ?? JSON.stringify(svc.data));

    // FIRST-TIME enrollment while a live assessment exists is ALLOWED (breaks
    // the start-before-enrolling deadlock); ever-enrolled is still false here.
    const enroll = await clientS1.rpc("enroll_face", {
      p_duplicate_subject: null,
      p_duplicate_similarity: 0,
    });
    record("D11b first-time enroll_face (mid-active) → ok + enrolled",
      enroll.data?.ok === true && enroll.data?.status === "enrolled",
      JSON.stringify(enroll.data));

    // A duplicate detected at enroll (similarity ≥ 0.45 against a DIFFERENT
    // subject) → status = pending_review, not enrolled.
    const dupEnroll = await clientS3.rpc("enroll_face", {
      p_duplicate_subject: studentS1.id,
      p_duplicate_similarity: 0.7,
    });
    record("D11b duplicate-detected enroll → pending_review",
      dupEnroll.data?.ok === true && dupEnroll.data?.status === "pending_review",
      JSON.stringify(dupEnroll.data) + " err=" + JSON.stringify(dupEnroll.error));

    // RE-ENROLL while a live assessment exists → live_assessment (the
    // ever-enrolled marker survives; a revoke→re-enroll face swap is blocked).
    const reEnroll = await clientS1.rpc("enroll_face", {
      p_duplicate_subject: null,
      p_duplicate_similarity: 0,
    });
    record("D11b re-enroll while live → live_assessment",
      reEnroll.data?.error === "live_assessment", JSON.stringify(reEnroll.data));

    // Self-recover of a COMPLETED session → session_not_active.
    const { sessionId: doneSession } = await makeLiveAssessment("D11b Done");
    await clientS1.rpc("submit_session", { p_session_id: doneSession });
    const doneRecover = await clientS1.rpc("self_recover_session", { p_session_id: doneSession });
    record("D11b self-recover of completed → session_not_active",
      doneRecover.data?.error === "session_not_active", JSON.stringify(doneRecover.data));

    // pending_review student verify → not_enrolled (they are not "enrolled").
    const { sessionId: pendSession } = await makeLiveAssessment("PendingReview", clientS3);
    const pendNonce = await currentNonce(clientS3, pendSession);
    const pendVerify = await clientS3.rpc("record_face_check", {
      p_session_id: pendSession,
      ...matchProbe(studentS3.id),
      p_trigger: "start",
      p_nonce: pendNonce,
    });
    record("D11b pending_review student verify → not_enrolled",
      pendVerify.data?.error === "not_enrolled", JSON.stringify(pendVerify.data));

    // Lecturer rejects the pending_review → status null → student re-enrolls.
    const reject = await clientA.rpc("reject_face_enrollment", { p_student_id: studentS3.id });
    const s3Profile = (await clientS3.from("profiles").select("face_enrollment_status").eq("id", studentS3.id).single()).data;
    // Close the pending-review session so the ever-enrolled gate doesn't block
    // the clean re-enrollment (a live assessment blocks re-enroll by design).
    await clientS3.rpc("submit_session", { p_session_id: pendSession });
    const reEnroll3 = await clientS3.rpc("enroll_face", {
      p_duplicate_subject: null,
      p_duplicate_similarity: 0,
    });
    record("D11b lecturer rejects pending_review → null + re-enroll → enrolled",
      reject.data?.ok === true && s3Profile.face_enrollment_status === null &&
        reEnroll3.data?.ok === true && reEnroll3.data?.status === "enrolled",
      `reject=${JSON.stringify(reject.data)} status=${s3Profile.face_enrollment_status} re-enroll=${JSON.stringify(reEnroll3.data)}`);
  }

  // ── D10: face_checks RLS + direct INSERT denied ─────────────────
  {
    const { sessionId } = await makeLiveAssessment("D10 RLS");
    const nonce = await currentNonce(clientS1, sessionId);
    const check = await clientS1.rpc("record_face_check", {
      p_session_id: sessionId,
      ...matchProbe(studentS1.id),
      p_trigger: "start",
      p_nonce: nonce,
    });
    record("D10 verify records a face_check (start, match)",
      check.data?.matched === true && check.data?.sessionStatus === "active" && typeof check.data?.nextNonce === "string",
      `${JSON.stringify(check.data)} err=${check.error?.message ?? ""}`);

    // Direct INSERT into face_checks by the student → denied (RPC-only writes).
    const directInsert = await clientS1
      .from("face_checks")
      .insert({ session_id: sessionId, matched: true, trigger: "periodic" });
    record("D10 direct face_checks INSERT denied",
      Boolean(directInsert.error), directInsert.error?.message ?? JSON.stringify(directInsert.data));

    // Student S2 (different student, NOT the session owner) cannot read S1's rows.
    const s2Read = await clientS2.from("face_checks").select("id").eq("session_id", sessionId);
    record("D10 student B SELECT of A's face_checks → 0 rows (RLS)",
      (s2Read.data ?? []).length === 0, `count=${(s2Read.data ?? []).length}`);

    // Student S2 calling record_face_check on S1's session → not_owner.
    const s2Verify = await clientS2.rpc("record_face_check", {
      p_session_id: sessionId,
      ...matchProbe(studentS1.id),
      p_trigger: "periodic",
      p_nonce: "00000000-0000-4000-8000-000000000000",
    });
    record("D10 other student verify on A's session → not_owner",
      s2Verify.data?.error === "not_owner", JSON.stringify(s2Verify.data));

    // Owner reads own rows → visible.
    const s1Read = await clientS1.from("face_checks").select("id").eq("session_id", sessionId);
    record("D10 owner reads own face_checks → visible",
      (s1Read.data ?? []).length >= 1, `count=${(s1Read.data ?? []).length}`);

    // Lecturer reads own quiz's rows → visible.
    const lectRead = await clientA.from("face_checks").select("id").eq("session_id", sessionId);
    record("D10 lecturer reads face_checks → visible",
      (lectRead.data ?? []).length >= 1, `count=${(lectRead.data ?? []).length}`);
  }

  // ── D14: nonce rotation + replay → nonce_mismatch ──────────────
  {
    const { sessionId } = await makeLiveAssessment("D14 Nonce");
    const nonce1 = await currentNonce(clientS1, sessionId);
    const r1 = await clientS1.rpc("record_face_check", {
      p_session_id: sessionId,
      ...matchProbe(studentS1.id),
      p_trigger: "question",
      p_nonce: nonce1,
    });
    const nonce2 = r1.data?.nextNonce;
    const r2 = await clientS1.rpc("record_face_check", {
      p_session_id: sessionId,
      ...matchProbe(studentS1.id),
      p_trigger: "question",
      p_nonce: nonce1, // STALE
    });
    const r3 = await clientS1.rpc("record_face_check", {
      p_session_id: sessionId,
      ...matchProbe(studentS1.id),
      p_trigger: "periodic",
      p_nonce: nonce2,
    });
    record("D14 nonce rotates + stale replay → nonce_mismatch",
      typeof nonce2 === "string" && nonce2 !== nonce1 &&
        r2.data?.error === "nonce_mismatch" &&
        r3.data?.matched === true,
      `r1=${JSON.stringify(r1.data)} r2=${JSON.stringify(r2.data)} r3=${JSON.stringify(r3.data)}`);
  }

  // ── I5: FLAT window — 3 fails (with recovery between) → flagged ──
  {
    const { sessionId } = await makeLiveAssessment("I5 Flag");
    let nonce = await currentNonce(clientS1, sessionId);
    let last = null;
    for (let i = 0; i < 3; i++) {
      // A single fail → paused. Blink-recovery (self_recover) returns to
      // active WITHOUT adding a window row, so the next fail lands on top.
      last = await clientS1.rpc("record_face_check", {
        p_session_id: sessionId,
        ...mismatchProbe(`I5-fail-${i}`),
        p_trigger: "periodic",
        p_nonce: nonce,
      });
      nonce = last.data?.nextNonce;
      if (i < 2) {
        const rec = await clientS1.rpc("self_recover_session", { p_session_id: sessionId });
        nonce = rec.data?.nextNonce ?? nonce;
      }
    }
    const row = (await clientS1.from("quiz_sessions").select("status, face_fail_streak").eq("id", sessionId).single()).data;
    record("I5 three flat fails → flagged (status + streak 3)",
      last.data?.sessionStatus === "flagged" && row.status === "flagged" && row.face_fail_streak === 3,
      `last=${JSON.stringify(last.data)} row=${JSON.stringify(row)}`);

    // submit from flagged → session_not_active + status unchanged.
    const submit = await clientS1.rpc("submit_session", { p_session_id: sessionId });
    const rowAfter = (await clientS1.from("quiz_sessions").select("status").eq("id", sessionId).single()).data;
    record("I5 submit from flagged → session_not_active + status unchanged",
      submit.data?.error === "session_not_active" && rowAfter.status === "flagged",
      `submit=${JSON.stringify(submit.data)} status=${rowAfter.status}`);
  }

  // ── I6: self-recover paused → active; flagged → 403; active → no-op ──
  {
    const { sessionId } = await makeLiveAssessment("I6 Recover");
    let nonce = await currentNonce(clientS1, sessionId);
    await clientS1.rpc("record_face_check", {
      p_session_id: sessionId,
      ...mismatchProbe("I6-fail"),
      p_trigger: "periodic",
      p_nonce: nonce,
    });
    const pausedRow = (await clientS1.from("quiz_sessions").select("status").eq("id", sessionId).single()).data;
    const recover = await clientS1.rpc("self_recover_session", { p_session_id: sessionId });
    const recoveredRow = (await clientS1.from("quiz_sessions").select("status").eq("id", sessionId).single()).data;
    record("I6 self-recover paused → active + new nonce",
      pausedRow.status === "paused" && recover.data?.sessionStatus === "active" &&
        typeof recover.data?.nextNonce === "string" && recoveredRow.status === "active",
      `paused=${pausedRow.status} recover=${JSON.stringify(recover.data)}`);

    // Flag → self-recover 403 (accumulate 3 fails WITH recovery between).
    let nonce2 = await currentNonce(clientS1, sessionId);
    for (let i = 0; i < 3; i++) {
      const r = await clientS1.rpc("record_face_check", {
        p_session_id: sessionId,
        ...mismatchProbe(`I6-flag-${i}`),
        p_trigger: "periodic",
        p_nonce: nonce2,
      });
      nonce2 = r.data?.nextNonce;
      if (i < 2) {
        const rec = await clientS1.rpc("self_recover_session", { p_session_id: sessionId });
        nonce2 = rec.data?.nextNonce ?? nonce2;
      }
    }
    const flagRecover = await clientS1.rpc("self_recover_session", { p_session_id: sessionId });
    record("I6 self-recover flagged → 403",
      flagRecover.data?.error === "flagged", JSON.stringify(flagRecover.data));

    // Active → idempotent no-op.
    const { sessionId: s2 } = await makeLiveAssessment("I6b Active No-op");
    const activeRecover = await clientS1.rpc("self_recover_session", { p_session_id: s2 });
    record("I6b self-recover active → idempotent sessionStatus active",
      activeRecover.data?.sessionStatus === "active", JSON.stringify(activeRecover.data));
  }

  // ── Lecturer unlock/exempt of completed → session_not_active ───
  {
    const { sessionId } = await makeLiveAssessment("I6c Completed");
    await clientS1.rpc("submit_session", { p_session_id: sessionId });
    const unlock = await clientA.rpc("unlock_session", { p_session_id: sessionId });
    const exempt = await clientA.rpc("exempt_face_session", { p_session_id: sessionId, p_reason: "test" });
    record("I6c unlock/exempt of completed → session_not_active",
      unlock.data?.error === "session_not_active" && exempt.data?.error === "session_not_active",
      `unlock=${JSON.stringify(unlock.data)} exempt=${JSON.stringify(exempt.data)}`);
  }

  // ── Lecturer unlock of flagged → active + audit ─────────────────
  {
    const { sessionId } = await makeLiveAssessment("D13 Unlock");
    let nonce = await currentNonce(clientS1, sessionId);
    for (let i = 0; i < 3; i++) {
      const r = await clientS1.rpc("record_face_check", {
        p_session_id: sessionId,
        ...mismatchProbe(`D13-flag-${i}`),
        p_trigger: "periodic",
        p_nonce: nonce,
      });
      nonce = r.data?.nextNonce;
      if (i < 2) {
        const rec = await clientS1.rpc("self_recover_session", { p_session_id: sessionId });
        nonce = rec.data?.nextNonce ?? nonce;
      }
    }
    const unlock = await clientA.rpc("unlock_session", { p_session_id: sessionId });
    const row = (await clientS1.from("quiz_sessions").select("status").eq("id", sessionId).single()).data;
    const audit = await admin.from("audit_events").select("action").eq("subject_id", studentS1.id).order("created_at", { ascending: false }).limit(5);
    record("D13 lecturer unlock flagged → active + audit('unlock')",
      unlock.data?.sessionStatus === "active" && row.status === "active" &&
        (audit.data ?? []).some((a) => a.action === "unlock"),
      `unlock=${JSON.stringify(unlock.data)} audit=${JSON.stringify(audit.data ?? [])}`);

    // Lecturer-only: student unlock → not_lecturer (or not_owner).
    const stuUnlock = await clientS1.rpc("unlock_session", { p_session_id: sessionId });
    record("D13 student unlock → forbidden",
      stuUnlock.data?.error === "not_lecturer" || stuUnlock.data?.error === "not_owner",
      JSON.stringify(stuUnlock.data));
  }

  // ── Consent revocation flags in-progress sessions; re-consent no un-flag ──
  {
    const { sessionId } = await makeLiveAssessment("Revoke");
    // S1 is already ever-enrolled; this enroll call returns live_assessment
    // (ignored — the point is revocation, not (re)enrollment).
    await clientS1.rpc("enroll_face", { p_duplicate_subject: null, p_duplicate_similarity: 0 });
    const revoke = await clientS1.rpc("revoke_face_consent");
    const row = (await clientS1.from("quiz_sessions").select("status").eq("id", sessionId).single()).data;
    record("revoke mid-session → session flagged",
      row.status === "flagged" && revoke.data?.ok === true && Array.isArray(revoke.data?.flagged_sessions),
      `status=${row.status} revoke=${JSON.stringify(revoke.data)}`);

    // Verify after revocation → consent_required.
    const nonce = await currentNonce(clientS1, sessionId);
    const verify = await clientS1.rpc("record_face_check", {
      p_session_id: sessionId,
      ...matchProbe(studentS1.id),
      p_trigger: "periodic",
      p_nonce: nonce,
    });
    record("revoke → verify after → consent_required",
      verify.data?.error === "consent_required", JSON.stringify(verify.data));

    // Answer after revocation → session_not_active (flagged).
    const q = (await clientA.from("questions").select("id").eq("quiz_id", (await clientS1.from("quiz_sessions").select("quiz_id").eq("id", sessionId).single()).data.quiz_id).limit(1)).data[0];
    const answer = await clientS1.rpc("answer_question", { p_session_id: sessionId, p_question_id: q.id, p_selected_index: 0 });
    record("revoke → answer after → session_not_active",
      answer.data?.error === "session_not_active", JSON.stringify(answer.data));

    // Re-consent restores consent_given_at only; does NOT un-flag or re-enroll.
    await setConsent(studentS1.id);
    const rowAfter = (await clientS1.from("quiz_sessions").select("status").eq("id", sessionId).single()).data;
    const profile = (await clientS1.from("profiles").select("consent_given_at, face_enrollment_status, face_deletion_pending").eq("id", studentS1.id).single()).data;
    record("re-consent restores consent, does NOT un-flag / re-enroll",
      rowAfter.status === "flagged" && profile.consent_given_at !== null &&
        profile.face_enrollment_status === null && profile.face_deletion_pending === true,
      `status=${rowAfter.status} consent=${Boolean(profile.consent_given_at)} status=${profile.face_enrollment_status}`);
  }

  // ── not_enrolled / not_assessment ──────────────────────────────
  {
    // not_enrolled: S1 revoked consent → face_enrollment_status null.
    const { sessionId } = await makeLiveAssessment("NotEnrolled");
    const nonce = await currentNonce(clientS1, sessionId);
    const r = await clientS1.rpc("record_face_check", {
      p_session_id: sessionId,
      ...matchProbe(studentS1.id),
      p_trigger: "start",
      p_nonce: nonce,
    });
    record("verify after revoke (not enrolled) → not_enrolled",
      r.data?.error === "not_enrolled", JSON.stringify(r.data));

    // not_assessment: practice session verify (re-consent S1 — the revoke
    // block above cleared consent; consent is required to reach the mode gate).
    await setConsent(studentS1.id);
    const pQuiz = await makeQuiz({ title: "NotAssess Practice", mode: "practice" });
    await addQuestions(pQuiz.id);
    await publish(pQuiz.id);
    const pStart = await clientS1.rpc("start_quiz_session", { p_quiz_id: pQuiz.id });
    const pSessionId = pStart.data.session.id;
    const pNonce = await currentNonce(clientS1, pSessionId);
    const r2 = await clientS1.rpc("record_face_check", {
      p_session_id: pSessionId,
      ...matchProbe(studentS1.id),
      p_trigger: "periodic",
      p_nonce: pNonce,
    });
    record("verify on practice session → not_assessment",
      r2.data?.error === "not_assessment", `${JSON.stringify(r2.data)} err=${r2.error?.message ?? ""}`);
  }

  // ── Margin rule: top gap vs second < 0.05 → fail (matches as self) ──
  {
    // S3 re-enrolled clean (above); consent was already set. Verify a lookalike
    // ── I-vote: multi-frame majority (replaces the removed margin rule) ──
    // scenario: a LOOKALIKE classmate ranks top-1 at 0.8 while the caller's
    // OWN similarity is 0.7 — under the old margin rule this FAILED; with
    // 1:1-by-lookup voting it must PASS. Each case uses a FRESH session.
    const { sessionId } = await makeLiveAssessment("Vote Lookalike", clientS3);
    const nonce = await currentNonce(clientS3, sessionId);
    const r = await clientS3.rpc("record_face_check", {
      p_session_id: sessionId,
      p_subject: studentS3.id,
      p_similarities: [0.7, 0.72],
      p_trigger: "periodic",
      p_nonce: nonce,
      p_frames: ["vote-lookalike-1", "vote-lookalike-2"],
    });
    record("1:1 vote: self sims [0.7,0.72] pass even though a lookalike would rank top-1",
      r.data?.matched === true && r.data?.sessionStatus === "active",
      `${JSON.stringify(r.data)} err=${r.error?.message ?? ""}`);

    // Majority required: 1-of-3 (one good frame between two failures) → fail
    // (fresh session — the previous one is active, so reuse is fine but a
    // fresh session keeps cases independent).
    const { sessionId: s2 } = await makeLiveAssessment("Vote Minority", clientS3);
    const nonce2 = await currentNonce(clientS3, s2);
    const r2 = await clientS3.rpc("record_face_check", {
      p_session_id: s2,
      p_subject: studentS3.id,
      p_similarities: [0.1, 0.9, 0.1],
      p_trigger: "periodic",
      p_nonce: nonce2,
      p_frames: ["vote-min-1", "vote-min-2", "vote-min-3"],
    });
    record("1:1 vote: 1-of-3 split → no majority → fail (paused)",
      r2.data?.matched === false && r2.data?.sessionStatus === "paused",
      JSON.stringify(r2.data));

    // Distance reflects the BEST frame of the vote.
    record("1:1 vote: distance = 1 − max(similarity)",
      Math.abs((r.data?.distance ?? -1) - 0.28) < 1e-6,
      `distance=${r.data?.distance}`);
  }

  // ── Advisory flags: suspected_replay / too_frequent ─────────────
  {
    // S3 is enrolled + consented + has no live assessment from prior blocks
    // other than the Margin one (which is still active — so use a fresh one).
    const { sessionId } = await makeLiveAssessment("Advisory", clientS3);
    let nonce = await currentNonce(clientS3, sessionId);
    // The SAME frame string → the RPC computes the SAME sha256 → replay.
    const probe = matchProbe(studentS3.id, "replay-frame");
    await clientS3.rpc("record_face_check", {
      p_session_id: sessionId,
      ...probe,
      p_trigger: "start",
      p_nonce: nonce,
    });
    const nonce2 = await currentNonce(clientS3, sessionId);
    const r2 = await clientS3.rpc("record_face_check", {
      p_session_id: sessionId,
      ...probe,
      p_trigger: "periodic",
      p_nonce: nonce2,
    });
    const rows = await clientS3.from("face_checks").select("suspected_replay, too_frequent").eq("session_id", sessionId).order("checked_at", { ascending: false }).limit(2);
    const second = rows.data?.[0];
    // suspected_replay is DETERMINISTIC (same frame → same sha256). too_frequent
    // depends on < 2s wall-clock between the two RPC calls — a slow CI/sandbox
    // can legitimately flip it, so it is NOT part of the pass assertion.
    record("advisory: repeated frame → suspected_replay set (too_frequent reported, timing-dependent)",
      second?.suspected_replay === true && r2.data?.sessionStatus === "active",
      `second=${JSON.stringify(second)} r2=${JSON.stringify(r2.data)}`);
  }

  // ── report_face_unavailable idempotence ─────────────────────────
  {
    const { sessionId } = await makeLiveAssessment("Unavailable");
    const r1 = await clientS1.rpc("report_face_unavailable", { p_session_id: sessionId });
    await sleep(50);
    const r2 = await clientS1.rpc("report_face_unavailable", { p_session_id: sessionId });
    const row = (await clientS1.from("quiz_sessions").select("face_unavailable_at").eq("id", sessionId).single()).data;
    record("report_face_unavailable idempotent (set-if-null)",
      r1.data?.ok === true && r2.data?.ok === true && row.face_unavailable_at !== null,
      `row=${JSON.stringify(row)} r1=${JSON.stringify(r1.data)} r2=${JSON.stringify(r2.data)}`);
  }

  // ── Window backfill: 4 same-timestamp fails + live mismatch → flagged ──
  {
    // Same-`checked_at` rows must not break the FLAT window count. NOTE: the
    // 4-fail fixture makes the count ORDER-INDEPENDENT (id DESC/ASC/unordered
    // all yield ≥3 fails), so this is a same-timestamp smoke test, NOT a pin
    // of the `id DESC` tie-break (which cannot be deterministically pinned
    // with random-uuid inserts — a 2F/2P fixture would be order-flaky).
    const { sessionId } = await makeLiveAssessment("TieBreak", clientS3);
    const ts = new Date().toISOString();
    // Insert 4 fail rows + 1 pass row with identical checked_at via service role.
    for (let i = 0; i < 4; i++) {
      const { error } = await admin.from("face_checks").insert({ session_id: sessionId, matched: false, distance: 2, trigger: "periodic", checked_at: ts });
      assertNoError("tiebreak insert fail", { error });
    }
    const { error: passErr } = await admin.from("face_checks").insert({ session_id: sessionId, matched: true, distance: 0, trigger: "periodic", checked_at: ts });
    assertNoError("tiebreak insert pass", { error: passErr });
    const nonce = await currentNonce(clientS3, sessionId);
    const r = await clientS3.rpc("record_face_check", {
      p_session_id: sessionId,
      ...mismatchProbe("tiebreak-mismatch"),
      p_trigger: "periodic",
      p_nonce: nonce,
    });
    record("window tie-break fixture: backfilled same-timestamp fails + live mismatch → flagged",
      r.data?.sessionStatus === "flagged" && r.data?.faceFailStreak >= 3,
      JSON.stringify(r.data));
  }

  // ── NULL-p_subject robustness: fail row (never a 500) ───────────
  {
    // A NULL subject with in-range similarity previously produced `v_matched =
    // NULL` → `matched boolean not null` insert violation → raw 500. With the
    // `coalesce` verdict it must land as a clean FAIL row (paused), same as the
    // no-face sentinel the route sends.
    const { sessionId } = await makeLiveAssessment("NullSubject", clientS3);
    const nonce = await currentNonce(clientS3, sessionId);
    const r = await clientS3.rpc("record_face_check", {
      p_session_id: sessionId, p_subject: null, p_similarities: [0.9],
      p_trigger: "start",
      p_nonce: nonce, p_frames: ["null-subject"],
    });
    const row = (await clientS3.from("quiz_sessions").select("status").eq("id", sessionId).single()).data;
    record("numeric gate: NULL p_subject + high similarity → clean fail row (paused), not a 500",
      r.data?.matched === false && r.data?.sessionStatus === "paused" && row.status === "paused",
      JSON.stringify(r.data));
  }

  // ── Window semantics (audit loop): pass-never-flags-current / F,P,F,P,F / spread ──
  {
    // (a) A pass NEVER flags the current check: backfill 4 fails, then a live
    // match → active (a pass clears the current check regardless of standing
    // fails; it does NOT truncate the window).
    const { sessionId } = await makeLiveAssessment("Win PassNever", clientS3);
    const ts = new Date().toISOString();
    for (let i = 0; i < 4; i++) {
      const { error } = await admin.from("face_checks").insert({ session_id: sessionId, matched: false, distance: 2, trigger: "periodic", checked_at: ts });
      assertNoError("win pass-never-flags backfill", { error });
    }
    const nonce = await currentNonce(clientS3, sessionId);
    const pass = await clientS3.rpc("record_face_check", {
      p_session_id: sessionId,
      ...matchProbe(studentS3.id, "win-pass"),
      p_trigger: "periodic",
      p_nonce: nonce,
    });
    record("window: a pass never flags the current check (4 standing fails → active)",
      pass.data?.matched === true && pass.data?.sessionStatus === "active",
      JSON.stringify(pass.data));

    // (b) The VERY NEXT fail re-flags — passes do NOT launder standing fails.
    const failAfter = await clientS3.rpc("record_face_check", {
      p_session_id: sessionId,
      ...mismatchProbe("win-fail-after-pass"),
      p_trigger: "periodic",
      p_nonce: pass.data?.nextNonce,
    });
    record("window: a fail after a pass re-flags (standing fails retained)",
      failAfter.data?.sessionStatus === "flagged",
      JSON.stringify(failAfter.data));
  }

  {
    // (c) F,P,F,P,F → flagged: the flat last-5 window counts fails regardless
    // of interleaved passes (recovery between fails — each fail pauses).
    const { sessionId } = await makeLiveAssessment("Win FPFPF", clientS3);
    let nonce = await currentNonce(clientS3, sessionId);
    const seq = [];
    for (const isFail of [true, false, true, false, true]) {
      const r = await clientS3.rpc("record_face_check", {
        p_session_id: sessionId,
        ...(isFail ? mismatchProbe(`fpf-f-${Math.random()}`) : matchProbe(studentS3.id, `fpf-p-${Math.random()}`)),
        p_trigger: "periodic",
        p_nonce: nonce,
      });
      seq.push(r.data?.sessionStatus ?? "err");
      nonce = r.data?.nextNonce;
      if (r.data?.sessionStatus === "paused") {
        const rec = await clientS3.rpc("self_recover_session", { p_session_id: sessionId });
        nonce = rec.data?.nextNonce ?? nonce;
      }
    }
    record("window: F,P,F,P,F → flagged (3 fails in flat last-5)",
      seq[4] === "flagged", seq.join(","));
  }

  {
    // (d) Fails spread over 8 checks (≤2 in every 5-window) → never flagged.
    const { sessionId } = await makeLiveAssessment("Win Spread8", clientS3);
    let nonce = await currentNonce(clientS3, sessionId);
    const seq = [];
    let sawFlagged = false;
    for (let i = 1; i <= 8; i++) {
      const isFail = [1, 2, 7].includes(i);
      const r = await clientS3.rpc("record_face_check", {
        p_session_id: sessionId,
        ...(isFail ? mismatchProbe(`sp8-f-${i}`) : matchProbe(studentS3.id, `sp8-p-${i}`)),
        p_trigger: "periodic",
        p_nonce: nonce,
      });
      seq.push(`${i}:${r.data?.sessionStatus ?? "err"}`);
      if (r.data?.sessionStatus === "flagged") sawFlagged = true;
      nonce = r.data?.nextNonce;
      if (r.data?.sessionStatus === "paused") {
        const rec = await clientS3.rpc("self_recover_session", { p_session_id: sessionId });
        nonce = rec.data?.nextNonce ?? nonce;
      }
    }
    record("window: fails spread over 8 (≤2 per 5-window) → never flagged",
      !sawFlagged, seq.join(","));
  }

  // ── I-threshold: FACE_SIMILARITY_MIN boundary (0.5) ─────────────
  {
    const { sessionId } = await makeLiveAssessment("Thresh 0.5", clientS3);
    const nonce = await currentNonce(clientS3, sessionId);
    const at = await clientS3.rpc("record_face_check", {
      p_session_id: sessionId, p_subject: studentS3.id, p_similarities: [0.5],
      p_trigger: "start",
      p_nonce: nonce, p_frames: ["threshold-0.5"],
    });
    record("threshold: similarity exactly 0.5 → matched",
      at.data?.matched === true, JSON.stringify(at.data));

    const { sessionId: s2 } = await makeLiveAssessment("Thresh 0.49", clientS3);
    const nonce2 = await currentNonce(clientS3, s2);
    const below = await clientS3.rpc("record_face_check", {
      p_session_id: s2, p_subject: studentS3.id, p_similarities: [0.49],
      p_trigger: "start",
      p_nonce: nonce2, p_frames: ["threshold-0.49"],
    });
    record("threshold: similarity 0.49 → not matched",
      below.data?.matched === false, JSON.stringify(below.data));
  }

  // ── I-numeric: NULL / out-of-range array elements → typed error (no 500) ──
  {
    // A per-element NULL/NaN similarity previously crashed the verdict (raw
    // 500); the 0020 gates reject them with typed invalid_frame. PostgREST
    // resolves the single 6-arg signature, so partial args are fine.
    const { sessionId } = await makeLiveAssessment("Numeric Gates", clientS3);
    const nonce = await currentNonce(clientS3, sessionId);
    const nullSim = await clientS3.rpc("record_face_check", {
      p_session_id: sessionId, p_subject: studentS3.id, p_similarities: [null],
      p_trigger: "start",
      p_nonce: nonce, p_frames: ["null-sim"],
    });
    record("numeric gate: NULL element in p_similarities → typed invalid_frame",
      nullSim.data?.error === "invalid_frame",
      `${JSON.stringify(nullSim.data)} err=${nullSim.error?.message ?? ""}`);

    const overRange = await clientS3.rpc("record_face_check", {
      p_session_id: sessionId, p_subject: studentS3.id, p_similarities: [1.5],
      p_trigger: "start",
      p_nonce: nonce, p_frames: ["over-sim"],
    });
    record("numeric gate: element > 1 → typed invalid_frame",
      overRange.data?.error === "invalid_frame",
      `${JSON.stringify(overRange.data)} err=${overRange.error?.message ?? ""}`);

    const lenMismatch = await clientS3.rpc("record_face_check", {
      p_session_id: sessionId, p_subject: studentS3.id, p_similarities: [0.9, 0.8],
      p_trigger: "start",
      p_nonce: nonce, p_frames: ["len-mismatch-1"],
    });
    record("numeric gate: |p_similarities| ≠ |p_frames| → typed invalid_frame",
      lenMismatch.data?.error === "invalid_frame",
      `${JSON.stringify(lenMismatch.data)} err=${lenMismatch.error?.message ?? ""}`);
  }

  // ── I-exempt: short-circuit against the REAL SQL ────────────────
  {
    const { sessionId } = await makeLiveAssessment("Exempt", clientS3);
    const exempt = await clientA.rpc("exempt_face_session", { p_session_id: sessionId, p_reason: "verify-face exempt probe" });
    assertNoError("exempt probe", { error: exempt.error });
    const nonce = await currentNonce(clientS3, sessionId);
    const r = await clientS3.rpc("record_face_check", {
      p_session_id: sessionId,
      ...mismatchProbe("exempt-frame"),
      p_trigger: "periodic",
      p_nonce: nonce,
    });
    const rows = await clientS3.from("face_checks").select("id").eq("session_id", sessionId);
    const rowAfter = (await clientS3.from("quiz_sessions").select("status, verify_nonce").eq("id", sessionId).single()).data;
    record("exempt: matched:true + distance null + NO row + NO nonce rotation",
      r.data?.matched === true && r.data?.distance === null &&
        r.data?.sessionStatus === "active" && r.data?.nextNonce === nonce &&
        (rows.data ?? []).length === 0 && rowAfter.verify_nonce === nonce,
      JSON.stringify(r.data));
  }

  // ── I-quiz-closed / I-class-removal → quiz_not_live ─────────────
  {
    const quiz = await makeQuiz({ title: "QuizClosed", mode: "assessment" });
    await addQuestions(quiz.id);
    await publish(quiz.id);
    const start = await clientS3.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    assertNoError("quiz-closed start", { error: start.error });
    await clientA.from("quizzes").update({ status: "closed" }).eq("id", quiz.id);
    const nonce = await currentNonce(clientS3, start.data.session.id);
    const r = await clientS3.rpc("record_face_check", {
      p_session_id: start.data.session.id,
      ...matchProbe(studentS3.id, "closed-frame"),
      p_trigger: "periodic",
      p_nonce: nonce,
    });
    record("verify after quiz closed → quiz_not_live",
      r.data?.error === "quiz_not_live", JSON.stringify(r.data));

    // Class removal (must be LAST — restores the enrollment after the probe).
    const rmQuiz = await makeQuiz({ title: "ClassRemoved", mode: "assessment" });
    await addQuestions(rmQuiz.id);
    await publish(rmQuiz.id);
    const rmStart = await clientS3.rpc("start_quiz_session", { p_quiz_id: rmQuiz.id });
    assertNoError("class-removed start", { error: rmStart.error });
    // class_enrollments has a COMPOSITE key (class_id, student_id) — no `id`
    // column. Delete by student_id (scoped to clsA so other classes are
    // untouched) and confirm the row is gone BEFORE the verify.
    const { error: delErr } = await admin
      .from("class_enrollments")
      .delete()
      .eq("student_id", studentS3.id)
      .eq("class_id", clsA.id);
    const afterDelete = await admin
      .from("class_enrollments")
      .select("class_id")
      .eq("student_id", studentS3.id)
      .eq("class_id", clsA.id);
    const rmNonce = await currentNonce(clientS3, rmStart.data.session.id);
    const r2 = await clientS3.rpc("record_face_check", {
      p_session_id: rmStart.data.session.id,
      ...matchProbe(studentS3.id, "removed-frame"),
      p_trigger: "periodic",
      p_nonce: rmNonce,
    });
    record("verify after class removal → quiz_not_live",
      r2.data?.error === "quiz_not_live" && (afterDelete.data ?? []).length === 0,
      `delErr=${delErr?.message ?? ""} remaining=${(afterDelete.data ?? []).length} verify=${JSON.stringify(r2.data)}`);
    // Restore S3's enrollment for any subsequent probes (rejoin the existing
    // class — join_class is idempotent for a fresh membership).
    await clientS3.rpc("join_class", { code: joinCode });
  }

  // ── Focus-loss pause escalation (0020/0021) ─────────────────────
  {
    const { sessionId } = await makeLiveAssessment("Focus Escalation", clientS3);
    let last = null;
    for (let i = 0; i < 3; i++) {
      if (i > 0) {
        await clientS3.rpc("self_recover_session", { p_session_id: sessionId });
      }
      last = await clientS3.rpc("pause_session", {
        p_session_id: sessionId,
        p_reason: "focus_lost",
      });
    }
    record("focus-loss: 3rd confirmed loss → flagged + audited",
      last.data?.sessionStatus === "flagged",
      JSON.stringify(last.data));
    const audits = await clientA
      .from("lecturer_audit_view")
      .select("action, event_session_id")
      .eq("event_session_id", sessionId);
    record("focus-loss: auto_flag_focus_loss attributed to the session timeline",
      (audits.data ?? []).some((a) => a.action === "auto_flag_focus_loss"),
      JSON.stringify(audits.data));

    // R1: flagging from `paused` must clear paused_at (unlock must not
    // credit flagged idle time as exam time). Three focus losses accumulate
    // ACROSS the paused state (blur while already paused still counts).
    const { sessionId: s2 } = await makeLiveAssessment("Focus Paused Flag", clientS3);
    await clientS3.rpc("pause_session", { p_session_id: s2, p_reason: "hand_loss" });
    let lastF = null;
    for (let i = 0; i < 3; i++) {
      lastF = await clientS3.rpc("pause_session", { p_session_id: s2, p_reason: "focus_lost" });
    }
    const rowAfterFlag = (await admin.from("quiz_sessions").select("status, paused_at, focus_pause_count").eq("id", s2).single()).data;
    record("focus-loss: flag from paused clears paused_at",
      lastF.data?.sessionStatus === "flagged" &&
        rowAfterFlag?.paused_at === null && rowAfterFlag?.status === "flagged",
      `${JSON.stringify(lastF.data)} row=${JSON.stringify(rowAfterFlag)}`);
    // Unlock resets the counter so the next genuine blur does not re-flag.
    const unlock = await clientA.rpc("unlock_session", { p_session_id: s2 });
    const rowAfterUnlock = (await admin.from("quiz_sessions").select("focus_pause_count").eq("id", s2).single()).data;
    record("focus-loss: unlock resets focus_pause_count",
      unlock.data?.sessionStatus === "active" && rowAfterUnlock?.focus_pause_count === 0,
      JSON.stringify(rowAfterUnlock));

    // Invalid reason → typed error.
    const badReason = await clientS3.rpc("pause_session", {
      p_session_id: s2, p_reason: "party",
    });
    record("pause_session: invalid reason → invalid_reason",
      badReason.data?.error === "invalid_reason", JSON.stringify(badReason.data));
  }

  // ── Session advisories (0020/0021): upsert + throttle ───────────
  {
    const { sessionId } = await makeLiveAssessment("Advisory RPC", clientS3);
    const a1 = await clientS3.rpc("report_session_advisory", { p_session_id: sessionId, p_type: "voice_activity" });
    record("advisory: valid type on own active session → ok",
      a1.data?.ok === true, JSON.stringify(a1.data));
    const badType = await clientS3.rpc("report_session_advisory", { p_session_id: sessionId, p_type: "vibes" });
    record("advisory: unknown type → invalid_type",
      badType.data?.error === "invalid_type", JSON.stringify(badType.data));
    // Throttle: rapid repeats must NOT inflate occurrences (55s RPC gate —
    // the second call lands inside the window).
    const before = (await admin.from("session_advisories").select("occurrences").eq("session_id", sessionId).eq("adv_type", "voice_activity").single()).data;
    await clientS3.rpc("report_session_advisory", { p_session_id: sessionId, p_type: "voice_activity" });
    const after = (await admin.from("session_advisories").select("occurrences").eq("session_id", sessionId).eq("adv_type", "voice_activity").single()).data;
    record("advisory: direct-RPC spam throttled (occurrences stay at 1)",
      before?.occurrences === 1 && after?.occurrences === 1,
      `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
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
