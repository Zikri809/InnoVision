-- ═══════════════════════════════════════════════════════════════════════
-- I-26 — Practice re-answer after skip (A5-5, audit-4 M8)
--
-- The A5-5 hole: the practice ON CONFLICT branch originally wrote only
-- selected_index/is_correct/answered_at, so re-answering a SKIPPED practice
-- row left `skipped = true` while writing a selection — which the
-- `session_answers_skip_shape` CHECK rejects with 23514, breaking the
-- student's practice retry. The 0055 body resets skipped/answer_text/mark_*
-- on every practice upsert branch; this suite drives the real RPC to pin it.
--
-- Also pins the scalar re-answer path (skip → mcq answer) and the
-- short_text → skip → short_text cycle, since each exercises a different
-- ON CONFLICT branch in answer_question.
--
-- Run: npx supabase test db
-- ═══════════════════════════════════════════════════════════════════════

begin;

create extension if not exists pgtap;

select plan(12);

-- ── Fixtures: a practice quiz with one mcq and one short_text ─────────
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('1e111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'stu-i26@test.local', 'x', now(), '{}', '{}', now(), now())
on conflict (id) do nothing;

insert into public.profiles (id, role, full_name)
values ('1e111111-1111-1111-1111-111111111111', 'student', 'I26 Student')
on conflict (id) do update set role = excluded.role;

insert into public.classes (id, lecturer_id, title, join_code)
values ('3e333333-3333-3333-3333-333333333333',
        '1e111111-1111-1111-1111-111111111111', 'I26 Class', 'ACE456')
on conflict (id) do nothing;

insert into public.class_enrollments (class_id, student_id)
values ('3e333333-3333-3333-3333-333333333333',
        '1e111111-1111-1111-1111-111111111111')
on conflict do nothing;

-- Practice quizzes are STUDENT-authored (student_quizzes), and
-- answer_question resolves practice sessions against them. Seed the shared
-- enum-typed rows directly so the fixture does not depend on the authoring
-- RPC's own gates.
-- quiz_status_transition enforces the INSERT-must-start-draft arm (M9) AND
-- refuses to publish an empty quiz, so the quiz + questions are inserted as a
-- draft and flipped live afterwards.
insert into public.quizzes (id, class_id, created_by, title, mode, status)
values ('4e444444-4444-4444-4444-444444444444',
        '3e333333-3333-3333-3333-333333333333',
        '1e111111-1111-1111-1111-111111111111', 'I26 Practice', 'practice', 'draft')
on conflict (id) do nothing;

insert into public.questions (quiz_id, order_index, type, prompt, options,
  correct_index)
values ('4e444444-4444-4444-4444-444444444444', 0, 'mcq', 'P-mcq',
        array['a','b'], 0)
on conflict do nothing;

insert into public.questions (quiz_id, order_index, type, prompt, options,
  correct_index, answer_key)
values ('4e444444-4444-4444-4444-444444444444', 1, 'short_text', 'P-text',
        array[]::text[], null, 'Rubric text')
on conflict do nothing;

update public.quizzes set status = 'live'
 where id = '4e444444-4444-4444-4444-444444444444';

select set_config('request.jwt.claims',
  jsonb_build_object('sub', '1e111111-1111-1111-1111-111111111111')::text, true);

select (public.start_quiz_session('4e444444-4444-4444-4444-444444444444')
        -> 'session' ->> 'id')::uuid as sid \gset

-- ── §1 Skip → scalar re-answer (the A5-5 reset) ───────────────────────
select is(
  (public.answer_question(:'sid'::uuid,
     (select id from public.questions where quiz_id = '4e444444-4444-4444-4444-444444444444'
       and prompt = 'P-mcq'), null, null, null, true)) ->> 'is_correct',
  'false',
  'a practice skip is recorded (graded 0)');

select is(
  (select skipped from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions
                          where quiz_id = '4e444444-4444-4444-4444-444444444444'
                            and prompt = 'P-mcq')),
  true,
  'the practice skip row carries skipped=true');

-- THE A5-5 assertion: the upsert must reset `skipped` (and clear the other
-- answer fields) or this call raises 23514 on session_answers_skip_shape.
select lives_ok(
  $$select public.answer_question(
      (select id from public.quiz_sessions where quiz_id = '4e444444-4444-4444-4444-444444444444' limit 1),
      (select id from public.questions where quiz_id = '4e444444-4444-4444-4444-444444444444'
        and prompt = 'P-mcq'), 0, null, null, false)$$,
  'A5-5: re-answering after a skip does NOT raise 23514 (skip fields reset)');

select is(
  (select skipped from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions
                          where quiz_id = '4e444444-4444-4444-4444-444444444444'
                            and prompt = 'P-mcq')),
  false,
  'A5-5: the re-answer cleared skipped');

select is(
  (select is_correct from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions
                          where quiz_id = '4e444444-4444-4444-4444-444444444444'
                            and prompt = 'P-mcq')),
  true,
  'A5-5: the re-answer re-graded the row (option A is correct)');

-- ── §2 short_text → skip → short_text cycle ───────────────────────────
select is(
  (public.answer_question(:'sid'::uuid,
     (select id from public.questions where quiz_id = '4e444444-4444-4444-4444-444444444444'
       and prompt = 'P-text'), null, null, 'First answer', false)) ->> 'is_correct',
  'false',
  'a practice short_text answer is recorded (needs_review sentinel)');

select is(
  (select answer_text from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions
                          where quiz_id = '4e444444-4444-4444-4444-444444444444'
                            and prompt = 'P-text')),
  'First answer',
  'the typed text is stored');

select lives_ok(
  $$select public.answer_question(
      (select id from public.quiz_sessions where quiz_id = '4e444444-4444-4444-4444-444444444444' limit 1),
      (select id from public.questions where quiz_id = '4e444444-4444-4444-4444-444444444444'
        and prompt = 'P-text'), null, null, null, true)$$,
  'A5-5: a short_text row can be SKIPPED after being answered (practice)');

select is(
  (select answer_text from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions
                          where quiz_id = '4e444444-4444-4444-4444-444444444444'
                            and prompt = 'P-text')),
  null,
  'A5-5: the skip cleared the typed text (skip_shape holds)');

select lives_ok(
  $$select public.answer_question(
      (select id from public.quiz_sessions where quiz_id = '4e444444-4444-4444-4444-444444444444' limit 1),
      (select id from public.questions where quiz_id = '4e444444-4444-4444-4444-444444444444'
        and prompt = 'P-text'), null, null, 'Second answer', false)$$,
  'A5-5: re-answering a SKIPPED short_text row does not raise 23514');

select is(
  (select skipped from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions
                          where quiz_id = '4e444444-4444-4444-4444-444444444444'
                            and prompt = 'P-text')),
  false,
  'A5-5: the short_text re-answer cleared skipped');

select is(
  (select answer_text from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions
                          where quiz_id = '4e444444-4444-4444-4444-444444444444'
                            and prompt = 'P-text')),
  'Second answer',
  'A5-5: the second text replaced the first');

select * from finish();
rollback;
