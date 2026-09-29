// Demo seed — provisions a REALISTIC semester of InnoVision usage so every
// screen can be clicked through with believable data:
//   • 3 lecturers, 14 students with local-flavoured names (varied engagement:
//     some do everything, some only play shared quizzes, some never attempt;
//     student11–14 are demo-cohort: x444 subject copies only, so student1–4
//     see each subject once instead of twice)
//   • 3 classes: two active (different courses), one archived
//   • Lecturer quizzes across the full lifecycle: draft → live → CLOSED with
//     historical sessions + revealed results (a past weekly quiz)
//   • EASY, natural-sounding questions (intro-course register, mostly recall
//     with one stretch item per set) so demos click through believably
//   • Session spread: staggered start times/durations, scores with wrong
//     answers scattered across the paper, an ACTIVE practice session
//   • Integrity traces on past assessments: focus pauses + advisories
//     (looked_away / voice_activity) populate the results-dashboard chips
//   • Student-created PRACTICE quizzes (the SQ feature): some SHARED via
//     /s/<code> links, some kept private — as real students would use them
//
// NOTE: idempotent = existing rows are REUSED, not rewritten. Changing the
// question text here does NOT update quizzes that were seeded before (their
// sessions/answers reference the old rows). For a clean slate:
//   supabase db reset && npm run seed:demo
//
// Face setup is intentionally NOT seeded (biometric enrollment stays a
// deliberate user action).
//
// Run:  node scripts/seed-demo.mjs [--remote]
//   --remote targets the hosted project (.env.production.local) instead of the
//   local seam — still requires ALLOW_PROD_SEED=1 or an interactive confirm.
import { createClient } from "@supabase/supabase-js";
import { resolveEnv, confirmRemote } from "./lib/remote-env.mjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const SEED_SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SEED_SCRIPT_DIR, "..");
// quiz-sources bucket cap (supabase/migrations/0007_ai_generation.sql): files
// over this are rejected by storage, so oversized handouts are truncated in
// seed-assets/ BEFORE seeding (see seed-assets/README.md) and skipped here.
const QUIZ_SOURCES_MAX_BYTES = 25 * 1024 * 1024;

const REMOTE = process.argv.includes("--remote");
const { URL, SERVICE, isRemote } = resolveEnv(process.argv);
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
if (isRemote) await confirmRemote("SEED demo accounts and mock data");

const PASSWORD = "Password123!";
// Join codes: 6 chars, unambiguous alphabet (no 0/O/1/I/L).
// Share codes: 10 chars from the SAME alphabet (CHECK-enforced).
const JOIN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // matches join_code CHECK
function randomJoinCode() {
  let s = "";
  for (let i = 0; i < 6; i++) s += JOIN_ALPHABET[Math.floor(Math.random() * JOIN_ALPHABET.length)];
  return s;
}

const PEOPLE = [
  { email: "lecturer@innovision.test", name: "Dr. Farah Omar", role: "lecturer" },
  { email: "lecturer2@innovision.test", name: "Dr. Rajesh Kumar", role: "lecturer" },
  // Demo-mode presenter account (docs/plans/PLAN_DEMO_MODE.md): the SAME fixed
  // password as every seeded user. Guests auto-join its demo class via the QR.
  { email: "demo-lecturer@innovision.test", name: "Dr. Demo Presenter", role: "lecturer" },
  { email: "student1@innovision.test", name: "Muhammad Danish", role: "student", matric: "231201" },
  { email: "student2@innovision.test", name: "Nur Aisyah", role: "student", matric: "231202" },
  { email: "student3@innovision.test", name: "Lim Wei Jian", role: "student", matric: "231203" },
  { email: "student4@innovision.test", name: "Tan Mei Mei", role: "student", matric: "231204" },
  { email: "student5@innovision.test", name: "Arjun Kumar", role: "student", matric: "231205" },
  { email: "student6@innovision.test", name: "Siti Zubaidah", role: "student", matric: "231206" },
  { email: "student7@innovision.test", name: "Ahmad Firdaus", role: "student", matric: "231207" },
  { email: "student8@innovision.test", name: "Priya Nair", role: "student", matric: "231208" },
  { email: "student9@innovision.test", name: "Chong Kah Meng", role: "student", matric: "231209" },
  { email: "student10@innovision.test", name: "Nurul Huda", role: "student", matric: "231210" },
  // Demo-cohort students (booth x444 subject copies only): dedicated accounts
  // so danish/aisyah/weijian/meimei see each subject ONCE (farah's x222 copy)
  // instead of twice. Enrolled nowhere else; history seeded in SUBJECT_COHORTS.
  { email: "student11@innovision.test", name: "Aina Farhana", role: "student", matric: "231211" },
  { email: "student12@innovision.test", name: "Jason Tan", role: "student", matric: "231212" },
  { email: "student13@innovision.test", name: "Divya Rao", role: "student", matric: "231213" },
  { email: "student14@innovision.test", name: "Hakim Rosli", role: "student", matric: "231214" },
];

function log(msg) {
  console.log(msg);
}

// ── Users ───────────────────────────────────────────────────────────
async function listAllUsers() {
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  return data.users;
}

async function ensureUser({ email, name, role, matric }) {
  const existing = (await listAllUsers()).find((u) => u.email === email);
  let user = existing;
  if (!user) {
    const payload = {
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: name, ...(matric ? { matric_no: matric } : {}) },
    };
    let { data, error } = await admin.auth.admin.createUser(payload);
    // Same collision guard as the profile repair below: never let one claimed
    // matric abort the whole demo provisioning.
    if (error && /duplicate key|matric_no_unique|23505/i.test(error.message ?? "")) {
      log(`  ⚠ matric ${matric} already claimed — creating ${email} without it`);
      ({ data, error } = await admin.auth.admin.createUser({
        ...payload,
        user_metadata: { full_name: name },
      }));
    }
    if (error) throw error;
    user = data.user;
    log(`  + created user ${email}`);
  } else {
    log(`  = reusing user ${email}`);
    // Ensure password is known & confirmed (idempotent re-runs).
    await admin.auth.admin.updateUserById(user.id, { password: PASSWORD, email_confirm: true });
  }

  // Ensure profile role + name + matric (the signup trigger creates a
  // 'student' row; promote lecturers via service role, bypassing RLS). The
  // matric repair here is what gives EXISTING demo DBs their matrics — the
  // createUser metadata alone only covers fresh databases (idempotent re-runs).
  // A claimed matric (real user got there first) must never abort the whole
  // seed: retry once WITHOUT the matric and carry on.
  const baseProfile = { role, full_name: name };
  const withMatric = matric ? { ...baseProfile, matric_no: matric } : baseProfile;
  let { error } = await admin.from("profiles").update(withMatric).eq("id", user.id);
  if (error && /duplicate key|matric_no_unique|23505/i.test(error.message ?? "")) {
    log(`  ⚠ matric ${matric} already claimed by another account — skipping for ${email}`);
    ({ error } = await admin.from("profiles").update(baseProfile).eq("id", user.id));
  }
  if (error) throw error;
  return { id: user.id, email, name, role };
}

// ── Class + enrollments ─────────────────────────────────────────────
async function ensureClass({ lecturerId, title, joinCode, archivedAt = null }) {
  // Idempotency is by TITLE for classes that carry a random, never-printed join
  // code (the demo showcase class): looking up by join_code alone would insert
  // a fresh copy on every seed run. Two lookups — a random code must not be
  // regenerated, and a fixed code must not accidentally match a foreign class.
  const byTitle = await admin
    .from("classes")
    .select("id, join_code")
    .eq("lecturer_id", lecturerId)
    .eq("title", title)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (byTitle.data) {
    log(`  = reusing class ${title} (${byTitle.data.join_code})`);
    return byTitle.data.id;
  }
  const { data: found } = await admin
    .from("classes")
    .select("id, join_code")
    .eq("join_code", joinCode)
    .maybeSingle();
  if (found) {
    log(`  = reusing class ${title} (${joinCode})`);
    return found.id;
  }
  const { data, error } = await admin
    .from("classes")
    .insert({ lecturer_id: lecturerId, title, join_code: joinCode, archived_at: archivedAt })
    .select("id")
    .single();
  if (error) throw error;
  log(`  + created class ${title} (${joinCode})${archivedAt ? " [archived]" : ""}`);
  return data.id;
}

async function ensureEnrollment(classId, studentId) {
  const { error } = await admin
    .from("class_enrollments")
    .upsert({ class_id: classId, student_id: studentId }, { onConflict: "class_id,student_id" });
  if (error) throw error;
}

// ── Quizzes + questions ─────────────────────────────────────────────
// Note: quizzes must start 'draft' (trigger), get questions, THEN be
// transitioned toward 'live'/'closed'. Questions only insert while 'draft'.
// A 'closed' target walks draft→live→closed like a real past quiz.
//
// Rich types (exhibition showcase):
//   - mcq / true_false: { type, prompt, options, correctIndex, explanation? }
//   - multi_select:     { type:'multi_select', prompt, options (2-4),
//                         correctIndices:[...], explanation? }
//   - short_text:       { type:'short_text', prompt, answerKey, explanation? }
// Sources provenance (fresh DBs only — frozen once live, so reuse keeps old
// rows): `sources` = [{filename,storage_path} | {kind:'web',url,title,...}].
async function ensureQuiz({ classId, createdBy, title, mode, timeLimitSec, status, questions, gesturesEnabled, sources, allowRetake, maxAttempts }) {
  let { data: quiz } = await admin
    .from("quizzes")
    .select("id, status")
    .eq("class_id", classId)
    .eq("title", title)
    .maybeSingle();

  if (!quiz) {
    const { data, error } = await admin
      .from("quizzes")
      .insert({
        class_id: classId,
        created_by: createdBy,
        title,
        mode,
        time_limit_sec: timeLimitSec,
        ...(gesturesEnabled === undefined ? {} : { gestures_enabled: gesturesEnabled }),
        ...(sources === undefined ? {} : { sources }),
        ...(allowRetake === undefined ? {} : { allow_retake: allowRetake }),
        ...(maxAttempts === undefined ? {} : { max_attempts: maxAttempts }),
      })
      .select("id, status")
      .single();
    if (error) throw error;
    quiz = data;
    log(`  + created ${mode} quiz "${title}" (draft)`);
  } else {
    log(`  = reusing quiz "${title}" (${quiz.status})`);
    // Live-manageable fields can still be topped up on reuse (retake config
    // is outside the draft freeze; sources only while draft).
    const patch = {};
    if (allowRetake !== undefined || maxAttempts !== undefined) {
      if (allowRetake !== undefined) patch.allow_retake = allowRetake;
      if (maxAttempts !== undefined) patch.max_attempts = maxAttempts;
      const { error } = await admin.from("quizzes").update(patch).eq("id", quiz.id);
      if (error) log(`  ⚠ retake patch failed for "${title}": ${error.message}`);
    }
    if (sources !== undefined && quiz.status === "draft") {
      const { error } = await admin.from("quizzes").update({ sources }).eq("id", quiz.id);
      if (error) log(`  ⚠ sources patch failed for "${title}": ${error.message}`);
      else log(`  + sources set on draft "${title}"`);
    }
  }

  // Add questions only if the quiz currently has none.
  const { count } = await admin
    .from("questions")
    .select("id", { count: "exact", head: true })
    .eq("quiz_id", quiz.id);

  if ((count ?? 0) === 0 && questions?.length) {
    const rows = questions.map((q, i) => {
      if (q.type === "multi_select") {
        const sorted = [...(q.correctIndices ?? [])].sort((a, b) => a - b);
        return {
          quiz_id: quiz.id,
          order_index: i,
          type: q.type,
          prompt: q.prompt,
          options: q.options,
          correct_index: null,
          correct_indices: sorted,
          explanation: q.explanation ?? null,
        };
      }
      if (q.type === "short_text") {
        return {
          quiz_id: quiz.id,
          order_index: i,
          type: q.type,
          prompt: q.prompt,
          options: [],
          correct_index: null,
          correct_indices: null,
          answer_key: q.answerKey,
          explanation: q.explanation ?? null,
        };
      }
      return {
        quiz_id: quiz.id,
        order_index: i,
        type: q.type,
        prompt: q.prompt,
        options: q.options,
        correct_index: q.correctIndex,
        explanation: q.explanation ?? null,
      };
    });
    const { error } = await admin.from("questions").insert(rows);
    if (error) throw error;
    log(`  + added ${rows.length} questions to "${title}"`);
  }

  // Transition toward the requested status along the legal path.
  if (quiz.status === "draft" && (status === "live" || status === "closed")) {
    const { error } = await admin.from("quizzes").update({ status: "live" }).eq("id", quiz.id);
    if (error) throw error;
    log(`  + published "${title}" → live`);
  }
  if (status === "closed" && quiz.status !== "closed") {
    // Re-read: the publish above may have just flipped it.
    const { data: cur } = await admin.from("quizzes").select("status").eq("id", quiz.id).single();
    if (cur?.status === "live") {
      const { error } = await admin.from("quizzes").update({ status: "closed" }).eq("id", quiz.id);
      if (error) throw error;
      log(`  + closed "${title}"`);
    }
  }
  return { id: quiz.id, title, mode };
}

/** Reveal results on an assessment (one-way gate the dashboard respects). */
async function ensureRevealed(quizId) {
  await admin
    .from("quizzes")
    .update({ results_revealed_at: new Date().toISOString() })
    .eq("id", quizId)
    .is("results_revealed_at", null);
}

// ── Sessions + answers (for the results dashboard) ──────────────────
/**
 * Seed one attempt. `opts`:
 *  - startedMinutesAgo / durationMin → realistic, spread-out timestamps
 *    (a class never submits in the same minute).
 *  - wrongOffset shifts WHICH questions were answered wrongly so two students
 *    with the same score don't have identical answer sheets.
 *  - focusPauses / advisories populate the integrity chips on the results
 *    dashboard (looked_away etc.) — believable proctoring traces.
 */
async function seedSession({
  quizId,
  studentId,
  mode,
  correctCount,
  totalQuestions,
  status,
  startedMinutesAgo = 2 * 24 * 60,
  durationMin = 12,
  wrongOffset = 0,
  focusPauses = 0,
  advisories = [],
}) {
  // One attempt per (quiz, student, mode) for these statuses: skip if exists.
  const { data: existing } = await admin
    .from("quiz_sessions")
    .select("id")
    .eq("quiz_id", quizId)
    .eq("student_id", studentId)
    .eq("mode", mode)
    .maybeSingle();
  if (existing) {
    log(`  = session already exists for quiz ${quizId.slice(0, 8)}… student ${studentId.slice(0, 8)}…`);
    return existing.id;
  }

  const submitted = status === "completed";
  const startMs = Date.now() - startedMinutesAgo * 60000;
  const endMs = startMs + durationMin * 60000;
  const { data: session, error } = await admin
    .from("quiz_sessions")
    .insert({
      quiz_id: quizId,
      student_id: studentId,
      mode,
      status,
      score: submitted ? correctCount : null,
      submitted_at: submitted ? new Date(endMs).toISOString() : null,
      started_at: new Date(startMs).toISOString(),
      last_activity_at: new Date(submitted ? endMs : Date.now() - 5 * 60000).toISOString(),
      focus_pause_count: focusPauses,
    })
    .select("id")
    .single();
  if (error) throw error;

  if (submitted) {
    // Insert answers: exactly correctCount correct, spread across the paper
    // (wrongOffset rotates which questions miss) instead of a flat prefix.
    const { data: qs, error: qErr } = await admin
      .from("questions")
      .select("id, correct_index, options")
      .eq("quiz_id", quizId)
      .order("order_index", { ascending: true });
    if (qErr) throw qErr;
    const papers = (qs ?? []).slice(0, totalQuestions);
    const wrongSlots = new Set(
      papers.map((_, i) => i).filter((i) => i < papers.length - correctCount)
        .map((i) => (i + wrongOffset) % papers.length),
    );
    const answers = papers.map((q, i) => {
      const len = Array.isArray(q.options) && q.options.length > 1 ? q.options.length : 2;
      const correct = !wrongSlots.has(i);
      // Deterministic distractor pick — never collides with the right index.
      const wrongIndex = (q.correct_index + 1 + (i % (len - 1))) % len;
      return {
        session_id: session.id,
        question_id: q.id,
        selected_index: correct ? q.correct_index : wrongIndex,
        is_correct: correct,
      };
    });
    if (answers.length) {
      const { error: aErr } = await admin.from("session_answers").insert(answers);
      if (aErr) throw aErr;
    }
  }

  // Proctoring traces: advisory rows are unique per (session, type).
  if (advisories.length) {
    const seen = new Date(startMs + 5 * 60000).toISOString();
    const rows = advisories.map((adv_type, i) => ({
      session_id: session.id,
      adv_type,
      first_seen_at: seen,
      last_seen_at: new Date(startMs + (8 + i * 2) * 60000).toISOString(),
      occurrences: 1 + ((i + wrongOffset) % 3),
    }));
    await admin.from("session_advisories").upsert(rows, { onConflict: "session_id,adv_type" });
  }

  log(
    `  + seeded ${status} ${mode} session (score ${correctCount}/${totalQuestions}` +
      `${focusPauses ? `, ${focusPauses} focus pauses` : ""}${advisories.length ? `, advisories: ${advisories.join("+")}` : ""})`,
  );
  return session.id;
}

// ── Rich exhibition sessions (mixed types + integrity traces) ───────
// Seeds assessment sessions with full answer shapes:
//   answers[i] = { kind:'mcq'|'multi'|'short'|'skip',
//                  correct?:bool (mcq/multi),
//                  markScore?: 0|0.5|1, markStatus?: 'marked'|'pending'|'needs_review',
//                  text?: string (short_text answer) }
// D10 scoring: SUM(COALESCE(mark_score, is_correct?1:0)) WHERE mark_status<>'pending'.
// `extra` may carry focusPauses, faceFailStreak, faceFailCount, handPauses,
// fullscreenPauses, faceExempt, lastPauseReason, attempt, advisories.
async function seedRichSession({ quizId, studentId, status, answers, startedMinutesAgo = 2 * 24 * 60, durationMin = 12, extra = {} }) {
  const attempt = extra.attempt ?? 1;
  const { data: existing } = await admin
    .from("quiz_sessions")
    .select("id")
    .eq("quiz_id", quizId)
    .eq("student_id", studentId)
    .eq("attempt", attempt)
    .maybeSingle();
  if (existing) {
    log(`  = rich session exists quiz ${quizId.slice(0, 8)}… student ${studentId.slice(0, 8)}… attempt ${attempt}`);
    return existing.id;
  }

  const submitted = status === "completed";
  const startMs = Date.now() - startedMinutesAgo * 60000;
  const endMs = startMs + durationMin * 60000;
  const { data: qs, error: qErr } = await admin
    .from("questions")
    .select("id, type, correct_index, correct_indices, options")
    .eq("quiz_id", quizId)
    .order("order_index", { ascending: true });
  if (qErr) throw qErr;
  const papers = qs ?? [];

  // Build answer rows + D10 score.
  let score = 0;
  const rows = [];
  for (let i = 0; i < papers.length; i++) {
    const q = papers[i];
    const spec = answers?.[i] ?? { kind: "mcq", correct: true };
    if (spec.kind === "skip") {
      rows.push({ session_id: null, question_id: q.id, skipped: true, is_correct: false, mark_status: "marked", attempt_version: 1 });
      continue;
    }
    if (q.type === "short_text") {
      const markStatus = spec.markStatus ?? "marked";
      const markScore = spec.markScore ?? (spec.correct === false ? 0 : 1);
      const isCorrect = markStatus === "pending" ? false : markScore >= 0.5;
      if (markStatus !== "pending") score += markScore;
      rows.push({
        session_id: null,
        question_id: q.id,
        answer_text: spec.text ?? "Seeded demo answer explaining the concept in one sentence.",
        is_correct: isCorrect,
        mark_status: markStatus,
        mark_score: markStatus === "pending" || markStatus === "needs_review" ? null : markScore,
        marked_at: markStatus === "pending" ? null : new Date(endMs).toISOString(),
        attempt_version: 1,
      });
      continue;
    }
    if (q.type === "multi_select") {
      const correct = spec.correct !== false;
      const key = (q.correct_indices ?? []).slice().sort((a, b) => a - b);
      const len = Array.isArray(q.options) ? q.options.length : 4;
      // Wrong pick: drop the last key element and add a distractor.
      let picked;
      if (correct) picked = key;
      else {
        const distract = key.length > 0 ? (key[key.length - 1] + 1) % len : 0;
        picked = [...key.slice(0, Math.max(0, key.length - 1)), distract].sort((a, b) => a - b);
        if (JSON.stringify(picked) === JSON.stringify(key)) picked = [distract];
      }
      if (correct) score += 1;
      rows.push({
        session_id: null,
        question_id: q.id,
        selected_indices: picked,
        is_correct: correct,
        mark_status: "marked",
        attempt_version: 1,
      });
      continue;
    }
    // mcq / true_false scalar.
    const len = Array.isArray(q.options) && q.options.length > 1 ? q.options.length : 2;
    const correct = spec.correct !== false;
    const wrongIndex = (q.correct_index + 1 + (i % (len - 1))) % len;
    if (correct) score += 1;
    rows.push({
      session_id: null,
      question_id: q.id,
      selected_index: correct ? q.correct_index : wrongIndex,
      is_correct: correct,
      mark_status: "marked",
      attempt_version: 1,
    });
  }

  const { data: session, error } = await admin
    .from("quiz_sessions")
    .insert({
      quiz_id: quizId,
      student_id: studentId,
      mode: "assessment",
      status,
      attempt,
      score: submitted ? score : null,
      submitted_at: submitted ? new Date(endMs).toISOString() : null,
      started_at: new Date(startMs).toISOString(),
      last_activity_at: new Date(submitted ? endMs : Date.now() - 2 * 60000).toISOString(),
      focus_pause_count: extra.focusPauses ?? 0,
      fullscreen_pause_count: extra.fullscreenPauses ?? 0,
      hand_pause_count: extra.handPauses ?? 0,
      face_fail_streak: extra.faceFailStreak ?? 0,
      face_fail_count: extra.faceFailCount ?? extra.faceFailStreak ?? 0,
      face_exempt: extra.faceExempt ?? false,
      last_pause_reason: extra.lastPauseReason ?? null,
    })
    .select("id")
    .single();
  if (error) throw error;
  if (submitted && rows.length) {
    for (const r of rows) r.session_id = session.id;
    const { error: aErr } = await admin.from("session_answers").insert(rows);
    if (aErr) throw aErr;
  }
  if (extra.advisories?.length) {
    const seen = new Date(startMs + 5 * 60000).toISOString();
    const advRows = extra.advisories.map((adv_type, i) => ({
      session_id: session.id,
      adv_type,
      first_seen_at: seen,
      last_seen_at: new Date(startMs + (8 + i * 2) * 60000).toISOString(),
      occurrences: 1 + (i % 3),
    }));
    await admin.from("session_advisories").upsert(advRows, { onConflict: "session_id,adv_type" });
  }
  log(`  + rich ${status} session score ${submitted ? score : "—"}/${papers.length}${extra.advisories?.length ? ` advisories:${extra.advisories.join("+")}` : ""}${extra.faceExempt ? " exempt" : ""}`);
  return session.id;
}

/** Face-check timeline rows (service-role direct insert; lecturer view reads them). */
async function seedFaceChecks(sessionId, { passes = 2, fails = 0, startMinutesAgo = 60 } = {}) {
  const { count } = await admin.from("face_checks").select("id", { count: "exact", head: true }).eq("session_id", sessionId);
  if ((count ?? 0) > 0) return;
  const rows = [];
  const total = passes + fails;
  // Interleave: fails first (trigger pause), then recovering passes.
  for (let i = 0; i < total; i++) {
    const matched = i >= fails;
    rows.push({
      session_id: sessionId,
      checked_at: new Date(Date.now() - (startMinutesAgo - i * 2) * 60000).toISOString(),
      matched,
      distance: matched ? 0.22 + (i % 3) * 0.03 : 0.68 + (i % 2) * 0.05,
      trigger: i === 0 ? "start" : i % 2 === 0 ? "question" : "periodic",
      suspected_replay: false,
      too_frequent: false,
      frame_hash: `demo-${sessionId.slice(0, 8)}-${i}`,
    });
  }
  if (rows.length) {
    const { error } = await admin.from("face_checks").insert(rows);
    if (error) log(`  ⚠ face_checks insert failed: ${error.message}`);
    else log(`  + ${rows.length} face_checks (${passes} pass/${fails} fail)`);
  }
}

async function seedIncidentClip(sessionId, { reason = "face_fail_streak", durationMs = 8000 } = {}) {
  const { count } = await admin.from("incident_clips").select("id", { count: "exact", head: true }).eq("session_id", sessionId);
  if ((count ?? 0) > 0) return;
  const now = Date.now();
  const { error } = await admin.from("incident_clips").insert({
    session_id: sessionId,
    storage_path: `demo/${sessionId.slice(0, 8)}/incident-${reason}.webm`,
    reason,
    duration_ms: durationMs,
    recorded_from: new Date(now - 10 * 60000).toISOString(),
    recorded_to: new Date(now - 10 * 60000 + durationMs).toISOString(),
  });
  if (error) log(`  ⚠ incident clip insert failed: ${error.message}`);
  else log(`  + incident clip (${reason})`);
}

async function seedAudit(actorId, subjectId, action, metadata = {}) {
  const { count } = await admin
    .from("audit_events")
    .select("id", { count: "exact", head: true })
    .eq("subject_id", subjectId)
    .eq("action", action);
  if ((count ?? 0) > 0) return;
  const { error } = await admin.from("audit_events").insert({ actor_id: actorId, subject_id: subjectId, action, metadata });
  if (error) log(`  ⚠ audit insert failed (${action}): ${error.message}`);
  else log(`  + audit ${action}`);
}

// ── Student-created practice quizzes (SQ feature) ───────────────────
// Mirrors what the API/RPC produce: creator-owned rows; sharing = setting a
// 10-char alphabet code. Plays leave NO rows (stateless grading) — so no
// "attempts by others" are seeded, matching privacy-by-construction.
async function ensureStudentQuiz({ createdBy, title, description, shareCode, questions }) {
  let { data: quiz } = await admin
    .from("student_quizzes")
    .select("id, share_code")
    .eq("created_by", createdBy)
    .eq("title", title)
    .maybeSingle();

  if (!quiz) {
    const { data, error } = await admin
      .from("student_quizzes")
      .insert({ created_by: createdBy, title, description: description ?? null })
      .select("id, share_code")
      .single();
    if (error) throw error;
    quiz = data;
    log(`  + created student quiz "${title}"`);
  } else {
    log(`  = reusing student quiz "${title}"`);
  }

  const { count } = await admin
    .from("student_quiz_questions")
    .select("id", { count: "exact", head: true })
    .eq("quiz_id", quiz.id);

  if ((count ?? 0) === 0 && questions?.length) {
    const rows = questions.map((q, i) => ({
      quiz_id: quiz.id,
      order_index: i,
      type: q.type,
      prompt: q.prompt,
      options: q.options,
      correct_index: q.correctIndex,
      explanation: q.explanation ?? null,
    }));
    const { error } = await admin.from("student_quiz_questions").insert(rows);
    if (error) throw error;
    log(`    + ${rows.length} questions`);
  }

  if (shareCode && !quiz.share_code) {
    const { error } = await admin
      .from("student_quizzes")
      .update({ share_code: shareCode })
      .eq("id", quiz.id);
    if (error) throw error;
    log(`    + shared at /s/${shareCode}`);
  }
  return quiz.id;
}

// ── Subject handout uploads (Sept 2026 intake materials) ──────────────
// Uploads each existing seed-assets file to quiz-sources under the
// UploadDropzone shape `<lecturerUid>/<quizId>/<uuid>-<filename>` so the
// owner-folder storage policy lets THAT lecturer download it for AI
// generation, and the quiz DELETE sweep recognises the path (well-formed
// contract in src/lib/media/validation.ts). Idempotent: objects already
// present (matched by `-<filename>` suffix) are reused, never re-uploaded.
// Missing/oversized files degrade to metadata-only entries (matching the
// seed's existing sources posture) instead of aborting the seed.
async function ensureSubjectUploads({ lecturerId, quizId, files }) {
  const prefix = `${lecturerId}/${quizId}`;
  let existing = [];
  try {
    const { data, error } = await admin.storage.from("quiz-sources").list(prefix);
    if (!error) existing = (data ?? []).map((o) => o.name);
  } catch {
    log(`  ⚠ quiz-sources list failed for ${prefix.slice(0, 8)}… — metadata-only sources`);
  }
  const now = new Date().toISOString();
  const sources = [];
  for (const f of files) {
    const hit = existing.find((n) => n.endsWith(`-${f.filename}`));
    if (hit) {
      sources.push({ id: randomUUID(), filename: f.filename, storage_path: `${prefix}/${hit}`, added_at: now });
      log(`  = reusing upload ${f.filename}`);
      continue;
    }
    const abs = path.join(REPO_ROOT, f.localPath);
    if (!fs.existsSync(abs)) {
      log(`  ⚠ missing asset ${f.localPath} — "${f.filename}" recorded without bytes`);
      sources.push({ id: randomUUID(), filename: f.filename, storage_path: `${prefix}/pending-${f.filename}`, added_at: now });
      continue;
    }
    const buf = fs.readFileSync(abs);
    if (buf.length > QUIZ_SOURCES_MAX_BYTES) {
      log(`  ⚠ ${f.filename} is ${(buf.length / 1048576).toFixed(1)}MB > 25MB cap — recorded without bytes`);
      sources.push({ id: randomUUID(), filename: f.filename, storage_path: `${prefix}/pending-${f.filename}`, added_at: now });
      continue;
    }
    const objectName = `${randomUUID()}-${f.filename}`;
    const { error } = await admin.storage
      .from("quiz-sources")
      .upload(`${prefix}/${objectName}`, buf, { contentType: f.contentType, upsert: false });
    if (error) {
      log(`  ⚠ upload failed for ${f.filename}: ${error.message} — recorded without bytes`);
      sources.push({ id: randomUUID(), filename: f.filename, storage_path: `${prefix}/pending-${f.filename}`, added_at: now });
      continue;
    }
    log(`  + uploaded ${f.filename} (${(buf.length / 1048576).toFixed(1)}MB)`);
    sources.push({ id: randomUUID(), filename: f.filename, storage_path: `${prefix}/${objectName}`, added_at: now });
  }
  return sources;
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  log("\n== InnoVision demo seed ==\n");

  log("Users:");
  const people = [];
  for (const p of PEOPLE) people.push(await ensureUser(p));
  const [farah, rajesh, demoLecturer] = people.filter((p) => p.role === "lecturer");
  const [danish, aisyah, weijian, meimei, arjun, siti, firdaus, priya, kahmeng, nurul,
    aina, jason, divya, hakim] =
    people.filter((p) => p.role === "student");

  log("\nClasses:");
  const cs101 = await ensureClass({
    lecturerId: farah.id,
    title: "CS101 — Intro to Algorithms",
    joinCode: "DEMK42",
  });
  const cs205 = await ensureClass({
    lecturerId: rajesh.id,
    title: "CS205 — Database Systems",
    joinCode: "DBSYS5",
  });
  const cs100 = await ensureClass({
    lecturerId: farah.id,
    title: "CS100 — Programming Fundamentals (Archived)",
    joinCode: "ARCH99",
    archivedAt: new Date(Date.now() - 7 * 86400000).toISOString(),
  });

  log("Enrollments:");
  for (const s of [danish, aisyah, weijian, meimei, arjun, siti]) {
    await ensureEnrollment(cs101, s.id);
  }
  for (const s of [aisyah, siti, firdaus, priya, kahmeng, nurul]) {
    await ensureEnrollment(cs205, s.id);
  }
  await ensureEnrollment(cs100, danish.id);
  log("  + CS101: danish, aisyah, weijian, meimei, arjun, siti");
  log("  + CS205: aisyah, siti, firdaus, priya, kahmeng, nurul");
  log("  + CS100 (archived): danish");

  log("\nCS101 quizzes:");
  // Shared bank: the live PRACTICE and its live ASSESSMENT counterpart ask
  // the same questions — one for instant-feedback play, one for graded takes.
  const CS101_BASICS_QS = [
    { type: "mcq", prompt: "You are lining up for lunch. Which data structure models this — first person in line is served first?", options: ["Stack", "Queue", "Tree", "Graph"], correctIndex: 1, explanation: "A queue serves items in arrival order (FIFO) — just like a lunch line." },
    { type: "mcq", prompt: "A pile of plates where you always take the top one is a…", options: ["Queue", "Linked List", "Stack", "Heap"], correctIndex: 2, explanation: "Last plate on is the first off — that's LIFO, the stack." },
    { type: "true_false", prompt: "A stack lets you remove items from both ends.", options: ["True", "False"], correctIndex: 1, explanation: "A stack only touches ONE end (the top); that's what makes it a stack." },
    { type: "mcq", prompt: "Searching a SORTED list by repeatedly halving it is called…", options: ["Linear search", "Binary search", "Bubble search", "Hashing"], correctIndex: 1, explanation: "Halving the range each step is binary search — O(log n)." },
  ];
  const practice = await ensureQuiz({
    classId: cs101,
    createdBy: farah.id,
    title: "Practice: Data Structures Basics",
    mode: "practice",
    timeLimitSec: null,
    status: "live",
    questions: CS101_BASICS_QS,
  });
  // Assessment counterpart: same bank, graded, click-to-answer (gestures OFF
  // so it plays on any device with no camera gate), untimed for the booth.
  await ensureQuiz({
    classId: cs101,
    createdBy: farah.id,
    title: "Assessment: Data Structures Basics",
    mode: "assessment",
    timeLimitSec: null,
    status: "live",
    gesturesEnabled: false,
    questions: CS101_BASICS_QS,
  });

  const midterm = await ensureQuiz({
    classId: cs101,
    createdBy: farah.id,
    title: "Assessment: Midterm — Algorithms",
    mode: "assessment",
    timeLimitSec: 600,
    status: "live",
    questions: [
      { type: "mcq", prompt: "Which sorting algorithm repeatedly swaps neighbouring items that are out of order?", options: ["Merge sort", "Insertion sort", "Bubble sort", "Selection sort"], correctIndex: 2, explanation: "Bubbling the largest value to the end each pass = bubble sort." },
      { type: "true_false", prompt: "For large lists, merge sort is usually faster than bubble sort.", options: ["True", "False"], correctIndex: 0, explanation: "O(n log n) beats O(n²) once lists get big." },
      { type: "true_false", prompt: "Binary search works on any list, sorted or not.", options: ["True", "False"], correctIndex: 1, explanation: "Halving only finds the target if the list is sorted." },
      { type: "mcq", prompt: "Which data structure processes the MOST urgent item first?", options: ["Queue", "Priority queue", "Stack", "Array"], correctIndex: 1, explanation: "A priority queue pops by importance, not arrival order." },
      { type: "true_false", prompt: "A hash table lookup takes the same time even when nearly full.", options: ["True", "False"], correctIndex: 1, explanation: "More collisions as it fills up → slower lookups. That's why tables resize." },
    ],
  });

  // A PAST quiz everyone took — closed, results revealed, full session history.
  const weekly3 = await ensureQuiz({
    classId: cs101,
    createdBy: farah.id,
    title: "Weekly Quiz 3 — Sorting (closed)",
    mode: "assessment",
    timeLimitSec: 420,
    status: "closed",
    questions: [
      { type: "mcq", prompt: "Which sorting algorithm is usually taught FIRST because it's the most intuitive?", options: ["Quick sort", "Insertion sort", "Heap sort", "Radix sort"], correctIndex: 1, explanation: "Insertion sort mirrors how you sort playing cards in your hand." },
      { type: "true_false", prompt: "Insertion sort is quick when the list is ALREADY almost sorted.", options: ["True", "False"], correctIndex: 0, explanation: "Nearly-sorted input needs almost no shifting — O(n)-ish." },
      { type: "mcq", prompt: "Which of these has the SLOWEST average performance on big random lists?", options: ["Merge sort", "Quick sort", "Bubble sort", "Heap sort"], correctIndex: 2, explanation: "Bubble sort's O(n²) comparisons crawl on large lists." },
    ],
  });
  await ensureRevealed(weekly3.id);

  await ensureQuiz({
    classId: cs101,
    createdBy: farah.id,
    title: "Draft: Graph Theory (WIP)",
    mode: "practice",
    timeLimitSec: null,
    status: "draft",
    questions: [
      { type: "mcq", prompt: "A graph with no cycles is called a…", options: ["Tree", "Complete graph", "Bipartite graph", "DAG only"], correctIndex: 0, explanation: "A connected acyclic graph is a tree." },
      { type: "true_false", prompt: "A DAG can be topologically sorted.", options: ["True", "False"], correctIndex: 0, explanation: "Directed acyclic graphs always admit a topological ordering." },
    ],
  });

  log("\nCS205 quizzes:");
  const CS205_ER_QS = [
    { type: "mcq", prompt: "In an ER diagram, what does a diamond represent?", options: ["Entity", "Attribute", "Relationship", "Key"], correctIndex: 2, explanation: "Diamonds are relationships; rectangles are entities." },
    { type: "true_false", prompt: "A foreign key column can be empty (NULL).", options: ["True", "False"], correctIndex: 0, explanation: "Nullable FKs model optional relationships — e.g. an employee with no manager yet." },
    { type: "mcq", prompt: "Which normal form removes partial dependencies on a composite key?", options: ["1NF", "2NF", "3NF", "BCNF"], correctIndex: 1, explanation: "2NF requires every non-key attribute to depend on the WHOLE key." },
  ];
  await ensureQuiz({
    classId: cs205,
    createdBy: rajesh.id,
    title: "Practice: ER Modelling & Normalization",
    mode: "practice",
    timeLimitSec: null,
    status: "live",
    questions: CS205_ER_QS,
  });
  // Assessment counterpart: same bank, graded, click-to-answer, untimed.
  await ensureQuiz({
    classId: cs205,
    createdBy: rajesh.id,
    title: "Assessment: ER Modelling & Normalization",
    mode: "assessment",
    timeLimitSec: null,
    status: "live",
    gesturesEnabled: false,
    questions: CS205_ER_QS,
  });
  await ensureQuiz({
    classId: cs205,
    createdBy: rajesh.id,
    title: "Assessment: SQL Practical (draft)",
    mode: "assessment",
    timeLimitSec: 900,
    status: "draft",
    questions: [
      { type: "mcq", prompt: "Which JOIN returns all rows from both sides, matching where possible?", options: ["INNER JOIN", "LEFT JOIN", "FULL OUTER JOIN", "CROSS JOIN"], correctIndex: 2, explanation: "FULL OUTER keeps unmatched rows from both tables." },
    ],
  });
  // CS205's CLOSED past quiz (assessment counterpart of the ER practice):
  // every CS205 student sat it last week, so student5–10 all carry
  // assessment history (kahmeng/nurul had none anywhere before this).
  const erQuiz1 = await ensureQuiz({
    classId: cs205,
    createdBy: rajesh.id,
    title: "Quiz 1 — ER Modelling (closed)",
    mode: "assessment",
    timeLimitSec: 600,
    status: "closed",
    gesturesEnabled: false,
    questions: [
      { type: "mcq", prompt: "In an ER diagram, crow's-foot notation on one end of a relationship means…", options: ["Exactly one", "Many", "Optional", "Derived"], correctIndex: 1, explanation: "Crow's feet mark the MANY side — one department, many employees." },
      { type: "true_false", prompt: "A table in first normal form (1NF) may hold repeating groups in a cell.", options: ["True", "False"], correctIndex: 1, explanation: "1NF demands atomic cells — one value per cell, no repeating groups." },
      { type: "mcq", prompt: "Which key is chosen to uniquely identify each row of a table?", options: ["Foreign key", "Primary key", "Alternate key", "Secondary index"], correctIndex: 1, explanation: "The primary key is THE row identifier; alternates are spares." },
      { type: "true_false", prompt: "Third normal form (3NF) removes transitive dependencies on the key.", options: ["True", "False"], correctIndex: 0, explanation: "Non-key facts must depend on the key, the whole key, and nothing but the key." },
    ],
  });
  await ensureRevealed(erQuiz1.id);

  // ── Exhibition showcase dataset ──────────────────────────────────
  // Mixed types (multi_select + short_text with AI-marking states), AI
  // provenance (file + web sources), retakes, and a live integrity cast
  // (flagged / paused / active) so every dashboard has something to show.
  log("\nShowcase quizzes:");
  const mixedClosed = await ensureQuiz({
    classId: cs101,
    createdBy: farah.id,
    title: "Assessment: Data Structures — Mixed Types (closed)",
    mode: "assessment",
    timeLimitSec: 600,
    status: "closed",
    gesturesEnabled: false,
    questions: [
      { type: "mcq", prompt: "Which structure gives O(1) lookup by key on average?", options: ["Array", "Linked list", "Hash table", "Stack"], correctIndex: 2, explanation: "Hashing maps keys straight to buckets." },
      { type: "multi_select", prompt: "Select ALL the LIFO structures.", options: ["Stack", "Queue", "Call stack", "Heap"], correctIndices: [0, 2], explanation: "Stack + call stack unwind last-in-first-out; queue is FIFO." },
      { type: "short_text", prompt: "In one sentence, why is binary search O(log n)?", answerKey: "It halves the search range each step on sorted input.", explanation: "Halving per step gives logarithmic depth." },
      { type: "short_text", prompt: "When does quicksort degrade to O(n²)?", answerKey: "Bad pivots on sorted input without randomization.", explanation: "Unbalanced partitions cause quadratic behaviour." },
      { type: "true_false", prompt: "A queue can be built from two stacks.", options: ["True", "False"], correctIndex: 0, explanation: "Push into one, pop from the other — amortized O(1)." },
    ],
  });
  await ensureRevealed(mixedClosed.id);

  const aiLive = await ensureQuiz({
    classId: cs101,
    createdBy: farah.id,
    title: "Assessment: AI-Generated — Sorting & Complexity (live)",
    mode: "assessment",
    timeLimitSec: null,
    status: "live",
    gesturesEnabled: false,
    sources: [
      { id: "src-1", filename: "week5-sorting.pdf", storage_path: `quiz-sources/${farah.id}/week5-sorting.pdf`, added_at: new Date(Date.now() - 5 * 86400000).toISOString() },
      { id: "src-2", kind: "web", url: "https://en.wikipedia.org/wiki/Sorting_algorithm", title: "Sorting algorithm — Wikipedia", retrieved_at: new Date(Date.now() - 5 * 86400000).toISOString(), query: "sorting algorithm complexity" },
      { id: "src-3", kind: "web", url: "https://en.wikipedia.org/wiki/Big_O_notation", title: "Big O notation — Wikipedia", retrieved_at: new Date(Date.now() - 5 * 86400000).toISOString(), query: "big-O notation explained" },
    ],
    questions: [
      { type: "mcq", prompt: "Best average case among these on random data?", options: ["Bubble sort", "Merge sort", "Insertion sort", "Selection sort"], correctIndex: 1, explanation: "Merge sort holds O(n log n)." },
      { type: "multi_select", prompt: "Which run in O(n log n) average?", options: ["Merge sort", "Quicksort", "Bubble sort"], correctIndices: [0, 1], explanation: "Merge + quicksort; bubble is quadratic." },
      { type: "short_text", prompt: "Why does merge sort need extra memory?", answerKey: "It merges into auxiliary arrays during the combine step.", explanation: "The merge step copies into temp storage." },
      { type: "true_false", prompt: "Quicksort is stable by default.", options: ["True", "False"], correctIndex: 1, explanation: "Partitioning can reorder equal keys." },
    ],
  });

  const retakeQuiz = await ensureQuiz({
    classId: cs205,
    createdBy: rajesh.id,
    title: "Assessment: SQL Joins — Retake Enabled (live)",
    mode: "assessment",
    timeLimitSec: null,
    status: "live",
    gesturesEnabled: false,
    allowRetake: true,
    maxAttempts: 3,
    questions: [
      { type: "mcq", prompt: "Keeps unmatched LEFT rows?", options: ["INNER JOIN", "LEFT JOIN", "RIGHT JOIN", "CROSS JOIN"], correctIndex: 1, explanation: "LEFT JOIN preserves the left table." },
      { type: "true_false", prompt: "CROSS JOIN returns n × m rows.", options: ["True", "False"], correctIndex: 0, explanation: "Cartesian product." },
      { type: "mcq", prompt: "A table joined with itself is a…", options: ["SELF JOIN", "OUTER JOIN", "SEMI JOIN", "ANTI JOIN"], correctIndex: 0, explanation: "Alias the two copies." },
    ],
  });

  log("\nSessions (past + present):");
  // Closed weekly quiz — the class took it two days ago, staggered starts and
  // mixed results. A couple of believable proctoring traces on the weaker runs.
  await seedSession({ quizId: weekly3.id, studentId: danish.id, mode: "assessment", correctCount: 3, totalQuestions: 3, status: "completed", startedMinutesAgo: 2 * 24 * 60, durationMin: 6 });
  await seedSession({ quizId: weekly3.id, studentId: aisyah.id, mode: "assessment", correctCount: 3, totalQuestions: 3, status: "completed", startedMinutesAgo: 2 * 24 * 60 + 9, durationMin: 7 });
  await seedSession({ quizId: weekly3.id, studentId: weijian.id, mode: "assessment", correctCount: 2, totalQuestions: 3, status: "completed", startedMinutesAgo: 2 * 24 * 60 + 17, durationMin: 11, wrongOffset: 1, advisories: ["voice_activity"] });
  await seedSession({ quizId: weekly3.id, studentId: meimei.id, mode: "assessment", correctCount: 1, totalQuestions: 3, status: "completed", startedMinutesAgo: 2 * 24 * 60 + 26, durationMin: 13, wrongOffset: 2, focusPauses: 2, advisories: ["looked_away"] });
  await seedSession({ quizId: weekly3.id, studentId: arjun.id, mode: "assessment", correctCount: 3, totalQuestions: 3, status: "completed", startedMinutesAgo: 2 * 24 * 60 + 38, durationMin: 5 });
  await seedSession({ quizId: weekly3.id, studentId: siti.id, mode: "assessment", correctCount: 2, totalQuestions: 3, status: "completed", startedMinutesAgo: 2 * 24 * 60 + 47, durationMin: 9, wrongOffset: 1, advisories: ["voice_activity"] });
  // Live midterm — early submissions so far (whole CS101 cohort).
  await seedSession({ quizId: midterm.id, studentId: danish.id, mode: "assessment", correctCount: 4, totalQuestions: 5, status: "completed", startedMinutesAgo: 26 * 60, durationMin: 9, wrongOffset: 1 });
  await seedSession({ quizId: midterm.id, studentId: aisyah.id, mode: "assessment", correctCount: 3, totalQuestions: 5, status: "completed", startedMinutesAgo: 25 * 60, durationMin: 10, wrongOffset: 3 });
  await seedSession({ quizId: midterm.id, studentId: weijian.id, mode: "assessment", correctCount: 3, totalQuestions: 5, status: "completed", startedMinutesAgo: 24 * 60, durationMin: 11, wrongOffset: 2 });
  await seedSession({ quizId: midterm.id, studentId: meimei.id, mode: "assessment", correctCount: 2, totalQuestions: 5, status: "completed", startedMinutesAgo: 23 * 60, durationMin: 12, wrongOffset: 1, advisories: ["looked_away"] });
  await seedSession({ quizId: midterm.id, studentId: arjun.id, mode: "assessment", correctCount: 4, totalQuestions: 5, status: "completed", startedMinutesAgo: 22 * 60, durationMin: 8, wrongOffset: 4 });
  await seedSession({ quizId: midterm.id, studentId: siti.id, mode: "assessment", correctCount: 3, totalQuestions: 5, status: "completed", startedMinutesAgo: 21 * 60, durationMin: 10, wrongOffset: 0 });
  // Practice engagement: aisyah finished a run yesterday; danish has one IN PROGRESS right now.
  await seedSession({ quizId: practice.id, studentId: aisyah.id, mode: "practice", correctCount: 3, totalQuestions: 4, status: "completed", startedMinutesAgo: 27 * 60, durationMin: 8, wrongOffset: 1 });
  await seedSession({ quizId: practice.id, studentId: danish.id, mode: "practice", correctCount: 0, totalQuestions: 4, status: "active", startedMinutesAgo: 15 });

  log("\nShowcase sessions (mixed types + integrity cast):");
  // Mixed-types closed quiz — full gradebook: perfect, half-marks (AI 0.5),
  // needs_review queue, pending excluded (closed must be fully marked).
  const mixedAnswers = {
    perfect: [{ kind: "mcq", correct: true }, { kind: "multi", correct: true }, { kind: "short", markScore: 1, text: "It halves the sorted range each step, so depth is logarithmic." }, { kind: "short", markScore: 1, text: "Bad pivots on sorted input without shuffle cause unbalanced partitions." }, { kind: "mcq", correct: true }],
    half: [{ kind: "mcq", correct: true }, { kind: "multi", correct: true }, { kind: "short", markScore: 0.5, text: "It gets smaller each time." }, { kind: "short", markScore: 1, text: "Bad pivots on sorted input." }, { kind: "mcq", correct: false }],
    review: [{ kind: "mcq", correct: true }, { kind: "multi", correct: false }, { kind: "short", markStatus: "needs_review", text: "Binary search is fast because halvesies." }, { kind: "short", markScore: 0, text: "When it is slow." }, { kind: "mcq", correct: true }],
    weak: [{ kind: "mcq", correct: false }, { kind: "multi", correct: false }, { kind: "short", markScore: 0, text: "No idea." }, { kind: "short", markScore: 0, text: "No idea." }, { kind: "mcq", correct: false }],
  };
  await seedRichSession({ quizId: mixedClosed.id, studentId: danish.id, status: "completed", answers: mixedAnswers.perfect, startedMinutesAgo: 4 * 24 * 60, durationMin: 9 });
  await seedRichSession({ quizId: mixedClosed.id, studentId: aisyah.id, status: "completed", answers: mixedAnswers.half, startedMinutesAgo: 4 * 24 * 60 + 11, durationMin: 12 });
  await seedRichSession({ quizId: mixedClosed.id, studentId: weijian.id, status: "completed", answers: mixedAnswers.review, startedMinutesAgo: 4 * 24 * 60 + 19, durationMin: 14, extra: { advisories: ["voice_activity"] } });
  await seedRichSession({ quizId: mixedClosed.id, studentId: meimei.id, status: "completed", answers: mixedAnswers.weak, startedMinutesAgo: 4 * 24 * 60 + 27, durationMin: 15, extra: { focusPauses: 2, advisories: ["looked_away"] } });
  await seedRichSession({ quizId: mixedClosed.id, studentId: arjun.id, status: "completed", answers: mixedAnswers.perfect, startedMinutesAgo: 4 * 24 * 60 + 35, durationMin: 8 });
  await seedRichSession({ quizId: mixedClosed.id, studentId: siti.id, status: "completed", answers: mixedAnswers.half, startedMinutesAgo: 4 * 24 * 60 + 44, durationMin: 10 });
  // AI-live quiz — early completions + one pending (AI marking in progress).
  await seedRichSession({ quizId: aiLive.id, studentId: danish.id, status: "completed", answers: [{ kind: "mcq", correct: true }, { kind: "multi", correct: true }, { kind: "short", markScore: 1, text: "Merge copies into temp arrays while combining runs." }, { kind: "mcq", correct: true }], startedMinutesAgo: 20 * 60, durationMin: 9 });
  await seedRichSession({ quizId: aiLive.id, studentId: aisyah.id, status: "completed", answers: [{ kind: "mcq", correct: true }, { kind: "multi", correct: false }, { kind: "short", markStatus: "pending", text: "Because it needs space to merge." }, { kind: "mcq", correct: true }], startedMinutesAgo: 19 * 60, durationMin: 11 });
  // Integrity cast on the AI-live quiz: flagged cheater, paused recovery,
  // exempt camera-off, and one live active attempt for the monitoring wall.
  const flaggedId = await seedRichSession({ quizId: aiLive.id, studentId: meimei.id, status: "flagged", answers: [], startedMinutesAgo: 35, durationMin: 6, extra: { focusPauses: 3, faceFailStreak: 3, faceFailCount: 4, lastPauseReason: "focus_lost", advisories: ["looked_away", "voice_activity", "second_face"] } });
  const pausedId = await seedRichSession({ quizId: aiLive.id, studentId: weijian.id, status: "paused", answers: [], startedMinutesAgo: 18, durationMin: 6, extra: { faceFailStreak: 2, faceFailCount: 2, lastPauseReason: "face_fail_streak", advisories: ["looked_away"] } });
  await seedRichSession({ quizId: aiLive.id, studentId: arjun.id, status: "active", answers: [], startedMinutesAgo: 5, durationMin: 6 });
  await seedRichSession({ quizId: aiLive.id, studentId: siti.id, status: "completed", answers: [{ kind: "mcq", correct: false }, { kind: "multi", correct: true }, { kind: "short", markScore: 0.5, text: "Extra buffer for merging." }, { kind: "mcq", correct: true }], startedMinutesAgo: 17 * 60, durationMin: 10, extra: { faceExempt: true } });
  await seedFaceChecks(flaggedId, { passes: 2, fails: 3, startMinutesAgo: 35 });
  await seedFaceChecks(pausedId, { passes: 1, fails: 2, startMinutesAgo: 18 });
  await seedIncidentClip(flaggedId, { reason: "face_fail_streak", durationMs: 9000 });
  await seedIncidentClip(pausedId, { reason: "focus_lost", durationMs: 6000 });
  await seedAudit(farah.id, meimei.id, "auto_flag_focus_loss", { focus_pause_count: 3, quiz_id: aiLive.id });
  await seedAudit(farah.id, siti.id, "exempt_face", { reason: "Camera died mid-exam — click-first fallback" });
  // Retake quiz — attempt 1 weak, attempt 2 in progress (retake chips).
  await seedRichSession({ quizId: retakeQuiz.id, studentId: firdaus.id, status: "completed", answers: [{ kind: "mcq", correct: false }, { kind: "mcq", correct: true }, { kind: "mcq", correct: false }], startedMinutesAgo: 2 * 24 * 60, durationMin: 8, extra: { attempt: 1 } });
  await seedRichSession({ quizId: retakeQuiz.id, studentId: firdaus.id, status: "active", answers: [], startedMinutesAgo: 12, durationMin: 6, extra: { attempt: 2 } });
  await seedRichSession({ quizId: retakeQuiz.id, studentId: priya.id, status: "completed", answers: [{ kind: "mcq", correct: true }, { kind: "mcq", correct: true }, { kind: "mcq", correct: true }], startedMinutesAgo: 2 * 24 * 60 + 15, durationMin: 7, extra: { attempt: 1 } });
  // Whole CS205 cohort holds an attempt-1, so every gradebook row is filled.
  await seedRichSession({ quizId: retakeQuiz.id, studentId: aisyah.id, status: "completed", answers: [{ kind: "mcq", correct: true }, { kind: "mcq", correct: false }, { kind: "mcq", correct: true }], startedMinutesAgo: 2 * 24 * 60 + 24, durationMin: 9, extra: { attempt: 1 } });
  await seedRichSession({ quizId: retakeQuiz.id, studentId: siti.id, status: "completed", answers: [{ kind: "mcq", correct: true }, { kind: "mcq", correct: true }, { kind: "mcq", correct: false }], startedMinutesAgo: 2 * 24 * 60 + 33, durationMin: 8, extra: { attempt: 1 } });
  await seedRichSession({ quizId: retakeQuiz.id, studentId: kahmeng.id, status: "completed", answers: [{ kind: "mcq", correct: false }, { kind: "mcq", correct: true }, { kind: "mcq", correct: false }], startedMinutesAgo: 2 * 24 * 60 + 41, durationMin: 11, extra: { attempt: 1 } });
  await seedRichSession({ quizId: retakeQuiz.id, studentId: nurul.id, status: "completed", answers: [{ kind: "mcq", correct: true }, { kind: "mcq", correct: false }, { kind: "mcq", correct: false }], startedMinutesAgo: 2 * 24 * 60 + 49, durationMin: 10, extra: { attempt: 1 } });

  log("\nCS205 closed Quiz 1 — whole cohort sat it last week:");
  // Closed ER counterpart — staggered sittings, mixed scores, traces on the
  // weaker runs so the CS205 gradebook + results dashboards read full.
  const erBase = 7 * 24 * 60;
  await seedSession({ quizId: erQuiz1.id, studentId: aisyah.id, mode: "assessment", correctCount: 4, totalQuestions: 4, status: "completed", startedMinutesAgo: erBase, durationMin: 8 });
  await seedSession({ quizId: erQuiz1.id, studentId: siti.id, mode: "assessment", correctCount: 4, totalQuestions: 4, status: "completed", startedMinutesAgo: erBase + 12, durationMin: 9 });
  await seedSession({ quizId: erQuiz1.id, studentId: firdaus.id, mode: "assessment", correctCount: 3, totalQuestions: 4, status: "completed", startedMinutesAgo: erBase + 21, durationMin: 10, wrongOffset: 2, advisories: ["voice_activity"] });
  await seedSession({ quizId: erQuiz1.id, studentId: priya.id, mode: "assessment", correctCount: 3, totalQuestions: 4, status: "completed", startedMinutesAgo: erBase + 30, durationMin: 11, wrongOffset: 0 });
  await seedSession({ quizId: erQuiz1.id, studentId: kahmeng.id, mode: "assessment", correctCount: 2, totalQuestions: 4, status: "completed", startedMinutesAgo: erBase + 39, durationMin: 13, wrongOffset: 1, focusPauses: 1, advisories: ["looked_away"] });
  await seedSession({ quizId: erQuiz1.id, studentId: nurul.id, mode: "assessment", correctCount: 2, totalQuestions: 4, status: "completed", startedMinutesAgo: erBase + 48, durationMin: 12, wrongOffset: 3, advisories: ["voice_activity"] });

  log("\nStudent-created practice quizzes (SQ):");
  await ensureStudentQuiz({
    createdBy: danish.id,
    title: "Big-O Cheat Sheet Drill",
    description: "My revision set for the midterm — mostly the basics.",
    shareCode: "STUDYHARD2",
    questions: [
      { type: "mcq", prompt: "Average case of a linear search?", options: ["O(1)", "O(log n)", "O(n)", "O(n²)"], correctIndex: 2, explanation: "On average you scan half the array." },
      { type: "true_false", prompt: "Binary search works on unsorted arrays.", options: ["True", "False"], correctIndex: 1, explanation: "It relies on sorted order to halve the range." },
      { type: "mcq", prompt: "Cost of inserting at the HEAD of a linked list?", options: ["O(1)", "O(n)", "O(n log n)", "Amortized O(1)"], correctIndex: 0, explanation: "Just rewire two pointers — no shifting." },
      { type: "true_false", prompt: "Quicksort is stable.", options: ["True", "False"], correctIndex: 1, explanation: "Partitioning can reorder equal elements." },
    ],
  });
  await ensureStudentQuiz({
    createdBy: aisyah.id,
    title: "SQL Joins Practice",
    description: "Made this while revising for the CS205 practical. Good luck!",
    shareCode: "EXAMPREP24",
    questions: [
      { type: "mcq", prompt: "Which JOIN keeps unmatched LEFT-side rows?", options: ["INNER JOIN", "LEFT JOIN", "RIGHT JOIN", "CROSS JOIN"], correctIndex: 1, explanation: "LEFT JOIN preserves the left table, NULL-filling the rest." },
      { type: "true_false", prompt: "CROSS JOIN produces n × m rows.", options: ["True", "False"], correctIndex: 0, explanation: "Every left row pairs with every right row." },
      { type: "mcq", prompt: "SELF JOIN is…", options: ["A syntax error", "A table joined with itself", "Two databases joined", "A view"], correctIndex: 1, explanation: "Use aliases to distinguish the two copies." },
    ],
  });
  await ensureStudentQuiz({
    createdBy: siti.id,
    title: "Packet Flow Drill",
    description: null, // real students often skip the description
    shareCode: null,    // kept private
    questions: [
      { type: "mcq", prompt: "Which layer does a router primarily operate at?", options: ["Layer 2", "Layer 3", "Layer 4", "Layer 7"], correctIndex: 1, explanation: "Routers forward based on IP (layer 3)." },
      { type: "true_false", prompt: "TCP guarantees packet order.", options: ["True", "False"], correctIndex: 0, explanation: "Sequence numbers allow reordering on arrival." },
    ],
  });
  log("  (meimei/arjun/etc. haven't made any — realistic distribution)");

  // ── Demo-mode classes (docs/plans/PLAN_DEMO_MODE.md D5) ─────────────────
  // DEMO class: guests auto-join here; contains ONLY the walk-up practice quiz.
  // Join code MUST equal DEMO_JOIN_CODE in src/lib/demo/gate.ts (SCAN23) — the
  // middleware/page predicates compare against that constant. A drift guard is
  // in src/lib/demo/gate.test.ts.
  log("\nDemo-mode classes:");
  const demoClass = await ensureClass({
    lecturerId: demoLecturer.id,
    title: "InnoVision Live Demo",
    joinCode: "SCAN23",
  });
  // Walk-up quiz prefix: the reset scripts recreate ONLY quizzes whose title
  // starts with this (see src/lib/demo/walkup-reset.ts + scripts/demo-reset.mjs).
  // Curated gesture-off quizzes below keep FIXED titles so resets can tell them
  // apart from timestamped walk-up recreations.
  // Walk-up PRACTICE with gestures ON: guests get finger-answering with NO face
  // lockup — play page arms face only on assessment+gestures (page.tsx:284),
  // play-client faceCommitRequired same conjunction (:331), commit_answer
  // v_requires_face same (0067:52-56) so practice delegates proof-free.
  // On plain-HTTP LAN the layer degrades honestly to off+chip (camera.ts
  // security), click still works; on HTTPS tunnel guests get full gestures.
  await ensureQuiz({
    classId: demoClass,
    createdBy: demoLecturer.id,
    title: "Try InnoVision — Live Demo",
    mode: "practice",
    timeLimitSec: null,
    status: "live",
    gesturesEnabled: true,
    sources: [
      { id: "demo-1", filename: "demo-handout.pdf", storage_path: `quiz-sources/${demoLecturer.id}/demo-handout.pdf`, added_at: new Date(Date.now() - 2 * 86400000).toISOString() },
    ],
    questions: [
      { type: "mcq", prompt: "Which data structure serves the FIRST item that arrived (like a queue at a counter)?", options: ["Stack", "Queue", "Tree", "Graph"], correctIndex: 1, explanation: "A queue is FIFO — first in, first served." },
      { type: "true_false", prompt: "A stack removes the most recently added item first.", options: ["True", "False"], correctIndex: 0, explanation: "Stacks are LIFO — last in, first out." },
      { type: "mcq", prompt: "Binary search only works on a...", options: ["Random list", "Sorted list", "Linked list", "Tree"], correctIndex: 1, explanation: "Halving the range relies on sorted order." },
      { type: "true_false", prompt: "Merge sort is generally faster than bubble sort on large lists.", options: ["True", "False"], correctIndex: 0, explanation: "O(n log n) beats O(n²) once lists grow." },
      { type: "mcq", prompt: "Which structure processes the MOST urgent task first?", options: ["Queue", "Stack", "Priority queue", "Array"], correctIndex: 2, explanation: "A priority queue orders by importance, not arrival." },
    ],
  });

  // Gesture-OFF assessment guests can ALSO play: click-to-answer, no camera, so
  // it works on visitor phones over plain-HTTP LAN (no navigator.mediaDevices).
  // Untimed like the walk-up quiz — exhibition manual says never time the demo.
  const demoClick = await ensureQuiz({
    classId: demoClass,
    createdBy: demoLecturer.id,
    title: "Demo Assessment — Click to Answer (No Camera)",
    mode: "assessment",
    timeLimitSec: null,
    status: "live",
    gesturesEnabled: false,
    sources: [
      { id: "demo-web-1", kind: "web", url: "https://en.wikipedia.org/wiki/Queue_(abstract_data_type)", title: "Queue (abstract data type) — Wikipedia", retrieved_at: new Date(Date.now() - 2 * 86400000).toISOString(), query: "queue FIFO data structure" },
    ],
    questions: [
      { type: "mcq", prompt: "A helpdesk handles support tickets in arrival order. Which structure fits?", options: ["Stack", "Queue", "Tree", "Graph"], correctIndex: 1, explanation: "First ticket in is the first handled — FIFO, a queue." },
      { type: "true_false", prompt: "In a queue, the LAST item added is served first.", options: ["True", "False"], correctIndex: 1, explanation: "That would be a stack (LIFO). A queue serves the oldest item first." },
      { type: "mcq", prompt: "Pressing undo (Ctrl+Z) repeatedly behaves like a…", options: ["Queue", "Stack", "Priority queue", "Linked list"], correctIndex: 1, explanation: "Undo reverses the most recent action first — LIFO, a stack." },
      { type: "mcq", prompt: "Which search needs the list to be SORTED first?", options: ["Linear search", "Binary search", "Bubble search", "Hash lookup"], correctIndex: 1, explanation: "Binary search halves the range, which only works on sorted input." },
      { type: "true_false", prompt: "A priority queue always serves whichever item arrived FIRST.", options: ["True", "False"], correctIndex: 1, explanation: "It serves by importance (priority), not arrival order — that's a plain queue." },
    ],
  });

  // Closed + revealed gesture-OFF history: guests see past results (scores,
  // review) without playing, and the lecturer dashboard has real rows to show.
  // Sessions are seeded from REAL seeded students (not guests) so the
  // between-shows reset — which only purges GUEST sessions — keeps this
  // history intact. No camera traces: a click quiz records none.
  const demoHistory = await ensureQuiz({
    classId: demoClass,
    createdBy: demoLecturer.id,
    title: "Past Results — Loops & Lists (revealed)",
    mode: "assessment",
    timeLimitSec: 420,
    status: "closed",
    gesturesEnabled: false,
    questions: [
      { type: "mcq", prompt: "Which loop runs its body AT LEAST once, even if the condition starts false?", options: ["for", "while", "do-while", "foreach"], correctIndex: 2, explanation: "do-while checks the condition AFTER the body, so it always runs once." },
      { type: "true_false", prompt: "Reading an array element by its index takes the same time however big the array is.", options: ["True", "False"], correctIndex: 0, explanation: "Indexing is arithmetic on the base address — O(1)." },
      { type: "mcq", prompt: "Appending to a dynamic array (ArrayList) is usually…", options: ["O(n²)", "O(n)", "Amortized O(1)", "O(log n)"], correctIndex: 2, explanation: "Occasional resizes average out — effectively constant time." },
    ],
  });
  await ensureRevealed(demoHistory.id);
  // Seeded history for the lecturer dashboard + guest past-results view.
  // Staggered starts, mixed scores, no camera traces (gestures-off click quiz).
  await seedSession({ quizId: demoHistory.id, studentId: danish.id, mode: "assessment", correctCount: 3, totalQuestions: 3, status: "completed", startedMinutesAgo: 3 * 24 * 60, durationMin: 7 });
  await seedSession({ quizId: demoHistory.id, studentId: aisyah.id, mode: "assessment", correctCount: 2, totalQuestions: 3, status: "completed", startedMinutesAgo: 3 * 24 * 60 + 12, durationMin: 9, wrongOffset: 1 });
  await seedSession({ quizId: demoHistory.id, studentId: weijian.id, mode: "assessment", correctCount: 1, totalQuestions: 3, status: "completed", startedMinutesAgo: 3 * 24 * 60 + 21, durationMin: 11, wrongOffset: 2 });
  await seedSession({ quizId: demoHistory.id, studentId: kahmeng.id, mode: "assessment", correctCount: 2, totalQuestions: 3, status: "completed", startedMinutesAgo: 3 * 24 * 60 + 30, durationMin: 10, wrongOffset: 1 });
  await seedSession({ quizId: demoHistory.id, studentId: nurul.id, mode: "assessment", correctCount: 1, totalQuestions: 3, status: "completed", startedMinutesAgo: 3 * 24 * 60 + 39, durationMin: 12, wrongOffset: 0 });
  // Demo click quiz gets seeded history too (real students — survives resets)
  // so the lecturer has rows even before the first guest plays.
  await seedSession({ quizId: demoClick.id, studentId: danish.id, mode: "assessment", correctCount: 5, totalQuestions: 5, status: "completed", startedMinutesAgo: 26 * 60, durationMin: 7 });
  await seedSession({ quizId: demoClick.id, studentId: aisyah.id, mode: "assessment", correctCount: 4, totalQuestions: 5, status: "completed", startedMinutesAgo: 24 * 60, durationMin: 8, wrongOffset: 2 });
  await seedSession({ quizId: demoClick.id, studentId: kahmeng.id, mode: "assessment", correctCount: 4, totalQuestions: 5, status: "completed", startedMinutesAgo: 22 * 60, durationMin: 9, wrongOffset: 3 });
  await seedSession({ quizId: demoClick.id, studentId: nurul.id, mode: "assessment", correctCount: 3, totalQuestions: 5, status: "completed", startedMinutesAgo: 20 * 60, durationMin: 10, wrongOffset: 1 });

  // SHOWCASE class: presenter-only (guests NEVER join). Gestures-ON assessment
  // kept DRAFT until showtime; a random, never-printed join code so it cannot
  // be self-enrolled even if guessed.
  const demoShowcaseClass = await ensureClass({
    lecturerId: demoLecturer.id,
    title: "InnoVision Showcase (Presenter Only)",
    joinCode: randomJoinCode(),
  });
  await ensureQuiz({
    classId: demoShowcaseClass,
    createdBy: demoLecturer.id,
    title: "Showcase — Gesture & Face Verification",
    mode: "assessment",
    // A7 (PLAN_DEMO_DAY_HARDENING): UNTIMED — the exhibition manual's golden
    // rule is "never time the demo" (gate time counts down). NOTE: changing
    // this does NOT update already-seeded rows (idempotent reuse); booth
    // builds run `db reset` first via demo:prep, so this lands clean.
    timeLimitSec: null,
    status: "draft",
    gesturesEnabled: true,
    questions: [
      { type: "mcq", prompt: "Hold up fingers to answer. Which number is shown as ONE finger?", options: ["1", "2", "3", "4"], correctIndex: 0, explanation: "One finger selects the first option." },
      { type: "true_false", prompt: "The camera verifies the same student answers each question.", options: ["True", "False"], correctIndex: 0, explanation: "Per-answer identity binding is the core control." },
      { type: "mcq", prompt: "A second face in frame triggers a...", options: ["Score bonus", "Second-face advisory", "Skip", "Lockout"], correctIndex: 1, explanation: "The server records a second_face advisory for review." },
    ],
  });

  // Showcase gesture-OFF twin (draft, presenter-only): the same assessment
  // beat answered with clicks instead of fingers, for the side-by-side
  // modality comparison in the 5-min showcase.
  await ensureQuiz({
    classId: demoShowcaseClass,
    createdBy: demoLecturer.id,
    title: "Showcase — Click to Answer (gestures OFF)",
    mode: "assessment",
    // A7: untimed, same reason as the gestures-ON twin above.
    timeLimitSec: null,
    status: "draft",
    gesturesEnabled: false,
    questions: [
      { type: "mcq", prompt: "No camera needed — answer with a click. Which structure is FIFO?", options: ["Stack", "Queue", "Tree", "Heap"], correctIndex: 1, explanation: "First in, first out — a queue." },
      { type: "true_false", prompt: "A click-to-answer quiz still records a score and an answer sheet.", options: ["True", "False"], correctIndex: 0, explanation: "Only the input modality changes; grading is identical." },
      { type: "mcq", prompt: "Integrity on a click quiz comes from…", options: ["Finger counting", "Session timing + lecturer review", "Voice commands", "Eye tracking only"], correctIndex: 1, explanation: "Timing, attempt patterns, and the lecturer's review of the session." },
    ],
  });

  // Showcase fallback history (closed + revealed): if the volunteer beat
  // fails on stage, the presenter still has face-check timelines, advisories,
  // and an incident clip to narrate from.
  const showcaseHistory = await ensureQuiz({
    classId: demoShowcaseClass,
    createdBy: demoLecturer.id,
    title: "Showcase — Past Session (revealed)",
    mode: "assessment",
    timeLimitSec: null,
    status: "closed",
    gesturesEnabled: true,
    questions: [
      { type: "mcq", prompt: "Show ONE finger to pick the first option. Which did you pick?", options: ["Option 1", "Option 2", "Option 3"], correctIndex: 0, explanation: "One finger = first slot." },
      { type: "true_false", prompt: "Face verify runs during the quiz, not just at login.", options: ["True", "False"], correctIndex: 0, explanation: "Periodic + per-question checks." },
      { type: "mcq", prompt: "Three failed checks in the last five does what?", options: ["Nothing", "Pauses the session", "Adds bonus", "Skips"], correctIndex: 1, explanation: "3-of-5 fail window pauses for recovery." },
    ],
  });
  await ensureRevealed(showcaseHistory.id);
  const sh1 = await seedRichSession({ quizId: showcaseHistory.id, studentId: danish.id, status: "completed", answers: [{ kind: "mcq", correct: true }, { kind: "mcq", correct: true }, { kind: "mcq", correct: true }], startedMinutesAgo: 5 * 24 * 60, durationMin: 8 });
  const sh2 = await seedRichSession({ quizId: showcaseHistory.id, studentId: aisyah.id, status: "completed", answers: [{ kind: "mcq", correct: true }, { kind: "mcq", correct: false }, { kind: "mcq", correct: true }], startedMinutesAgo: 5 * 24 * 60 + 14, durationMin: 10, extra: { focusPauses: 1, faceFailStreak: 0, advisories: ["looked_away", "second_face"] } });
  await seedFaceChecks(sh1, { passes: 3, fails: 0, startMinutesAgo: 5 * 24 * 60 });
  await seedFaceChecks(sh2, { passes: 2, fails: 1, startMinutesAgo: 5 * 24 * 60 + 14 });
  await seedIncidentClip(sh2, { reason: "second_face", durationMs: 7000 });

  // ── Subject showcase classes (Sept 2026 intake handouts) ─────────────
  // Three real subjects from the lecturer's materials (seed-assets/):
  // Principle of Economics (3 PDF chapters), Risk & Insurance (Ch.1 pp.1-10 —
  // the full 32MB scan exceeds the 25MB quiz-sources cap, see
  // seed-assets/README.md), Public Speaking Skills (2 PPTX chapters). Each
  // subject is mirrored under ALL THREE lecturers (9 classes); every class
  // carries the full exhibition set: a LIVE practice quiz (instant play),
  // a CLOSED+revealed assessment with seeded sessions (gradebook story),
  // and an AI-ready DRAFT holding the real uploaded files (presenter opens
  // the builder → Generate from file). Join codes are fixed + legal-alphabet
  // so they are printable on booth cards. These are SEPARATE classes from
  // the SCAN23 demo class, so demo:reset:walkup never touches them.
  log("\nSubject classes (intake handouts):");
  // Multiple TOPICS per subject, grounded in the chapter material. Each topic
  // becomes a LIVE Practice quiz (instant play, gestures on) plus its LIVE
  // Assessment counterpart (graded, click-to-answer) sharing the SAME bank —
  // so students always have several topics to work through, not one. The
  // first topic also carries the CLOSED+revealed history quiz.
  const SUBJECTS = [
    {
      key: "ECON",
      classTitle: "ECON101 — Principle of Economics",
      joinCodes: { farah: "ECN222", rajesh: "ECN333", demo: "ECN444" },
      files: [
        { filename: "ECO-Chapter01.pdf", localPath: "seed-assets/economics/ECO-Chapter01.pdf", contentType: "application/pdf" },
        { filename: "ECO-Chapter02.pdf", localPath: "seed-assets/economics/ECO-Chapter02.pdf", contentType: "application/pdf" },
        { filename: "ECO-Chapter03.pdf", localPath: "seed-assets/economics/ECO-Chapter03.pdf", contentType: "application/pdf" },
      ],
      topics: [
        {
          name: "Scarcity, Choice & Opportunity Cost",
          questions: [
            { type: "mcq", prompt: "Economics is best described as the study of…", options: ["How societies allocate scarce resources", "How banks print money", "How share prices move each day", "How to run a small business"], correctIndex: 0, explanation: "Scarcity forces choices about what to produce and for whom — that allocation problem is the core of economics." },
            { type: "true_false", prompt: "Scarcity means human wants exceed the available resources.", options: ["True", "False"], correctIndex: 0, explanation: "Unlimited wants versus limited resources — the starting point of every economics chapter." },
            { type: "mcq", prompt: "You skip a RM60 part-time shift to revise. The opportunity cost of revising is…", options: ["RM0 — revising is free", "RM60", "Your textbook price", "Nothing, time is unlimited"], correctIndex: 1, explanation: "Opportunity cost is the best alternative forgone: the RM60 shift." },
            { type: "true_false", prompt: "A 'good' gives utility (satisfaction); a 'bad' gives disutility.", options: ["True", "False"], correctIndex: 0, explanation: "Chapter 1: goods yield utility, bads yield disutility — e.g. pollution is a bad." },
            { type: "mcq", prompt: "Deciding by weighing EXTRA benefits against EXTRA costs is called thinking…", options: ["At the margin", "On average", "In the long run", "Nominally"], correctIndex: 0, explanation: "Marginal analysis compares the additional benefit of a change with its additional cost." },
          ],
        },
        {
          name: "Efficiency, Incentives & Exchange",
          questions: [
            { type: "mcq", prompt: "Economic efficiency is achieved when…", options: ["Marginal benefit equals marginal cost", "Output is at its maximum", "Prices are zero", "Everyone is employed"], correctIndex: 0, explanation: "MB = MC is the condition the chapter gives for efficiency." },
            { type: "true_false", prompt: "An incentive is a reward or penalty that motivates people to act.", options: ["True", "False"], correctIndex: 0, explanation: "Incentives change behaviour — and can produce unintended effects." },
            { type: "mcq", prompt: "An outcome nobody intended but that followed from an action is an…", options: ["Unintended effect", "Equilibrium", "Incentive", "Ceteris paribus"], correctIndex: 0, explanation: "Unintended effects are positive or negative outcomes that were not planned for." },
            { type: "true_false", prompt: "Voluntary exchange is expected to make both trading parties better off.", options: ["True", "False"], correctIndex: 0, explanation: "Exchange lets each side give up what it values less for what it values more." },
            { type: "mcq", prompt: "Positive economics studies… while normative economics studies…", options: ["'What is'; 'what should be'", "'What should be'; 'what is'", "Micro; macro", "Firms; households"], correctIndex: 0, explanation: "Positive = factual/objective; normative = value judgements about what ought to be." },
          ],
        },
        {
          name: "Production Possibilities Frontier",
          questions: [
            { type: "mcq", prompt: "A curve showing every combination of two goods an economy can produce is the…", options: ["Demand curve", "Supply curve", "Production possibilities frontier", "Budget line"], correctIndex: 2, explanation: "The PPF shows attainable output combinations under fixed technology and fully employed resources." },
            { type: "true_false", prompt: "A point INSIDE the PPF is attainable but productively inefficient.", options: ["True", "False"], correctIndex: 0, explanation: "Inside the frontier means resources are unused or misallocated; only points ON it are efficient." },
            { type: "mcq", prompt: "A PPF that is bowed outward reflects…", options: ["Constant opportunity cost", "Increasing opportunity cost", "Zero opportunity cost", "Unlimited resources"], correctIndex: 1, explanation: "Bow-out (concave) shape is the law of increasing opportunity cost." },
            { type: "true_false", prompt: "A point OUTSIDE the current PPF is unattainable without economic growth.", options: ["True", "False"], correctIndex: 0, explanation: "The frontier bounds what today's resources and technology can produce." },
            { type: "mcq", prompt: "Moving from one point on the PPF to another illustrates…", options: ["Opportunity cost", "Inflation", "A shift in demand", "Ceteris paribus"], correctIndex: 0, explanation: "More of one good means less of the other — that trade-off is opportunity cost." },
          ],
        },
        {
          name: "Demand, Supply & Market Equilibrium",
          questions: [
            { type: "mcq", prompt: "The price of nasi lemak rises and the quantity bought falls. This illustrates…", options: ["The law of demand", "The law of supply", "Market equilibrium", "A price ceiling"], correctIndex: 0, explanation: "Higher price → lower quantity demanded, all else equal." },
            { type: "true_false", prompt: "In a competitive market the equilibrium price clears the market: quantity demanded equals quantity supplied.", options: ["True", "False"], correctIndex: 0, explanation: "No surplus, no shortage — the market clears." },
            { type: "mcq", prompt: "The 'ceteris paribus' assumption means…", options: ["All else held constant", "Everything changes at once", "Only price matters", "Government sets prices"], correctIndex: 0, explanation: "Ceteris paribus isolates one change by holding other factors constant." },
            { type: "true_false", prompt: "Rising income shifts the demand curve for a normal good to the right.", options: ["True", "False"], correctIndex: 0, explanation: "Income is a demand shifter — more income raises demand for normal goods." },
            { type: "mcq", prompt: "When the price of a substitute good rises, demand for the original good…", options: ["Falls", "Rises", "Is unchanged", "Becomes zero"], correctIndex: 1, explanation: "Buyers switch towards the now-relatively cheaper good — its demand shifts right." },
          ],
        },
      ],
      draftTitle: "AI Draft: Economics (generate from chapters)",
    },
    {
      key: "RISK",
      classTitle: "RISK201 — Risk & Insurance",
      joinCodes: { farah: "RSK222", rajesh: "RSK333", demo: "RSK444" },
      files: [
        { filename: "RISK-Chapter01-p01-10.pdf", localPath: "seed-assets/risk-insurance/RISK-Chapter01-p01-10.pdf", contentType: "application/pdf" },
      ],
      topics: [
        {
          name: "Defining Risk, Peril & Hazard",
          questions: [
            { type: "mcq", prompt: "Risk is best defined as…", options: ["Certainty of loss", "Uncertainty concerning loss", "Any road accident", "Insurance itself"], correctIndex: 1, explanation: "No uncertainty, no risk — the foundation of Chapter 1." },
            { type: "true_false", prompt: "A peril is the cause of a loss, while a hazard is a condition that increases it.", options: ["True", "False"], correctIndex: 0, explanation: "Peril = the cause (e.g. fire); hazard = the condition that raises its frequency or severity." },
            { type: "mcq", prompt: "Texting while riding with no helmet is an example of…", options: ["Physical hazard", "Moral hazard", "Morale hazard", "A peril"], correctIndex: 2, explanation: "A careless attitude that increases loss severity is morale (attitudinal) hazard." },
            { type: "true_false", prompt: "A physical hazard is a tangible condition that raises the chance or severity of loss.", options: ["True", "False"], correctIndex: 0, explanation: "Icy roads or defective wiring are physical hazards." },
            { type: "mcq", prompt: "Which hazard describes dishonesty or exaggeration to gain from insurance?", options: ["Physical", "Moral", "Morale", "Legal"], correctIndex: 1, explanation: "Moral hazard is dishonest behaviour — e.g. faking a claim." },
          ],
        },
        {
          name: "Pure vs Speculative Risk",
          questions: [
            { type: "true_false", prompt: "Pure risk means only loss or no loss — never a gain.", options: ["True", "False"], correctIndex: 0, explanation: "Fire, flood, theft are pure risks. Investing is speculative, not pure." },
            { type: "mcq", prompt: "Which of these is a PURE risk?", options: ["Buying unit trusts", "Opening a café", "A house fire", "Trading forex"], correctIndex: 2, explanation: "Only loss or no loss — the house fire. The rest can also gain." },
            { type: "true_false", prompt: "Buying shares is a speculative risk, so insurers will generally NOT cover it.", options: ["True", "False"], correctIndex: 0, explanation: "Speculative risk offers gain or loss — not insurable as a rule." },
            { type: "mcq", prompt: "Speculative risk has how many possible outcomes?", options: ["One", "Two (loss / no loss)", "Three (loss / no loss / gain)", "None"], correctIndex: 2, explanation: "The element of potential gain is why speculative risk is uninsurable." },
            { type: "true_false", prompt: "Gambling is a classic example of speculative risk.", options: ["True", "False"], correctIndex: 0, explanation: "Risk is deliberately created in the hope of gain — loss, no loss, or gain." },
          ],
        },
        {
          name: "Types of Pure Risk",
          questions: [
            { type: "mcq", prompt: "Which category of pure risk directly affects a person's income or health?", options: ["Personal risk", "Property risk", "Liability risk", "Market risk"], correctIndex: 0, explanation: "Personal risks include premature death, poor health, and unemployment." },
            { type: "true_false", prompt: "A direct loss is physical damage or theft, while an indirect loss follows from it.", options: ["True", "False"], correctIndex: 0, explanation: "Property risk splits into direct loss and consequential (indirect) loss." },
            { type: "mcq", prompt: "Being held legally liable for injuring someone is which type of pure risk?", options: ["Personal", "Property", "Liability", "Speculative"], correctIndex: 2, explanation: "Liability risk is legal responsibility for another's bodily injury or property damage." },
            { type: "true_false", prompt: "Liability losses can exceed the value of the insured's own assets.", options: ["True", "False"], correctIndex: 0, explanation: "A court award can outstrip net worth — which is why liability cover matters." },
            { type: "mcq", prompt: "A family's lost wage-earning capacity after a death is best classified as…", options: ["Property risk", "Personal risk", "Legal hazard", "Speculative risk"], correctIndex: 1, explanation: "Loss of income to dependents is a personal risk." },
          ],
        },
        {
          name: "Objective Risk & Classification",
          questions: [
            { type: "mcq", prompt: "Objective risk is best measured by…", options: ["Personal feeling", "The relative variation of actual from expected loss", "The premium paid", "The sum insured"], correctIndex: 1, explanation: "Objective risk is statistical — range, variance, standard deviation, coefficient of variation." },
            { type: "true_false", prompt: "As the number of exposure units rises, objective risk tends to fall.", options: ["True", "False"], correctIndex: 0, explanation: "More observations make actual results track the expected more closely." },
            { type: "mcq", prompt: "Subjective risk is…", options: ["Measurable by statistics", "An individual's perception of uncertainty", "Always accurate", "The same for everyone"], correctIndex: 1, explanation: "Subjective risk differs person to person — insurers prefer objective risk." },
            { type: "true_false", prompt: "Fundamental risks affect large sections of society; particular risks affect few.", options: ["True", "False"], correctIndex: 0, explanation: "Floods and epidemics are fundamental; a single firm's fire is particular." },
            { type: "mcq", prompt: "Which of these is a burden risk places on society?", options: ["Lower premiums", "The need to hold large emergency funds", "Guaranteed income", "Zero worry"], correctIndex: 1, explanation: "Chapter 1 lists three burdens: emergency funds, discouraged innovation, and worry/fear." },
          ],
        },
      ],
      draftTitle: "AI Draft: Risk & Insurance (generate from chapter)",
    },
    {
      key: "SPEECH",
      classTitle: "SPEECH301 — Public Speaking Skills",
      joinCodes: { farah: "SPK222", rajesh: "SPK333", demo: "SPK444" },
      files: [
        { filename: "APS-Chapter01.pptx", localPath: "seed-assets/public-speaking/APS-Chapter01.pptx", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
        { filename: "APS-Chapter02.pptx", localPath: "seed-assets/public-speaking/APS-Chapter02.pptx", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
      ],
      topics: [
        {
          name: "Speaking vs Conversation & Speech Anxiety",
          questions: [
            { type: "mcq", prompt: "Compared with everyday conversation, public speaking is…", options: ["Less structured", "More highly structured", "Identical in every way", "Always impromptu"], correctIndex: 1, explanation: "Chapter 1: public speaking is more structured, more formal, and needs a different delivery." },
            { type: "true_false", prompt: "Only beginners get stage fright — experienced speakers never feel nervous.", options: ["True", "False"], correctIndex: 1, explanation: "Most speakers feel nerves; preparation and practice manage them." },
            { type: "mcq", prompt: "Which of these is a recommended way to reduce speech anxiety?", options: ["Expect perfection", "Prepare, prepare, prepare", "Avoid all practice", "Memorize nothing"], correctIndex: 1, explanation: "Preparation, visualisation, gaining experience and not expecting perfection all help." },
            { type: "true_false", prompt: "'Positive nervousness' is controlled nervousness that energises the speaker.", options: ["True", "False"], correctIndex: 0, explanation: "Channeling adrenaline into energy beats fighting it." },
            { type: "mcq", prompt: "Stage fright is best defined as…", options: ["Fear of the audience's topic", "Anxiety about speaking in front of an audience", "Dislike of research", "Fear of microphones"], correctIndex: 1, explanation: "It is anxiety over the prospect of presenting to listeners." },
          ],
        },
        {
          name: "Speech Communication Process",
          questions: [
            { type: "mcq", prompt: "In the speech communication process, the person encoding the message is the…", options: ["Listener", "Speaker", "Channel", "Situation"], correctIndex: 1, explanation: "The speaker is the source; the listener receives and responds." },
            { type: "true_false", prompt: "Feedback is the listener's response to the speaker's message.", options: ["True", "False"], correctIndex: 0, explanation: "It can be verbal or non-verbal and lets the speaker adapt." },
            { type: "mcq", prompt: "Noise or distractions that interfere with the message are called…", options: ["Channel", "Feedback", "Interference", "Situation"], correctIndex: 2, explanation: "Interference (external or internal) blocks the message reaching listeners." },
            { type: "true_false", prompt: "The speech communication process includes the speaker, message, channel, listener, feedback, interference and situation.", options: ["True", "False"], correctIndex: 0, explanation: "Those are the seven elements the chapter lists." },
            { type: "mcq", prompt: "The time and place in which communication occurs is the…", options: ["Channel", "Situation", "Message", "Feedback"], correctIndex: 1, explanation: "The situation shapes what is appropriate and effective." },
          ],
        },
        {
          name: "Audience & Culture (Ethnocentrism)",
          questions: [
            { type: "true_false", prompt: "Knowing your audience helps you pick the right words and examples.", options: ["True", "False"], correctIndex: 0, explanation: "Age, background and knowledge shape what lands." },
            { type: "mcq", prompt: "Ethnocentrism is…", options: ["Respecting all cultures", "Believing one's own group's culture is superior", "Studying many languages", "Avoiding feedback"], correctIndex: 1, explanation: "Chapter 1 defines it as assuming one group is superior to all others." },
            { type: "true_false", prompt: "Adapting the message to listeners' cultural expectations is one way to avoid ethnocentrism.", options: ["True", "False"], correctIndex: 0, explanation: "Respect listeners' values and put yourself in their place." },
            { type: "mcq", prompt: "Which is a step for avoiding ethnocentrism?", options: ["Ignore feedback", "Respect listeners' cultural values", "Use only your own examples", "Assume everyone shares your culture"], correctIndex: 1, explanation: "Respect, adaptation, empathy, and staying alert to feedback all help." },
            { type: "mcq", prompt: "Speaking to INFORM differs from speaking to PERSUADE because it aims to…", options: ["Use zero examples", "Increase understanding, not change minds", "Always be shorter", "Skip all research"], correctIndex: 1, explanation: "Inform is about clarity and comprehension; persuade targets attitude or behaviour change." },
          ],
        },
        {
          name: "Ethics, Plagiarism & Ethical Listening",
          questions: [
            { type: "mcq", prompt: "Ethics in public speaking deals with…", options: ["Slide design", "Issues of right and wrong in human affairs", "Voice projection", "Timing"], correctIndex: 1, explanation: "Chapter 2 defines ethics as matters of right and wrong." },
            { type: "true_false", prompt: "Name-calling uses language to defame, demean or degrade people.", options: ["True", "False"], correctIndex: 0, explanation: "Ethical speakers avoid name-calling and abusive language." },
            { type: "mcq", prompt: "Presenting another person's ideas or language as your own is…", options: ["Paraphrasing", "Plagiarism", "Citing", "Summarising"], correctIndex: 1, explanation: "Plagiarism is the definition given in Chapter 2." },
            { type: "mcq", prompt: "Stealing ideas from two or three sources and passing them off as one's own is…", options: ["Global plagiarism", "Patchwork plagiarism", "Incremental plagiarism", "Fair use"], correctIndex: 1, explanation: "Global = one source; patchwork = two or three; incremental = uncredited parts." },
            { type: "true_false", prompt: "Ethical listening means listeners also bear responsibilities during a speech.", options: ["True", "False"], correctIndex: 0, explanation: "Speech-making is a two-way street — listeners have ethical obligations too." },
          ],
        },
      ],
      draftTitle: "AI Draft: Public Speaking (generate from slides)",
    },
  ];
  // Owner cohorts: farah/rajesh reuse their CS101/CS205 students; the demo
  // lecturer's subject classes use REAL seeded students (not guests) so the
  // history survives the between-shows walk-up reset.
  const SUBJECT_COHORTS = [
    { lecturer: farah, codeKey: "farah", students: [danish, aisyah, weijian, meimei] },
    { lecturer: rajesh, codeKey: "rajesh", students: [aisyah, siti, firdaus, priya] },
    // Demo copies also carry kahmeng/nurul (CS205-only students with no
    // subject home): they get live quizzes to play here without duplicating
    // any other subject class. History still seeds for the first four only
    // (the [c1..c4] destructure below), so their rows stay clean.
    { lecturer: demoLecturer, codeKey: "demo", students: [aina, jason, divya, hakim, kahmeng, nurul] },
  ];
  // Every student 1–10 must land in ALL THREE subject classes, so no account
  // is left seeing a single class (the old cohorts left arjun/subject-less
  // students with only CS101). The base owner is the farah copy for this
  // guarantee; cohorts above keep the richer per-lecturer mix on top.
  const SUBJECT_COVERAGE = [danish, aisyah, weijian, meimei, arjun, siti, firdaus, priya, kahmeng, nurul];
  for (const subj of SUBJECTS) {
    for (const cohort of SUBJECT_COHORTS) {
      const classId = await ensureClass({
        lecturerId: cohort.lecturer.id,
        title: subj.classTitle,
        joinCode: subj.joinCodes[cohort.codeKey],
      });
      for (const s of cohort.students) await ensureEnrollment(classId, s.id);
      if (cohort.codeKey === "farah") {
        for (const s of SUBJECT_COVERAGE) await ensureEnrollment(classId, s.id);
      }
      // One Practice + its Assessment counterpart PER TOPIC (same bank), so the
      // class reads as several topics rather than a single quiz. The FIRST
      // topic also carries the closed+revealed history quiz (gradebook story).
      for (let t = 0; t < subj.topics.length; t++) {
        const topic = subj.topics[t];
        await ensureQuiz({
          classId,
          createdBy: cohort.lecturer.id,
          title: `Practice: ${topic.name}`,
          mode: "practice",
          timeLimitSec: null,
          status: "live",
          gesturesEnabled: true,
          questions: topic.questions,
        });
        // Assessment counterpart of the same bank: graded, click-to-answer
        // (gestures OFF, no camera gate), untimed — every subject student gets
        // a live assessment for every topic, not just history rows.
        await ensureQuiz({
          classId,
          createdBy: cohort.lecturer.id,
          title: `Assessment: ${topic.name}`,
          mode: "assessment",
          timeLimitSec: null,
          status: "live",
          gesturesEnabled: false,
          questions: topic.questions,
        });
        if (t !== 0) continue;
        const closed = await ensureQuiz({
          classId,
          createdBy: cohort.lecturer.id,
          title: `Quiz 1 — ${topic.name} (closed)`,
          mode: "assessment",
          timeLimitSec: 600,
          status: "closed",
          gesturesEnabled: false,
          questions: topic.questions,
        });
        await ensureRevealed(closed.id);
        // Seeded history: staggered sittings six days ago, mixed scores, one
        // believable proctoring trace on the weaker run.
        const [c1, c2, c3, c4] = cohort.students;
        const total = topic.questions.length;
        const base = 6 * 24 * 60;
        await seedSession({ quizId: closed.id, studentId: c1.id, mode: "assessment", correctCount: total, totalQuestions: total, status: "completed", startedMinutesAgo: base, durationMin: 8 });
        await seedSession({ quizId: closed.id, studentId: c2.id, mode: "assessment", correctCount: total, totalQuestions: total, status: "completed", startedMinutesAgo: base + 11, durationMin: 9 });
        await seedSession({ quizId: closed.id, studentId: c3.id, mode: "assessment", correctCount: total - 1, totalQuestions: total, status: "completed", startedMinutesAgo: base + 19, durationMin: 11, wrongOffset: 1, advisories: ["voice_activity"] });
        await seedSession({ quizId: closed.id, studentId: c4.id, mode: "assessment", correctCount: total - 2, totalQuestions: total, status: "completed", startedMinutesAgo: base + 28, durationMin: 13, wrongOffset: 2, focusPauses: 1, advisories: ["looked_away"] });
      }
      // AI-ready draft: created empty (publishing an empty quiz is blocked by
      // design) with the real handout files attached as sources.
      const draft = await ensureQuiz({
        classId,
        createdBy: cohort.lecturer.id,
        title: subj.draftTitle,
        mode: "assessment",
        timeLimitSec: null,
        status: "draft",
        gesturesEnabled: true,
        questions: [],
      });
      const sources = await ensureSubjectUploads({ lecturerId: cohort.lecturer.id, quizId: draft.id, files: subj.files });
      if (sources.length) {
        const { error } = await admin.from("quizzes").update({ sources }).eq("id", draft.id);
        if (error) log(`  ⚠ sources patch failed for "${subj.draftTitle}": ${error.message}`);
        else log(`  + ${sources.length} file source(s) on "${subj.draftTitle}"`);
      }
    }
  }

  log("\n== Done ==\n");
  log("Sign in at http://localhost:3000/login  (password for all: " + PASSWORD + ")");
  log("  lecturers : lecturer@innovision.test, lecturer2@innovision.test");
  log("  demo      : demo-lecturer@innovision.test (presenter)");
  log("  students  : student1@…test … student14@…test (see PEOPLE above; 11–14 are demo-cohort, x444 subjects only)");
  log(`\nJoin codes : CS101=DEMK42  CS205=DBSYS5  DEMO=SCAN23`);
  log("  Subjects   : ECON101 farah=ECN222 rajesh=ECN333 demo=ECN444 | RISK201 farah=RSK222 rajesh=RSK333 demo=RSK444 | SPEECH301 farah=SPK222 rajesh=SPK333 demo=SPK444");
  log("\nShared student quizzes:");
  log("  /s/STUDYHARD2  — Big-O Cheat Sheet Drill (Danish)");
  log("  /s/EXAMPREP24  — SQL Joins Practice (Aisyah)");
  log("\nFace setup intentionally NOT seeded — enrollment stays a user action.\n");
}

main().catch((e) => {
  console.error("\nSEED FAILED:", e?.message ?? e);
  process.exit(1);
});
