-- 0067 — an assessment answer and its fresh identity verdict commit together.
-- Run: npx supabase test db
begin;

create extension if not exists pgtap;
select plan(10);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('6f111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'stu-i67@test.local', 'x', now(), '{}', '{}', now(), now())
on conflict (id) do nothing;
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('6f222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'lec-i67@test.local', 'x', now(), '{}', '{}', now(), now())
on conflict (id) do nothing;
insert into public.profiles (id, role, full_name, consent_given_at, face_enrollment_status)
values ('6f111111-1111-1111-1111-111111111111', 'student', 'I67 Student', now(), null),
       ('6f222222-2222-2222-2222-222222222222', 'lecturer', 'I67 Lecturer', null, null)
on conflict (id) do update set role = excluded.role,
  consent_given_at = excluded.consent_given_at;
insert into public.classes (id, lecturer_id, title, join_code)
values ('6f333333-3333-3333-3333-333333333333', '6f222222-2222-2222-2222-222222222222', 'I67 class', 'K23456')
on conflict (id) do nothing;
insert into public.class_enrollments (class_id, student_id)
values ('6f333333-3333-3333-3333-333333333333', '6f111111-1111-1111-1111-111111111111')
on conflict do nothing;
insert into public.quizzes (id, class_id, created_by, title, mode, status, gestures_enabled)
values ('6f444444-4444-4444-4444-444444444444', '6f333333-3333-3333-3333-333333333333',
  '6f222222-2222-2222-2222-222222222222', 'I67 quiz', 'assessment', 'draft', true)
on conflict (id) do nothing;
insert into public.questions (id, quiz_id, order_index, type, prompt, options, correct_index)
values ('6f555555-5555-5555-5555-555555555555', '6f444444-4444-4444-4444-444444444444',
  0, 'mcq', 'I67 question', array['a','b'], 0)
on conflict (id) do nothing;
update public.quizzes set status = 'live', gestures_enabled = true
 where id = '6f444444-4444-4444-4444-444444444444' and status = 'draft';

-- A second fixture quiz has the lecturer toggle disabled before publication;
-- gestures_enabled is intentionally frozen once a quiz goes live.
insert into public.quizzes (id, class_id, created_by, title, mode, status, gestures_enabled)
values ('6f666666-6666-6666-6666-666666666666', '6f333333-3333-3333-3333-333333333333',
  '6f222222-2222-2222-2222-222222222222', 'I67 exempt quiz', 'assessment', 'draft', false)
on conflict (id) do nothing;
insert into public.questions (id, quiz_id, order_index, type, prompt, options, correct_index)
values ('6f777777-7777-7777-7777-777777777777', '6f666666-6666-6666-6666-666666666666',
  0, 'mcq', 'I67 exempt question', array['a','b'], 0)
on conflict (id) do nothing;
update public.quizzes set status = 'live'
 where id = '6f666666-6666-6666-6666-666666666666' and status = 'draft';

select set_config('request.jwt.claims',
  jsonb_build_object('sub', '6f111111-1111-1111-1111-111111111111')::text, true);
select set_config('app.face_enroll', 'on', true);
select set_config('app.face_enroll_actor', '6f111111-1111-1111-1111-111111111111', true);
update public.profiles set face_enrollment_status = 'enrolled'
 where id = '6f111111-1111-1111-1111-111111111111';
select set_config('app.face_enroll', '', true);
select set_config('app.face_enroll_actor', '', true);
select (public.start_quiz_session('6f444444-4444-4444-4444-444444444444') -> 'session' ->> 'id')::uuid as sid \gset

select is(
  public.commit_answer(:'sid'::uuid, '6f555555-5555-5555-5555-555555555555'::uuid, 0,
    null::int[], null::text, false, null::uuid, null::text[], null::real[],
    null::text, null::text, null::jsonb) ->> 'error',
  'face_verification_required',
  'gesture-enabled assessment holds an answer with no fresh frames');
select is(
  (select count(*)::int from public.session_answers where session_id = :'sid'::uuid),
  0,
  'missing verification leaves the answer table unchanged');

-- Supply valid route-style frame and answer HMACs but a no-match verdict.
-- record_face_check must commit its mismatch/paused state while the answer
-- write remains absent. This pins transaction-safe typed error semantics.
with session_row as (
  select id, verify_nonce as nonce from public.quiz_sessions where id = :'sid'::uuid
), proof_inputs as (
  select s.id, s.nonce, secret.secret,
    '|frame-a|frame-b|frame-c'::text as frame_concat,
    encode(extensions.digest('|frame-a|frame-b|frame-c', 'sha256'), 'hex') as frame_hash
  from session_row s cross join app_private.verify_proof_secret secret where secret.id = 1
), proof_values as (
  select *,
    encode(extensions.hmac(id::text || ':' || nonce::text || ':' || frame_concat, secret, 'sha256'), 'hex') as frame_proof,
    encode(extensions.hmac(
    'answer:' || id::text || ':' || nonce::text || ':' || frame_hash || ':' ||
      octet_length(convert_to('6f555555-5555-5555-5555-555555555555', 'UTF8'))::text || ':' ||
      '6f555555-5555-5555-5555-555555555555' || '1:0-:-:5:false', secret, 'sha256'), 'hex') as answer_proof
  from proof_inputs
)
select (public.commit_answer(
  id, '6f555555-5555-5555-5555-555555555555', 0, null, null, false,
  nonce, array['frame-a','frame-b','frame-c'], array[0.1::real,0.1::real,0.1::real],
  frame_proof, answer_proof, '[]'::jsonb
) ->> 'error') as mismatch from proof_values \gset
select is(:'mismatch'::text, 'face_mismatch', 'a validly bound no-match returns face_mismatch');
select is(
  (select count(*)::int from public.face_checks where session_id = :'sid'::uuid and matched = false),
  1,
  'the rejected answer still commits its mismatch audit row');
select is(
  (select status::text from public.quiz_sessions where id = :'sid'::uuid),
  'paused',
  'the mismatch keeps the session paused');
select is(
  (select count(*)::int from public.session_answers where session_id = :'sid'::uuid),
  0,
  'mismatch does not save the answer');

-- The lecturer-controlled gesture toggle is the only quiz-level face bypass.
select (public.start_quiz_session('6f666666-6666-6666-6666-666666666666') -> 'session' ->> 'id')::uuid as sid2 \gset
select is(
  public.commit_answer(:'sid2'::uuid, '6f777777-7777-7777-7777-777777777777'::uuid, 0,
    null::int[], null::text, false, null::uuid, null::text[], null::real[],
    null::text, null::text, null::jsonb) ->> 'recorded',
  'true',
  'gesture-disabled assessment accepts an answer without face evidence');
select is(
  (select count(*)::int from public.session_answers where session_id = :'sid2'::uuid),
  1,
  'gesture-disabled answer is saved');
select ok(
  not has_function_privilege('authenticated', 'public.answer_question(uuid,uuid,int,int[],text,boolean)', 'EXECUTE'),
  'authenticated cannot bypass commit_answer through the legacy RPC');
select ok(
  not has_function_privilege('anon', 'public.answer_question(uuid,uuid,int,int[],text,boolean)', 'EXECUTE'),
  'anon cannot call the legacy answer RPC');

select * from finish();
rollback;
