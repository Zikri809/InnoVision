-- ═══════════════════════════════════════════════════════════════════════
-- I-25 — 0052 question/session SHAPE constraints (pgTAP)
--
-- Pins the DB-layer contract for the short_text type: per-type option
-- bounds, the three-way questions_correct_shape, the short_text shape
-- CHECKs, and the session_answers pending/skip shapes.
--
-- These are the constraints that make the new type REACHABLE (C1: the 0037
-- two-way correct_shape demanded `correct_index IS NOT NULL` on every
-- non-multi row, so a short_text insert failed on the FIRST row) and keep a
-- malformed marking row UNREACHABLE.
--
-- Run: npx supabase test db
-- ═══════════════════════════════════════════════════════════════════════

begin;

create extension if not exists pgtap;

select plan(27);

-- ── Fixtures ──────────────────────────────────────────────────────────
-- A lecturer + class + draft quiz to hang questions off. Fixtures run as
-- postgres (superuser), so RLS is bypassed and the helper functions see the
-- auth.uid() we set below.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'lect-i25@test.local', 'x', now(), '{}', '{}', now(), now())
on conflict (id) do nothing;

insert into public.profiles (id, role, full_name)
values ('11111111-1111-1111-1111-111111111111', 'lecturer', 'I25 Lecturer')
on conflict (id) do update set role = excluded.role;

insert into public.classes (id, lecturer_id, title, join_code)
values ('33333333-3333-3333-3333-333333333333',
        '11111111-1111-1111-1111-111111111111', 'I25 Class', 'ABC234')
on conflict (id) do nothing;

insert into public.quizzes (id, class_id, created_by, title, mode, status)
values ('44444444-4444-4444-4444-444444444444',
        '33333333-3333-3333-3333-333333333333',
        '11111111-1111-1111-1111-111111111111', 'I25 Quiz', 'assessment', 'draft')
on conflict (id) do nothing;

-- ── §0 gestures_enabled default (n11) ─────────────────────────────────
-- FC-1/D9: the toggle must default ON for every pre-existing quiz row and for
-- any INSERT that omits it. The migration says `not null default true`; this
-- pins the actual column metadata so a later "default false" edit cannot ship
-- silently (it would disable gestures for every newly created quiz).
select is(
  (select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'quizzes'
      and column_name = 'gestures_enabled'),
  'true',
  'quizzes.gestures_enabled defaults to true (gestures on unless opted out)');

select is(
  (select is_nullable from information_schema.columns
    where table_schema = 'public' and table_name = 'quizzes'
      and column_name = 'gestures_enabled'),
  'NO',
  'quizzes.gestures_enabled is NOT NULL (a null would render as the falsy off-branch)');

select set_config('request.jwt.claims',
  jsonb_build_object('sub', '11111111-1111-1111-1111-111111111111')::text, true);

-- append_question's signature is now 10-arg:
--   (quiz_id, type, prompt, options, correct_index, explanation,
--    correct_indices, answer_key, max_score)  — the trailing p_max_score.
-- Order of the two optional keys is explanation THEN correct_indices.

-- ── §1 options cardinality per type (U-60 / B6-4) ─────────────────────
-- The 0004 2..5 CHECK was TYPE-BLIND: it rejected short_text (0 options)
-- before any shape logic could run.

select lives_ok(
  $$select public.append_question(
      '44444444-4444-4444-4444-444444444444', 'mcq', 'mcq-2',
      array['a','b'], 0, null, null, null, 1)$$,
  'mcq with 2 options is accepted');

select lives_ok(
  $$select public.append_question(
      '44444444-4444-4444-4444-444444444444', 'mcq', 'mcq-5',
      array['a','b','c','d','e'], 0, null, null, null, 1)$$,
  'mcq with 5 options is accepted (D1 cap unchanged)');

select throws_ok(
  $$select public.append_question(
      '44444444-4444-4444-4444-444444444444', 'mcq', 'mcq-6',
      array['a','b','c','d','e','f'], 0, null, null, null, 1)$$,
  '23514', null,
  'mcq with 6 options is rejected by questions_options_check');

select lives_ok(
  $$select public.append_question(
      '44444444-4444-4444-4444-444444444444', 'true_false', 'tf-2',
      array['True','False'], 0, null, null, null, 1)$$,
  'true_false with exactly 2 options is accepted');

select throws_ok(
  $$select public.append_question(
      '44444444-4444-4444-4444-444444444444', 'true_false', 'tf-3',
      array['a','b','c'], 0, null, null, null, 1)$$,
  '23514', null,
  'true_false with 3 options is rejected');

select lives_ok(
  $$select public.append_question(
      '44444444-4444-4444-4444-444444444444', 'multi_select', 'multi-4',
      array['a','b','c','d'], null, null, array[0,1], null, 1)$$,
  'multi_select with 4 options is accepted (D1 cap)');

select throws_ok(
  $$select public.append_question(
      '44444444-4444-4444-4444-444444444444', 'multi_select', 'multi-5',
      array['a','b','c','d','e'], null, null, array[0], null, 1)$$,
  '23514', null,
  'multi_select with 5 options is rejected (finger 5 is palm-commit)');

select lives_ok(
  $$select public.append_question(
      '44444444-4444-4444-4444-444444444444', 'short_text', 'st-empty',
      array[]::text[], null, null, null, 'Rubric text', 1)$$,
  'short_text with an EMPTY options array is accepted (D2-1 convention)');

-- ── §2 short_text shape ───────────────────────────────────────────────

select throws_ok(
  $$select public.append_question(
      '44444444-4444-4444-4444-444444444444', 'short_text', 'st-blank',
      array[]::text[], null, null, null, '   ', 1)$$,
  '23514', null,
  'short_text with a BLANK answer_key is rejected');

select throws_ok(
  $$select public.append_question(
      '44444444-4444-4444-4444-444444444444', 'short_text', 'st-nokey',
      array[]::text[], null, null, null, null, 1)$$,
  '23514', null,
  'short_text WITHOUT an answer_key is rejected');

select throws_ok(
  $$select public.append_question(
      '44444444-4444-4444-4444-444444444444', 'short_text', 'st-opts',
      array['a','b'], null, null, null, 'Rubric', 1)$$,
  '23514', null,
  'short_text WITH options is rejected by questions_short_text_shape');

-- audit-4 n11: the answer_key CEILING (questions_answer_key_shape caps the
-- trimmed rubric at 500). A 500-char key is legal; 501 must reject, or one
-- student's oversized rubric would monopolize the quiz's daily AI budget.
select lives_ok(
  $$select public.append_question(
      '44444444-4444-4444-4444-444444444444', 'short_text', 'st-key500',
      array[]::text[], null, null, null, repeat('r', 500), 1)$$,
  'short_text with a 500-char answer_key is accepted (the bound is inclusive)');

select throws_ok(
  $$select public.append_question(
      '44444444-4444-4444-4444-444444444444', 'short_text', 'st-key501',
      array[]::text[], null, null, null, repeat('r', 501), 1)$$,
  '23514', null,
  'short_text with a 501-char answer_key is rejected');

-- ── §3 questions_correct_shape three-way (C1) ─────────────────────────

select throws_ok(
  $$select public.append_question(
      '44444444-4444-4444-4444-444444444444', 'short_text', 'st-correctidx',
      array[]::text[], 0, null, null, 'Rubric', 1)$$,
  '23514', null,
  'short_text carrying a correct_index is rejected');

-- NOTE: the PRE-EXISTING 0037 questions_correct_indices_guard fires first for
-- a non-multi row carrying a set (its `else` arm raises invalid_correct_indices),
-- so that is the code asserted here. questions_correct_shape is the row-level
-- backstop for a write that bypasses the trigger.
select throws_ok(
  $$select public.append_question(
      '44444444-4444-4444-4444-444444444444', 'short_text', 'st-correctset',
      array[]::text[], null, null, array[1], 'Rubric', 1)$$,
  'P0001', 'invalid_correct_indices',
  'short_text carrying a correct_indices set is rejected');

-- ── §4 max_score is locked at 1 (D7) ──────────────────────────────────

select throws_ok(
  $$select public.append_question(
      '44444444-4444-4444-4444-444444444444', 'mcq', 'ms-2',
      array['a','b'], 0, null, null, null, 2)$$,
  '23514', null,
  'max_score = 2 is rejected (structure reserved, value locked)');

-- ── §5 session_answers shapes ─────────────────────────────────────────
-- These are row-level CHECKs; exercise them directly on a real session so
-- the constraint (not the RPC) is what rejects.

insert into public.quiz_sessions (id, quiz_id, student_id, mode, status)
values ('55555555-5555-5555-5555-555555555555',
        '44444444-4444-4444-4444-444444444444',
        '11111111-1111-1111-1111-111111111111', 'assessment', 'active')
on conflict (id) do nothing;

select throws_ok(
  $$insert into public.session_answers
      (session_id, question_id, selected_index, is_correct, mark_status, mark_score)
    values ('55555555-5555-5555-5555-555555555555',
            (select id from public.questions where prompt = 'mcq-2'),
            0, false, 'pending', 1)$$,
  '23514', null,
  'a PENDING row carrying a mark_score is rejected (pending_shape)');

select throws_ok(
  $$insert into public.session_answers
      (session_id, question_id, selected_index, is_correct, mark_status)
    values ('55555555-5555-5555-5555-555555555555',
            (select id from public.questions where prompt = 'mcq-5'),
            0, true, 'pending')$$,
  '23514', null,
  'a PENDING row marked is_correct=true is rejected (pending_shape)');

-- Every fixture below targets a question that ACTUALLY EXISTS after §1-§4
-- (mcq-2, mcq-5, tf-2, multi-4, st-empty). The rejected prompts above left
-- no row, so a subselect on them would yield NULL and trip the NOT NULL
-- constraint instead of the shape CHECK under test.

select throws_ok(
  $$insert into public.session_answers
      (session_id, question_id, selected_index, is_correct, skipped)
    values ('55555555-5555-5555-5555-555555555555',
            (select id from public.questions where prompt = 'mcq-2'),
            0, false, true)$$,
  '23514', null,
  'a SKIPPED row carrying a selection is rejected (skip_shape)');

select throws_ok(
  $$insert into public.session_answers
      (session_id, question_id, is_correct, skipped, answer_text)
    values ('55555555-5555-5555-5555-555555555555',
            (select id from public.questions where prompt = 'multi-4'),
            false, true, 'some text')$$,
  '23514', null,
  'a SKIPPED row carrying answer_text is rejected (skip_shape)');

select throws_ok(
  $$insert into public.session_answers
      (session_id, question_id, is_correct, mark_score)
    values ('55555555-5555-5555-5555-555555555555',
            (select id from public.questions where prompt = 'tf-2'),
            false, 0.7)$$,
  '23514', null,
  'mark_score = 0.7 is rejected (the 0/0.5/1 ladder)');

select throws_ok(
  $$insert into public.session_answers
      (session_id, question_id, is_correct, answer_text)
    values ('55555555-5555-5555-5555-555555555555',
            (select id from public.questions where prompt = 'st-empty'),
            false, repeat('x', 501))$$,
  '23514', null,
  'answer_text longer than 500 chars is rejected');

select lives_ok(
  $$insert into public.session_answers
      (session_id, question_id, is_correct, skipped)
    values ('55555555-5555-5555-5555-555555555555',
            (select id from public.questions where prompt = 'tf-2'),
            false, true)$$,
  'a well-formed SKIPPED row is accepted');

-- audit-4 n11: mark_metadata is plain JSONB with no CHECK — smoke-insert a
-- nested object to prove the column accepts the {rationale, confidence, model}
-- shape the finalizer writes (0057:627-631) and reads back intact. Without
-- this the rich-marking column had no positive-path test at all.
select lives_ok(
  $$insert into public.session_answers
      (session_id, question_id, answer_text, is_correct, mark_status,
       mark_score, mark_metadata)
    values ('55555555-5555-5555-5555-555555555555',
            (select id from public.questions where prompt = 'st-empty'),
            'A real free-text answer', true, 'marked', 0.5,
            jsonb_build_object('rationale', 'Half right.',
                               'confidence', 0.8, 'model', 'glm'))$$,
  'a marked short_text row carrying mark_metadata JSONB is accepted');

-- ── §6 Student domain keeps scalar types only (D12) ───────────────────
-- student_quizzes is authored by the STUDENT profile, so the fixture uses
-- the same id as the lecturer here (any profile row satisfies the FK; the
-- type CHECKs are what these assertions target).

insert into public.student_quizzes (id, created_by, title)
values ('66666666-6666-6666-6666-666666666666',
        '11111111-1111-1111-1111-111111111111', 'I25 Practice')
on conflict (id) do nothing;

-- correct_index is NOT NULL on student_quiz_questions, so a 0 is supplied —
-- the type CHECK is still what must reject the row.
select throws_ok(
  $$insert into public.student_quiz_questions
      (quiz_id, order_index, type, prompt, options, correct_index)
    values ('66666666-6666-6666-6666-666666666666',
            0, 'short_text', 'nope', array['a','b'], 0)$$,
  '23514', null,
  'student_quiz_questions rejects short_text (D12 scope guard)');

select * from finish();
rollback;
