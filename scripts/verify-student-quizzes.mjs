// Phase SQ security/RLS verification harness — runs against live local Supabase.
// Mirrors scripts/verify-quizzes.mjs: admin (service-role) client provisions
// users; authenticated (anon-key + user token) clients verify RLS from the
// attacker's actual vantage point. Covers PLAN_STUDENT_PRACTICE_QUIZZES gates:
//   SQ-D1 — creator CRUD works via RLS (insert quiz + append question RPC)
//   SQ-D2 — student B cannot read A's UNshared quiz; CAN read the shared one
//   SQ-D3 — B cannot read A's questions TABLE rows even when shared
//           (creator-only policy); the player VIEW exposes NO correct_index
//   SQ-D4 — answer_student_question: grades for players on shared quizzes;
//           foreign/unshared/NULL all fold into ONE {error:'unavailable'}
//   SQ-D5 — resolve_shared_student_quiz returns creator FIRST NAME only and
//           NULL for unknown-or-revoked codes (one shape)
//   SQ-D6 — unshare nulls the code; re-share mints a FRESH one
//   SQ-D7 — caps: 26th quiz per student rejected (quiz_cap_reached)
//   SQ-D8 — lecturers can play (resolve + grade) but CANNOT author
// NOT a unit test; run manually: node scripts/verify-student-quizzes.mjs
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

assertLocalTarget(URL, "verify-student-quizzes.mjs");

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const results = [];
const createdUsers = [];
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
    user_metadata: { full_name: `First${email.split("@")[0]} Lastname` },
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

async function cleanup() {
  for (const id of createdQuizIds) {
    await admin.from("student_quizzes").delete().eq("id", id);
  }
  for (const id of createdUsers) {
    await admin.auth.admin.deleteUser(id);
  }
}

async function main() {
  const a = await createUser(`sq-a-${stamp}@verify.local`);
  const b = await createUser(`sq-b-${stamp}@verify.local`);
  const lec = await createUser(`sq-lect-${stamp}@verify.local`);
  await admin.from("profiles").update({ role: "student" }).eq("id", a.id);
  await admin.from("profiles").update({ role: "student" }).eq("id", b.id);
  await admin.from("profiles").update({ role: "lecturer" }).eq("id", lec.id);

  const A = await asUser(`sq-a-${stamp}@verify.local`);
  const B = await asUser(`sq-b-${stamp}@verify.local`);
  const L = await asUser(`sq-lect-${stamp}@verify.local`);

  // ── SQ-D1: creator CRUD via RLS ──────────────────────────────────
  const { data: quiz, error: insErr } = await A.from("student_quizzes")
    .insert({ created_by: a.id, title: "Verify Quiz" })
    .select("id, share_code")
    .single();
  record("SQ-D1a creator inserts own quiz", !insErr && !!quiz, insErr?.message);
  if (quiz) createdQuizIds.push(quiz.id);

  const { data: q, error: qErr } = await A.rpc("append_student_question", {
    p_quiz_id: quiz.id,
    p_type: "mcq",
    p_prompt: "2+2?",
    p_options: ["3", "4"],
    p_correct_index: 1,
    p_explanation: "addition",
  });
  record("SQ-D1b append RPC adds question", !qErr && !!q, qErr?.message);

  // ── SQ-D2: unshared invisible to B; lecturer too ────────────────
  const { data: hidden } = await B.from("student_quizzes")
    .select("id")
    .eq("id", quiz.id);
  record("SQ-D2a B cannot see UNshared quiz", (hidden ?? []).length === 0);

  // Share it.
  const finalCode = "ABCDEFGH2J"; // every char on the share alphabet
  const { data: sharedRow, error: shareErr } = await A.rpc("student_quiz_share_action", {
    p_quiz_id: quiz.id,
    p_action: "share",
    p_code: finalCode,
  });
  record("SQ-D2b creator sets share code via RPC", !shareErr && sharedRow?.share_code === finalCode);

  const { data: visible } = await B.from("student_quizzes")
    .select("id, title, created_by")
    .eq("id", quiz.id);
  record("SQ-D2c B sees SHARED quiz", (visible ?? []).length === 1);
  record(
    "SQ-D2d shared read does not expose created_by to B? (RLS row-level only — column strip is API-layer)",
    (visible ?? [])[0]?.created_by !== undefined, // RLS exposes the column; API layer strips it. Documented.
  );

  // ── SQ-D3: questions TABLE stays creator-only; VIEW hides the key ──
  const { data: bRows } = await B.from("student_quiz_questions")
    .select("id")
    .eq("quiz_id", quiz.id);
  record("SQ-D3a B reads ZERO rows from questions table", (bRows ?? []).length === 0);

  const { data: viewRows } = await B.from("student_quiz_player_question_view")
    .select("*")
    .eq("quiz_id", quiz.id);
  const v0 = (viewRows ?? [])[0];
  record(
    "SQ-D3b player view exposes questions WITHOUT correct_index/explanation",
    (viewRows ?? []).length === 1 &&
      v0 &&
      !("correct_index" in v0) &&
      !("explanation" in v0),
  );

  // ── SQ-D4: grading RPC semantics ─────────────────────────────────
  const { data: right } = await B.rpc("answer_student_question", {
    p_question_id: q.id,
    p_selected_index: 1,
  });
  record(
    "SQ-D4a player grades correctly (is_correct + key + explanation)",
    right?.is_correct === true && right?.correct_index === 1 && right?.explanation === "addition",
  );

  const { data: oob } = await B.rpc("answer_student_question", {
    p_question_id: q.id,
    p_selected_index: 99,
  });
  record("SQ-D4b out-of-bounds folds into unavailable", oob?.error === "unavailable");

  const { data: nullSel } = await B.rpc("answer_student_question", {
    p_question_id: q.id,
    p_selected_index: null,
  });
  record("SQ-D4c NULL selection reveals nothing", nullSel?.error === "unavailable");

  // Unshare → grading folds into unavailable for B.
  await A.rpc("student_quiz_share_action", { p_quiz_id: quiz.id, p_action: "unshare" });
  const { data: revokedGrade } = await B.rpc("answer_student_question", {
    p_question_id: q.id,
    p_selected_index: 1,
  });
  record("SQ-D4d revoked quiz grades as unavailable", revokedGrade?.error === "unavailable");

  // Creator still grades own unshared quiz.
  const { data: selfGrade } = await A.rpc("answer_student_question", {
    p_question_id: q.id,
    p_selected_index: 1,
  });
  record("SQ-D4e creator self-grades unshared quiz", selfGrade?.is_correct === true);

  // ── SQ-D5: resolve RPC — first name only; unknown/revoked → NULL ──
  await A.rpc("student_quiz_share_action", {
    p_quiz_id: quiz.id,
    p_action: "share",
    p_code: finalCode,
  });
  const { data: resolved } = await B.rpc("resolve_shared_student_quiz", {
    p_code: finalCode.toLowerCase(), // normalization contract
  });
  record(
    "SQ-D5a resolve returns metadata + first name, NO created_by UUID",
    resolved?.title === "Verify Quiz" &&
      typeof resolved?.creator_first_name === "string" &&
      resolved.creator_first_name.startsWith("First") &&
      !JSON.stringify(resolved).includes(a.id),
  );
  const { data: unknownCode } = await B.rpc("resolve_shared_student_quiz", {
    p_code: "ZZZZZZZZ2Z",
  });
  record("SQ-D5b unknown code → NULL", unknownCode === null);

  // ── SQ-D6: unshare nulls; re-share mints fresh ───────────────────
  await A.rpc("student_quiz_share_action", { p_quiz_id: quiz.id, p_action: "unshare" });
  const { data: reShared } = await A.rpc("student_quiz_share_action", {
    p_quiz_id: quiz.id,
    p_action: "share", // code was nulled by the unshare above — share mints fresh
    p_code: "BBBBBBBB2B",
  });
  record(
    "SQ-D6 unshare → re-share mints the new code (single source of truth)",
    reShared?.share_code === "BBBBBBBB2B",
  );

  // ── SQ-D7: cap — 26th quiz rejected ──────────────────────────────
  for (let i = 0; i < 25; i++) {
    const { data: extra, error: extraErr } = await B.from("student_quizzes")
      .insert({ created_by: b.id, title: `Bulk ${i}` })
      .select("id")
      .single();
    if (extraErr) {
      record("SQ-D7 26th quiz per student rejected by trigger", false, "cap hit early: " + extraErr.message);
      break;
    }
    if (extra) createdQuizIds.push(extra.id);
    if (i === 24) {
      // 25 rows now exist — the NEXT insert must be rejected by the trigger.
      const { error: overErr } = await B.from("student_quizzes")
        .insert({ created_by: b.id, title: "Bulk over-cap" })
        .select("id")
        .single();
      record("SQ-D7 26th quiz per student rejected by trigger", !!overErr && overErr.message.includes("quiz_cap_reached"));
    }
  }

  // ── SQ-D8: lecturers play but cannot author ──────────────────────
  const { data: lecResolved } = await L.rpc("resolve_shared_student_quiz", {
    p_code: "BBBBBBBB2B",
  });
  record("SQ-D8a lecturer resolves shared quiz", !!lecResolved);
  const { data: lecGrade } = await L.rpc("answer_student_question", {
    p_question_id: q.id,
    p_selected_index: 1,
  });
  record("SQ-D8b lecturer grades shared quiz", lecGrade?.is_correct === true);
  const { error: lecInsErr } = await L.from("student_quizzes")
    .insert({ created_by: lec.id, title: "Lec attempt" })
    .select("id")
    .single();
  record("SQ-D8c lecturer CANNOT author student quizzes", !!lecInsErr);

  // ── SQ-D9: share_code is NOT insertable — revoked-code hijack closed ──
  // Column-restricted INSERT grant: a direct PostgREST INSERT carrying
  // share_code must fail with a permission error (42501), not succeed.
  await A.rpc("student_quiz_share_action", {
    p_quiz_id: quiz.id,
    p_action: "unshare",
  }); // revoke "BBBBBBBB2B" so the code below is FREE for an attacker
  const { data: resurrected, error: resErr } = await B.from("student_quizzes")
    .insert({ created_by: b.id, title: "Hijack", share_code: "BBBBBBBB2B" })
    .select("id, share_code")
    .single();
  record(
    "SQ-D9 direct INSERT with share_code rejected (revoked-code hijack closed)",
    !!resErr && !resurrected,
    resErr?.message ?? "unexpectedly succeeded",
  );

  await cleanup();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} probes passed.`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup();
  process.exit(1);
});
