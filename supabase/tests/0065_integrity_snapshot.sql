-- ═══════════════════════════════════════════════════════════════════════
-- 0065 — integrity snapshot (audit-5 O2 / O5)
--
-- Pins the service-role snapshot RPC that makes a mass false-flag deploy (O2)
-- and abandonment/seal volume (O5) visible from one call. Also pins the
-- grant lattice: the RPC is service_role-only (never anon/authenticated), so
-- a student cannot read the flag rate.
--
-- Run: npx supabase test db
-- ═══════════════════════════════════════════════════════════════════════

begin;

create extension if not exists pgtap;

select plan(6);

-- ── Fixtures: lecturer + class + enrolled/consenting student ──────────
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('6a111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'lec-o2@test.local', 'x', now(), '{}', '{}', now(), now()),
       ('6a222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'stu-o2@test.local', 'x', now(), '{}', '{}', now(), now())
on conflict (id) do nothing;

insert into public.profiles (id, role, full_name, consent_given_at)
values ('6a111111-1111-1111-1111-111111111111', 'lecturer', 'O2 Lecturer', null),
       ('6a222222-2222-2222-2222-222222222222', 'student', 'O2 Student', now())
on conflict (id) do update set role = excluded.role,
                               consent_given_at = excluded.consent_given_at;

insert into public.classes (id, lecturer_id, title, join_code)
values ('6a333333-3333-3333-3333-333333333333',
        '6a111111-1111-1111-1111-111111111111', 'O2 Class', 'PBC234')
on conflict (id) do nothing;

insert into public.class_enrollments (class_id, student_id)
values ('6a333333-3333-3333-3333-333333333333', '6a222222-2222-2222-2222-222222222222')
on conflict do nothing;

insert into public.quizzes (id, class_id, created_by, title, mode, status)
values ('6a444444-4444-4444-4444-444444444444',
        '6a333333-3333-3333-3333-333333333333',
        '6a111111-1111-1111-1111-111111111111', 'O2 Quiz', 'assessment', 'draft')
on conflict (id) do nothing;

insert into public.questions (quiz_id, order_index, type, prompt, options, correct_index)
values ('6a444444-4444-4444-4444-444444444444', 0, 'mcq', 'Q1', array['a','b'], 0)
on conflict do nothing;

update public.quizzes set status = 'live'
 where id = '6a444444-4444-4444-4444-444444444444';

select set_config('request.jwt.claims',
  jsonb_build_object('sub', '6a222222-2222-2222-2222-222222222222')::text, true);

-- ── The snapshot shape ────────────────────────────────────────────────
select is(
  public.integrity_snapshot(24) ->> 'windowHours',
  '24',
  'O2a the snapshot echoes the requested window');

select is(
  (public.integrity_snapshot(24) ->> 'flags24h')::int,
  0,
  'O2b a quiet system reports zero flags');

-- A start + submit shows up in the counters (O1 audit rows feed O2/O5).
select (public.start_quiz_session('6a444444-4444-4444-4444-444444444444')
        -> 'session' ->> 'id')::uuid as sid \gset
select public.answer_question(:'sid'::uuid,
  (select id from public.questions where quiz_id = '6a444444-4444-4444-4444-444444444444' and prompt = 'Q1'),
  0, null, null, false);
select public.submit_session(:'sid'::uuid);

select is(
  (public.integrity_snapshot(24) ->> 'started')::int,
  1,
  'O5a the snapshot counts the start (abandonment denominator)');

select is(
  (public.integrity_snapshot(24) ->> 'submitted')::int,
  1,
  'O5a the snapshot counts the submit');

-- A flagged session is visible in flaggedNow.
update public.quiz_sessions set status = 'flagged' where id = :'sid'::uuid;
select is(
  (public.integrity_snapshot(24) ->> 'flaggedNow')::int,
  1,
  'O2c flaggedNow reflects a flagged session');

-- ── Grant lattice ─────────────────────────────────────────────────────
select ok(
  not has_function_privilege('authenticated', 'public.integrity_snapshot(int)', 'execute')
  and not has_function_privilege('anon', 'public.integrity_snapshot(int)', 'execute')
  and has_function_privilege('service_role', 'public.integrity_snapshot(int)', 'execute'),
  'O2d integrity_snapshot is service_role-only (never anon/authenticated)');

select * from finish();

rollback;
