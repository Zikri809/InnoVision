// InsightFace end-to-end SCENARIO harness — real faces, real sidecar, real
// Supabase RPCs. Complements verify-face.mjs (which pins RPC semantics with
// synthetic seed vectors) by exercising the FULL biometric path a real
// assessment exercises:
//
//   enroll (sidecar /extract x3 angles → enroll_face p_samples) →
//   verify (sidecar → compare_face_baseline → record_face_check majority vote)
//
// Scenarios (assessment-time, the ones that must behave every time):
//   S1  genuine student enrolls via the real enroll RPC (pose-gated)
//   S2  genuine verify at assessment start → matched (multi-frame majority)
//   S3  genuine verify under capture variation (dim / blur / small / shifted)
//   S4  imposter (different student's face) → NOT matched → paused
//   S5  two faces in frame (passer-by) → the genuine face must WIN (never
//       contaminated upward by the second face)
//   S6  no face in frame (blank wall) → 0-vote fail → paused
//   S7  duplicate enrollment: student B enrolls student A's FACE →
//       pending_review (internal dup check) → B blocked from verify
//   S8  fail-streak → flagged at 3 fails in the last-5 window; lecturer
//       unlock → re-verify passes
//   S9  imposter threshold MARGIN: impostor max-cosine must sit clearly below
//       FACE_SIMILARITY_MIN and genuine min clearly above (calibration report)
//
// Faces are AI-GENERATED (thispersondoesnotexist.com dataset — no real
// person depicted). Regenerate/extend with any face images; each "student"
// needs one representative webcam-style JPEG (640x480-ish, face ~60% height).
//
// Prereqs: `supabase start`, migration 0039 applied, sidecar up
// (`npm run face:start`), .env.local with Supabase keys.
// Run: node scripts/face-scenarios.mjs   (or `npm run face:scenarios`)
//
// NOT a unit test; run manually. Cleanup deletes everything it created.
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

assertLocalTarget(URL, "face-scenarios.mjs");

const SIDECAR = (env.INSIGHTFACE_BASE_URL || "http://localhost:8000").replace(/\/$/, "");
const SIDECAR_TOKEN = env.FACE_SIDECAR_TOKEN || "";
const FACE_SIMILARITY_MIN = 0.5; // mirror of the SQL constant (0021)
const FIXTURES = path.resolve(__dirname, "../e2e/fixtures/faces/scenarios");

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

function assertNoError(step, { error }) {
  if (error) throw new Error(`${step}: ${error.message}`);
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
  const { error } = await admin.from("profiles").update({ role: "lecturer" }).eq("id", userId);
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

// ── Sidecar + biometric math ────────────────────────────────────────────
function cos(u, v) {
  let d = 0;
  for (let i = 0; i < u.length; i++) d += u[i] * v[i];
  return d;
}

async function extractFaces(jpegPath) {
  const b64 = fs.readFileSync(jpegPath).toString("base64");
  const headers = { "content-type": "application/json" };
  if (SIDECAR_TOKEN) headers["x-sidecar-token"] = SIDECAR_TOKEN;
  const res = await fetch(`${SIDECAR}/extract`, {
    method: "POST",
    headers,
    body: JSON.stringify({ frame: `data:image/jpeg;base64,${b64}` }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`sidecar /extract ${jpegPath} → HTTP ${res.status}`);
  return (await res.json()).faces ?? [];
}

/**
 * Mirror of the route's primary-face selection (src/lib/face/embedding.ts):
 * det_score ≥ 0.6 → largest bbox → nearest frame center → index.
 * Returns null when no face clears the floor (a 0-vote).
 */
function selectPrimaryFace(faces, frameWidth = 640, frameHeight = 480) {
  const DETECTION_SCORE_MIN = 0.6;
  let best = null;
  let bestArea = -1;
  let bestCenterDist = Infinity;
  let bestIndex = -1;
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    if (f.det_score < DETECTION_SCORE_MIN) continue;
    const [x1, y1, x2, y2] = f.bbox;
    const area = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const centerDist = (cx - frameWidth / 2) ** 2 + (cy - frameHeight / 2) ** 2;
    if (
      area > bestArea ||
      (area === bestArea &&
        (centerDist < bestCenterDist ||
          (centerDist === bestCenterDist && bestIndex !== -1 && i < bestIndex)))
    ) {
      best = f;
      bestArea = area;
      bestCenterDist = centerDist;
      bestIndex = i;
    }
  }
  return best;
}

/** Route-shaped enroll: 3 extracts → primary selection → pose gate → samples. */
async function routeEnrollSamples(paths) {
  const samples = [];
  const perFrame = [];
  for (let i = 0; i < paths.length; i++) {
    const faces = await extractFaces(paths[i]);
    const primary = selectPrimaryFace(faces);
    if (!primary) {
      perFrame.push({ path: paths[i], ok: false, reason: "no face above det floor 0.6" });
      continue;
    }
    perFrame.push({
      path: paths[i],
      ok: true,
      det: +primary.det_score.toFixed(3),
      yaw: +primary.yaw.toFixed(1),
    });
    samples.push({ angle: ["front", "left", "right"][i], embedding: primary.embedding });
  }
  return { samples, perFrame };
}

/** Route-shaped verify vote for ONE frame: primary face → max self cosine. */
async function routeFrameVote(jpegPath, baselineClient) {
  const faces = await extractFaces(jpegPath);
  const primary = selectPrimaryFace(faces);
  if (!primary) return { vote: 0, det: 0, selected: "none-below-floor" };
  const { data, error } = await baselineClient.rpc("compare_face_baseline", {
    p_embedding: primary.embedding,
  });
  if (error) throw new Error(`compare_face_baseline: ${error.message}`);
  const sim = data?.present ? Math.min(1, Math.max(0, data.similarity)) : 0;
  return {
    vote: sim,
    det: +primary.det_score.toFixed(3),
    yaw: +primary.yaw.toFixed(1),
    selected: faces.length > 1 ? "primary-of-" + faces.length : "only",
  };
}

/** 3-frame majority verdict like the verify route + record_face_check. */
function majority(votes) {
  const hits = votes.filter((v) => v >= FACE_SIMILARITY_MIN).length;
  return hits * 2 > votes.length;
}

async function main() {
  // ── Provision: lecturer, students A (genuine), B (imposter/dup), C (spare)
  const lecturerL = await createUser(`scenL-${stamp}@innovision.test`);
  const studentA = await createUser(`scenA-${stamp}@innovision.test`);
  const studentB = await createUser(`scenB-${stamp}@innovision.test`);
  await promoteLecturer(lecturerL.id);
  await setConsent(studentA.id);
  await setConsent(studentB.id);

  const clientL = await asUser(`scenL-${stamp}@innovision.test`);
  const clientA = await asUser(`scenA-${stamp}@innovision.test`);
  const clientB = await asUser(`scenB-${stamp}@innovision.test`);

  const joinCode = makeJoinCode();
  const { data: cls, error: createErr } = await clientL
    .from("classes")
    .insert({ title: "Scenario Face Class", lecturer_id: lecturerL.id, join_code: joinCode })
    .select("id")
    .single();
  assertNoError("create class", { error: createErr });
  createdClassIds.push(cls.id);
  assertNoError("A join", await clientA.rpc("join_class", { code: joinCode }));
  assertNoError("B join", await clientB.rpc("join_class", { code: joinCode }));

  async function makeLiveAssessment(title, studentClient) {
    const { data: quiz, error } = await clientL
      .from("quizzes")
      .insert({
        class_id: cls.id,
        created_by: lecturerL.id,
        title,
        status: "draft",
        mode: "assessment",
      })
      .select("id")
      .single();
    assertNoError("create quiz", { error });
    createdQuizIds.push(quiz.id);
    const { error: q1 } = await clientL
      .from("questions")
      .insert({ quiz_id: quiz.id, order_index: 0, type: "mcq", prompt: "Q0", options: ["a", "b"], correct_index: 0 })
      .select("id")
      .single();
    assertNoError("insert question", { error: q1 });
    const { error: pubErr } = await clientL.from("quizzes").update({ status: "live" }).eq("id", quiz.id);
    assertNoError("publish quiz", { error: pubErr });
    const start = await studentClient.rpc("start_quiz_session", { p_quiz_id: quiz.id });
    assertNoError("start session", start);
    return start.data.session.id;
  }

  async function currentNonce(client, sessionId) {
    const { data } = await client
      .from("quiz_sessions")
      .select("verify_nonce")
      .eq("id", sessionId)
      .single();
    return data.verify_nonce;
  }

  async function faceCheckRow(client, sessionId) {
    // matched/distance come from the face_checks row; face_fail_streak lives
    // on quiz_sessions (0010) — two reads, both RLS-visible to the owner.
    const { data: check } = await client
      .from("face_checks")
      .select("matched, distance")
      .eq("session_id", sessionId)
      .order("checked_at", { ascending: false })
      .limit(1);
    const { data: session } = await client
      .from("quiz_sessions")
      .select("face_fail_streak, status")
      .eq("id", sessionId)
      .single();
    return { ...(check?.[0] ?? null), face_fail_streak: session?.face_fail_streak, status: session?.status };
  }

  // ── S1: genuine enrollment through the REAL pipeline shape ────────────
  // Three webcam-style frames of student A stand in for the three capture
  // angles (front/left/right); pose gates are route-side and the fixtures
  // are near-frontal, so the enroll path exercised here is extract →
  // primary selection → enroll_face(p_samples).
  const enrollFrames = [
    path.join(FIXTURES, "student-a.jpg"),
    path.join(FIXTURES, "student-a-dim.jpg"), // stands in for the left angle
    path.join(FIXTURES, "student-a-blur.jpg"), // stands in for the right angle
  ];
  const { samples, perFrame } = await routeEnrollSamples(enrollFrames);
  const enrollable = samples.length === 3;
  record(
    "S1a enrollment frames clear the det/pose pipeline (3/3 faces selected)",
    enrollable,
    JSON.stringify(perFrame),
  );
  if (!enrollable) {
    console.error(
      "\nEnrollment fixtures fell below DETECTION_SCORE_MIN=0.6 — this is the calibration gap flagged in PLAN_INSIGHTFACE_MIGRATION §6. Regenerate fixtures with tighter webcam framing or recalibrate the floor.",
    );
    return 1;
  }

  const enrollRes = await clientA.rpc("enroll_face", { p_samples: samples });
  record(
    "S1b enroll_face(p_samples) with REAL embeddings → enrolled",
    enrollRes.data?.ok === true && enrollRes.data?.status === "enrolled",
    JSON.stringify(enrollRes.data),
  );

  // ── S2: assessment start verify (genuine) ─────────────────────────────
  {
    const sessionId = await makeLiveAssessment("S2 Genuine Start", clientA);
    const nonce = await currentNonce(clientA, sessionId);
    const votes = [];
    for (const f of ["student-a.jpg", "student-a-small.jpg", "student-a-shift.jpg"]) {
      votes.push(await routeFrameVote(path.join(FIXTURES, f), clientA));
    }
    const sims = votes.map((v) => v.vote);
    const matched = majority(sims);
    record(
      "S2 genuine verify → matched (majority of 3 ≥ 0.5)",
      matched === true,
      `sims=[${sims.map((s) => s.toFixed(3)).join(", ")}]`,
    );

    const rec = await clientA.rpc("record_face_check", {
      p_session_id: sessionId,
      p_subject: studentA.id,
      p_similarities: sims,
      p_trigger: "start",
      p_nonce: nonce,
      p_frames: ["scen-a1", "scen-a2", "scen-a3"],
    });
    const row = await faceCheckRow(clientA, sessionId);
    record(
      "S2b record_face_check row lands matched=true, session stays active",
      rec.data?.matched === true && rec.data?.sessionStatus === "active" && row?.matched === true,
      `rpc=${JSON.stringify(rec.data)} row=${JSON.stringify(row)}`,
    );
  }

  // ── S3: capture variation still verifies (single-frame margins) ───────
  {
    const sessionId = await makeLiveAssessment("S3 Variation", clientA);
    for (const f of ["student-a-dim.jpg", "student-a-blur.jpg", "student-a-small.jpg", "student-a-shift.jpg"]) {
      const v = await routeFrameVote(path.join(FIXTURES, f), clientA);
      record(
        `S3 genuine under ${f.replace("student-a-", "").replace(".jpg", "")} → vote ≥ 0.5`,
        v.vote >= FACE_SIMILARITY_MIN,
        `sim=${v.vote.toFixed(3)} det=${v.det} ${v.selected}`,
      );
    }
    void sessionId;
  }

  // ── S4: imposter at assessment start → not matched → paused ───────────
  {
    const sessionId = await makeLiveAssessment("S4 Imposter", clientA);
    const nonce = await currentNonce(clientA, sessionId);
    const v = await routeFrameVote(path.join(FIXTURES, "student-b.jpg"), clientA);
    const rec = await clientA.rpc("record_face_check", {
      p_session_id: sessionId,
      p_subject: studentA.id,
      p_similarities: [v.vote, v.vote, v.vote],
      p_trigger: "start",
      p_nonce: nonce,
      p_frames: ["scen-imp1", "scen-imp2", "scen-imp3"],
    });
    const row = await faceCheckRow(clientA, sessionId);
    record(
      "S4 imposter face fails the check (sim < 0.5) → paused + streak 1",
      v.vote < FACE_SIMILARITY_MIN &&
        rec.data?.matched === false &&
        rec.data?.sessionStatus === "paused" &&
        row?.face_fail_streak === 1,
      `sim=${v.vote.toFixed(3)} rpc=${JSON.stringify(rec.data)} row=${JSON.stringify(row)}`,
    );

    // Verify-while-paused is refused (session_not_active) — a paused student
    // cannot keep verifying; recovery is the only path back.
    const nonce2 = await currentNonce(clientA, sessionId);
    const rec2 = await clientA.rpc("record_face_check", {
      p_session_id: sessionId,
      p_subject: studentA.id,
      p_similarities: [0.9, 0.9, 0.9],
      p_trigger: "periodic",
      p_nonce: nonce2,
      p_frames: ["scen-x1", "scen-x2", "scen-x3"],
    });
    record(
      "S4b verify on paused session → session_not_active (no blind retry)",
      rec2.data?.error === "session_not_active",
      JSON.stringify(rec2.data),
    );

    // Genuine recovers: self_recover (blink stand-in) → re-verify → active.
    const recover = await clientA.rpc("self_recover_session", { p_session_id: sessionId });
    const nonce3 = await currentNonce(clientA, sessionId);
    const vG = await routeFrameVote(path.join(FIXTURES, "student-a.jpg"), clientA);
    const rec3 = await clientA.rpc("record_face_check", {
      p_session_id: sessionId,
      p_subject: studentA.id,
      p_similarities: [vG.vote, vG.vote, vG.vote],
      p_trigger: "start",
      p_nonce: nonce3,
      p_frames: ["scen-r1", "scen-r2", "scen-r3"],
    });
    record(
      "S4c genuine recovery after imposter pause → active again",
      recover.data?.sessionStatus === "active" &&
        vG.vote >= FACE_SIMILARITY_MIN &&
        rec3.data?.sessionStatus === "active",
      `recover=${JSON.stringify(recover.data)} sim=${vG.vote.toFixed(3)} recheck=${JSON.stringify(rec3.data)}`,
    );
  }

  // ── S5: two faces in frame → genuine face must win ────────────────────
  {
    const sessionId = await makeLiveAssessment("S5 Two Faces", clientA);
    const votes = [];
    for (const f of ["two-faces.jpg", "two-faces.jpg", "two-faces.jpg"]) {
      votes.push(await routeFrameVote(path.join(FIXTURES, f), clientA));
    }
    const sims = votes.map((v) => v.vote);
    const det = votes[0].det;
    record(
      "S5 second person in frame does NOT contaminate the verdict (selects A, matched)",
      majority(sims) === true,
      `sims=[${sims.map((s) => s.toFixed(3)).join(", ")}] det_primary=${det} (${votes[0].selected})`,
    );

    // And the inverse: B verifying the SAME two-face frame must select B (the
    // large face is A — B is the small passer-by, which never wins selection;
    // assert B's own-baseline compare against the PRIMARY (A's) face fails).
    const vB = await routeFrameVote(path.join(FIXTURES, "two-faces.jpg"), clientB);
    record(
      "S5b imposter-B on the two-face frame → votes on the SELECTED primary, fails",
      vB.vote < FACE_SIMILARITY_MIN,
      `sim=${vB.vote.toFixed(3)} ${vB.selected}`,
    );
    void sessionId;
  }

  // ── S6: no face → 0-vote → paused ──────────────────────────────────────
  {
    const sessionId = await makeLiveAssessment("S6 No Face", clientA);
    const nonce = await currentNonce(clientA, sessionId);
    const faces = await extractFaces(path.join(FIXTURES, "blank-wall.jpg"));
    const primary = selectPrimaryFace(faces);
    const sim = primary ? null : 0; // route maps no-face → 0 vote
    const rec = await clientA.rpc("record_face_check", {
      p_session_id: sessionId,
      p_subject: studentA.id,
      p_similarities: [sim, sim, sim],
      p_trigger: "periodic",
      p_nonce: nonce,
      p_frames: ["scen-blank1", "scen-blank2", "scen-blank3"],
    });
    const row = await faceCheckRow(clientA, sessionId);
    record(
      "S6 blank wall → 0-vote fail → paused (never skipped silently)",
      primary === null && rec.data?.matched === false && rec.data?.sessionStatus === "paused",
      `faces=${faces.length} rpc=${JSON.stringify(rec.data)} row=${JSON.stringify(row)}`,
    );
  }

  // ── S7: duplicate enrollment (B enrolls A's face) → pending_review ─────
  {
    // B uses A's three frames as their own enrollment — the internal dup
    // check must catch it (max cosine vs OTHER students ≥ 0.45).
    const dup = await routeEnrollSamples(enrollFrames);
    const dupRes = await clientB.rpc("enroll_face", { p_samples: dup.samples });
    const duped = dupRes.data?.status === "pending_review";
    record(
      "S7 enrolling someone else's face → pending_review (internal dup check)",
      duped === true,
      `dup_similarity=${dupRes.data?.status ? "n/a" : "?"} status=${dupRes.data?.status ?? JSON.stringify(dupRes.data)}`,
    );

    // A pending_review student is not verifiable: verify-route guard maps an
    // unusable enrollment to not_enrolled. Mirror at RPC level: the profile
    // status blocks quiz gates; here pin the profile status + audit trail.
    const { data: bProfile } = await admin
      .from("profiles")
      .select("face_enrollment_status")
      .eq("id", studentB.id)
      .single();
    const { data: dupAudit } = await admin
      .from("audit_events")
      .select("metadata")
      .eq("actor_id", studentB.id)
      .eq("action", "face_enroll")
      .order("created_at", { ascending: false })
      .limit(1);
    record(
      "S7b pending_review persisted + audit carries the duplicate similarity",
      bProfile?.face_enrollment_status === "pending_review" &&
        typeof dupAudit?.[0]?.metadata?.duplicate_similarity === "number",
      `status=${bProfile?.face_enrollment_status} audit=${JSON.stringify(dupAudit?.[0]?.metadata)}`,
    );

    // Lecturer rejects → B can re-enroll with their OWN face.
    const reject = await clientL.rpc("reject_face_enrollment", { p_student_id: studentB.id });
    const { data: bProfile2 } = await admin
      .from("profiles")
      .select("face_enrollment_status")
      .eq("id", studentB.id)
      .single();
    const dupOwn = await routeEnrollSamples([
      path.join(FIXTURES, "student-b.jpg"),
      path.join(FIXTURES, "student-b.jpg"),
      path.join(FIXTURES, "student-b.jpg"),
    ]);
    const reEnroll = dupOwn.samples.length === 3 ? await clientB.rpc("enroll_face", { p_samples: dupOwn.samples }) : { data: { error: "no-face" } };
    record(
      "S7c lecturer reject → status cleared → B re-enrolls own face → enrolled",
      reject.data?.ok === true &&
        bProfile2?.face_enrollment_status === null &&
        reEnroll.data?.status === "enrolled",
      `reject=${JSON.stringify(reject.data)} reEnroll=${JSON.stringify(reEnroll.data)}`,
    );

    // B's OWN baseline now verifies as genuinely B (on their own session).
    const sessionIdB = await makeLiveAssessment("S7d B Genuine", clientB);
    const nonceB = await currentNonce(clientB, sessionIdB);
    const vB = await routeFrameVote(path.join(FIXTURES, "student-b.jpg"), clientB);
    const recB = await clientB.rpc("record_face_check", {
      p_session_id: sessionIdB,
      p_subject: studentB.id,
      p_similarities: [vB.vote, vB.vote, vB.vote],
      p_trigger: "start",
      p_nonce: nonceB,
      p_frames: ["scen-b1", "scen-b2", "scen-b3"],
    });
    record(
      "S7d B's own face passes on B's baseline → matched, active",
      vB.vote >= FACE_SIMILARITY_MIN && recB.data?.matched === true && recB.data?.sessionStatus === "active",
      `sim=${vB.vote.toFixed(3)} rpc=${JSON.stringify(recB.data)}`,
    );
  }

  // ── S8: fail streak → flagged → lecturer unlock → genuine passes ──────
  {
    const sessionId = await makeLiveAssessment("S8 Streak", clientA);
    // 3 fails in the flat last-5 window → flagged. A failing check PAUSES the
    // session (verify-while-paused is refused), so each fail must be followed
    // by self_recover — the client's blink-recovery stand-in — exactly the
    // flow the real pipeline runs between checks.
    const failOnce = async (i) => {
      const nonce = await currentNonce(clientA, sessionId);
      const res = await clientA.rpc("record_face_check", {
        p_session_id: sessionId,
        p_subject: studentA.id,
        p_similarities: [0, 0, 0],
        p_trigger: "periodic",
        p_nonce: nonce,
        p_frames: [`scen-fail${i}a`, `scen-fail${i}b`, `scen-fail${i}c`],
      });
      return res.data;
    };
    for (let i = 0; i < 3; i++) {
      await failOnce(i); // → paused (streak i+1)
      if (i < 2) {
        const rec = await clientA.rpc("self_recover_session", { p_session_id: sessionId });
        if (rec.data?.sessionStatus !== "active") {
          record(`S8 recover before fail ${i + 2} → active`, false, JSON.stringify(rec.data));
          break;
        }
      }
    }
    const row = await faceCheckRow(clientA, sessionId);
    record(
      "S8 three fails (recovered between) → session flagged at streak 3",
      row?.status === "flagged" && row?.face_fail_streak === 3,
      `status=${row?.status} streak=${row?.face_fail_streak}`,
    );

    const unlock = await clientL.rpc("unlock_session", { p_session_id: sessionId });
    const vG = await routeFrameVote(path.join(FIXTURES, "student-a.jpg"), clientA);
    const nonce = await currentNonce(clientA, sessionId);
    const rec = await clientA.rpc("record_face_check", {
      p_session_id: sessionId,
      p_subject: studentA.id,
      p_similarities: [vG.vote, vG.vote, vG.vote],
      p_trigger: "start",
      p_nonce: nonce,
      p_frames: ["scen-u1", "scen-u2", "scen-u3"],
    });
    record(
      "S8b lecturer unlock → genuine re-verify → active (exam continues)",
      unlock.data?.sessionStatus === "active" &&
        vG.vote >= FACE_SIMILARITY_MIN &&
        rec.data?.sessionStatus === "active",
      `unlock=${JSON.stringify(unlock.data)} sim=${vG.vote.toFixed(3)} recheck=${JSON.stringify(rec.data)}`,
    );
  }

  // ── S9: calibration margins (report, not a hard gate) ─────────────────
  {
    console.log("\n── S9 calibration margins (genuine min vs impostor max) ──");
    const genuine = [];
    for (const f of ["student-a.jpg", "student-a-dim.jpg", "student-a-blur.jpg", "student-a-small.jpg", "student-a-shift.jpg"]) {
      const v = await routeFrameVote(path.join(FIXTURES, f), clientA);
      genuine.push({ f, sim: v.vote });
    }
    const impostors = [];
    // B's baseline vs A's frames, A's baseline vs B's frame.
    for (const f of ["student-a.jpg", "student-a-dim.jpg"]) {
      const v = await routeFrameVote(path.join(FIXTURES, f), clientB);
      impostors.push({ f: `${f} (vs B)`, sim: v.vote });
    }
    {
      const v = await routeFrameVote(path.join(FIXTURES, "student-b.jpg"), clientA);
      impostors.push({ f: "student-b.jpg (vs A)", sim: v.vote });
    }
    const gMin = Math.min(...genuine.map((g) => g.sim));
    const iMax = Math.max(...impostors.map((i) => i.sim));
    for (const g of genuine) console.log(`  genuine  ${g.f.padEnd(24)} ${g.sim.toFixed(4)}`);
    for (const i of impostors) console.log(`  impostor ${i.f.padEnd(24)} ${i.sim.toFixed(4)}`);
    const marginOk = gMin >= FACE_SIMILARITY_MIN && iMax < FACE_SIMILARITY_MIN;
    record(
      "S9 thresholds separate genuine from impostor on real-model fixtures",
      marginOk,
      `genuine_min=${gMin.toFixed(3)} impostor_max=${iMax.toFixed(3)} gate=${FACE_SIMILARITY_MIN} separation=${(gMin - iMax).toFixed(3)}`,
    );
  }

  console.log("\n" + "=".repeat(60));
  const passed = results.filter((r) => r.pass).length;
  console.log(`${passed}/${results.length} scenario checks passed`);
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
