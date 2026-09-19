-- ═══════════════════════════════════════════════════════════════════════
-- 0059 — AI marking schedules (PLAN_GESTURE_OFF_RICH_TYPES)
--
-- TWO guarded schedules (A7-1), not one:
--   innovision-ai-mark-sweep     '* * * * *'   — claim + dispatch
--   innovision-ai-mark-escalate  '*/5 * * * *' — resolve exhausted rows
--
-- Why two: A6-2 established that escalation must run in its OWN transaction
-- (plpgsql cannot COMMIT mid-body, so an escalation write inside the claim
-- txn would share its locks and roll back with it). pg_cron runs each job's
-- command as one statement string, and two `cron.schedule` entries give two
-- independent transactions — which a single two-statement command would not.
--
-- This bumps the cron job count 5 → 7, so `/api/health` EXPECTED_JOBS and
-- `deploy/sync-migrations.sh` EXPECTED_CRON_JOBS move to 7 in the same commit
-- (the sync script's `die` fails a deploy AFTER the schema push has landed).
--
-- 1-min for the sweep is justified: the pending banner promises "usually
-- under a minute", the sweep is cheap (index-only claim + a gate
-- short-circuit), and the worker route fires right after the claim commits.
-- Autoclose stays at 5-min.
--
-- FS-13/C5-11/A6-6: `create extension if not exists pg_cron` is the FIRST
-- statement (house pattern 0019:806, 0042:288). pg_net is created in its OWN
-- block in 0057 — never here, because an unavailable pg_net would roll the
-- schedule back inside this EXCEPTION subtransaction while the notice blamed
-- pg_cron (the 0042:287-291 warning).
-- ═══════════════════════════════════════════════════════════════════════

do $do$ begin
  create extension if not exists pg_cron;

  if not exists (select 1 from cron.job where jobname = 'innovision-ai-mark-sweep') then
    perform cron.schedule(
      'innovision-ai-mark-sweep',
      '* * * * *',
      $cron$select public.sweep_ai_marks();$cron$
    );
  end if;

  if not exists (select 1 from cron.job where jobname = 'innovision-ai-mark-escalate') then
    perform cron.schedule(
      'innovision-ai-mark-escalate',
      '*/5 * * * *',
      $cron$select public.escalate_stale_marks();$cron$
    );
  end if;
exception when others then
  raise notice 'pg_cron unavailable; skipping ai-mark schedules';
end $do$;
