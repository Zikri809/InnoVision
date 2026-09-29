-- 0070 — incident_clips retention must never leave a listed row without its
-- storage object (the prod 2026-09-29 `NoSuchKey` / "Object not found" signing
-- error on the lecturer results dashboard).
--
-- The SQL prune owns METADATA only: it deletes a row exactly when its object
-- is already gone. It must NOT delete storage objects (the Storage
-- `protect_delete` guard raises 42501 — that is what made the old function a
-- silent no-op), and it must NOT drop an aged row whose object still exists
-- (that would strand the object with no metadata; the Storage-API path owns
-- aged-object reclamation).
--
-- Pins:
--   T0  the function runs at all (the old body raised on protect_delete)
--   T1  an orphan row (object already deleted) is removed regardless of age
--   T2  an aged LIVE pair keeps BOTH sides (SQL never strands an object)
--   T3  a young live pair is untouched
--   T4  invariant: no incident_clips row lacks its storage object
--   T5  idempotent second pass removes nothing more
--
-- Run: npx supabase test db
-- ---------------------------------------------------------------------

begin;

create extension if not exists pgtap;

select plan(9);

-- ─── Fixtures: lecturer + class + quiz + one session (FK target) ─────────
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('70111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'lec-i70@test.local', 'x', now(), '{}', '{}', now(), now()),
       ('70222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'stu-i70@test.local', 'x', now(), '{}', '{}', now(), now())
on conflict (id) do nothing;

insert into public.profiles (id, role, full_name, consent_given_at)
values ('70111111-1111-1111-1111-111111111111', 'lecturer', 'I70 Lecturer', null),
       ('70222222-2222-2222-2222-222222222222', 'student', 'I70 Student', now())
on conflict (id) do update set role = excluded.role;

insert into public.classes (id, lecturer_id, title, join_code)
values ('70333333-3333-3333-3333-333333333333',
        '70111111-1111-1111-1111-111111111111', 'I70 class', 'PRSTUV')
on conflict (id) do nothing;

-- Quiz must INSERT as draft (quiz_status_transition, 0004); its status is
-- irrelevant to the prune — only the session FK and the clip rows matter.
insert into public.quizzes (id, class_id, created_by, title, mode, status)
values ('70444444-4444-4444-4444-444444444444',
        '70333333-3333-3333-3333-333333333333',
        '70111111-1111-1111-1111-111111111111', 'I70 quiz', 'assessment', 'draft')
on conflict (id) do nothing;

insert into public.quiz_sessions (id, quiz_id, student_id, mode, status)
values ('70555555-5555-5555-5555-555555555555',
        '70444444-4444-4444-4444-444444444444',
        '70222222-2222-2222-2222-222222222222', 'assessment', 'active')
on conflict (id) do nothing;

-- ─── Three clip shapes ───────────────────────────────────────────────────
-- A: ORPHAN ROW — a young row whose object has ALREADY been deleted through
--    the Storage API (the route's orphan cleanup / incident-cleanup.mjs).
--    This is precisely the row that 404s on every dashboard load.
insert into public.incident_clips (id, session_id, storage_path, reason, recorded_from, recorded_to)
values ('70a00000-0000-0000-0000-00000000000a', '70555555-5555-5555-5555-555555555555',
        '70555555-5555-5555-5555-555555555555/orphan.webm', 'focus_lost',
        now(), now());

-- B: AGED LIVE PAIR — object + row both past 30d. SQL must NOT touch either:
--    the Storage-API path reclaims them together (row first, then object).
insert into storage.objects (id, bucket_id, name, created_at)
values (gen_random_uuid(), 'incident-footage',
        '70555555-5555-5555-5555-555555555555/aged.webm', now() - interval '31 days');
insert into public.incident_clips (id, session_id, storage_path, reason, recorded_from, recorded_to)
values ('70b00000-0000-0000-0000-00000000000b', '70555555-5555-5555-5555-555555555555',
        '70555555-5555-5555-5555-555555555555/aged.webm', 'paused',
        now() - interval '31 days', now() - interval '31 days');

-- C: YOUNG LIVE PAIR — object + row inside retention. Must survive intact.
insert into storage.objects (id, bucket_id, name, created_at)
values (gen_random_uuid(), 'incident-footage',
        '70555555-5555-5555-5555-555555555555/young.webm', now() - interval '2 days');
insert into public.incident_clips (id, session_id, storage_path, reason, recorded_from, recorded_to)
values ('70c00000-0000-0000-0000-00000000000c', '70555555-5555-5555-5555-555555555555',
        '70555555-5555-5555-5555-555555555555/young.webm', 'flagged',
        now() - interval '2 days', now() - interval '2 days');

-- ─── Run the reconcile (T0: must not raise protect_delete 42501) ─────────
select lives_ok(
  $$select public.prune_expired_incident_clips()$$,
  'T0 prune_expired_incident_clips() runs (no storage-table delete)');

-- T1: the orphan row is gone.
select is(
  (select count(*)::int from public.incident_clips
    where id = '70a00000-0000-0000-0000-00000000000a'),
  0,
  'T1 orphan row (object already gone) is deleted regardless of age');

-- T2: the aged live pair is preserved on BOTH sides (SQL never strands an
--     object; the Storage-API path reclaims the pair).
select is(
  (select count(*)::int from public.incident_clips
    where id = '70b00000-0000-0000-0000-00000000000b'),
  1,
  'T2 aged live pair keeps its row (object not stranded by SQL)');
select is(
  (select count(*)::int from storage.objects
    where bucket_id = 'incident-footage'
      and name = '70555555-5555-5555-5555-555555555555/aged.webm'),
  1,
  'T2 aged live pair keeps its storage object');

-- T3: the young live pair is untouched on both sides.
select is(
  (select count(*)::int from public.incident_clips
    where id = '70c00000-0000-0000-0000-00000000000c'),
  1,
  'T3 young clip row survives');
select is(
  (select count(*)::int from storage.objects
    where bucket_id = 'incident-footage'
      and name = '70555555-5555-5555-5555-555555555555/young.webm'),
  1,
  'T3 young clip storage object survives');

-- T4: the core invariant — NO listed row points at a missing object.
select is(
  (select count(*)::int
     from public.incident_clips c
    where not exists (
      select 1 from storage.objects o
       where o.bucket_id = 'incident-footage' and o.name = c.storage_path)),
  0,
  'T4 invariant: no incident_clips row lacks its storage object');

-- T5: idempotent — a second pass over the healed state removes nothing.
select is(
  (public.prune_expired_incident_clips() ->> 'pruned_orphan_rows')::int,
  0,
  'T5 second pass finds no orphan rows (idempotent)');
select is(
  (public.prune_expired_incident_clips() ->> 'pruned_storage_objects')::int,
  0,
  'T5 SQL never reports storage-object deletions');

select * from finish();
rollback;
