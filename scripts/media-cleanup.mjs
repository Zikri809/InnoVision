// Media orphan sweep — removes storage objects no longer referenced by any
// row (question images + avatars). Committed deliverable of M0 (plan D10):
// Supabase storage has no transactional coupling with Postgres, so replace/
// delete flows intentionally leave best-effort orphans that this script sweeps.
// Cron expectation: run alongside incident-cleanup (see migration 0020 notes).
//
// audit-2 C-04 hardening (the old build was a data-loss footgun):
//   - the reference sets were fetched with UNCAPPED selects (PostgREST
//     defaults to 1 000 rows) — every referenced path past row 1 000 was
//     invisible, so its object looked "orphaned" and got DELETED. Both
//     reference fetches now paginate to completion;
//   - the storage listing truncated at 1 000 entries per folder (safe
//     direction, but silently skipped orphans) — now offset-paginated;
//   - remove() ran as one unbounded call — now batched;
//   - the sweep is FAIL-CLOSED: any fetch error aborts before the first
//     delete (it used to throw mid-run only, but the reference truncation
//     meant a "successful" run could still destroy live data);
//   - deletion requires an explicit --apply (M-20: the old default deleted
//     with no confirmation; --remote additionally demands confirmRemote(),
//     mirroring seed-demo).
//
// Usage:
//   node scripts/media-cleanup.mjs                     # dry-run (default)
//   node scripts/media-cleanup.mjs --dry-run           # same, explicit
//   node scripts/media-cleanup.mjs --apply             # delete the orphans
//   node scripts/media-cleanup.mjs --apply --remote    # hosted (confirm gate)
import { createClient } from "@supabase/supabase-js";
import { resolveEnv, confirmRemote } from "./lib/remote-env.mjs";

const { URL: URL_, SERVICE, isRemote } = resolveEnv(process.argv);

const dryRun = !process.argv.includes("--apply");
if (dryRun) {
  console.log("dry-run: no objects will be deleted (pass --apply to delete).");
} else if (isRemote && process.env.ALLOW_PROD_SEED !== "1") {
  // M-20: same interactive project-ref gate as the seed scripts.
  await confirmRemote("bulk-delete unreferenced storage objects");
}

const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });

const PAGE = 1000; // PostgREST max rows per request; storage list cap too.

/**
 * Paginated storage walk. `list()` returns at most `limit` entries per call
 * and gives NO truncation signal, so a single 1 000-row call silently missed
 * everything past the cap (C-04, safe direction — but the sweep then never
 * saw those orphans either).
 */
async function listAll(bucket) {
  const out = [];
  async function walk(prefix) {
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await admin.storage
        .from(bucket)
        .list(prefix, { limit: PAGE, offset });
      if (error) throw error;
      const entries = data ?? [];
      for (const entry of entries) {
        const full = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.id === null) {
          // Folder marker — recurse (folders are returned in the SAME page
          // window as files; recursing regardless keeps the walk complete).
          await walk(full);
        } else {
          out.push(full);
        }
      }
      if (entries.length < PAGE) break;
    }
  }
  await walk("");
  return out;
}

/**
 * Paginated fetch of a reference column. THE critical fix: the old
 * uncapped select stopped at PostgREST's default 1 000 rows, so referenced
 * paths beyond that were missing from the kept-set and their objects were
 * treated as orphans and deleted (C-04, the data-loss direction).
 * Returns null only when a page errors — callers abort the sweep.
 */
async function fetchReferencedSet(table, column) {
  const out = new Set();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from(table)
      .select(column)
      .not(column, "is", null)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    for (const row of rows) out.add(row[column]);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function removeInBatches(bucket, paths) {
  let removed = 0;
  for (let i = 0; i < paths.length; i += 100) {
    const batch = paths.slice(i, i + 100);
    const { error } = await admin.storage.from(bucket).remove(batch);
    if (error) throw error;
    removed += batch.length;
  }
  return removed;
}

async function main() {
  let removed = 0;

  // ── question-images: referenced by questions.image_path OR student_quiz_questions.image_path
  const referenced = new Set();
  for (const [table, column] of [
    ["questions", "image_path"],
    ["student_quiz_questions", "image_path"],
  ]) {
    for (const p of await fetchReferencedSet(table, column)) referenced.add(p);
  }

  const qObjects = await listAll("question-images");
  const qOrphans = qObjects.filter((p) => !referenced.has(p));
  console.log(`question-images: ${qObjects.length} objects, ${qOrphans.length} unreferenced`);
  if (!dryRun && qOrphans.length > 0) {
    removed += await removeInBatches("question-images", qOrphans);
  }

  // ── avatars: referenced by profiles.avatar_path
  const avatarRefs = await fetchReferencedSet("profiles", "avatar_path");
  const aObjects = await listAll("avatars");
  const aOrphans = aObjects.filter((p) => !avatarRefs.has(p));
  console.log(`avatars: ${aObjects.length} objects, ${aOrphans.length} unreferenced`);
  if (!dryRun && aOrphans.length > 0) {
    removed += await removeInBatches("avatars", aOrphans);
  }

  console.log(dryRun ? `dry-run complete (${removed} would be removed)` : `removed ${removed} orphan(s)`);
}

main().catch((err) => {
  // Fail-closed: a partially-completed reference fetch or listing must never
  // be followed by deletes from the caller's shell (`&&` chains) — exit non-
  // zero and let the cron alert on it.
  console.error("media-cleanup failed:", err);
  process.exit(1);
});
