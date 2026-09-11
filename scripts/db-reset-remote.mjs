// Remote database reset — the hosted-project counterpart of `supabase db reset`.
//
// `supabase db reset` only works against the local seam (it replays migrations
// in Docker). The hosted project keeps its schema via `supabase db push`, so a
// remote "reset" means:
//   1. Delete every auth.users row — ON DELETE CASCADE through profiles wipes
//      classes, enrollments, quizzes, questions, sessions, answers, results,
//      notifications, student quizzes, face samples, advisories, clips, etc.
//   2. Empty all app storage buckets (quiz-sources, question-images, avatars,
//      incident-footage) — storage has no transactional coupling with Postgres,
//      so cascades never touch objects (see migration 0020 / media-cleanup).
//   3. Verify zero rows remain on the hot tables.
//
// Schema is NOT touched — migrations are managed by `supabase db push`.
//
// Usage:
//   node scripts/db-reset-remote.mjs --remote   # interactive confirm
//   ALLOW_PROD_SEED=1 node scripts/db-reset-remote.mjs --remote   # skip confirm (CI)
import { createClient } from "@supabase/supabase-js";
import { resolveEnv, confirmRemote } from "./lib/remote-env.mjs";

// This script exists to reset the hosted project — refuse to run without the
// explicit flag so a forgotten `--remote` can never wipe the local seam.
if (!process.argv.includes("--remote")) {
  console.error(
    "Refusing to run without --remote (this script targets the HOSTED project).\n" +
      "For the local seam use: npm run db:reset",
  );
  process.exit(1);
}
const { URL, SERVICE } = resolveEnv(process.argv);
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

const BUCKETS = ["quiz-sources", "question-images", "avatars", "incident-footage"];

async function emptyBucket(bucket) {
  const out = [];
  async function walk(prefix) {
    const { data, error } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
    if (error) throw new Error(`${bucket}: ${error.message}`);
    for (const entry of data ?? []) {
      const full = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) await walk(full);
      else out.push(full);
    }
  }
  await walk("");
  if (out.length === 0) {
    console.log(`  ✓ ${bucket}: already empty`);
    return 0;
  }
  // Storage API remove() takes ≤100 paths per call.
  for (let i = 0; i < out.length; i += 100) {
    const { error } = await admin.storage.from(bucket).remove(out.slice(i, i + 100));
    if (error) throw new Error(`${bucket}: ${error.message}`);
  }
  console.log(`  ✓ ${bucket}: removed ${out.length} object(s)`);
  return out.length;
}

async function main() {
  console.log(`🔄 [db:reset:remote] Target: ${URL}\n`);

  // 1. Storage first: incident clips etc. reference objects we're about to need
    //    gone even if the user cascade stalls partway.
  let objects = 0;
  for (const bucket of BUCKETS) objects += await emptyBucket(bucket);
  console.log(`  (${objects} storage object(s) cleared)\n`);

  // 2. Wipe auth users — cascades through every public.* table that references
  //    profiles. Rows not tied to a user (none expected) are swept below.
  const { data: users, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) throw listErr;
  console.log(`Deleting ${users.users.length} auth user(s)...`);
  for (const u of users.users) {
    const { error } = await admin.auth.admin.deleteUser(u.id);
    if (error) console.warn(`  ⚠️ could not delete user ${u.id}: ${error.message}`);
  }
  console.log("  ✓ auth.users wiped (cascades: profiles → classes/quizzes/sessions/results/…)");

  // 3. Sweep any orphans outside the user cascade (defensive; normally zero).
  for (const table of ["session_advisories", "incident_clips", "profile_face_samples", "face_checks"]) {
    const { error, count } = await admin
      .from(table)
      .delete(undefined, { count: "exact" })
      .neq("id", "00000000-0000-0000-0000-000000000000");
    console.log(error ? `  ⚠️ ${table}: ${error.message}` : `  ✓ ${table}: ${count ?? 0} row(s)`);
  }

  // 4. Verify.
  const checks = [
    ["profiles", "id"],
    ["classes", "id"],
    ["quizzes", "id"],
    ["quiz_sessions", "id"],
  ];
  let clean = true;
  for (const [table, col] of checks) {
    const { count, error } = await admin.from(table).select(col, { count: "exact", head: true });
    if (error) {
      console.warn(`  ⚠️ verify ${table}: ${error.message}`);
      continue;
    }
    if (count > 0) clean = false;
    console.log(`  ✓ verify ${table}: ${count} row(s)`);
  }

  console.log(
    clean
      ? "\n✨ Remote reset complete. Run `npm run seed:demo -- --remote` to reseed."
      : "\n⚠️ Reset finished with leftovers — check the warnings above.",
  );
}

await confirmRemote("WIPE all users, data, and storage objects");
main().catch((err) => {
  console.error("db-reset-remote failed:", err.message);
  process.exit(1);
});
