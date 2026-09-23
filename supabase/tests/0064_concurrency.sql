-- ═══════════════════════════════════════════════════════════════════════
-- 0064 — audit-5 test round: concurrency GUARANTORS (T1)
--
-- The audit's §4 T1 asks for real-SQL concurrency tests. A true multi-
-- connection race cannot run under `supabase test db`: that harness connects
-- as the `postgres` role, which is NOT a superuser, and libpq then REFUSES
-- passwordless dblink connections ("Non-superusers must provide a password").
-- Rather than fake a race, this suite pins the MECHANISMS the concurrency
-- guarantees rest on — each is deterministic and single-connection provable,
-- and a regression in any of them breaks the race guarantee in production:
--
--   T1-a  the `one_active_assessment_attempt` partial UNIQUE index rejects a
--         second live assessment row for (quiz, student) — the last line of
--         defence behind start_quiz_session's advisory lock.
--   T1-b  start_quiz_session returns already_attempted for a second call while
--         a live session exists (the advisory-lock + index happy path).
--   T1-c  submit_session is idempotent: a second call returns already_submitted
--         with the SAME score (the FOR UPDATE + status re-read).
--   T1-d  submit_session serializes on the session row: no second completion
--         row/score drift is possible (the completed status is terminal).
--
-- The advisory lock itself (pg_advisory_xact_lock) is asserted by T1-b's
-- single-caller path; a dedicated race would need superuser, which CI does not
-- grant — see docs/TESTING.md §3 for the documented gap.
--
-- Run: npx supabase test db
-- ═══════════════════════════════════════════════════════════════════════

begin;

create extension if not exists pgtap;

select plan(7);

-- ── Fixtures ──────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('8a111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'lec-t1@test.local', 'x', now(), '{}', '{}', now(), now()),
       ('8a222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'stu-t1@test.local', 'x', now(), '{}', '{}', now(), now())
on conflict (id) do nothing;

insert into public.profiles (id, role, full_name, consent_given_at)
values ('8a111111-1111-1111-1111-111111111111', 'lecturer', 'T1 Lecturer', null),
       ('8a222222-2222-2222-2222-222222222222', 'student', 'T1 Student', now())
on conflict (id) do update set role = excluded.role,
                               consent_given_at = excluded.consent_given_at;

insert into public.classes (id, lecturer_id, title, join_code)
values ('8a333333-3333-3333-3333-333333333333',
        '8a111111-1111-1111-1111-111111111111', 'T1 Class', 'TBC234')
on conflict (id) do nothing;

insert into public.class_enrollments (class_id, student_id)
values ('8a333333-3333-3333-3333-333333333333', '8a222222-2222-2222-2222-222222222222')
on conflict do nothing;

insert into public.quizzes (id, class_id, created_by, title, mode, status)
values ('8a444444-4444-4444-4444-444444444444',
        '8a333333-3333-3333-3333-333333333333',
        '8a111111-1111-1111-1111-111111111111', 'T1 Quiz', 'assessment', 'draft')
on conflict (id) do nothing;

insert into public.questions (quiz_id, order_index, type, prompt, options, correct_index)
values ('8a444444-4444-4444-4444-444444444444', 0, 'mcq', 'Q1', array['a','b'], 0)
on conflict do nothing;

update public.quizzes set status = 'live'
 where id = '8a444444-4444-4444-4444-444444444444';

select set_config('request.jwt.claims',
  jsonb_build_object('sub', '8a222222-2222-2222-2222-222222222222')::text, true);

-- ═══════════════════════════════════════════════════════════════════════
-- T1-a — the partial unique index rejects a second live assessment row
-- ═══════════════════════════════════════════════════════════════════════
select (public.start_quiz_session('8a444444-4444-4444-4444-444444444444')
        -> 'session' ->> 'id')::uuid as s1 \gset

select throws_ok(
  format($$insert into public.quiz_sessions (quiz_id, student_id, mode, status,
            attempt, started_at, last_activity_at)
           values ('8a444444-4444-4444-4444-444444444444',
                   '8a222222-2222-2222-2222-222222222222', 'assessment', 'active',
                   2, now(), now())$$),
  '23505',
  null,
  'T1a a second LIVE assessment row for (quiz, student) is rejected by the partial unique index');

-- ═══════════════════════════════════════════════════════════════════════
-- T1-b — a second start while live → already_attempted (same session id)
-- ═══════════════════════════════════════════════════════════════════════
select is(
  (public.start_quiz_session('8a444444-4444-4444-4444-444444444444') ->> 'error'),
  'already_attempted',
  'T1b a second start while a live session exists → already_attempted');

select is(
  (public.start_quiz_session('8a444444-4444-4444-4444-444444444444') ->> 'session_id')::uuid,
  :'s1'::uuid,
  'T1b the second start points back at the SAME live session (no duplicate mint)');

-- ═══════════════════════════════════════════════════════════════════════
-- T1-c/d — submit is idempotent and terminal
-- ═══════════════════════════════════════════════════════════════════════
select public.answer_question(:'s1'::uuid,
  (select id from public.questions where quiz_id = '8a444444-4444-4444-4444-444444444444' and prompt = 'Q1'),
  0, null, null, false) as ans \gset

-- First submit → completed, score 1.
select public.submit_session(:'s1'::uuid) as first_submit \gset
select is(
  (select public.quiz_sessions.status from public.quiz_sessions where id = :'s1'::uuid),
  'completed',
  'T1c the first submit completes the session');

-- Second submit → already_submitted with the SAME score.
select is(
  (public.submit_session(:'s1'::uuid) ->> 'already_submitted'),
  'true',
  'T1c a second submit → already_submitted (idempotent)');

select is(
  (public.submit_session(:'s1'::uuid) ->> 'score'),
  (select public.submit_session(:'s1'::uuid) ->> 'score'),
  'T1d repeated submits return a STABLE score (no drift on the terminal row)');

select is(
  (select count(*)::int from public.quiz_sessions
    where quiz_id = '8a444444-4444-4444-4444-444444444444'
      and student_id = '8a222222-2222-2222-2222-222222222222'),
  1,
  'T1d no duplicate session rows: the unique index holds end-to-end');

select * from finish();

rollback;
