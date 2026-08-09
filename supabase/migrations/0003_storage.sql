-- InnoVision — Phase 2: private quiz-sources storage bucket + RLS
-- Depends on: storage schema (provided by Supabase), 0001/0002.

-- ─── Bucket (idempotent) ─────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('quiz-sources', 'quiz-sources', false)
on conflict (id) do nothing;

-- ─── Grants ──────────────────────────────────────────────────────
-- Authenticated users need explicit grants inside the storage schema or the
-- object-level policies below have no effect (PostgREST/RLS gates on grants).
grant select on storage.buckets to authenticated;
grant select, insert, update, delete on storage.objects to authenticated;
grant select, insert, update, delete on storage.buckets to service_role;
grant select, insert, update, delete on storage.objects to service_role;

-- ─── Policies (idempotent) ───────────────────────────────────────
-- Files are stored under "<lecturer_id>/..." so ownership is derived from the
-- first path segment via (storage.foldername(name))[1] — NOT the `owner` column
-- (service-role uploads set owner = NULL, which would break owner-based RLS).

drop policy if exists "quiz-sources owner upload" on storage.objects;
create policy "quiz-sources owner upload"
  on storage.objects for insert
  with check (
    bucket_id = 'quiz-sources'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "quiz-sources owner read" on storage.objects;
create policy "quiz-sources owner read"
  on storage.objects for select
  using (
    bucket_id = 'quiz-sources'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "quiz-sources owner update" on storage.objects;
create policy "quiz-sources owner update"
  on storage.objects for update
  using (
    bucket_id = 'quiz-sources'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "quiz-sources owner delete" on storage.objects;
create policy "quiz-sources owner delete"
  on storage.objects for delete
  using (
    bucket_id = 'quiz-sources'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
