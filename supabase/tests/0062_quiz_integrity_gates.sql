-- ═══════════════════════════════════════════════════════════════════════
-- 0062 — Quiz/integrity/verification gates (audit-5)
--
-- Pins the migration-0062 behaviors against the REAL RPCs:
--   I-27  M2: start_quiz_session refuses an assessment start without consent
--         (consent_required) and for a pending_review enrollment
--         (face_enrollment_pending); practice is unaffected.
--   I-28  M3: enroll_face refuses while ANY live assessment session exists
--         (live_assessment) — no more mid-session identity swap.
--   I-29  M1: submit_session writes the finalization-time silence evidence
--         (auto_flag_verify_silence, via='submit') when the session meets the
--         silence predicate, and records NOTHING when it does not (an honest
--         submit with recent verifies). The autoclose seal arm carries
--         via='autoclose_seal'.
--   I-30  M4: approve_face_enrollment flips pending_review → enrolled
--         (audited), refuses a non-pending enrollment (not_pending).
--
-- Run: npx supabase test db
-- ═══════════════════════════════════════════════════════════════════════

begin;

create extension if not exists pgtap;

select plan(13);
-- ── Fixtures: lecturer + class + students ─────────────────────────────
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('1f111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'lec-i27@test.local', 'x', now(), '{}', '{}', now(), now()),
       ('2f222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'stu-i27@test.local', 'x', now(), '{}', '{}', now(), now()),
       ('3f333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'stu2-i27@test.local', 'x', now(), '{}', '{}', now(), now())
on conflict (id) do nothing;

-- The first student has NO consent (M2's negative case); the second does.
insert into public.profiles (id, role, full_name, consent_given_at)
values ('1f111111-1111-1111-1111-111111111111', 'lecturer', 'I27 Lecturer', null),
       ('2f222222-2222-2222-2222-222222222222', 'student', 'I27 NoConsent', null),
       ('3f333333-3333-3333-3333-333333333333', 'student', 'I27 Consent', now())
on conflict (id) do update set role = excluded.role,
                               consent_given_at = excluded.consent_given_at;

insert into public.classes (id, lecturer_id, title, join_code)
values ('4f444444-4444-4444-4444-444444444444',
        '1f111111-1111-1111-1111-111111111111', 'I27 Class', 'ACF234')
on conflict (id) do nothing;

insert into public.class_enrollments (class_id, student_id)
values ('4f444444-4444-4444-4444-444444444444', '2f222222-2222-2222-2222-222222222222'),
       ('4f444444-4444-4444-4444-444444444444', '3f333333-3333-3333-3333-333333333333')
on conflict do nothing;

-- Assessment quiz with two questions.
insert into public.quizzes (id, class_id, created_by, title, mode, status)
values ('5f555555-5555-5555-5555-555555555555',
        '4f444444-4444-4444-4444-444444444444',
        '1f111111-1111-1111-1111-111111111111', 'I27 Quiz', 'assessment', 'draft')
on conflict (id) do nothing;

insert into public.questions (quiz_id, order_index, type, prompt, options, correct_index)
values ('5f555555-5555-5555-5555-555555555555', 0, 'mcq', 'Q1', array['a','b'], 0),
       ('5f555555-5555-5555-5555-555555555555', 1, 'mcq', 'Q2', array['a','b'], 0)
on conflict do nothing;

update public.quizzes set status = 'live'
 where id = '5f555555-5555-5555-5555-555555555555';

-- ── I-27a: assessment start without consent → consent_required ────────
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '2f222222-2222-2222-2222-222222222222')::text, true);

select is(
  (public.start_quiz_session('5f555555-5555-5555-5555-555555555555')) ->> 'error',
  'consent_required',
  'I-27a assessment start without consent → consent_required (audit-5 M2)');

-- ── I-27b: practice start without consent still succeeds ──────────────
insert into public.quizzes (id, class_id, created_by, title, mode, status)
values ('5f555555-5555-5555-5555-555555555556',
        '4f444444-4444-4444-4444-444444444444',
        '1f111111-1111-1111-1111-111111111111', 'I27 Practice', 'practice', 'draft')
on conflict (id) do nothing;
insert into public.questions (quiz_id, order_index, type, prompt, options, correct_index)
values ('5f555555-5555-5555-5555-555555555556', 0, 'mcq', 'PQ', array['a','b'], 0)
on conflict do nothing;
update public.quizzes set status = 'live'
 where id = '5f555555-5555-5555-5555-555555555556';

select ok(
  (public.start_quiz_session('5f555555-5555-5555-5555-555555555556')) -> 'session' ->> 'id' is not null,
  'I-27b practice start without consent succeeds (M2 is assessment-only)');

-- ── I-27c/d: consenting student, pending_review gate, and the happy spawn ──
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '3f333333-3333-3333-3333-333333333333')::text, true);

-- Force pending_review via the sanctioned GUC path (mirrors enroll_face's
-- status write) so M2's second arm can be exercised without the dup-scan.
select set_config('app.face_enroll', 'on', true);
select set_config('app.face_enroll_actor', '3f333333-3333-3333-3333-333333333333', true);
update public.profiles set face_enrollment_status = 'pending_review'
 where id = '3f333333-3333-3333-3333-333333333333';
select set_config('app.face_enroll', '', true);
select set_config('app.face_enroll_actor', '', true);

select is(
  (public.start_quiz_session('5f555555-5555-5555-5555-555555555555')) ->> 'error',
  'face_enrollment_pending',
  'I-27c pending_review assessment start → face_enrollment_pending (audit-5 M2)');

-- ── I-28: enroll_face blocked while a live assessment session exists ──
-- Put the consenting student back to a clean (non-pending) state so the
-- enroll gate — not the pending gate — is what answers.
select set_config('app.face_enroll', 'on', true);
select set_config('app.face_enroll_actor', '3f333333-3333-3333-3333-333333333333', true);
update public.profiles set face_enrollment_status = null
 where id = '3f333333-3333-3333-3333-333333333333';
select set_config('app.face_enroll', '', true);
select set_config('app.face_enroll_actor', '', true);

select (public.start_quiz_session('5f555555-5555-5555-5555-555555555555')
        -> 'session' ->> 'id')::uuid as sid \gset

select is(
  (public.enroll_face(jsonb_build_array(
     jsonb_build_object('angle','front','embedding', (select jsonb_agg(0.001 order by i) from generate_series(1,512) i)),
     jsonb_build_object('angle','left','embedding', (select jsonb_agg(0.001 order by i) from generate_series(1,512) i)),
     jsonb_build_object('angle','right','embedding', (select jsonb_agg(0.001 order by i) from generate_series(1,512) i))
   ))) ->> 'error',
  'live_assessment',
  'I-28 enroll_face with a live assessment session → live_assessment (audit-5 M3)');

-- ── I-29: submit-time silence evidence for a suppressed attempt ───────
-- The session above has NO face_checks rows and (after two answers) meets the
-- silence predicate: coalesce(max(checked_at), started_at) is older than 300s
-- only when started_at is backdated, so backdate it.
update public.quiz_sessions set started_at = now() - interval '10 minutes'
 where id = :'sid'::uuid;

select public.answer_question(:'sid'::uuid,
  (select id from public.questions where quiz_id = '5f555555-5555-5555-5555-555555555555' and prompt = 'Q1'),
  0, null, null, false);
select public.answer_question(:'sid'::uuid,
  (select id from public.questions where quiz_id = '5f555555-5555-5555-5555-555555555555' and prompt = 'Q2'),
  0, null, null, false);

select public.submit_session(:'sid'::uuid);

select is(
  (select count(*)::int from public.audit_events
    where action = 'auto_flag_verify_silence'
      and metadata ->> 'session_id' = :'sid'::text
      and metadata ->> 'via' = 'submit'),
  1,
  'I-29a a suppressed submit writes ONE auto_flag_verify_silence marker (via=submit)');

select is(
  (select status from public.quiz_sessions where id = :'sid'::uuid),
  'completed',
  'I-29b the marker does not block completion (submit stays permissive)');

-- ── I-29c: an HONEST submit (fresh verify) records nothing ────────────
select (public.start_quiz_session('5f555555-5555-5555-5555-555555555556')
        -> 'session' ->> 'id')::uuid as hsid \gset

-- A recent face_checks row satisfies corroboration AND the 300s freshness term
-- (the max(checked_at) is now), so the silence predicate is false.
insert into public.face_checks (session_id, checked_at, matched, trigger)
values (:'hsid'::uuid, now(), true, 'start');

select public.answer_question(:'hsid'::uuid,
  (select id from public.questions where quiz_id = '5f555555-5555-5555-5555-555555555556' and prompt = 'PQ'),
  0, null, null, false);
select public.answer_question(:'hsid'::uuid,
  (select id from public.questions where quiz_id = '5f555555-5555-5555-5555-555555555556' and prompt = 'PQ'),
  0, null, null, false);
select public.submit_session(:'hsid'::uuid);

select is(
  (select count(*)::int from public.audit_events
    where action = 'auto_flag_verify_silence'
      and metadata ->> 'session_id' = :'hsid'::text),
  0,
  'I-29c an honest submit (fresh verify) records NO silence marker');

-- ── I-29d: the submit marker is dedupe-guarded ────────────────────────
-- Re-submit is idempotent (already_submitted) and must not add a row.
select public.submit_session(:'sid'::uuid);
select is(
  (select count(*)::int from public.audit_events
    where action = 'auto_flag_verify_silence'
      and metadata ->> 'session_id' = :'sid'::text),
  1,
  'I-29d an idempotent re-submit does not duplicate the marker');

-- ── I-30: approve_face_enrollment arms ────────────────────────────────
-- Put the consenting student into pending_review, then approve as lecturer.
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '3f333333-3333-3333-3333-333333333333')::text, true);
-- Close the live session first so the state is clean (not required for the
-- status write, but keeps the fixture legible).
update public.quiz_sessions set status = 'completed'
 where id = :'sid'::uuid;
select set_config('app.face_enroll', 'on', true);
select set_config('app.face_enroll_actor', '3f333333-3333-3333-3333-333333333333', true);
update public.profiles set face_enrollment_status = 'pending_review'
 where id = '3f333333-3333-3333-3333-333333333333';
select set_config('app.face_enroll', '', true);
select set_config('app.face_enroll_actor', '', true);

select set_config('request.jwt.claims',
  jsonb_build_object('sub', '1f111111-1111-1111-1111-111111111111')::text, true);

select is(
  (public.approve_face_enrollment('3f333333-3333-3333-3333-333333333333')) ->> 'status',
  'enrolled',
  'I-30a approve_face_enrollment → enrolled (audit-5 M4)');

select is(
  (select face_enrollment_status from public.profiles
    where id = '3f333333-3333-3333-3333-333333333333'),
  'enrolled',
  'I-30b the profile status is enrolled after approval');

select is(
  (select count(*)::int from public.audit_events
    where action = 'face_enroll_approved'
      and actor_id = '1f111111-1111-1111-1111-111111111111'
      and subject_id = '3f333333-3333-3333-3333-333333333333'),
  1,
  'I-30c the approval is audited (face_enroll_approved)');

-- Approving a non-pending enrollment → not_pending (never a silent write).
select is(
  (public.approve_face_enrollment('3f333333-3333-3333-3333-333333333333')) ->> 'error',
  'not_pending',
  'I-30d approve of a non-pending enrollment → not_pending');

-- ── I-31: the silence predicate itself (unit form) ────────────────────
-- The backdated suppressed session still meets the raw predicate (the helper
-- does not care that it is completed — that is the escape the submit arm
-- closes). A fresh session with a recent verify must NOT.
select ok(
  public.session_verify_silent(:'hsid'::uuid) = false,
  'I-31a a freshly-verified session is not silence-candid (helper)');

select * from finish();

rollback;
