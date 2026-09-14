import type { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Service-role storage sweep for the DELETE/replace paths.
 *
 * audit-3 H3-INFRA-F9: the historic call sites were `void admin.storage
 * .remove(...).catch(() => {})` — the rejection was neither awaited nor
 * logged, so a transient Storage 5xx orphaned the object permanently and
 * silently. This helper awaits the call and LOGS the failure instead.
 *
 * audit-3 C-F1/G-F3: every path handed in MUST already have passed an
 * owner-pinned, shape-anchored validator at the call site (the columns it is
 * read from are caller-writable at the DB layer). This helper deliberately
 * does not validate — validation is the caller's responsibility so that the
 * bucket-specific contract stays visible next to the collection site.
 *
 * Cleanup is best-effort: the DB row is already gone/updated, so a storage
 * failure must never turn a successful delete into an error response.
 */
export async function removeStorageObjects(
  admin: AdminClient,
  bucket: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  try {
    const { error } = await admin.storage.from(bucket).remove(paths);
    if (error) {
      console.error("storage cleanup failed", {
        bucket,
        count: paths.length,
        error: error.message,
      });
    }
  } catch (err) {
    console.error("storage cleanup threw", {
      bucket,
      count: paths.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * audit-3 G-F3 (amplifier): sweep every object under a server-constructed
 * folder prefix (used for `quiz-sources` uploads, which no cron covers).
 *
 * `list()` returns object names RELATIVE to the prefix, so the full path is
 * reassembled and re-validated with the caller's owner-pinned contract before
 * anything reaches the service-role `remove()`. Pagination is bounded (5
 * pages × 100) — a practice-quiz source folder holds a handful of uploads.
 */
export async function removeValidatedStoragePrefix(
  admin: AdminClient,
  bucket: string,
  prefix: string,
  validate: (path: string) => boolean,
): Promise<void> {
  const paths: string[] = [];
  const limit = 100;
  const maxPages = 5;
  for (let page = 0; page < maxPages; page += 1) {
    let rows: { name: string }[];
    try {
      const { data, error } = await admin.storage
        .from(bucket)
        .list(prefix, { limit, offset: page * limit });
      if (error) {
        console.error("storage prefix sweep failed", {
          bucket,
          prefix,
          error: error.message,
        });
        return;
      }
      rows = data ?? [];
    } catch (err) {
      console.error("storage prefix sweep threw", {
        bucket,
        prefix,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    for (const row of rows) {
      const full = `${prefix}/${row.name}`;
      if (validate(full)) paths.push(full);
      else console.error("storage prefix sweep: refusing malformed path", { bucket, path: full });
    }
    if (rows.length < limit) break;
  }
  await removeStorageObjects(admin, bucket, paths);
}
