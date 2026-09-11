// Media orphan sweep — removes storage objects no longer referenced by any
// row (question images + avatars). Committed deliverable of M0 (plan D10):
// Supabase storage has no transactional coupling with Postgres, so replace/
// delete flows intentionally leave best-effort orphans that this script sweeps.
// Cron expectation: run alongside incident-cleanup (see migration 0020 notes).
//
// Usage:
//   node scripts/media-cleanup.mjs --dry-run   # list unreferenced objects
//   node scripts/media-cleanup.mjs             # delete them
//   node scripts/media-cleanup.mjs --remote    # target hosted (.env.production.local)
import { createClient } from "@supabase/supabase-js";
import { resolveEnv } from "./lib/remote-env.mjs";

const { URL: URL_, SERVICE } = resolveEnv(process.argv);

const dryRun = process.argv.includes("--dry-run");
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });

async function listAll(bucket) {
  const out = [];
  async function walk(prefix) {
    const { data, error } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
    if (error) throw error;
    for (const entry of data ?? []) {
      const full = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) {
        // Folder marker — recurse.
        await walk(full);
      } else {
        out.push(full);
      }
    }
  }
  await walk("");
  return out;
}

async function main() {
  let removed = 0;

  // ── question-images: referenced by questions.image_path OR student_quiz_questions.image_path
  const referenced = new Set();
  for (const [table, column] of [
    ["questions", "image_path"],
    ["student_quiz_questions", "image_path"],
  ]) {
    const { data, error } = await admin.from(table).select(column).not(column, "is", null);
    if (error) throw error;
    for (const row of data ?? []) referenced.add(row[column]);
  }

  const qObjects = await listAll("question-images");
  const qOrphans = qObjects.filter((p) => !referenced.has(p));
  console.log(`question-images: ${qObjects.length} objects, ${qOrphans.length} unreferenced`);
  if (!dryRun && qOrphans.length > 0) {
    const { error } = await admin.storage.from("question-images").remove(qOrphans);
    if (error) throw error;
    removed += qOrphans.length;
  }

  // ── avatars: referenced by profiles.avatar_path
  const avatarRefs = new Set();
  {
    const { data, error } = await admin.from("profiles").select("avatar_path").not("avatar_path", "is", null);
    if (error) throw error;
    for (const row of data ?? []) avatarRefs.add(row.avatar_path);
  }
  const aObjects = await listAll("avatars");
  const aOrphans = aObjects.filter((p) => !avatarRefs.has(p));
  console.log(`avatars: ${aObjects.length} objects, ${aOrphans.length} unreferenced`);
  if (!dryRun && aOrphans.length > 0) {
    const { error } = await admin.storage.from("avatars").remove(aOrphans);
    if (error) throw error;
    removed += aOrphans.length;
  }

  console.log(dryRun ? `dry-run complete (${removed} would be removed)` : `removed ${removed} orphan(s)`);
}

main().catch((err) => {
  console.error("media-cleanup failed:", err);
  process.exit(1);
});
