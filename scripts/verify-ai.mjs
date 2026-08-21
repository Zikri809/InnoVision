// Phase 4 security/RLS verification harness — runs against live local Supabase.
// Covers gate tests:
//   D34 — owner replaces a draft quiz's questions via replace_quiz_questions →
//         old gone, new set order_index 0..n-1, title/source fields set
//   D35 — non-owner lecturer / student / non-draft → typed errors; non-existent
//         and non-owned quizzes raise the SAME 'not_owner' (no oracle);
//         execute revoked from anon
//   D36 — invalid payload → error and PRIOR questions untouched (rollback)
//   D37 — after publish, a status-less UPDATE of source_text/source_file_url →
//         quiz_not_draft_edit (edit-lock fires on any UPDATE)
//   D38 — student sees no source_text/source_file_url/created_by via views;
//         a second lecturer reads 0 rows of the live quiz (owner-only)
//   D39 — N concurrent replace_quiz_questions on one draft quiz → no errors,
//         valid final state (advisory lock serialization)
//   D40 — source_text > 15000 via direct SQL → stored (cap removed)
// NOT a unit test; run manually: node scripts/verify-ai.mjs
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

assertLocalTarget(URL, "verify-ai.mjs");

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

/** A valid 3-question payload (matches the AI contract bounds). */
function makePayload(prefix = "Q") {
  return [
    { type: "mcq", prompt: `${prefix}1: What is velocity?`, options: ["Speed", "Distance"], correct_index: 0, explanation: "Velocity is speed with direction." },
    { type: "true_false", prompt: `${prefix}2: Light travels faster than sound.`, options: ["True", "False"], correct_index: 0 },
    { type: "mcq", prompt: `${prefix}3: Unit of force?`, options: ["Joule", "Newton", "Watt"], correct_index: 1 },
  ];
}

async function main() {
  // ── Provision: lecturer A, lecturer B, students S1 (enrolled), S2 (not) ──
  const lecturerA = await createUser(`aiA-${stamp}@innovision.test`);
  const lecturerB = await createUser(`aiB-${stamp}@innovision.test`);
  await createUser(`aiS1-${stamp}@innovision.test`);
  await createUser(`aiS2-${stamp}@innovision.test`);
  await promoteLecturer(lecturerA.id);
  await promoteLecturer(lecturerB.id);

  const clientA = await asUser(`aiA-${stamp}@innovision.test`);
  const clientB = await asUser(`aiB-${stamp}@innovision.test`);
  const clientS1 = await asUser(`aiS1-${stamp}@innovision.test`);
  const clientS2 = await asUser(`aiS2-${stamp}@innovision.test`);

  // ── Lecturer A creates a class + S1 enrolls ─────────────────────
  const joinCode = makeJoinCode();
  const { data: clsA, error: createErr } = await clientA
    .from("classes")
    .insert({ title: "A's AI Class", lecturer_id: lecturerA.id, join_code: joinCode })
    .select("id")
    .single();
  assertNoError("create class", { error: createErr });
  const { error: joinErr } = await clientS1.rpc("join_class", { code: joinCode });
  assertNoError("S1 join", { error: joinErr });

  async function makeDraftQuiz(title) {
    const { data: quiz, error } = await clientA
      .from("quizzes")
      .insert({ class_id: clsA.id, created_by: lecturerA.id, title, status: "draft" })
      .select("id, status")
      .single();
    assertNoError("create draft quiz", { error });
    createdQuizIds.push(quiz.id);
    return quiz;
  }

  // ── D34: owner replaces draft questions atomically ─────────────
  const quiz34 = await makeDraftQuiz("D34 Quiz");
  const { data: replaced, error: repErr } = await clientA.rpc("replace_quiz_questions", {
    p_quiz_id: quiz34.id,
    p_title: "D34 Renamed",
    p_source_file_url: `${lecturerA.id}/${quiz34.id}/chapter.pdf`,
    p_source_text: "Velocity is displacement over time. Force equals mass times acceleration.",
    p_questions: makePayload("D34"),
  });
  record("D34 replace succeeds", !repErr && Array.isArray(replaced) && replaced.length === 3,
    repErr?.message ?? JSON.stringify(replaced));

  const { data: rows34 } = await clientA
    .from("questions")
    .select("id, order_index, prompt")
    .eq("quiz_id", quiz34.id)
    .order("order_index");
  const ok34 =
    rows34?.length === 3 &&
    rows34.every((r, i) => r.order_index === i) &&
    rows34[0].prompt.startsWith("D34");
  record("D34 new set order_index 0..2", Boolean(ok34), JSON.stringify(rows34 ?? []));

  const { data: quiz34After } = await clientA
    .from("quizzes")
    .select("title, source_file_url, source_text")
    .eq("id", quiz34.id)
    .single();
  record("D34 title/source fields set",
    quiz34After?.title === "D34 Renamed" &&
      quiz34After?.source_file_url === `${lecturerA.id}/${quiz34.id}/chapter.pdf` &&
      quiz34After?.source_text?.includes("Velocity"),
    JSON.stringify(quiz34After));

  // ── D36: invalid payload → error, prior questions untouched ────
  const quiz36 = await makeDraftQuiz("D36 Quiz");
  await clientA.rpc("replace_quiz_questions", {
    p_quiz_id: quiz36.id,
    p_title: null,
    p_source_file_url: null,
    p_source_text: null,
    p_questions: makePayload("D36"),
  });
  const invalidPayloads = [
    [],                                                                           // empty
    [{ type: "mcq", prompt: "Only one", options: ["a", "b"], correct_index: 0 }], // <3
    Array.from({ length: 31 }, (_, i) => ({ type: "mcq", prompt: `Q${i}`, options: ["a", "b"], correct_index: 0 })), // >30
    [{ type: "mcq", prompt: "Bad options", options: ["a", "b", "c", "d", "e", "f"], correct_index: 0 }], // >5 options
    [{ type: "mcq", prompt: "Bad index", options: ["a", "b"], correct_index: 9 }], // OOR
    [{ type: "mcq", prompt: "Dupe", options: ["Yes", "yes"], correct_index: 0 }],  // duplicate
  ];
  let d36Pass = true;
  for (const payload of invalidPayloads) {
    const { error } = await clientA.rpc("replace_quiz_questions", {
      p_quiz_id: quiz36.id,
      p_title: null,
      p_source_file_url: null,
      p_source_text: null,
      p_questions: payload,
    });
    if (!error) d36Pass = false;
  }
  const { data: rows36 } = await clientA
    .from("questions")
    .select("prompt")
    .eq("quiz_id", quiz36.id)
    .order("order_index");
  const d36Rollback =
    rows36?.length === 3 && rows36[0].prompt.startsWith("D36");
  record("D36 invalid payloads rejected + prior questions untouched",
    d36Pass && Boolean(d36Rollback),
    `errorsOk=${d36Pass} remaining=${rows36?.length ?? 0}`);

  // ── D35: authZ + no-oracle + non-draft ─────────────────────────
  const { error: s1ReplaceErr } = await clientS1.rpc("replace_quiz_questions", {
    p_quiz_id: quiz34.id,
    p_title: null,
    p_source_file_url: null,
    p_source_text: null,
    p_questions: makePayload("HACK"),
  });
  record("D35 student replace denied", Boolean(s1ReplaceErr), s1ReplaceErr?.message ?? "unexpectedly succeeded");

  const { error: bReplaceErr } = await clientB.rpc("replace_quiz_questions", {
    p_quiz_id: quiz34.id,
    p_title: null,
    p_source_file_url: null,
    p_source_text: null,
    p_questions: makePayload("HACK"),
  });
  record("D35 lecturer B replace on A's quiz denied", Boolean(bReplaceErr), bReplaceErr?.message ?? "unexpectedly succeeded");

  const ghostId = "00000000-0000-4000-8000-0000000000aa";
  const { error: ghostErr } = await clientA.rpc("replace_quiz_questions", {
    p_quiz_id: ghostId,
    p_title: null,
    p_source_file_url: null,
    p_source_text: null,
p_questions: makePayload("GHOST"),
  });
  const ghostMsg = ghostErr?.message ?? "";
  record("D35 non-existent quiz raises not_owner (no oracle)",
    Boolean(ghostErr) && ghostMsg.includes("not_owner"),
    ghostMsg);

  // D35 fold-in: an unauthenticated caller (raw anon key, no sign-in) must
  // not be able to call replace_quiz_questions. The RPC's
  // `revoke execute from public, anon` (migration 0007) is what guarantees
  // this — if it regresses the call would either succeed or leak a different
  // error code than a logged-in non-owner.
  const anonClient = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data: anonData, error: anonErr } = await anonClient.rpc(
    "replace_quiz_questions",
    {
      p_quiz_id: quiz34.id,
      p_title: null,
      p_source_file_url: null,
      p_source_text: null,
      p_questions: makePayload("ANON"),
    },
  );
  const anonMsg = anonErr?.message ?? "";
  record("D35 anon caller denied by revoke execute",
    Boolean(anonErr) &&
      (anonMsg.includes("permission denied") ||
        anonMsg.includes("not_owner") ||
        anonMsg.includes("JWT")),
    `${anonMsg} | data=${JSON.stringify(anonData ?? null)?.slice(0, 60)}`);
  // The error code MUST differ from the authenticated not_owner so a
  // non-authenticated caller learns nothing about quiz existence.
  record("D35 anon error differs from authenticated not_owner (no oracle)",
    anonMsg !== ghostMsg,
    `anon="${anonMsg}" ghost="${ghostMsg}"`);

  // Non-draft (live) quiz → questions_locked_quiz_not_draft.
  const quizLive = await makeDraftQuiz("D35 Live");
  await clientA.rpc("replace_quiz_questions", {
    p_quiz_id: quizLive.id,
    p_title: null,
    p_source_file_url: null,
    p_source_text: null,
    p_questions: makePayload("LIVE"),
  });
  const { error: pubErr } = await clientA
    .from("quizzes")
    .update({ status: "live" })
    .eq("id", quizLive.id);
  assertNoError("publish live quiz", { error: pubErr });
  const { error: liveReplaceErr } = await clientA.rpc("replace_quiz_questions", {
    p_quiz_id: quizLive.id,
    p_title: null,
    p_source_file_url: null,
    p_source_text: null,
    p_questions: makePayload("LIVE2"),
  });
  record("D35 replace on live quiz blocked",
    Boolean(liveReplaceErr) && (liveReplaceErr.message ?? "").includes("questions_locked_quiz_not_draft"),
    liveReplaceErr?.message ?? "unexpectedly replaced live quiz");

  // ── D37: status-less source update on a LIVE quiz → edit-lock ──
  const { error: d37Err } = await clientA
    .from("quizzes")
    .update({ source_text: "tampered" })
    .eq("id", quizLive.id);
  record("D37 status-less source_text update on live quiz blocked",
    Boolean(d37Err) && (d37Err.message ?? "").includes("quiz_not_draft_edit"),
    d37Err?.message ?? "unexpectedly edited live quiz source");

  // ── D38: student sees no source fields; second lecturer sees 0 rows ──
  // The view only shows LIVE quizzes, so query the live quiz (quizLive).
  // NOTE: we must select ONLY columns the view exposes — selecting a column
  // absent from the view makes PostgREST error (data=null), not return rows.
  const { data: s1View, error: s1ViewErr } = await clientS1
    .from("student_quiz_view")
    .select("id, title, class_id, mode, status, time_limit_sec, created_at")
    .eq("id", quizLive.id);
  const s1Ok =
    !s1ViewErr &&
    Array.isArray(s1View) &&
    s1View.length === 1 &&
    !("source_text" in (s1View[0] ?? {})) &&
    !("source_file_url" in (s1View[0] ?? {})) &&
    !("created_by" in (s1View[0] ?? {}));
  record("D38 student view omits source fields/created_by", Boolean(s1Ok), JSON.stringify(s1View ?? []));

  const { data: s2View } = await clientS2
    .from("student_quiz_view")
    .select("id")
    .eq("id", quizLive.id);
  record("D38 unenrolled student sees nothing", (s2View ?? []).length === 0);

  const { data: bQuizRead } = await clientB
    .from("quizzes")
    .select("id, source_text")
    .eq("id", quizLive.id);
  record("D38 lecturer B reads 0 rows of A's quiz (owner-only)",
    (bQuizRead ?? []).length === 0, JSON.stringify(bQuizRead ?? []));

  // ── D39: concurrent replace serializes (advisory lock) ─────────
  const quiz39 = await makeDraftQuiz("D39 Quiz");
  const CONCURRENT = 8;
  const repResults = await Promise.all(
    Array.from({ length: CONCURRENT }, (_, i) =>
      clientA.rpc("replace_quiz_questions", {
        p_quiz_id: quiz39.id,
        p_title: `D39-${i}`,
        p_source_file_url: null,
        p_source_text: `text-${i}`,
        p_questions: makePayload(`D39-${i}`),
      }),
    ),
  );
  const repErrors = repResults.filter((r) => r.error);
  const { data: rows39 } = await clientA
    .from("questions")
    .select("order_index")
    .eq("quiz_id", quiz39.id);
  const indexes39 = (rows39 ?? []).map((q) => q.order_index).sort((a, b) => a - b);
  const unique39 = new Set(indexes39);
  record("D39 concurrent replaces serialize to a valid final state",
    repErrors.length === 0 &&
      indexes39.length === 3 &&
      unique39.size === 3 &&
      indexes39[0] === 0 &&
      indexes39[2] === 2,
    `errors=${repErrors.length} indexes=${JSON.stringify(indexes39)}`);

  // ── D40: source_text > 15000 stored (cap removed) ──────────────
  const quiz40 = await makeDraftQuiz("D40 Quiz");
  const bigSource = "x".repeat(15_001);
  const { error: d40Err } = await clientA
    .from("quizzes")
    .update({ source_text: bigSource })
    .eq("id", quiz40.id);
  const { data: d40Row } = await clientA
    .from("quizzes")
    .select("source_text")
    .eq("id", quiz40.id)
    .single();
  record(
    "D40 source_text > 15000 stored",
    !d40Err && d40Row?.source_text?.length === 15_001,
    d40Err?.message ?? (d40Row?.source_text?.length === 15_001 ? "stored" : "unexpected short/absent source_text"),
  );

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

