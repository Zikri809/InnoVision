-- ═══════════════════════════════════════════════════════════════════════
-- I-24 — Sweep lifecycle: claim → mark → finalize → retry → escalate
--        (migration 0057)
--
-- The end-to-end contract for AI marking, including the three holes the
-- plan's critic rounds closed:
--
--   R3-M2  a transient FAILURE must retry, not finalize the answer at 0
--   A6-1   rows at attempts >= 3 must be REACHABLE (a queued-only or
--          failed-and-under-cap-only predicate strands the answer pending,
--          which blocks v_all_done for the whole class)
--   A6-4   the finalizer writes ONLY for the claim_token it was handed, so a
--          superseded worker cannot clobber a newer result
--   D2-13  the epoch guard makes a lecturer override win over a late AI write
--   R3-MIN3 a discarded row is closed as 'marked', never left in 'marking'
--
-- Run: npx supabase test db
-- ═══════════════════════════════════════════════════════════════════════

begin;

create extension if not exists pgtap;

select plan(46);

-- ── Isolation from pre-existing claimable rows ────────────────────────
-- `sweep_ai_marks()` and `escalate_stale_marks()` are GLOBAL by design (one
-- cron, one sweep, every claimable row), so a persistent local DB carrying
-- residue from an E2E run — or from a previous, interrupted suite — would
-- inflate every batch count and break the single-token assertion.
--
-- Park those rows at a NON-claimable status for the duration of this
-- transaction. The file's closing ROLLBACK restores them exactly, so this is
-- an isolation device, not a mutation. `needs_review` is chosen because it is
-- terminal for both RPCs (neither the claim predicate nor the escalation
-- predicate matches it).
create temporary table parked_ledger as
  select id from public.ai_marking_ledger
   where status in ('queued', 'failed', 'marking');
update public.ai_marking_ledger
   set status = 'needs_review', claim_token = null
 where id in (select id from parked_ledger);

-- ── Fixtures ──────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('1c111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'lect-i24@test.local', 'x', now(), '{}', '{}', now(), now()),
       ('2c222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'stu-i24@test.local', 'x', now(), '{}', '{}', now(), now())
on conflict (id) do nothing;

-- audit-5 M2: start_quiz_session requires biometric consent for assessment
-- mode, so the fixture student carries it (the same state registration sets).
insert into public.profiles (id, role, full_name, consent_given_at)
values ('1c111111-1111-1111-1111-111111111111', 'lecturer', 'I24 Lecturer', null),
       ('2c222222-2222-2222-2222-222222222222', 'student', 'I24 Student', now())
on conflict (id) do update set role = excluded.role, consent_given_at = excluded.consent_given_at;

insert into public.classes (id, lecturer_id, title, join_code)
values ('3c333333-3333-3333-3333-333333333333',
        '1c111111-1111-1111-1111-111111111111', 'I24 Class', 'ACD456')
on conflict (id) do nothing;

insert into public.class_enrollments (class_id, student_id)
values ('3c333333-3333-3333-3333-333333333333',
        '2c222222-2222-2222-2222-222222222222')
on conflict do nothing;

insert into public.quizzes (id, class_id, created_by, title, mode, status)
values ('4c444444-4444-4444-4444-444444444444',
        '3c333333-3333-3333-3333-333333333333',
        '1c111111-1111-1111-1111-111111111111', 'I24 Quiz', 'assessment', 'draft')
on conflict (id) do nothing;

select set_config('request.jwt.claims',
  jsonb_build_object('sub', '1c111111-1111-1111-1111-111111111111')::text, true);

select public.append_question('4c444444-4444-4444-4444-444444444444', 'short_text',
  'S1', array[]::text[], null, null, null, 'Rubric one', 1);
select public.append_question('4c444444-4444-4444-4444-444444444444', 'short_text',
  'S2', array[]::text[], null, null, null, 'Rubric two', 1);
select public.append_question('4c444444-4444-4444-4444-444444444444', 'short_text',
  'S3', array[]::text[], null, null, null, 'Rubric three', 1);

update public.quizzes set status = 'live'
 where id = '4c444444-4444-4444-4444-444444444444';

select set_config('request.jwt.claims',
  jsonb_build_object('sub', '2c222222-2222-2222-2222-222222222222')::text, true);

select (public.start_quiz_session('4c444444-4444-4444-4444-444444444444')
        -> 'session' ->> 'id')::uuid as sid \gset

select public.answer_question(:'sid'::uuid,
  (select id from public.questions where prompt = 'S1'), null, null, 'answer one', false);
select public.answer_question(:'sid'::uuid,
  (select id from public.questions where prompt = 'S2'), null, null, 'answer two', false);
select public.answer_question(:'sid'::uuid,
  (select id from public.questions where prompt = 'S3'), null, null, 'answer three', false);

-- ── §1 The claim ──────────────────────────────────────────────────────
select set_config('request.jwt.claims', '', true);

select is(
  (public.sweep_ai_marks()) ->> 'count',
  '3',
  'the sweep claims all three queued rows');

select is(
  (select count(*) from public.ai_marking_ledger
    where status = 'marking' and quiz_id = '4c444444-4444-4444-4444-444444444444'),
  3::bigint,
  'all three ledger rows are in marking');

-- Scoped to THIS quiz: the parking statement deliberately spares the
-- fixture's own rows, so a concurrent E2E run (or earlier residue) can leave
-- other claimable rows in the table that a later sweep would also claim.
select is(
  (select count(distinct claim_token) from public.ai_marking_ledger
    where quiz_id = '4c444444-4444-4444-4444-444444444444'),
  1::bigint,
  'A5-1: the batch shares ONE claim_token (the worker''s identity)');

select is(
  (select count(*) from public.ai_marking_ledger
    where attempts = 1 and quiz_id = '4c444444-4444-4444-4444-444444444444'),
  3::bigint,
  'A6-10: the claim advances attempts to 1');

-- A second sweep must NOT re-claim OUR in-flight rows (the lease is 5 min).
-- Scoped to this quiz: a global count would include another suite's residue.
select is(
  (public.sweep_ai_marks() -> 'rows') @> (
    select jsonb_agg(jsonb_build_object('session_id', l.session_id))
      from public.ai_marking_ledger l
     where l.quiz_id = '4c444444-4444-4444-4444-444444444444'
       and l.status = 'marking'
  ),
  false,
  'a second sweep does NOT re-claim this quiz''s fresh in-flight rows (the 5-min lease)');

-- ── §1b FS-3 lease recovery (audit-4 M12) ─────────────────────────────
-- The assertion above only proves a FRESH row is left alone. The lease's whole
-- point is the opposite case: a worker that crashed mid-batch leaves the row in
-- 'marking' forever, the answer stays pending, and v_all_done blocks the class.
-- Age S2's claim past the 5-minute lease and prove the next sweep re-claims it.
update public.ai_marking_ledger
   set claimed_at = now() - interval '6 minutes'
 where quiz_id = '4c444444-4444-4444-4444-444444444444'
   and question_id = (select id from public.questions where prompt = 'S2');

select is(
  (select count(*) from jsonb_array_elements(public.sweep_ai_marks() -> 'rows') r
    where (r ->> 'question_id')::uuid = (select id from public.questions where prompt = 'S2')),
  1::bigint,
  'FS-3: a claim staler than the 5-min lease IS re-claimed (crashed-worker recovery)');

select is(
  (select attempts from public.ai_marking_ledger
    where quiz_id = '4c444444-4444-4444-4444-444444444444'
      and question_id = (select id from public.questions where prompt = 'S2')),
  2,
  'the lease re-claim advances attempts (so a crash-loop still escalates)');

-- The lease re-claim minted a NEW token for S2. Capture it for §4: a finalize
-- carrying the superseded batch token is (correctly) discarded, so the
-- low-confidence assertions must use the re-claim's token.
select (select claim_token from public.ai_marking_ledger
         where question_id = (select id from public.questions where prompt = 'S2'))::text as tok2 \gset

-- ── §2 The A6-4 token guard ───────────────────────────────────────────
select (select claim_token from public.ai_marking_ledger
         where question_id = (select id from public.questions where prompt = 'S1'))::text as tok \gset

select is(
  (public.finalize_ai_mark(jsonb_build_array(jsonb_build_object(
    'ledger_id', (select id from public.ai_marking_ledger
                   where question_id = (select id from public.questions where prompt = 'S1')),
    'session_id', :'sid'::uuid,
    'question_id', (select id from public.questions where prompt = 'S1'),
    'attempt_version', 1,
    -- A DIFFERENT token: models a superseded worker's late finalize.
    'claim_token', '00000000-0000-0000-0000-0000000000ff'::uuid,
    'ok', true, 'score', 1, 'confidence', 0.99,
    'rationale', 'superseded', 'tokens', 10, 'usd', 0.0001
  )))) ->> 'discarded',
  '1',
  'A6-4: a finalize carrying a STALE claim_token is discarded');

select is(
  (select mark_status from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions where prompt = 'S1')),
  'pending',
  'A6-4: the stale-token finalize wrote NOTHING (the answer stays pending)');

-- audit-4 M12: the OLD test stopped at "answer stayed pending" — which a
-- finalizer that simply no-op'd on everything would also satisfy. Pin the
-- ledger half: the row must remain `marking` with its ORIGINAL token, so a
-- subsequently-token-valid finalize can still land. A bug that closed/captured
-- the row on a stale-token call would strand a legitimately-claimed mark.
select is(
  (select status from public.ai_marking_ledger
    where question_id = (select id from public.questions where prompt = 'S1')),
  'marking',
  'A6-4: the stale-token finalize leaves the ledger row in marking (claim intact)');

select is(
  (select claim_token from public.ai_marking_ledger
    where question_id = (select id from public.questions where prompt = 'S1')),
  :'tok'::uuid,
  'A6-4: the stale-token finalize does NOT consume the real claim_token');

-- ── §3 A successful finalize ──────────────────────────────────────────
select is(
  (public.finalize_ai_mark(jsonb_build_array(jsonb_build_object(
    'ledger_id', (select id from public.ai_marking_ledger
                   where question_id = (select id from public.questions where prompt = 'S1')),
    'session_id', :'sid'::uuid,
    'question_id', (select id from public.questions where prompt = 'S1'),
    'attempt_version', 1,
    'claim_token', :'tok'::uuid,
    'ok', true, 'score', 1, 'confidence', 0.95,
    'rationale', 'Correct.', 'tokens', 150, 'usd', 0.0015
  )))) ->> 'applied',
  '1',
  'the correct-token finalize applies');

select is(
  (select mark_status from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions where prompt = 'S1')),
  'marked',
  'a high-confidence mark lands as marked');

select is(
  (select mark_metadata ->> 'rationale' from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions where prompt = 'S1')),
  'Correct.',
  'S7: the AI rationale is persisted (for plain-text rendering)');

select is(
  (select tokens from public.ai_marking_ledger
    where question_id = (select id from public.questions where prompt = 'S1')),
  150,
  'the actual token count is reconciled back into the ledger (FS-9)');

-- ── §4 Low confidence → needs_review, score STANDS ────────────────────
-- S2's claim is the LEASE RE-CLAIM's (tok2), not the original batch token:
-- the re-claim superseded the first token by design, and a finalize carrying
-- the superseded token is discarded (A6-4) — which is exactly what the A6-4
-- assertion above pins for S1.
select is(
  (public.finalize_ai_mark(jsonb_build_array(jsonb_build_object(
    'ledger_id', (select id from public.ai_marking_ledger
                   where question_id = (select id from public.questions where prompt = 'S2')),
    'session_id', :'sid'::uuid,
    'question_id', (select id from public.questions where prompt = 'S2'),
    'attempt_version', 1,
    'claim_token', :'tok2'::uuid,
    'ok', true, 'score', 0.5, 'confidence', 0.4,
    'rationale', 'Uncertain.', 'tokens', 120, 'usd', 0.001
  )))) ->> 'applied',
  '1',
  'a low-confidence mark is applied');

select is(
  (select mark_status from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions where prompt = 'S2')),
  'needs_review',
  'confidence < 0.55 routes the answer to needs_review');

select is(
  (select mark_score from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions where prompt = 'S2')),
  0.5::numeric,
  'the low-confidence score STANDS (a human confirms it; it is not zeroed)');

-- ── §5 A FAILED mark stays pending and retries (R3-M2) ────────────────
select is(
  (public.finalize_ai_mark(jsonb_build_array(jsonb_build_object(
    'ledger_id', (select id from public.ai_marking_ledger
                   where question_id = (select id from public.questions where prompt = 'S3')),
    'session_id', :'sid'::uuid,
    'question_id', (select id from public.questions where prompt = 'S3'),
    'attempt_version', 1,
    'claim_token', :'tok'::uuid,
    'ok', false, 'tokens', 0, 'usd', 0
  )))) ->> 'failed',
  '1',
  'a model failure is recorded as failed');

select is(
  (select status from public.ai_marking_ledger
    where question_id = (select id from public.questions where prompt = 'S3')),
  'failed',
  'the ledger row is marked failed');

select is(
  (select mark_status from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions where prompt = 'S3')),
  'pending',
  'R3-M2: the ANSWER stays pending so the sweep retries it (not finalised at 0)');

select is(
  (select count(*) from jsonb_array_elements(public.sweep_ai_marks() -> 'rows') r
    where (r ->> 'question_id')::uuid = (select id from public.questions where prompt = 'S3')),
  1::bigint,
  'R3-M2: the next sweep RE-CLAIMS the failed row');

select is(
  (select attempts from public.ai_marking_ledger
    where question_id = (select id from public.questions where prompt = 'S3')),
  2,
  'the retry advances attempts to 2');

-- ── §6 The override wins over a late AI write (D2-13) ─────────────────
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '1c111111-1111-1111-1111-111111111111')::text, true);

select is(
  (public.override_answer_mark(:'sid'::uuid,
     (select id from public.questions where prompt = 'S3'), 1,
     'Lecturer adjudicates while the AI is still working')) ->> 'ok',
  'true',
  'a lecturer overrides the in-flight answer');

select (select claim_token from public.ai_marking_ledger
         where question_id = (select id from public.questions where prompt = 'S3'))::text as tok3 \gset

select set_config('request.jwt.claims', '', true);

select is(
  (public.finalize_ai_mark(jsonb_build_array(jsonb_build_object(
    'ledger_id', (select id from public.ai_marking_ledger
                   where question_id = (select id from public.questions where prompt = 'S3')),
    'session_id', :'sid'::uuid,
    'question_id', (select id from public.questions where prompt = 'S3'),
    'attempt_version', 2,   -- the retry's epoch view
    'claim_token', :'tok3'::uuid,
    'ok', true, 'score', 0, 'confidence', 0.99,
    'rationale', 'Late AI write.', 'tokens', 90, 'usd', 0.001
  )))) ->> 'discarded',
  '1',
  'D2-13: the late AI write is DISCARDED (the override bumped attempt_version)');

select is(
  (select mark_score from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions where prompt = 'S3')),
  1::numeric,
  'the override''s mark survives (the AI did not clobber the adjudication)');

select is(
  (select status from public.ai_marking_ledger
    where question_id = (select id from public.questions where prompt = 'S3')),
  'marked',
  'R3-MIN3: the discarded ledger row is CLOSED as marked — no zombie in marking');

-- ── §6b A TRUE epoch discard (audit-4 M12) ────────────────────────────
-- §6 above passes attempt_version = 2, which is the POST-override value, so the
-- `mark_status in ('pending','failed')` arm — not the epoch arm — is what
-- produced its discard. That leaves the epoch guard itself unexercised. Here the
-- answer is reset to PENDING and its attempt_version bumped to 2 (the override
-- epoch), while the in-flight worker still believes it claimed epoch 1. The
-- `mark_status` arm now PASSES (pending is writable), so the ONLY thing that can
-- discard is `attempt_version = v_epoch`.
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '1c111111-1111-1111-1111-111111111111')::text, true);

-- Re-claim S3 so the ledger carries a live token for the stale-epoch worker.
update public.ai_marking_ledger
   set status = 'queued', attempts = 0, claim_token = null
 where question_id = (select id from public.questions where prompt = 'S3');

select set_config('request.jwt.claims', '', true);
select public.sweep_ai_marks();

-- The override below re-bumps attempt_version (2 → 3) and resets the answer to
-- pending/failed-epoch semantics; we then finalize as the OLD epoch 1.
update public.session_answers
   set mark_status = 'pending', mark_score = null, is_correct = false,
       attempt_version = 2
 where session_id = :'sid'::uuid
   and question_id = (select id from public.questions where prompt = 'S3');

select (select claim_token from public.ai_marking_ledger
         where question_id = (select id from public.questions where prompt = 'S3')) as tok3b \gset

select is(
  (public.finalize_ai_mark(jsonb_build_array(jsonb_build_object(
    'ledger_id', (select id from public.ai_marking_ledger
                   where question_id = (select id from public.questions where prompt = 'S3')),
    'session_id', :'sid'::uuid,
    'question_id', (select id from public.questions where prompt = 'S3'),
    'attempt_version', 1,   -- the OLD worker's epoch; the row is at 2
    'claim_token', :'tok3b'::uuid,
    'ok', true, 'score', 0.5, 'confidence', 0.99,
    'rationale', 'Stale epoch.', 'tokens', 11, 'usd', 0.0001
  )))) ->> 'discarded',
  '1',
  'D2-13: the epoch arm ALONE discards a pending-answer write at a stale attempt_version');

select is(
  (select mark_status from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions where prompt = 'S3')),
  'pending',
  'the stale-epoch write did NOT resolve the answer (mark_status arm was open)');

-- ── §7 Escalation of an exhausted row (A6-1) ──────────────────────────
-- Drive S3 (already overridden in §6, so its answer is RESOLVED) and S2 to
-- attempts = 3 in the failed state, then confirm the claim predicate can
-- still REACH them (the A6-1 hole: a queued-only or under-cap-only predicate
-- strands the answer pending forever) and that escalation closes both.
--
-- S2's answer is also resolved already (needs_review from §4), so this
-- exercises the "close the ledger row even when the answer needs no write"
-- arm; S1 is added as a genuinely-pending exhausted row so the
-- answer-resolution arm is covered too.
update public.ai_marking_ledger
   set status = 'failed', attempts = 3, claim_token = null
 where question_id in (
   select id from public.questions where prompt in ('S2', 'S3'));

select is(
  (select count(*) from jsonb_array_elements(public.sweep_ai_marks() -> 'rows') r
    where (r ->> 'question_id')::uuid in (
      select id from public.questions where prompt in ('S2', 'S3'))),
  0::bigint,
  'A6-1: exhausted rows are NOT handed to the worker (escalation-only)');

select public.escalate_stale_marks();

select is(
  (select count(*) from public.ai_marking_ledger
    where quiz_id = '4c444444-4444-4444-4444-444444444444'
      and attempts >= 3 and status = 'needs_review'),
  2::bigint,
  'A6-1: escalate_stale_marks closes both of this quiz''s exhausted ledger rows');

select is(
  (select count(*) from public.ai_marking_ledger
    where quiz_id = '4c444444-4444-4444-4444-444444444444'
      and attempts >= 3 and status in ('failed', 'marking')),
  0::bigint,
  'no exhausted row of this quiz is left claimable (the A6-1 hole is closed)');

select is(
  (select status from public.ai_marking_ledger
    where question_id = (select id from public.questions where prompt = 'S2')),
  'needs_review',
  'the escalated ledger row is closed as needs_review');

select is(
  (public.escalate_stale_marks()),
  0,
  'escalation is idempotent (a second run finds nothing)');

-- ── §8 The AB-BA deadlock guard (found in audit) ──────────────────────
-- `finalize_ai_mark` writes ledger rows BEFORE taking its quizzes locks,
-- while `sweep_ai_marks` takes quizzes BEFORE its ledger rows. Two concurrent
-- calls therefore lock the same pair in opposite orders and Postgres kills
-- one with a deadlock error — reproduced live against this schema before the
-- fix. Both now share the `ai_mark_sweep` advisory lock, so the second waits
-- instead of deadlocking.
--
-- pgTAP runs one transaction, so the guard is asserted STRUCTURALLY: the
-- advisory lock must appear in the function body. A behavioural test needs
-- two real connections, which a single-transaction pgTAP file cannot open —
-- the manual reproduction is recorded in the audit notes instead.
select ok(
  (select pg_get_functiondef(oid) like '%ai_mark_sweep%'
     from pg_proc where proname = 'finalize_ai_mark'),
  'finalize_ai_mark takes the ai_mark_sweep advisory lock (AB-BA deadlock guard)');

select ok(
  (select pg_get_functiondef(oid) like '%ai_mark_sweep%'
     from pg_proc where proname = 'sweep_ai_marks'),
  'sweep_ai_marks takes the same lock (the shared serialization point)');

-- The genuinely-pending arm: S1's answer is reset to pending and its ledger
-- row exhausted, so escalation must resolve the ANSWER this time.
update public.session_answers
   set mark_status = 'pending', mark_score = null, is_correct = false
 where session_id = :'sid'::uuid
   and question_id = (select id from public.questions where prompt = 'S1');
update public.ai_marking_ledger
   set status = 'failed', attempts = 3, claim_token = null
 where question_id = (select id from public.questions where prompt = 'S1');

select is(
  (public.escalate_stale_marks()),
  1,
  'escalation closes the pending exhausted row');

select is(
  (select mark_status from public.session_answers
    where session_id = :'sid'::uuid
      and question_id = (select id from public.questions where prompt = 'S1')),
  'needs_review',
  'the PENDING answer is resolved to needs_review (so it stops blocking v_all_done)');

-- ── §9 Digest / v_all_done RE-FIRE against a COMPLETED session (M12) ──
-- Every earlier section left the session `active` (the fixture never submits),
-- so `recheck_quiz_completion`'s digest arm (`submitted_at is not null`) and
-- its auto-reveal arm were only half-exercised. Here the session is actually
-- SUBMITTED with a pending answer, then the last pending row is finalized —
-- exactly the production path (student submits hand-writing → sweep resolves →
-- the class digest must fire without waiting for the 5-min autoclose tick).
insert into public.quizzes (id, class_id, created_by, title, mode, status,
  auto_reveal_on_complete)
values ('4c444444-4444-4444-4444-444444444445',
        '3c333333-3333-3333-3333-333333333333',
        '1c111111-1111-1111-1111-111111111111',
        'I24 Submit Quiz', 'assessment', 'draft', true)
on conflict (id) do nothing;

select set_config('request.jwt.claims',
  jsonb_build_object('sub', '1c111111-1111-1111-1111-111111111111')::text, true);

select public.append_question('4c444444-4444-4444-4444-444444444445', 'mcq',
  'D1', array['a','b'], 0, null, null, null, 1);
select public.append_question('4c444444-4444-4444-4444-444444444445', 'short_text',
  'D2', array[]::text[], null, null, null, 'Rubric digest', 1);
update public.quizzes set status = 'live'
 where id = '4c444444-4444-4444-4444-444444444445';

select set_config('request.jwt.claims',
  jsonb_build_object('sub', '2c222222-2222-2222-2222-222222222222')::text, true);

select (public.start_quiz_session('4c444444-4444-4444-4444-444444444445')
        -> 'session' ->> 'id')::uuid as sid2 \gset

select public.answer_question(:'sid2'::uuid,
  (select id from public.questions where quiz_id = '4c444444-4444-4444-4444-444444444445' and prompt = 'D1'), 0, null, null, false);
select public.answer_question(:'sid2'::uuid,
  (select id from public.questions where quiz_id = '4c444444-4444-4444-4444-444444444445' and prompt = 'D2'),
  null, null, 'long answer', false);

select set_config('request.jwt.claims', '', true);

-- Claim the new row, then SUBMIT the session while it is still pending.
select public.sweep_ai_marks();

select set_config('request.jwt.claims',
  jsonb_build_object('sub', '2c222222-2222-2222-2222-222222222222')::text, true);

select public.submit_session(:'sid2'::uuid);

select set_config('request.jwt.claims', '', true);

select is(
  (select submitted_at is not null from public.quiz_sessions where id = :'sid2'::uuid),
  true,
  'M12 setup: the session is genuinely SUBMITTED (submitted_at stamped)');

select is(
  (select count(*) from public.notifications
    where dedupe_key = 'quiz_completed_all:4c444444-4444-4444-4444-444444444445'),
  0::bigint,
  'M12: the digest does NOT fire while the submitted session holds a pending answer');

select (select claim_token from public.ai_marking_ledger
         where session_id = :'sid2'::uuid)::text as tok_d \gset

-- The finalize of the last pending row runs the trailing recheck loop, which
-- must now fire the digest (submitted_at is present, zero pending remain).
select is(
  (public.finalize_ai_mark(jsonb_build_array(jsonb_build_object(
    'ledger_id', (select id from public.ai_marking_ledger where session_id = :'sid2'::uuid),
    'session_id', :'sid2'::uuid,
    'question_id', (select id from public.questions
                     where quiz_id = '4c444444-4444-4444-4444-444444444445' and prompt = 'D2'),
    'attempt_version', 1,
    'claim_token', :'tok_d'::uuid,
    'ok', true, 'score', 1, 'confidence', 0.99,
    'rationale', 'Digest path.', 'tokens', 100, 'usd', 0.001
  )))) ->> 'applied',
  '1',
  'M12: finalizing the last pending row applies against the COMPLETED session');

select is(
  (select count(*) from public.notifications
    where dedupe_key = 'quiz_completed_all:4c444444-4444-4444-4444-444444444445'),
  1::bigint,
  'M12: the digest RE-FIRES from finalize''s recheck once the completed session has no pending');

select is(
  (select score from public.quiz_sessions where id = :'sid2'::uuid),
  2::numeric,
  'M12: finalize recomputed the submitted session score (1 + 1)');

-- The reveal arm carries the SAME 2h quiet-window term as quiz_autoclose (and
-- a different window than the digest's 1h "recent" term) — a just-submitted
-- session is deliberately NOT revealed under a possible retake. Assert that
-- negative first (it is the honest behaviour, not a missing reveal), then age
-- the activity past the window and re-run the recheck: the reveal must fire.
select is(
  (select results_revealed_at from public.quizzes
    where id = '4c444444-4444-4444-4444-444444444445'),
  null,
  'M12: the reveal arm HOLDS while the submit is inside the 2h quiet window');

update public.quiz_sessions
   set last_activity_at = clock_timestamp() - interval '3 hours'
 where id = :'sid2'::uuid;

select lives_ok(
  $$select public.recheck_quiz_completion('4c444444-4444-4444-4444-444444444445')$$,
  'M12: the recheck runs after the quiet window elapses');

select is(
  (select results_revealed_at is not null from public.quizzes
    where id = '4c444444-4444-4444-4444-444444444445'),
  true,
  'M12: the auto-reveal arm fires once the class is quiet and zero pending remain');

select * from finish();
rollback;
