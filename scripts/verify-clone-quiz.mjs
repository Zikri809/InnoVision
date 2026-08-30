// AP-2 clone_quiz verification harness (PLAN_R_AUTHORING_PRODUCTIVITY) — runs
// against live local Supabase.
// - Admin (service-role) client for provisioning + DB assertions.
// - Authenticated clients (anon key + real user tokens) to verify RLS/RPC
//   guards from the caller's actual vantage point.
// Covers:
//   AP2-D1  owner clones own draft quiz → new draft, " (copy)" title
//   AP2-D2  clone fidelity: questions copied (order/type/prompt/options/
//           correct_index/explanation/image_path verbatim)
//   AP2-D3  metadata copied: mode/time_limit/retake/attempts/shuffle/source_text
//   AP2-D4  fresh state: windows/reveal NULL, file provenance cleared
//   AP2-D5  LIVE source clones → draft destination
//   AP2-D6  CLOSED source clones → draft destination
//   AP2-D7  cross-lecturer SOURCE denied (not_quiz_owner)
//   AP2-D8  destination class NOT owned denied (not_class_owner)
//   AP2-D9  archived destination denied (class_archived)
//   AP2-D10 the 30-question cap is deliberately NOT enforced on clone
//   AP2-D11 grant posture: anon key cannot execute clone_quiz
// NOT a unit test; run manually: npm run verify:clone
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

assertLocalTarget(URL, "verify-clone-quiz.mjs");

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

async function createOwnedClass(client, lecturerId, title) {
  const { data: cls, error } = await client
    .from("classes")
    .insert({ title, lecturer_id: lecturerId, join_code: makeJoinCode() })
    .select("id")
    .single();
  assertNoError(`create class ${title}`, { error });
  createdClassIds.push(cls.id);
  return cls.id;
}

async function createDraftQuiz(client, lecturerId, classId, title, extra = {}) {
  const { data: quiz, error } = await client
    .from("quizzes")
    .insert({ class_id: classId, created_by: lecturerId, title, mode: "assessment", time_limit_sec: 600, ...extra })
    .select("id")
    .single();
  assertNoError(`create quiz ${title}`, { error });
  createdQuizIds.push(quiz.id);
  return quiz.id;
}

async function appendQuestion(client, quizId, i, imagePath = null) {
  const { error } = await client.rpc("append_question", {
    p_quiz_id: quizId,
    p_type: "mcq",
    p_prompt: `Question ${i}?`,
    p_options: [`opt ${i}A`, `opt ${i}B`, `opt ${i}C`],
    p_correct_index: 1,
    p_explanation: i === 0 ? "Because." : "",
  });
  assertNoError(`append question ${i}`, { error });
  if (imagePath) {
    const { data: row } = await admin
      .from("questions")
      .select("id")
      .eq("quiz_id", quizId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (row?.[0]) {
      await admin.from("questions").update({ image_path: imagePath }).eq("id", row[0].id);
    }
  }
}

async function main() {
  // ── Provision: lecturer A (owner), lecturer B (attacker) ──
  const lecturerA = await createUser(`cloneA-${stamp}@innovision.test`);
  const lecturerB = await createUser(`cloneB-${stamp}@innovision.test`);
  await promoteLecturer(lecturerA.id);
  await promoteLecturer(lecturerB.id);

  const clientA = await asUser(`cloneA-${stamp}@innovision.test`);
  const clientB = await asUser(`cloneB-${stamp}@innovision.test`);

  const classA1 = await createOwnedClass(clientA, lecturerA.id, "A1 Clone Class");
  const classA2 = await createOwnedClass(clientA, lecturerA.id, "A2 Clone Class");
  const classB1 = await createOwnedClass(clientB, lecturerB.id, "B1 Clone Class");

  // ── Source quiz: draft assessment with 2 questions (one imaged) ──
  const srcQuiz = await createDraftQuiz(clientA, lecturerA.id, classA1, "Source Quiz", {
    source_text: "Chapter 3 notes",
    allow_retake: true,
    max_attempts: 3,
    shuffle_questions: true,
    auto_reveal_on_complete: true,
  });
  await appendQuestion(clientA, srcQuiz, 1, `${lecturerA.id}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`);
  await appendQuestion(clientA, srcQuiz, 2);

  // QT1-D9: a multi_select source question must clone with its answer-key SET.
  {
    const { error: qtMultiErr } = await clientA.rpc("append_question", {
      p_quiz_id: srcQuiz,
      p_type: "multi_select",
      p_prompt: "Which are prime?",
      p_options: ["2", "3", "4", "5"],
      p_correct_index: null,
      p_correct_indices: [0, 1, 3],
      p_explanation: "2, 3, 5.",
    });
    assertNoError("QT1-D9 append multi question to source", { error: qtMultiErr });
  }

  // AP2-D1 — owner clones own draft within the class.
  const { data: cloneId, error: cloneErr } = await clientA.rpc("clone_quiz", {
    p_src_quiz_id: srcQuiz,
    p_dest_class_id: classA1,
  });
  record("AP2-D1 owner clones own draft quiz → uuid", !cloneErr && typeof cloneId === "string", cloneErr?.message ?? "");
  if (cloneErr) return summary();
  createdQuizIds.push(cloneId);

  const { data: cloneRow, error: cloneRowErr } = await clientA
    .from("quizzes")
    .select("*")
    .eq("id", cloneId)
    .single();
  assertNoError("read clone row", { error: cloneRowErr });

  record("AP2-D1b clone titled '<title> (copy)'", cloneRow.title === "Source Quiz (copy)", cloneRow.title);
  record("AP2-D1c clone is a DRAFT in the destination class owned by the caller",
    cloneRow.status === "draft" && cloneRow.class_id === classA1 && cloneRow.created_by === lecturerA.id,
    `${cloneRow.status}/${cloneRow.class_id}/${cloneRow.created_by}`);

  // AP2-D1d — title suffix truncation: a 200-char source title still clones
  // with the " (copy)" suffix inside the 200-char CHECK.
  const longQuiz = await createDraftQuiz(clientA, lecturerA.id, classA1, "x".repeat(200));
  const { data: longCloneId, error: longCloneErr } = await clientA.rpc("clone_quiz", {
    p_src_quiz_id: longQuiz,
    p_dest_class_id: classA1,
  });
  createdQuizIds.push(longCloneId);
  const { data: longClone } = longCloneId
    ? await clientA.from("quizzes").select("title").eq("id", longCloneId).single()
    : { data: null };
  record("AP2-D1d 200-char source title truncates but keeps the suffix",
    !longCloneErr && longClone !== null &&
      longClone.title.length <= 200 && longClone.title.endsWith(" (copy)"),
    longCloneErr?.message ?? `${longClone?.title.length} chars, ends: "${longClone?.title.slice(-12)}"`);

  // AP2-D2 — question fidelity.
  const { data: srcQuestions } = await clientA.from("questions").select("*").eq("quiz_id", srcQuiz).order("order_index");
  const { data: cloneQuestions } = await clientA.from("questions").select("*").eq("quiz_id", cloneId).order("order_index");
  const fidelity =
    cloneQuestions?.length === 3 &&
    cloneQuestions.every((q, i) =>
      q.order_index === srcQuestions[i].order_index &&
      q.type === srcQuestions[i].type &&
      q.prompt === srcQuestions[i].prompt &&
      JSON.stringify(q.options) === JSON.stringify(srcQuestions[i].options) &&
      q.correct_index === srcQuestions[i].correct_index &&
      JSON.stringify(q.correct_indices) === JSON.stringify(srcQuestions[i].correct_indices) &&
      q.explanation === srcQuestions[i].explanation &&
      q.image_path === srcQuestions[i].image_path &&
      q.quiz_id === cloneId,
    );
  record("AP2-D2 question rows copied with fidelity (incl. image_path)", Boolean(fidelity), JSON.stringify(cloneQuestions?.map((q) => [q.order_index, q.prompt, q.image_path])));

  const multiSrc = (srcQuestions ?? [])[2];
  const multiClone = (cloneQuestions ?? [])[2];
  record("QT1-D9 clone copies the multi answer-key set verbatim",
    multiSrc?.type === "multi_select" &&
      multiClone?.type === "multi_select" &&
      multiClone?.correct_index === null &&
      JSON.stringify(multiClone?.correct_indices) === JSON.stringify([0, 1, 3]),
    `src=${JSON.stringify(multiSrc?.correct_indices)} clone=${JSON.stringify(multiClone?.correct_indices)}`);

  // AP2-D3 — metadata copied.
  record("AP2-D3 metadata copied (mode/time/retake/attempts/shuffle/source_text/auto_reveal)",
    cloneRow.mode === "assessment" &&
      cloneRow.time_limit_sec === 600 &&
      cloneRow.allow_retake === true &&
      cloneRow.max_attempts === 3 &&
      cloneRow.shuffle_questions === true &&
      cloneRow.source_text === "Chapter 3 notes" &&
      cloneRow.auto_reveal_on_complete === true,
    JSON.stringify([cloneRow.mode, cloneRow.time_limit_sec, cloneRow.allow_retake, cloneRow.max_attempts, cloneRow.shuffle_questions, cloneRow.source_text, cloneRow.auto_reveal_on_complete]));

  // AP2-D4 — fresh state.
  record("AP2-D4 fresh state (windows/reveal NULL, file provenance cleared)",
    cloneRow.opens_at === null &&
      cloneRow.closes_at === null &&
      cloneRow.results_revealed_at === null &&
      cloneRow.source_file_url === null &&
      JSON.stringify(cloneRow.sources) === "[]",
    JSON.stringify([cloneRow.opens_at, cloneRow.closes_at, cloneRow.results_revealed_at, cloneRow.source_file_url, cloneRow.sources]));

  // AP2-D5 — LIVE source clones → draft.
  const liveQuiz = await createDraftQuiz(clientA, lecturerA.id, classA1, "Live Source");
  await appendQuestion(clientA, liveQuiz, 1);
  await appendQuestion(clientA, liveQuiz, 2);
  const { error: liveErr } = await clientA.from("quizzes").update({ status: "live" }).eq("id", liveQuiz);
  assertNoError("publish live source", { error: liveErr });
  const { data: liveCloneId, error: liveCloneErr } = await clientA.rpc("clone_quiz", {
    p_src_quiz_id: liveQuiz,
    p_dest_class_id: classA1,
  });
  createdQuizIds.push(liveCloneId);
  const { data: liveClone } = liveCloneId
    ? await clientA.from("quizzes").select("status").eq("id", liveCloneId).single()
    : { data: null };
  record("AP2-D5 LIVE source clones → draft destination", !liveCloneErr && liveClone?.status === "draft", liveCloneErr?.message ?? liveClone?.status);

  // AP2-D6 — CLOSED source clones → draft.
  const { error: closeErr } = await clientA.from("quizzes").update({ status: "closed" }).eq("id", liveQuiz);
  assertNoError("close source", { error: closeErr });
  const { data: closedCloneId, error: closedCloneErr } = await clientA.rpc("clone_quiz", {
    p_src_quiz_id: liveQuiz,
    p_dest_class_id: classA1,
  });
  createdQuizIds.push(closedCloneId);
  const { data: closedClone } = closedCloneId
    ? await clientA.from("quizzes").select("status").eq("id", closedCloneId).single()
    : { data: null };
  record("AP2-D6 CLOSED source clones → draft destination", !closedCloneErr && closedClone?.status === "draft", closedCloneErr?.message ?? closedClone?.status);

  // AP2-D7 — cross-lecturer SOURCE denied (no oracle: also covers missing).
  const { error: foreignSrcErr } = await clientB.rpc("clone_quiz", {
    p_src_quiz_id: srcQuiz,
    p_dest_class_id: classB1,
  });
  record("AP2-D7 foreign source denied (not_quiz_owner)", Boolean(foreignSrcErr) && foreignSrcErr.message.includes("not_quiz_owner"), foreignSrcErr?.message ?? "no error");

  // AP2-D8 — destination class NOT owned denied.
  const { error: foreignDestErr } = await clientA.rpc("clone_quiz", {
    p_src_quiz_id: srcQuiz,
    p_dest_class_id: classB1,
  });
  record("AP2-D8 foreign destination denied (not_class_owner)", Boolean(foreignDestErr) && foreignDestErr.message.includes("not_class_owner"), foreignDestErr?.message ?? "no error");

  // AP2-D9 — archived destination denied.
  const { error: archiveErr } = await admin
    .from("classes")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", classA2);
  assertNoError("archive classA2", { error: archiveErr });
  const { error: archivedDestErr } = await clientA.rpc("clone_quiz", {
    p_src_quiz_id: srcQuiz,
    p_dest_class_id: classA2,
  });
  record("AP2-D9 archived destination denied (class_archived)", Boolean(archivedDestErr) && archivedDestErr.message.includes("class_archived"), archivedDestErr?.message ?? "no error");

  // AP2-D10 — the 30-cap is deliberately NOT enforced on clone.
  const bigQuiz = await createDraftQuiz(clientA, lecturerA.id, classA1, "Big Source");
  for (let i = 1; i <= 31; i++) {
    await appendQuestion(clientA, bigQuiz, i);
  }
  const { data: bigCloneId, error: bigCloneErr } = await clientA.rpc("clone_quiz", {
    p_src_quiz_id: bigQuiz,
    p_dest_class_id: classA1,
  });
  createdQuizIds.push(bigCloneId);
  const { count: bigCloneCount } = bigCloneId
    ? await clientA.from("questions").select("id", { count: "exact", head: true }).eq("quiz_id", bigCloneId)
    : { count: 0 };
  record("AP2-D10 31-question source clones in full (no cap)", !bigCloneErr && bigCloneCount === 31, bigCloneErr?.message ?? `${bigCloneCount} questions`);

  // AP2-D11 — grant posture: anon key cannot execute clone_quiz.
  const anonClient = createClient(URL, ANON, { auth: { persistSession: false } });
  const { error: anonErr } = await anonClient.rpc("clone_quiz", {
    p_src_quiz_id: srcQuiz,
    p_dest_class_id: classA1,
  });
  record("AP2-D11 anon EXECUTE denied at the grant layer", Boolean(anonErr), anonErr?.message ?? "no error");

  return summary();
}

function summary() {
  console.log("\n" + "=".repeat(60));
  const passed = results.filter((r) => r.pass).length;
  console.log(`${passed}/${results.length} checks passed`);
  return passed === results.length ? 0 : 1;
}

async function cleanup() {
  try {
    for (const qid of createdQuizIds) {
      if (qid) await admin.from("questions").delete().eq("quiz_id", qid);
      if (qid) await admin.from("quizzes").delete().eq("id", qid);
    }
    for (const cid of createdClassIds) {
      await admin.from("classes").delete().eq("id", cid);
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
