-- ═══════════════════════════════════════════════════════════════════════
-- 0070 — incident-clip retention: reconcile metadata rows to the storage
-- objects that actually exist (fixes the prod `NoSuchKey` signing errors).
--
-- Observed failure (prod 2026-09-29): the lecturer results dashboard logs
--   `Incident clip signing error: <id> ... Object not found / NoSuchKey`
-- because an `incident_clips` row exists whose private `incident-footage`
-- object is already gone, and the results page signs every listed row
-- unconditionally (lecturer/quizzes/[id]/results/page.tsx).
--
-- ROOT CAUSE — the SQL prune has been a no-op since the Storage
-- `protect_delete` guard shipped. Both prior revisions end in:
--     delete from storage.objects where bucket_id = 'incident-footage' ...
-- which now raises 42501 "Direct deletion from storage tables is not
-- allowed. Use the Storage API instead." (BEFORE DELETE ... FOR EACH
-- STATEMENT trigger `protect_objects_delete` on storage.objects). The
-- exception aborts the whole function BEFORE its row delete runs, so
-- `prune_expired_incident_clips()` (cron `innovision-incident-prune`,
-- 04:23 UTC, 0042) has failed silently every day. Objects are instead
-- removed through the Storage API — the upload route's orphan cleanup and
-- scripts/incident-cleanup.mjs — and those paths never touched the rows, so
-- every API-deleted clip left a permanently orphaned metadata row. (0021's
-- created_at-vs-recorded_to predicate split, discussed in git history, was
-- a latent second-order hazard; the guard made the function dead first.)
--
-- FIX — one owner per side, and the SQL side never writes storage:
--   • SQL owns METADATA. It deletes a row ONLY when its object is already
--     absent. That is exactly the shape that breaks signing, so the
--     invariant "no incident_clips row without its object" holds after every
--     pass. Setting `storage.allow_delete_query` to force the object delete
--     from SQL is deliberately NOT done: it defeats a platform safety guard
--     and the Storage API must stay the single writer of storage.objects.
--   • The Storage API owns OBJECTS. scripts/incident-cleanup.mjs already
--     removes an aged object and then its row via the API (a 404
--     "object already gone" is tolerated), so aged live pairs are reclaimed
--     there — no object is ever stranded with no metadata, because this
--     function refuses to drop an aged row while its object still exists.
--
-- Idempotent; safe to run on every cron tick. Signature, returns, and grants
-- are UNCHANGED (the return counters keep their original keys plus a
-- compatibility alias) — no PostgREST churn.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.prune_expired_incident_clips()
returns jsonb
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  v_orphan_rows   bigint;
  v_expired_rows  bigint;
begin
  -- 1. Orphan rows — the object is ALREADY gone. These are the exact rows the
  --    dashboard cannot sign (NoSuchKey). Deleted regardless of age: an
  --    unplayable listing is a bug, not retention, and the storage side is
  --    already settled so no object can be stranded by dropping the row.
  delete from public.incident_clips c
   where not exists (
     select 1
       from storage.objects o
      where o.bucket_id = 'incident-footage'
        and o.name = c.storage_path
   );
  get diagnostics v_orphan_rows = row_count;

  -- 2. Rows past retention whose object is ALSO gone. This arm is effectively
  --    a subset of (1) (an object gone at any age is caught above), but it is
  --    kept explicit so the function still expresses the age policy if the
  --    orphan sweep is ever narrowed. The predicate deliberately requires the
  --    object to be absent: an AGED LIVE PAIR is left for the Storage-API
  --    path (scripts/incident-cleanup.mjs) so its object is never orphaned.
  delete from public.incident_clips c
   where c.recorded_to < now() - interval '30 days'
     and not exists (
       select 1
         from storage.objects o
        where o.bucket_id = 'incident-footage'
          and o.name = c.storage_path
     );
  get diagnostics v_expired_rows = row_count;

  -- Legacy counter keys retained (health/dashboard probes read them); the
  -- storage count is always 0 now — SQL does not delete storage objects.
  return jsonb_build_object(
    'pruned_orphan_rows',     coalesce(v_orphan_rows, 0),
    'pruned_rows',            coalesce(v_expired_rows, 0),
    'pruned_storage_objects', 0
  );
end;
$$;

revoke all on function public.prune_expired_incident_clips() from public, anon;
grant execute on function public.prune_expired_incident_clips() to service_role;

-- Heal existing damage immediately: the daily job has been dead, so prod
-- likely carries orphan rows right now. Running the reconciler at migration
-- time clears them once (no-op on a clean DB / fresh local reset).
select public.prune_expired_incident_clips();
