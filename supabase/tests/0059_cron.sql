-- ═══════════════════════════════════════════════════════════════════════
-- I-22 — AI marking schedules (migration 0059)
--
-- A7-1 is the decision under test: TWO schedules, not one. Escalation must
-- run in its own transaction (A6-2 — plpgsql cannot COMMIT mid-body, so an
-- escalation write sharing the claim's txn would roll back with it), and
-- pg_cron gives one transaction per JOB, not per statement.
--
-- Also pinned:
--   * the job count is SEVEN (drives /api/health EXPECTED_JOBS and
--     deploy/sync-migrations.sh EXPECTED_CRON_JOBS)
--   * both new jobs are `innovision-` prefixed so cron_health reports them
--   * the schedules are 1-min (sweep) and 5-min (escalate)
--   * the commands invoke the PINNED functions
--
-- Run: npx supabase test db
-- ═══════════════════════════════════════════════════════════════════════

begin;

create extension if not exists pgtap;

select plan(15);

-- ── §1 Both jobs exist ────────────────────────────────────────────────
select ok(
  exists (select 1 from cron.job where jobname = 'innovision-ai-mark-sweep'),
  'the 1-min AI marking sweep job is scheduled');

select ok(
  exists (select 1 from cron.job where jobname = 'innovision-ai-mark-escalate'),
  'A7-1: the 5-min escalation job is scheduled as a SEPARATE job (own txn)');

-- ── §2 Schedules ──────────────────────────────────────────────────────
select is(
  (select schedule from cron.job where jobname = 'innovision-ai-mark-sweep'),
  '* * * * *',
  'the sweep runs every minute (the pending banner promises "under a minute")');

select is(
  (select schedule from cron.job where jobname = 'innovision-ai-mark-escalate'),
  '*/5 * * * *',
  'the escalation runs every 5 minutes');

-- ── §3 Commands invoke the pinned functions (A7-1) ────────────────────
select is(
  (select command from cron.job where jobname = 'innovision-ai-mark-sweep'),
  'select public.sweep_ai_marks();',
  'the sweep job calls sweep_ai_marks() — the pinned invoker');

select is(
  (select command from cron.job where jobname = 'innovision-ai-mark-escalate'),
  'select public.escalate_stale_marks();',
  'the escalate job calls escalate_stale_marks() — the pinned invoker');

-- The two jobs must NOT be collapsed into one two-statement command: that
-- would share a transaction and reintroduce the A6-2 defect.
select ok(
  (select command from cron.job where jobname = 'innovision-ai-mark-sweep')
    not like '%;%select%',
  'A6-2: the sweep job is a SINGLE statement (no shared transaction)');

-- audit-4 n1: the SAME single-statement assertion for the escalate job. Both
-- commands are single-`SELECT` today; a future "helpfully" merged command would
-- silently reintroduce the A6-2 defect (one shared transaction), and only the
-- sweep had the mirror.
select ok(
  (select command from cron.job where jobname = 'innovision-ai-mark-escalate')
    not like '%;%select%',
  'A6-2: the escalate job is a SINGLE statement (own transaction, no merge)');

-- ── §4 Both are active ────────────────────────────────────────────────
select ok(
  (select active from cron.job where jobname = 'innovision-ai-mark-sweep'),
  'the sweep job is active');

select ok(
  (select active from cron.job where jobname = 'innovision-ai-mark-escalate'),
  'the escalate job is active');

-- ── §5 The job count is SEVEN (health + deploy expectations) ──────────
select is(
  (select count(*) from cron.job where jobname like 'innovision-%'),
  7::bigint,
  'exactly SEVEN innovision- jobs exist — EXPECTED_JOBS / EXPECTED_CRON_JOBS must match');

select is(
  (select count(*) from cron.job where jobname = 'innovision-ai-mark-sweep'),
  1::bigint,
  'the sweep job is not duplicated (idempotent guarded schedule)');

select is(
  (select count(*) from cron.job where jobname = 'innovision-ai-mark-escalate'),
  1::bigint,
  'the escalate job is not duplicated');

-- ── §6 cron_health reports them ───────────────────────────────────────
select ok(
  (public.cron_health()) -> 'jobs' @> '[{"job": "innovision-ai-mark-sweep"}]'::jsonb,
  'cron_health() reports the sweep job (the /api/health probe source)');

select ok(
  (public.cron_health()) -> 'jobs' @> '[{"job": "innovision-ai-mark-escalate"}]'::jsonb,
  'cron_health() reports the escalate job');

select * from finish();
rollback;
