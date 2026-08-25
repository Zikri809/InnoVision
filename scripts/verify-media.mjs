// Media security verification harness — runs against live local Supabase.
// Mirrors scripts/verify-student-quizzes.mjs conventions. Covers
// PLAN_MEDIA_AND_STUDENT_AI gates:
//   MEDIA-D1 — deny-by-default storage: authenticated clients cannot
//              upload/list/download on question-images / avatars buckets
//              (zero policies; grants ≠ authorization)
//   MEDIA-D2 — resolve_question_image ASSESSMENT matrix: class-owner any
//              status ✓; enrolled+live ✓; enrolled+draft ✗;
//              enrolled+closed unrevealed ✗; enrolled+closed revealed ✓;
//              unenrolled ✗ (D12: images follow score reveal on close)
//   MEDIA-D3 — practice matrix: creator ✓; shared-code player ✓;
//              unshared non-creator folds into the SAME empty result
//   MEDIA-D4 — TTL scoping: shared-practice mints 300 s; owner paths 3600 s
//   MEDIA-D5 — save_student_quiz_questions: ownership (B → not_owner),
//              mode whitelist, append counting, cap enforcement
//   MEDIA-D6 — atomicity: one invalid row mid-batch ⇒ typed error AND zero
//              inserts (single-transaction rollback)
//   MEDIA-D7 — advisory-lock serialization: N concurrent appends produce the
//              exact expected final count (no lost updates)
//   MEDIA-D8 — grants layer: anon cannot execute the new RPCs
//   MEDIA-D9 — quiz-sources widening: student CAN upload into own
//              ${uid}/${quizId}/ folder; cross-uid prefix denied
//   MEDIA-D10 — player views expose has_image but NEVER image_path
// NOT a unit test; run manually: node scripts/verify-media.mjs
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

const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL_ || !ANON || !SERVICE) {
  console.error("Missing .env.local keys (NEXT_PUBLIC_SUPABASE_URL / ANON / SERVICE_ROLE).");
  process.exit(1);
}

assertLocalTarget(URL_, "verify-media.mjs");

const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const results = [];
const createdUsers = [];
const createdQuizIds = [];
const createdClassIds = [];
const createdPracticeIds = [];

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
  const client = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({
    email,
    password: "hunter2!Secure",
  });
  if (error) throw error;
  return client;
}

async function cleanup() {
  for (const id of createdQuizIds) await admin.from("quizzes").delete().eq("id", id);
  for (const id of createdPracticeIds) await admin.from("student_quizzes").delete().eq("id", id);
  for (const id of createdClassIds) await admin.from("classes").delete().eq("id", id);
  for (const id of createdUsers) await admin.auth.admin.deleteUser(id);
}

/** Assessment quiz with one imaged question; optional status/reveal moves. */
async function makeAssessmentQuiz(classId, createdBy, { status, revealed }) {
  const { data: quiz, error } = await admin
    .from("quizzes")
    .insert({ class_id: classId, created_by: createdBy, title: `media-${stamp}`, mode: "assessment" })
    .select("id")
    .single();
  if (error) throw error;
  createdQuizIds.push(quiz.id);

  const { data: q, error: qErr } = await admin
    .from("questions")
    .insert({
      quiz_id: quiz.id,
      order_index: 0,
      type: "mcq",
      prompt: "Which one?",
      options: ["a", "b"],
      correct_index: 0,
      image_path: `${createdBy}/11111111-2222-3333-4444-555555555555.png`,
    })
    .select("id")
    .single();
  if (qErr) throw qErr;

  if (status !== "draft") {
    const { error: liveErr } = await admin.from("quizzes").update({ status: "live" }).eq("id", quiz.id);
    if (liveErr) throw liveErr;
  }
  if (status === "closed") {
    const { error: closeErr } = await admin.from("quizzes").update({ status: "closed" }).eq("id", quiz.id);
    if (closeErr) throw closeErr;
  }
  if (revealed) {
    const { error: revErr } = await admin
      .from("quizzes")
      .update({ results_revealed_at: new Date().toISOString() })
      .eq("id", quiz.id);
    if (revErr) throw revErr;
  }
  return { quizId: quiz.id, questionId: q.id };
}

async function main() {
  // ── Provision actors ────────────────────────────────────────────────
  const lec = await createUser(`media-lec-${stamp}@verify.local`);
  const a = await createUser(`media-a-${stamp}@verify.local`);
  const b = await createUser(`media-b-${stamp}@verify.local`);
  await admin.from("profiles").update({ role: "lecturer" }).eq("id", lec.id);
  await admin.from("profiles").update({ role: "student" }).eq("id", a.id);
  await admin.from("profiles").update({ role: "student" }).eq("id", b.id);

  const L = await asUser(`media-lec-${stamp}@verify.local`);
  const A = await asUser(`media-a-${stamp}@verify.local`);
  const B = await asUser(`media-b-${stamp}@verify.local`);

  // Class owned by lec; A enrolled; B not. join_code: 6-char unambiguous alphabet.
  const joinCode = Array.from(
    { length: 6 },
    () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)],
  ).join("");
  const { data: cls, error: clsErr } = await admin
    .from("classes")
    .insert({ lecturer_id: lec.id, title: `media-${stamp}`, join_code: joinCode })
    .select("id")
    .single();
  if (clsErr) throw clsErr;
  createdClassIds.push(cls.id);
  const { error: enrErr } = await admin
    .from("class_enrollments")
    .insert({ class_id: cls.id, student_id: a.id });
  if (enrErr) throw enrErr;

  // ── MEDIA-D1: deny-by-default storage ───────────────────────────────
  // NOTE (probed): with ZERO policies, upload errors outright, while
  // list/download/createSignedUrl return empty / "Object not found" — the
  // storage layer masks SELECT denials as not-found. Deny-by-default holds
  // semantically: clients can never write, read bytes, mint URLs, or
  // enumerate names. The list probe seeds an object first to prove that
  // nothing leaks.
  for (const bucket of ["question-images", "avatars"]) {
    const { error: upErr } = await A.storage
      .from(bucket)
      .upload(`${a.id}/probe-${stamp}.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        contentType: "image/png",
        upsert: false,
      });
    record(`MEDIA-D1 ${bucket} client upload denied`, upErr != null, upErr?.message ?? "");

    // Seed via service role so the listing has something to (not) leak.
    const seedPath = `${a.id}/seeded-${stamp}.png`;
    await admin.storage
      .from(bucket)
      .upload(seedPath, Buffer.from([0x89, 0x50]), { contentType: "image/png", upsert: true });
    const { data: listed, error: listErr } = await A.storage.from(bucket).list(a.id);
    record(
      `MEDIA-D1 ${bucket} client list leaks nothing`,
      !listErr && (listed ?? []).length === 0,
      listErr?.message ?? JSON.stringify(listed),
    );
    await admin.storage.from(bucket).remove([seedPath]);

    const { error: dlErr } = await A.storage.from(bucket).download(seedPath);
    record(`MEDIA-D1 ${bucket} client download denied`, dlErr != null, dlErr?.message ?? "");
  }

  // ── MEDIA-D2/D4: assessment visibility matrix + TTLs ────────────────
  const draft = await makeAssessmentQuiz(cls.id, lec.id, { status: "draft" });
  const live = await makeAssessmentQuiz(cls.id, lec.id, { status: "live" });
  const closedU = await makeAssessmentQuiz(cls.id, lec.id, { status: "closed", revealed: false });
  const closedR = await makeAssessmentQuiz(cls.id, lec.id, { status: "closed", revealed: true });

  async function resolves(client, questionId) {
    const { data, error } = await client.rpc("resolve_question_image", { p_question_id: questionId });
    if (error) return { error };
    const row = (data ?? [])[0];
    return row ? { path: row.image_path, ttl: row.ttl_seconds } : {};
  }

  {
    const r = await resolves(L, live.questionId);
    record("MEDIA-D2 owner resolves LIVE", !!r.path && r.ttl === 3600, JSON.stringify(r));
    const d = await resolves(L, draft.questionId);
    record("MEDIA-D2 owner resolves DRAFT", !!d.path, JSON.stringify(d));

    const aLive = await resolves(A, live.questionId);
    record("MEDIA-D2 enrolled resolves LIVE", !!aLive.path, JSON.stringify(aLive));
    const aDraft = await resolves(A, draft.questionId);
    record("MEDIA-D2 enrolled BLOCKED on draft", !aDraft.path && !aDraft.error, JSON.stringify(aDraft));
    const aClosedU = await resolves(A, closedU.questionId);
    record("MEDIA-D2 enrolled BLOCKED on closed-unrevealed", !aClosedU.path, JSON.stringify(aClosedU));
    const aClosedR = await resolves(A, closedR.questionId);
    record("MEDIA-D2 enrolled resolves closed-revealed", !!aClosedR.path && aClosedR.ttl === 3600, JSON.stringify(aClosedR));

    const bLive = await resolves(B, live.questionId);
    record("MEDIA-D2 unenrolled blocked", !bLive.path && !bLive.error, JSON.stringify(bLive));
  }

  // ── MEDIA-D3/D4: practice visibility + TTLs ─────────────────────────
  // 10-char unambiguous alphabet (no 0/O/1/I) per the share_code CHECK.
  const shareCode = Array.from(
    { length: 10 },
    () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)],
  ).join("");
  const { data: pShared, error: pSharedErr } = await admin
    .from("student_quizzes")
    .insert({ created_by: a.id, title: `shared-${stamp}`, share_code: shareCode })
    .select("id")
    .single();
  if (pSharedErr) throw pSharedErr;
  createdPracticeIds.push(pShared.id);

  const { data: pqShared, error: pqErr } = await admin
    .from("student_quiz_questions")
    .insert({
      quiz_id: pShared.id,
      order_index: 0,
      type: "mcq",
      prompt: "Pick",
      options: ["x", "y"],
      correct_index: 1,
      image_path: `${a.id}/22222222-3333-4444-5555-666666666666.webp`,
    })
    .select("id")
    .single();
  if (pqErr) throw pqErr;

  {
    const asCreator = await resolves(A, pqShared.id);
    record("MEDIA-D3 creator resolves shared-practice", !!asCreator.path && asCreator.ttl === 3600, JSON.stringify(asCreator));
    const asPlayer = await resolves(B, pqShared.id);
    record("MEDIA-D3 code-holder resolves at SHORT ttl", !!asPlayer.path && asPlayer.ttl === 300, JSON.stringify(asPlayer));

    // Unshared quiz question: B gets the SAME empty result as unknown ids.
    const { data: pPriv, error: pPrivErr } = await admin
      .from("student_quizzes")
      .insert({ created_by: a.id, title: `priv-${stamp}` })
      .select("id")
      .single();
    if (pPrivErr) throw pPrivErr;
    createdPracticeIds.push(pPriv.id);
    const { data: pqPriv, error: pqPrivErr } = await admin
      .from("student_quiz_questions")
      .insert({
        quiz_id: pPriv.id,
        order_index: 0,
        type: "mcq",
        prompt: "Hidden pick",
        options: ["x", "y"],
        correct_index: 0,
        image_path: `${a.id}/33333333-4444-5555-6666-777777777777.png`,
      })
      .select("id")
      .single();
    if (pqPrivErr) throw pqPrivErr;

    const privAsB = await resolves(B, pqPriv.id);
    const unknownAsB = await resolves(B, "00000000-0000-4000-8000-000000000000");
    record(
      "MEDIA-D3 unshared ≡ unknown (one empty shape)",
      !privAsB.path && !unknownAsB.path && !privAsB.error,
      JSON.stringify({ privAsB, unknownAsB }),
    );
  }

  // ── MEDIA-D5..D7: save_student_quiz_questions ───────────────────────
  const { data: pSave, error: pSaveErr } = await admin
    .from("student_quizzes")
    .insert({ created_by: a.id, title: `save-${stamp}` })
    .select("id")
    .single();
  if (pSaveErr) throw pSaveErr;
  createdPracticeIds.push(pSave.id);

  const threeRows = Array.from({ length: 3 }, (_, i) => ({
    type: "mcq",
    prompt: `Question ${i + 1} about cells`,
    options: ["alpha", "beta"],
    correct_index: i % 2,
    explanation: null,
  }));

  {
    const { data: saved, error: repErr } = await A.rpc("save_student_quiz_questions", {
      p_quiz_id: pSave.id,
      p_questions: threeRows,
      p_mode: "replace",
    });
    record("MEDIA-D5 replace seeds questions", !repErr && (saved ?? []).length === 3, repErr?.message ?? "");

    const { error: appErr } = await A.rpc("save_student_quiz_questions", {
      p_quiz_id: pSave.id,
      p_questions: [threeRows[0]],
      p_mode: "append",
    });
    record("MEDIA-D5 append adds", !appErr, appErr?.message ?? "");

    const { error: bErr } = await B.rpc("save_student_quiz_questions", {
      p_quiz_id: pSave.id,
      p_questions: threeRows,
      p_mode: "append",
    });
    record("MEDIA-D5 foreign creator blocked", bErr != null && /not_owner|quiz_not_found/i.test(bErr.message), bErr?.message ?? "");

    const { error: badModeErr } = await A.rpc("save_student_quiz_questions", {
      p_quiz_id: pSave.id,
      p_questions: threeRows,
      p_mode: "upsert",
    });
    record("MEDIA-D5 mode whitelist", badModeErr != null && /invalid_mode/.test(badModeErr.message), badModeErr?.message ?? "");

    // Cap: currently 4; appending 47 would exceed 50.
    const bigBatch = Array.from({ length: 47 }, (_, i) => ({ ...threeRows[0], prompt: `cap ${i}` }));
    const { error: capErr } = await A.rpc("save_student_quiz_questions", {
      p_quiz_id: pSave.id,
      p_questions: bigBatch,
      p_mode: "append",
    });
    record("MEDIA-D5 50-cap enforced", capErr != null && /question_cap_reached|limit/i.test(capErr.message), capErr?.message ?? "");
  }

  // MEDIA-D6: atomicity — one bad row mid-batch rolls back EVERYTHING.
  {
    const { count: before } = await admin
      .from("student_quiz_questions")
      .select("*", { count: "exact", head: true })
      .eq("quiz_id", pSave.id);

    const mixed = [
      { type: "mcq", prompt: "good row before the bad one", options: ["m", "n"], correct_index: 0 },
      { type: "mcq", prompt: null, options: ["m", "n"], correct_index: 0 },
    ];
    const { error: mixErr } = await A.rpc("save_student_quiz_questions", {
      p_quiz_id: pSave.id,
      p_questions: mixed,
      p_mode: "append",
    });

    const { count: after } = await admin
      .from("student_quiz_questions")
      .select("*", { count: "exact", head: true })
      .eq("quiz_id", pSave.id);

    record(
      "MEDIA-D6 invalid batch ⇒ zero inserts",
      mixErr != null && before === after,
      `err=${mixErr?.message ?? "none"} count ${before}→${after}`,
    );
  }

  // MEDIA-D7: concurrent single-appends serialize to the exact final count.
  {
    const { count: start } = await admin
      .from("student_quiz_questions")
      .select("*", { count: "exact", head: true })
      .eq("quiz_id", pSave.id);

    const results7 = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        A.rpc("save_student_quiz_questions", {
          p_quiz_id: pSave.id,
          p_questions: [{ ...threeRows[0], prompt: `concurrent ${i} ${stamp}` }],
          p_mode: "append",
        }),
      ),
    );
    const oks = results7.filter((r) => !r.error).length;

    const { count: end } = await admin
      .from("student_quiz_questions")
      .select("*", { count: "exact", head: true })
      .eq("quiz_id", pSave.id);

    record(
      "MEDIA-D7 concurrent appends serialize",
      oks === 4 && end === start + 4,
      `ok=${oks} count ${start}→${end}`,
    );
  }

  // ── MEDIA-D8: grant layer — anon cannot execute ─────────────────────
  {
    const anonClient = createClient(URL_, ANON, { auth: { persistSession: false } });
    const { error: anonErr } = await anonClient.rpc("resolve_question_image", {
      p_question_id: "00000000-0000-4000-8000-000000000000",
    });
    record("MEDIA-D8 anon blocked on resolve_question_image", anonErr != null, anonErr?.message ?? "");
    const { error: anonSaveErr } = await anonClient.rpc("save_student_quiz_questions", {
      p_quiz_id: "00000000-0000-4000-8000-000000000000",
      p_questions: [],
      p_mode: "replace",
    });
    record("MEDIA-D8 anon blocked on save_student_quiz_questions", anonSaveErr != null, anonSaveErr?.message ?? "");
  }

  // ── MEDIA-D9: quiz-sources widening ─────────────────────────────────
  {
    const ownPath = `${a.id}/${pSave.id}/notes-${stamp}.pdf`;
    const { error: ownErr } = await A.storage
      .from("quiz-sources")
      .upload(ownPath, Buffer.from("%PDF-1.4 test"), { contentType: "application/pdf", upsert: false });
    record("MEDIA-D9 student uploads own quiz folder", ownErr == null, ownErr?.message ?? "");
    if (!ownErr) await admin.storage.from("quiz-sources").remove([ownPath]);

    const foreignPath = `${b.id}/${pSave.id}/evil.pdf`;
    const { error: foreignErr } = await A.storage
      .from("quiz-sources")
      .upload(foreignPath, Buffer.from("%PDF-1.4 evil"), { contentType: "application/pdf", upsert: false });
    record("MEDIA-D9 cross-uid upload denied", foreignErr != null, foreignErr?.message ?? "");
  }

  // ── MEDIA-D10: views expose presence, never paths ───────────────────
  {
    const { error: pathSelErr } = await B
      .from("student_quiz_player_question_view")
      .select("image_path")
      .eq("quiz_id", pShared.id);
    record("MEDIA-D10 player view hides image_path column", pathSelErr != null, pathSelErr?.message ?? "");

    const { data: presRows, error: presErr } = await B
      .from("student_quiz_player_question_view")
      .select("id, has_image")
      .eq("quiz_id", pShared.id);
    record(
      "MEDIA-D10 player view exposes has_image",
      !presErr && (presRows ?? []).some((r) => r.has_image === true),
      presErr?.message ?? "",
    );

    const { error: assessPathErr } = await A
      .from("student_question_view")
      .select("image_path")
      .eq("quiz_id", live.quizId);
    record("MEDIA-D10 assessment view hides image_path", assessPathErr != null, assessPathErr?.message ?? "");
  }

  // ── MEDIA-D11: concurrent replace ⇒ consistent state, ≤1 orphan ─────
  {
    // Two clients race a replace on the SAME question; the final column must
    // point at an existing object and at most one loser object may orphan.
    const { data: pRace, error: pRaceErr } = await admin
      .from("student_quizzes")
      .insert({ created_by: a.id, title: `race-${stamp}` })
      .select("id")
      .single();
    if (pRaceErr) throw pRaceErr;
    createdPracticeIds.push(pRace.id);
    const { data: rq, error: rqErr } = await admin
      .from("student_quiz_questions")
      .insert({
        quiz_id: pRace.id,
        order_index: 0,
        type: "mcq",
        prompt: "race pick",
        options: ["x", "y"],
        correct_index: 0,
        image_path: `${a.id}/44444444-5555-6666-7777-888888888888.png`,
      })
      .select("id")
      .single();
    if (rqErr) throw rqErr;

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // Objects are seeded via SERVICE ROLE — clients cannot write to this
    // bucket by design (MEDIA-D1); the route's admin client is what writes.
    await Promise.all(
      Array.from({ length: 2 }, (_, i) =>
        admin.storage
          .from("question-images")
          .upload(`${a.id}/race-${i}-${stamp}.png`, png, { contentType: "image/png", upsert: false }),
      ),
    );
    // GENUINE concurrent replace: TWO authed clients (same owner, both RLS-
    // legal) race the column UPDATE — last-writer-wins must still leave the
    // column pointing at an EXISTING object.
    const A2 = await asUser(`media-a-${stamp}@verify.local`); // same account, second session
    const path0 = `${a.id}/race-0-${stamp}.png`;
    const path1 = `${a.id}/race-1-${stamp}.png`;
    await Promise.all([
      A.from("student_quiz_questions").update({ image_path: path0 }).eq("id", rq.id),
      A2.from("student_quiz_questions").update({ image_path: path1 }).eq("id", rq.id),
    ]);

    const { data: finalRow } = await admin
      .from("student_quiz_questions")
      .select("image_path")
      .eq("id", rq.id)
      .single();
    const finalPath = finalRow?.image_path;
    const { data: existsCheck } = await admin.storage.from("question-images").list(a.id);
    const names = new Set((existsCheck ?? []).map((e) => e.name));
    record(
      "MEDIA-D11 replace race leaves consistent column + ≤1 orphan",
      typeof finalPath === "string" && names.has(finalPath.split("/").pop()),
      JSON.stringify({ finalPath }),
    );

    // Cleanup the seeded race objects.
    await admin.storage.from("question-images").remove([
      `${a.id}/race-0-${stamp}.png`,
      `${a.id}/race-1-${stamp}.png`,
    ]);
  }

  // ── MEDIA-D12: signed-URL expiry is real (1 s TTL → dead after wait) ─
  {
    const seedPath = `expiry-${a.id}.png`;
    await admin.storage
      .from("question-images")
      .upload(seedPath, Buffer.from([0x89, 0x50]), { contentType: "image/png", upsert: true });
    const { data: signed } = await admin.storage
      .from("question-images")
      .createSignedUrl(seedPath, 1);
    if (!signed?.signedUrl) throw new Error("expiry probe could not mint URL");
    await new Promise((r) => setTimeout(r, 2000));
    let expired = false;
    try {
      const res = await fetch(signed.signedUrl);
      expired = !res.ok;
    } catch {
      expired = true;
    }
    record("MEDIA-D12 1-second-TTL URL dies after expiry", expired);
    await admin.storage.from("question-images").remove([seedPath]);
  }

  await cleanup();

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nverify-media: ${results.length - failed}/${results.length} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main()
  .catch(async (err) => {
    console.error("Harness crashed:", err);
  await cleanup();
    process.exit(1);
  });
