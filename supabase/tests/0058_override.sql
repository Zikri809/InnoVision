-- ═══════════════════════════════════════════════════════════════════════
-- I-21 — Override adjudication + reveal re-publish (migration 0058)
--
-- What is pinned:
--   * validation: NULL mark, bad reason, over-max, foreign question,
--     no-answer-row → typed errors (never a silent ok:true)
--   * the score recompute uses the D10 SUM
--   * attempt_version increments (the override epoch that invalidates an
--     in-flight AI mark)
--   * an audit row is written
--   * NO submitted_at/last_activity_at stamp (D4: adjudication ≠ submission)
--   * submit-suppression: the override does not produce a submit notification
--   * the re-publish NULLs results_revealed_at INSIDE the GUC, and the
--     one-way trigger still blocks an un-reveal OUTSIDE it
--
-- Run: npx supabase test db
-- ═══════════════════════════════════════════════════════════════════════

begin;

create extension if not exists pgtap;

select plan(24);

-- ── Fixtures ──────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('1b111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'lect-i21@test.local', 'x', now(), '{}', '{}', now(), now()),
       ('2b222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'stu-i21@test.local', 'x', now(), '{}', '{}', now(), now()),
       ('3b333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'oth-i21@test.local', 'x', now(), '{}', '{}', now(), now())
on conflict (id) do nothing;

-- audit-5 M2: start_quiz_session requires biometric consent for assessment
-- mode, so the fixture student carries it (the same state registration sets).
insert into public.profiles (id, role, full_name, consent_given_at)
values ('1b111111-1111-1111-1111-111111111111', 'lecturer', 'I21 Lecturer', null),
       ('2b222222-2222-2222-2222-222222222222', 'student', 'I21 Student', now()),
       ('3b333333-3333-3333-3333-333333333333', 'lecturer', 'I21 Other Lecturer', null)
on conflict (id) do update set role = excluded.role, consent_given_at = excluded.consent_given_at;

insert into public.classes (id, lecturer_id, title, join_code)
values ('4b444444-4444-4444-4444-444444444444',
        '1b111111-1111-1111-1111-111111111111', 'I21 Class', 'ACD345')
on conflict (id) do nothing;

insert into public.class_enrollments (class_id, student_id)
values ('4b444444-4444-4444-4444-444444444444',
        '2b222222-2222-2222-2222-222222222222')
on conflict do nothing;

insert into public.quizzes (id, class_id, created_by, title, mode, status)
values ('5b555555-5555-5555-5555-555555555555',
        '4b444444-4444-4444-4444-444444444444',
        '1b111111-1111-1111-1111-111111111111', 'I21 Quiz', 'assessment', 'draft')
on conflict (id) do nothing;

select set_config('request.jwt.claims',
  jsonb_build_object('sub', '1b111111-1111-1111-1111-111111111111')::text, true);

select public.append_question('5b555555-5555-5555-5555-555555555555', 'mcq',
  'Q1', array['a','b'], 0, null, null, null, 1);
select public.append_question('5b555555-5555-5555-5555-555555555555', 'mcq',
  'Q2', array['a','b'], 1, null, null, null, 1);
-- Q3 is authored here but never answered, so it exercises C10's "question
-- belongs to this quiz but has no answer row in this session" arm. It must
-- be inserted BEFORE the publish: questions_draft_only freezes the set once
-- the quiz is live.
select public.append_question('5b555555-5555-5555-5555-555555555555', 'mcq',
  'Q-unanswered', array['a','b'], 0, null, null, null, 1);

update public.quizzes set status = 'live'
 where id = '5b555555-5555-5555-5555-555555555555';

select set_config('request.jwt.claims',
  jsonb_build_object('sub', '2b222222-2222-2222-2222-222222222222')::text, true);

select (public.start_quiz_session('5b555555-5555-5555-5555-555555555555')
        -> 'session' ->> 'id')::uuid as sid \gset

-- Q1 correct, Q2 wrong → score 1 of 2.
select public.answer_question(:'sid'::uuid,
  (select id from public.questions where quiz_id = '5b555555-5555-5555-5555-555555555555' and prompt = 'Q1'), 0, null, null, false);
select public.answer_question(:'sid'::uuid,
  (select id from public.questions where quiz_id = '5b555555-5555-5555-5555-555555555555' and prompt = 'Q2'), 0, null, null, false);

select public.submit_session(:'sid'::uuid);

select set_config('request.jwt.claims',
  jsonb_build_object('sub', '1b111111-1111-1111-1111-111111111111')::text, true);

-- ── §1 Validation ─────────────────────────────────────────────────────
select is(
  (public.override_answer_mark(:'sid'::uuid,
     (select id from public.questions where quiz_id = '5b555555-5555-5555-5555-555555555555' and prompt = 'Q1'), null, 'valid reason here')) ->> 'error',
  'invalid_mark',
  'C9: a NULL mark is rejected (NOT IN alone lets NULL through)');

select is(
  (public.override_answer_mark(:'sid'::uuid,
     (select id from public.questions where quiz_id = '5b555555-5555-5555-5555-555555555555' and prompt = 'Q1'), 0.7, 'valid reason here')) ->> 'error',
  'invalid_mark',
  'a mark outside the 0/0.5/1 ladder is rejected');

select is(
  (public.override_answer_mark(:'sid'::uuid,
     (select id from public.questions where quiz_id = '5b555555-5555-5555-5555-555555555555' and prompt = 'Q1'), 1, 'no')) ->> 'error',
  'reason_required',
  'a reason shorter than 5 chars is rejected');

select is(
  (public.override_answer_mark(:'sid'::uuid,
     (select id from public.questions where quiz_id = '5b555555-5555-5555-5555-555555555555' and prompt = 'Q1'), 1, null)) ->> 'error',
  'reason_required',
  'a NULL reason is rejected');

select is(
  (public.override_answer_mark(:'sid'::uuid,
     '99999999-9999-9999-9999-999999999999', 1, 'foreign question probe')) ->> 'error',
  'not_found',
  'C10: a question that is not in this quiz returns not_found (no cross-quiz oracle)');

select is(
  (public.override_answer_mark('99999999-9999-9999-9999-999999999999',
     (select id from public.questions where quiz_id = '5b555555-5555-5555-5555-555555555555' and prompt = 'Q1'), 1, 'foreign session probe')) ->> 'error',
  'not_owner',
  'a foreign session returns not_owner');

-- A question that exists in the quiz but has NO answer row in this session
-- (Q-unanswered was authored before publish, never answered).
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '1b111111-1111-1111-1111-111111111111')::text, true);

select is(
  (public.override_answer_mark(:'sid'::uuid,
     (select id from public.questions where quiz_id = '5b555555-5555-5555-5555-555555555555' and prompt = 'Q-unanswered'),
     1, 'unanswered question probe')) ->> 'error',
  'not_found',
  'C10: a question with NO answer row in this session returns not_found');

-- ── §2 A different lecturer cannot override ───────────────────────────
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '3b333333-3333-3333-3333-333333333333')::text, true);

select is(
  (public.override_answer_mark(:'sid'::uuid,
     (select id from public.questions where quiz_id = '5b555555-5555-5555-5555-555555555555' and prompt = 'Q1'), 1, 'not my quiz at all')) ->> 'error',
  'not_owner',
  'a lecturer of ANOTHER class cannot override this session');

-- ── §3 The happy path ─────────────────────────────────────────────────
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '1b111111-1111-1111-1111-111111111111')::text, true);

-- Capture the pre-state so the no-stamp assertion is meaningful.
select last_activity_at as pre_activity, submitted_at as pre_submitted
  from public.quiz_sessions
 where id = :'sid'::uuid \gset

-- The submit above legitimately fired session_submitted; the override must
-- not fire a SECOND one. Count before/after rather than asserting 0.
select count(*) as pre_notifs from public.notifications
 where dedupe_key = 'session_submitted:' || :'sid'::uuid::text \gset

select is(
  (public.override_answer_mark(:'sid'::uuid,
     (select id from public.questions where quiz_id = '5b555555-5555-5555-5555-555555555555' and prompt = 'Q2'), 1,
     'The student was right, marking scheme was wrong')) ->> 'ok',
  'true',
  'a valid override returns ok:true');

select is(
  (select mark_score from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions where quiz_id = '5b555555-5555-5555-5555-555555555555' and prompt = 'Q2')),
  1::numeric,
  'the override writes the new mark');

select is(
  (select mark_status from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions where quiz_id = '5b555555-5555-5555-5555-555555555555' and prompt = 'Q2')),
  'marked',
  'the override resolves the row to marked');

select is(
  (select is_correct from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions where quiz_id = '5b555555-5555-5555-5555-555555555555' and prompt = 'Q2')),
  true,
  'the override sets is_correct from the mark (>= 0.5)');

select is(
  (select attempt_version from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions where quiz_id = '5b555555-5555-5555-5555-555555555555' and prompt = 'Q2')),
  2,
  'L8: attempt_version increments — the override epoch that invalidates an in-flight AI mark');

select is(
  (select score from public.quiz_sessions where id = :'sid'::uuid),
  2::numeric,
  'the score recomputes with the D10 SUM (1 + 1)');

select is(
  (select count(*) from public.audit_events
    where action = 'override_answer_mark' and subject_id = :'sid'::uuid),
  1::bigint,
  'an audit_events row records the override');

select is(
  (select metadata ->> 'reason' from public.audit_events
    where action = 'override_answer_mark' and subject_id = :'sid'::uuid),
  'The student was right, marking scheme was wrong',
  'the audit row carries the reason');

-- ── §4 No submission stamp (D4) ───────────────────────────────────────
select is(
  (select last_activity_at from public.quiz_sessions where id = :'sid'::uuid),
  :'pre_activity'::timestamptz,
  'D4: the override does NOT stamp last_activity_at (adjudication ≠ submission)');

-- audit-4 n2: pin submitted_at too. The implementation writes neither, but
-- only last_activity_at was guarded — a future "touch the session" refactor
-- would fake a re-submission (and re-fire the digest/window logic) undetected.
select is(
  (select submitted_at from public.quiz_sessions where id = :'sid'::uuid),
  :'pre_submitted'::timestamptz,
  'D4: the override does NOT re-stamp submitted_at (adjudication ≠ submission)');

-- ── §5 No EXTRA submit notification from an override ──────────────────
-- The genuine submit fired one; the override must not add another. This is
-- the D4 contract: adjudication is not a submission event.
select is(
  (select count(*) from public.notifications
    where dedupe_key = 'session_submitted:' || :'sid'::uuid::text),
  :'pre_notifs'::bigint,
  'the override produces no additional session_submitted notification');

-- ── §6 Re-publish (C6/L1/D2-7) ────────────────────────────────────────
-- Reveal first, then override → the GUC permits the non-null → NULL write.
update public.quizzes
   set results_revealed_at = clock_timestamp()
 where id = '5b555555-5555-5555-5555-555555555555';

select isnt(
  (select results_revealed_at from public.quizzes
    where id = '5b555555-5555-5555-5555-555555555555'),
  null,
  'the quiz is revealed before the second override');

select is(
  (public.override_answer_mark(:'sid'::uuid,
     (select id from public.questions where quiz_id = '5b555555-5555-5555-5555-555555555555' and prompt = 'Q2'), 0,
     'Reversing the earlier adjudication')) ->> 'ok',
  'true',
  'a post-reveal override succeeds');

select is(
  (select results_revealed_at from public.quizzes
    where id = '5b555555-5555-5555-5555-555555555555'),
  null,
  'C6/L1/D2-7: the override NULLs results_revealed_at (re-publish required)');

-- ── §7 The one-way trigger still holds outside the GUC ────────────────
-- pgTAP runs the whole file in ONE transaction, so the GUC the override set
-- (`app.mark_overridden`, transaction-local) is still live here. Resetting it
-- is what models the production reality: the override's transaction commits
-- and the GUC dies with it, so every OTHER transaction sees the plain
-- one-way rule. Without this reset the assertion would pass vacuously.
select set_config('app.mark_overridden', 'off', true);

select throws_ok(
  $$update public.quizzes set results_revealed_at = clock_timestamp()
     where id = '5b555555-5555-5555-5555-555555555555';
    update public.quizzes set results_revealed_at = null
     where id = '5b555555-5555-5555-5555-555555555555'$$,
  'P0001', 'reveal_once_only',
  'a manual un-reveal OUTSIDE the override GUC still throws reveal_once_only');

-- And the GUC itself is the ONLY key: with it armed the same sequence passes.
select lives_ok(
  $$select set_config('app.mark_overridden', 'on', true);
    update public.quizzes set results_revealed_at = null
     where id = '5b555555-5555-5555-5555-555555555555';
    select set_config('app.mark_overridden', 'off', true)$$,
  'the same un-reveal IS permitted while the override GUC is armed (C6/L1)');

select * from finish();
rollback;
