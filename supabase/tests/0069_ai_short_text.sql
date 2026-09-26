-- 0069 — save_quiz_questions_web accepts the AI-generated short_text shape.
-- Run: npx supabase test db
begin;

create extension if not exists pgtap;
select plan(8);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('69111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'lec-i69@test.local', 'x', now(), '{}', '{}', now(), now())
on conflict (id) do nothing;
insert into public.classes (id, lecturer_id, title, join_code)
values ('69333333-3333-3333-3333-333333333333', '69111111-1111-1111-1111-111111111111', 'I69 class', 'K26969')
on conflict (id) do nothing;
-- Gesture-off draft: the quiz shape AI generation targets with short_text.
insert into public.quizzes (id, class_id, created_by, title, mode, status, gestures_enabled)
values ('69444444-4444-4444-4444-444444444444', '69333333-3333-3333-3333-333333333333',
  '69111111-1111-1111-1111-111111111111', 'I69 quiz', 'assessment', 'draft', false)
on conflict (id) do nothing;

select set_config('request.jwt.claims',
  jsonb_build_object('sub', '69111111-1111-1111-1111-111111111111')::text, true);

-- ─── A mixed AI payload (mcq + multi + short_text) saves in one call ──────
select lives_ok(
  $$select public.save_quiz_questions_web(
    '69444444-4444-4444-4444-444444444444', 'I69 quiz', null, 'source material',
    '[
      {"type":"mcq","prompt":"Which structure is FIFO?","options":["Stack","Queue"],"correct_index":1,"explanation":"FIFO is a queue."},
      {"type":"multi_select","prompt":"Which structures are LIFO?","options":["Stack","Queue","Deque"],"correct_indices":[0,2],"explanation":"Stack and deque ends pop last-in-first."},
      {"type":"short_text","prompt":"Explain why a queue is FIFO.","options":[],"correct_index":null,"answer_key":"Items leave in arrival order.","explanation":"Arrival order defines the queue."}
    ]'::jsonb,
    'replace', null, null)$$,
  'mixed mcq/multi/short_text payload saves');

select is(
  (select answer_key from public.questions
    where quiz_id = '69444444-4444-4444-4444-444444444444' and type = 'short_text'),
  'Items leave in arrival order.',
  'short_text row stores the rubric in answer_key');

select ok(
  (select options = '{}'::text[] and correct_index is null and correct_indices is null
    from public.questions
    where quiz_id = '69444444-4444-4444-4444-444444444444' and type = 'short_text'),
  'short_text row is option-less and keyless (0052 shape)');

-- ─── Malformed short_text is rejected, not half-saved ─────────────────────
-- Append mode (single-row minimum) so the field check — not the count check —
-- is what fires.
select throws_ok(
  $$select public.save_quiz_questions_web(
    '69444444-4444-4444-4444-444444444444', 'I69 quiz', null, null,
    '[{"type":"short_text","prompt":"Explain queues.","options":[]}]'::jsonb,
    'append', null, null)$$,
  'P0001',
  'invalid_question_fields',
  'short_text without answer_key is rejected');

select throws_ok(
  $$select public.save_quiz_questions_web(
    '69444444-4444-4444-4444-444444444444', 'I69 quiz', null, null,
    '[{"type":"mcq","prompt":"Which is FIFO?","options":["Stack","Queue"],"correct_index":1,"answer_key":"stray"}]'::jsonb,
    'append', null, null)$$,
  'P0001',
  'invalid_question_fields',
  'a rubric on a choice row is rejected');

select throws_ok(
  $$select public.save_quiz_questions_web(
    '69444444-4444-4444-4444-444444444444', 'I69 quiz', null, null,
    '[{"type":"multi_select","prompt":"Which are prime?","options":["2","3","4"],"correct_indices":[0,1],"answer_key":"stray"}]'::jsonb,
    'append', null, null)$$,
  'P0001',
  'invalid_question_fields',
  'a rubric on a multi row is rejected, not silently dropped');

select throws_ok(
  $$select public.save_quiz_questions_web(
    '69444444-4444-4444-4444-444444444444', 'I69 quiz', null, null,
    '[{"type":"mcq","prompt":"Which is FIFO?","options":["Stack","Queue"],"correct_index":"abc"}]'::jsonb,
    'append', null, null)$$,
  'P0001',
  'invalid_question_fields',
  'a non-numeric correct_index raises invalid_question_fields, not 22P02');

select is(
  (select count(*)::int from public.questions
    where quiz_id = '69444444-4444-4444-4444-444444444444'),
  3,
  'rejected appends leave the saved rows untouched');

select * from finish();
rollback;
