// Demo walk-up reset — CLI twin of POST /api/demo/reset-walkup
// (docs/plans/PLAN_DEMO_MODE.md D6).
//
// WHY a direct service-role script instead of the plan's "5-line fetch": the
// route authenticates on an SSR session COOKIE (the demo lecturer's), which a
// bare node fetch cannot present without replaying @supabase/ssr's chunked
// cookie encoding. Rather than forge that, this script performs the SAME steps
// the route's `resetWalkup()` helper performs, against the service-role client.
//
// KEEP IN SYNC with src/lib/demo/walkup-reset.ts. The steps:
//   1. delete guest accounts older than N hours (FK cascade clears their
//      enrollments/sessions/answers);
//   2. find the demo class by join code (DEMO_JOIN_CODE = SCAN23);
//   3. strip non-guest enrollments from the demo class;
//   4. recreate a fresh walk-up practice quiz cloned from the newest WALK-UP
//      one (title prefix "Try InnoVision"), then delete the stale walk-up
//      ones; clear remaining guest sessions on curated gesture-off quizzes
//      (their rows + seeded history are kept).
//
// Run:  node scripts/demo-reset.mjs [--max-age-hours=2] [--skip-guest-purge]
//                                   [--remote]
//   --remote targets the hosted project (.env.production.local) — still requires
//   ALLOW_PROD_SEED=1 or an interactive confirm.
import { createClient } from "@supabase/supabase-js";
import { resolveEnv, confirmRemote } from "./lib/remote-env.mjs";

const REMOTE = process.argv.includes("--remote");
const { URL, SERVICE, isRemote } = resolveEnv(process.argv);
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
if (isRemote) await confirmRemote("RESET the walk-up demo (delete guests, recreate quiz)");

const DEMO_JOIN_CODE = "SCAN23"; // MUST equal src/lib/demo/gate.ts DEMO_JOIN_CODE
const DEMO_LECTURER_EMAIL = "demo-lecturer@innovision.test";
const GUEST_DOMAIN = "demo.innovision.test";
// MUST equal WALKUP_QUIZ_TITLE_PREFIX in src/lib/demo/walkup-reset.ts: only
// quizzes with this title prefix are recreated; curated gesture-off quizzes
// (fixed titles) keep their rows and only lose guest attempts.
const WALKUP_QUIZ_TITLE_PREFIX = "Try InnoVision";

const maxAgeArg = process.argv.find((a) => a.startsWith("--max-age-hours="));
const MAX_AGE_HOURS = maxAgeArg ? Number(maxAgeArg.split("=")[1]) : 2;
const SKIP_PURGE = process.argv.includes("--skip-guest-purge");

function log(msg) {
  console.log(msg);
}

async function listAllUsers() {
  const all = [];
  for (let page = 1; page <= 40; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ perPage: 500, page });
    if (error) throw error;
    const users = data?.users ?? [];
    all.push(...users);
    if (users.length < 500) break;
  }
  return all;
}

async function main() {
  log("\n== Demo walk-up reset ==\n");
  const summary = {
    guestsDeleted: 0,
    realEnrollmentsRemoved: 0,
    quizRecreated: false,
    newQuizId: null,
    staleQuizzesDeleted: 0,
    demoClassFound: false,
    quizRecreateFailedReason: undefined,
    curatedGuestSessionsCleared: 0,
    curatedQuizzesPreserved: 0,
  };

  let demoLecturerId = null;
  if (!SKIP_PURGE) {
    const cutoffMs = Date.now() - MAX_AGE_HOURS * 3600_000;
    const users = await listAllUsers();
    for (const u of users) {
      if (u.email === DEMO_LECTURER_EMAIL) demoLecturerId = u.id;
    }
    const toDelete = users.filter(
      (u) =>
        u.email?.endsWith(`@${GUEST_DOMAIN}`) &&
        (u.created_at ? Date.parse(u.created_at) : 0) <= cutoffMs,
    );
    for (const u of toDelete) {
      const { error } = await admin.auth.admin.deleteUser(u.id);
      if (!error) summary.guestsDeleted += 1;
    }
    log(`  - deleted ${summary.guestsDeleted} guest(s) older than ${MAX_AGE_HOURS}h`);
  }

  // Find demo lecturer + guest ids.
  const users = await listAllUsers();
  if (!demoLecturerId) demoLecturerId = users.find((u) => u.email === DEMO_LECTURER_EMAIL)?.id ?? null;
  const guestIds = new Set(
    users.filter((u) => u.email?.endsWith(`@${GUEST_DOMAIN}`)).map((u) => u.id),
  );

  const { data: demoClass } = await admin
    .from("classes")
    .select("id")
    .eq("join_code", DEMO_JOIN_CODE)
    .maybeSingle();
  if (!demoClass?.id) {
    log("  ! demo class not found (run `npm run seed:demo` first)");
    return summary;
  }
  summary.demoClassFound = true;

  // Strip non-guest enrollments.
  const { data: enrollments } = await admin
    .from("class_enrollments")
    .select("student_id")
    .eq("class_id", demoClass.id);
  const realIds = [...new Set((enrollments ?? []).map((e) => e.student_id))].filter(
    (id) => id && !guestIds.has(id),
  );
  if (realIds.length > 0) {
    const { error } = await admin
      .from("class_enrollments")
      .delete()
      .eq("class_id", demoClass.id)
      .in("student_id", realIds);
    if (!error) summary.realEnrollmentsRemoved = realIds.length;
  }
  log(`  - removed ${summary.realEnrollmentsRemoved} real enrollment(s)`);

  // Recreate the walk-up quiz (guarded ordering: never delete the source until
  // a replacement is verified live). Scoped to WALK-UP-titled quizzes so the
  // curated gesture-off quizzes are never collapsed into the clone; their
  // guest attempts are cleared instead (seeded history is kept).
  const { data: quizzes } = await admin
    .from("quizzes")
    .select("id, title, created_at")
    .eq("class_id", demoClass.id)
    .order("created_at", { ascending: false });
  const walkupQuizzes = (quizzes ?? []).filter((q) =>
    (q.title ?? "").startsWith(WALKUP_QUIZ_TITLE_PREFIX),
  );
  const curatedQuizzes = (quizzes ?? []).filter(
    (q) => !(q.title ?? "").startsWith(WALKUP_QUIZ_TITLE_PREFIX),
  );
  summary.curatedQuizzesPreserved = curatedQuizzes.length;
  const source = walkupQuizzes[0] ?? (quizzes ?? [])[0];

  if (curatedQuizzes.length > 0 && guestIds.size > 0) {
    const { count, error: clearError } = await admin
      .from("quiz_sessions")
      .delete({ count: "exact" })
      .in(
        "quiz_id",
        curatedQuizzes.map((q) => q.id),
      )
      .in("student_id", [...guestIds]);
    if (!clearError) summary.curatedGuestSessionsCleared = count ?? 0;
    log(`  - cleared ${summary.curatedGuestSessionsCleared} guest session(s) on ${curatedQuizzes.length} curated quiz(zes)`);
  }
  if (source && demoLecturerId) {
    const { data: questions, error: questionsError } = await admin
      .from("questions")
      .select("order_index, type, prompt, options, correct_index, correct_indices, answer_key, explanation, max_score")
      .eq("quiz_id", source.id)
      .order("order_index", { ascending: true });

    // A failed read or an empty source aborts: publishing a zero-question quiz
    // is impossible and would strand the source behind an empty replacement.
    if (questionsError || !questions || questions.length === 0) {
      summary.quizRecreateFailedReason = questionsError ? "questions_read_error" : "source_empty";
      log("  ! source quiz has no readable questions — source left untouched");
      return summary;
    }

    const title = `Try InnoVision Live Demo (${new Date().toISOString().slice(0, 16).replace("T", " ")})`;
    const { data: created, error: createError } = await admin
      .from("quizzes")
      .insert({
        class_id: demoClass.id,
        created_by: demoLecturerId,
        title,
        mode: "practice",
        time_limit_sec: null,
        gestures_enabled: false,
      })
      .select("id")
      .single();

    if (createError || !created?.id) {
      summary.quizRecreateFailedReason = "create_failed";
      log("  ! could not create the replacement quiz — source left untouched");
      return summary;
    }

    const { error: qErr } = await admin.from("questions").insert(
      questions.map((q) => ({ ...q, quiz_id: created.id })),
    );
    if (qErr) {
      await admin.from("quizzes").delete().eq("id", created.id);
      summary.quizRecreateFailedReason = "insert_failed";
      log("  ! replacement questions failed — source left untouched");
      return summary;
    }
    const { error: pubErr } = await admin
      .from("quizzes")
      .update({ status: "live" })
      .eq("id", created.id);
    if (pubErr) {
      await admin.from("quizzes").delete().eq("id", created.id);
      summary.quizRecreateFailedReason = "publish_failed";
      log("  ! replacement quiz could not be published — source left untouched");
      return summary;
    }

    // Verified live → prune the stale WALK-UP quizzes (curated ids excluded).
    const staleIds = walkupQuizzes.map((q) => q.id).filter((id) => id !== created.id);
    if (staleIds.length > 0) {
      const { count } = await admin.from("quizzes").delete({ count: "exact" }).in("id", staleIds);
      summary.staleQuizzesDeleted = count ?? 0;
    }
    summary.quizRecreated = true;
    summary.newQuizId = created.id;
    log(`  + recreated walk-up quiz (${created.id}); deleted ${summary.staleQuizzesDeleted} stale`);
  } else if (source && !demoLecturerId) {
    summary.quizRecreateFailedReason = "no_lecturer";
  }

  log("\n== Done ==\n");
  return summary;
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nRESET FAILED:", e?.message ?? e);
    process.exit(1);
  });
