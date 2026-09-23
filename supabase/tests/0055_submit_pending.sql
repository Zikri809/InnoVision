-- ═══════════════════════════════════════════════════════════════════════
-- I-20 — Submit with pending marks: provisional score, gated completion
--        (PLAN_GESTURE_OFF_RICH_TYPES §4, migrations 0055/0056)
--
-- The pending-aware completion rules live in the RECREATED bodies of
-- submit_session (0055) and quiz_autoclose (0056), so this file tests THOSE.
--
-- What is pinned:
--   * a pending answer contributes 0 to the score (D10 SUM + pending filter)
--   * v_all_done is FALSE while any answer quiz-wide is pending → no reveal
--   * quiz_autoclose's reveal arm refuses for the same reason
--   * the completed-count / digest excludes sessions holding pending answers
--   * the D10 arithmetic survives a 0.5 mark (NUMERIC, not rounded)
--   * skip = resolved (it is NOT pending) and counts as a graded 0
--
-- Run: npx supabase test db
-- ═══════════════════════════════════════════════════════════════════════

begin;

create extension if not exists pgtap;

select plan(31);

-- ── Fixtures ──────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('1a111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'lect-i20@test.local', 'x', now(), '{}', '{}', now(), now()),
       ('2a222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'stu-i20@test.local', 'x', now(), '{}', '{}', now(), now())
on conflict (id) do nothing;

-- audit-5 M2: start_quiz_session requires biometric consent for assessment
-- mode, so the fixture student carries it (the same state registration sets).
insert into public.profiles (id, role, full_name, consent_given_at)
values ('1a111111-1111-1111-1111-111111111111', 'lecturer', 'I20 Lecturer', null),
       ('2a222222-2222-2222-2222-222222222222', 'student', 'I20 Student', now())
on conflict (id) do update set role = excluded.role, consent_given_at = excluded.consent_given_at;

insert into public.classes (id, lecturer_id, title, join_code)
values ('3a333333-3333-3333-3333-333333333333',
        '1a111111-1111-1111-1111-111111111111', 'I20 Class', 'ACD234')
on conflict (id) do nothing;

insert into public.class_enrollments (class_id, student_id)
values ('3a333333-3333-3333-3333-333333333333',
        '2a222222-2222-2222-2222-222222222222')
on conflict do nothing;

insert into public.quizzes (id, class_id, created_by, title, mode, status,
  auto_reveal_on_complete)
values ('4a444444-4444-4444-4444-444444444444',
        '3a333333-3333-3333-3333-333333333333',
        '1a111111-1111-1111-1111-111111111111',
        'I20 Quiz', 'assessment', 'draft', true)
on conflict (id) do nothing;

select set_config('request.jwt.claims',
  jsonb_build_object('sub', '1a111111-1111-1111-1111-111111111111')::text, true);

select public.append_question('4a444444-4444-4444-4444-444444444444', 'mcq',
  'Q-mcq', array['a','b'], 0, null, null, null, 1);
select public.append_question('4a444444-4444-4444-4444-444444444444', 'short_text',
  'Q-text', array[]::text[], null, null, null, 'Rubric', 1);
select public.append_question('4a444444-4444-4444-4444-444444444444', 'mcq',
  'Q-skip', array['a','b'], 0, null, null, null, 1);
update public.quizzes set status = 'live'
 where id = '4a444444-4444-4444-4444-444444444444';

-- ── Start a session as the student ────────────────────────────────────
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '2a222222-2222-2222-2222-222222222222')::text, true);

select (public.start_quiz_session('4a444444-4444-4444-4444-444444444444')
        -> 'session' ->> 'id')::uuid as sid \gset

-- ── §1 The pending row's contribution ─────────────────────────────────
select is(
  (public.answer_question(:'sid'::uuid,
     (select id from public.questions where prompt = 'Q-mcq'),
     0, null, null, false)) ->> 'recorded',
  'true',
  'an mcq answer in assessment is recorded keylessly');

select is(
  (public.answer_question(:'sid'::uuid,
     (select id from public.questions where prompt = 'Q-text'),
     null, null, 'A short answer', false)) ->> 'recorded',
  'true',
  'a short_text answer is recorded (it becomes pending)');

select is(
  (select mark_status from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions where prompt = 'Q-text')),
  'pending',
  'the short_text answer lands PENDING');

select is(
  (select mark_score from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions where prompt = 'Q-text')),
  null,
  'a pending row carries NO mark_score');

select is(
  (select count(*) from public.ai_marking_ledger
    where session_id = :'sid'::uuid),
  1::bigint,
  'answering short_text queues exactly one ledger row');

select is(
  (select idempotency_key from public.ai_marking_ledger
    where session_id = :'sid'::uuid),
  :'sid' || ':' ||
    (select id from public.questions where prompt = 'Q-text')::text || ':1',
  'the ledger key is {session}:{question}:{attempt_version} (epoch 1)');

-- A skip is RESOLVED, not pending — it must not hold the reveal.
select is(
  (public.answer_question(:'sid'::uuid,
     (select id from public.questions where prompt = 'Q-skip'),
     null, null, null, true)) ->> 'recorded',
  'true',
  'a skip is recorded');

select is(
  (select skipped from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions where prompt = 'Q-skip')),
  true,
  'the skipped row is marked skipped');

select is(
  (select mark_status from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions where prompt = 'Q-skip')),
  'marked',
  'a skipped row is RESOLVED (mark_status=marked), never pending');

select is(
  (select mark_score from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions where prompt = 'Q-skip')),
  0::numeric,
  'a skipped row scores a graded 0');

-- ── §2 pending_count surface ──────────────────────────────────────────
select is(
  (public.student_pending_count(:'sid'::uuid)) ->> 'pending_count',
  '1',
  'student_pending_count reports the one unresolved answer');

select is(
  (public.student_pending_count(:'sid'::uuid)) ->> 'revealed',
  'false',
  'student_pending_count is NOT reveal-gated (it answers pre-reveal)');

select is(
  (public.student_pending_count('99999999-9999-9999-9999-999999999999')) ->> 'error',
  'not_found',
  'a foreign session id returns not_found (no oracle)');

-- ── §3 Submit: provisional score, no reveal ───────────────────────────
select is(
  (public.submit_session(:'sid'::uuid)) ->> 'score',
  null,
  'the unrevealed assessment submit returns score:null (L10 preserved)');

select is(
  (select score from public.quiz_sessions where id = :'sid'::uuid),
  1::numeric,
  'the STORED score counts only resolved answers (mcq 1 + skip 0, pending excluded)');

select is(
  (select results_revealed_at from public.quizzes
    where id = '4a444444-4444-4444-4444-444444444444'),
  null,
  'v_all_done is FALSE while an answer is pending → NO auto-reveal (L4)');

-- ── §4 quiz_autoclose's reveal arm also refuses (L4) ──────────────────
-- Make the session stale so the 2h activity term is satisfied; the pending
-- term must still hold the reveal.
update public.quiz_sessions
   set last_activity_at = clock_timestamp() - interval '3 hours'
 where id = :'sid'::uuid;

select lives_ok(
  $$select public.quiz_autoclose()$$,
  'quiz_autoclose runs');

select is(
  (select results_revealed_at from public.quizzes
    where id = '4a444444-4444-4444-4444-444444444444'),
  null,
  'autoclose does NOT reveal a quiz with a pending answer (L4)');

-- ── §5 Digest / completed-count excludes pending sessions (L5) ────────
select is(
  (select count(*) from public.notifications
    where dedupe_key = 'quiz_completed_all:4a444444-4444-4444-4444-444444444444'),
  0::bigint,
  'quiz_completed_all does NOT fire while a session holds a pending answer (L5)');

-- ── §6 Resolving the pending mark releases the gate ───────────────────
-- Finalize with a 0.5 mark: exercises the D10 arithmetic AND the release.
select (select claim_token from public.ai_marking_ledger
         where session_id = :'sid'::uuid) as token \gset

select set_config('request.jwt.claims',
  jsonb_build_object('sub', '1a111111-1111-1111-1111-111111111111')::text, true);

-- ── §6 Resolving the pending mark releases the gate ───────────────────
-- Finalize with a 0.5 mark: exercises the D10 arithmetic AND the release.
-- The real flow is claim-then-finalize: the sweep mints the claim_token the
-- finalizer's A6-4 guard requires, so the token must come FROM the sweep
-- (reading a bare status='marking' row would not be a claim).
-- The sweep is service_role-only; pgTAP runs as the DB superuser, so the
-- EXECUTE grant is not what is under test here.
select set_config('request.jwt.claims', '', true);

-- Isolation: `sweep_ai_marks()` is GLOBAL, so pre-existing claimable rows in
-- a persistent local DB (E2E residue) would inflate the batch. Park them at a
-- non-claimable status for this transaction only — the closing ROLLBACK
-- restores them exactly. EXCLUDE this fixture's own row, which the assertions
-- below depend on.
create temporary table parked_ledger as
  select id from public.ai_marking_ledger
   where status in ('queued', 'failed', 'marking')
     and session_id <> :'sid'::uuid;
update public.ai_marking_ledger
   set status = 'needs_review', claim_token = null
 where id in (select id from parked_ledger);

select is(
  (public.sweep_ai_marks()) ->> 'count',
  '1',
  'the sweep CLAIMS the queued short_text row');

select is(
  (select status from public.ai_marking_ledger where session_id = :'sid'::uuid),
  'marking',
  'the claimed ledger row moves to marking');

select (select claim_token from public.ai_marking_ledger
         where session_id = :'sid'::uuid)::text as token \gset

select isnt(
  :'token'::text,
  ''::text,
  'the claim mints a claim_token (A5-1)');

select is(
  (public.finalize_ai_mark(jsonb_build_array(jsonb_build_object(
    'ledger_id', (select id from public.ai_marking_ledger where session_id = :'sid'::uuid),
    'session_id', :'sid'::uuid,
    'question_id', (select id from public.questions where prompt = 'Q-text'),
    'attempt_version', 1,
    'claim_token', :'token'::uuid,
    'ok', true, 'score', 0.5, 'confidence', 0.9,
    'rationale', 'Half credit.', 'tokens', 100, 'usd', 0.001
  )))) ->> 'applied',
  '1',
  'the finalizer applies the AI mark');

select is(
  (select score from public.quiz_sessions where id = :'sid'::uuid),
  1.5::numeric,
  'D10: a 0.5 mark survives the recompute (NUMERIC — no rounding to 2)');

select is(
  (select is_correct from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions where prompt = 'Q-text')),
  true,
  'A7-4: is_correct is set from the mark (score >= 0.5), so the UI does not show a red X');

select is(
  (select results_revealed_at is not null from public.quizzes
    where id = '4a444444-4444-4444-4444-444444444444'),
  true,
  'with pending resolved, the completion check reveals the quiz (L2/L5/X2-7)');

-- ── §7 already_submitted RECOMPUTE (C5-7/L10 — audit-4 M6) ────────────
-- The session is now completed (score 1.5, revealed). A re-submit must NOT
-- echo the stored score blindly: C5-7 recomputes so a mark changed AFTER
-- submit — exactly what the override below does — reaches the student's own
-- re-read. This is the highest-risk new block in submit_session and had no
-- test at all.
--
-- Drive it as the lecturer: override Q-mcq (the stored mcq row) from 1 → 0.5.
-- The prompt's stored score must then recompute to 0.5 (mcq) + 0.5 (text) = 1.
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '1a111111-1111-1111-1111-111111111111')::text, true);

select is(
  (public.override_answer_mark(:'sid'::uuid,
     (select id from public.questions where prompt = 'Q-mcq'), 0.5,
     'Audit: half credit on the mcq after submit')) ->> 'ok',
  'true',
  'M6 setup: the lecturer overrides an already-submitted mcq to 0.5');

-- The override above re-published (NULLed) `results_revealed_at` by design
-- (D2-7) — a re-submit would otherwise hit the L10 null arm, not the recompute
-- arm. Re-reveal first so the recompute's SCORE is observable; the null arm is
-- pinned after this block.
update public.quizzes
   set results_revealed_at = clock_timestamp()
 where id = '4a444444-4444-4444-4444-444444444444';

select set_config('request.jwt.claims',
  jsonb_build_object('sub', '2a222222-2222-2222-2222-222222222222')::text, true);

select is(
  ((public.submit_session(:'sid'::uuid)) ->> 'score')::numeric,
  1::numeric,
  'C5-7: a re-submit RECOMPUTES (0.5 + 0.5 = 1), it does not return the stale stored 1.5');

select is(
  (public.submit_session(:'sid'::uuid)) ->> 'already_submitted',
  'true',
  'the recompute path still advertises already_submitted');

select is(
  (select score from public.quiz_sessions where id = :'sid'::uuid),
  1::numeric,
  'the stored session score was refreshed to the recomputed 1');

-- The L10 arm: a re-submit on an UNREVEALED assessment returns score:null even
-- though the recompute just ran. Un-reveal the quiz directly — the one-way
-- trigger permits non-null→NULL only under the override GUC, so arm it for the
-- setup write and clear it again before the assertion.
select set_config('app.mark_overridden', 'on', true);
update public.quizzes
   set results_revealed_at = null
 where id = '4a444444-4444-4444-4444-444444444444';
select set_config('app.mark_overridden', 'off', true);

select is(
  (public.submit_session(:'sid'::uuid)) ->> 'score',
  null,
  'L10: the recompute is still reveal-gated — score:null while unrevealed');

select * from finish();
rollback;
