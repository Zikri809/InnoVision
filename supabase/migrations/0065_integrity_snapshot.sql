-- ═══════════════════════════════════════════════════════════════════════
-- 0065 — integrity snapshot for observability (audit-5 O2 + O5)
--
-- O2: a mass false-flag deploy (e.g. a broken sidecar) surfaced only as
--     day-bucketed per-session notification emails — there was no single
--     number an operator could watch. O5: quiz_autoclose's seal count is an
--     unread return value (pg_cron discards it), so abandonment is invisible.
--
-- This migration adds ONE service-role RPC, `integrity_snapshot(window_hours)`,
-- returning the small set of counters that make both visible:
--   flags24h      — auto_flag_* audit rows in the window, BY action
--   flaggedNow    — sessions currently in status='flagged'
--   sealed        — session_sealed audit rows in the window (abandonment)
--   submitted     — session_submitted audit rows in the window
--   pendingMarks  — answers still awaiting AI marking (the reveal-stranding risk)
--   completed     — completed assessment sessions in the window
--
-- The `/api/health` cron section (lecturer-only) surfaces this under `cron`,
-- so a lecturer/uptime monitor sees a flag-rate spike without reading mail.
--
-- The supporting index on audit_events(action, created_at) is the enabling
-- column support the audit's §6 N11 flagged as missing. It is created
-- CONCURRENTLY-safe here as a plain CREATE INDEX (migration runs offline).
--
-- Run: npx supabase db reset / db push
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1. Audit-action / time index (N11 support) ────────────────────────
create index if not exists audit_events_action_created_at_idx
  on public.audit_events (action, created_at desc);

-- ─── 2. integrity_snapshot ─────────────────────────────────────────────
create or replace function public.integrity_snapshot(p_window_hours int default 24)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  with win as (
    select clock_timestamp() - make_interval(hours => greatest(p_window_hours, 1)) as since
  )
  select jsonb_build_object(
    'windowHours', greatest(p_window_hours, 1),
    'since', (select since from win),
    'flagsByAction', (
      select coalesce(jsonb_object_agg(t.action, t.n), '{}'::jsonb)
        from (
          select ae.action, count(*)::int as n
            from public.audit_events ae, win
           where ae.action like 'auto\_flag\_%'
             and ae.created_at >= win.since
           group by ae.action
        ) t
    ),
    'flags24h', (
      select count(*)::int
        from public.audit_events ae, win
       where ae.action like 'auto\_flag\_%'
         and ae.created_at >= win.since
    ),
    'flaggedNow', (
      select count(*)::int
        from public.quiz_sessions s
       where s.status = 'flagged'
    ),
    'sealed', (
      select count(*)::int
        from public.audit_events ae, win
       where ae.action = 'session_sealed'
         and ae.created_at >= win.since
    ),
    'submitted', (
      select count(*)::int
        from public.audit_events ae, win
       where ae.action = 'session_submitted'
         and ae.created_at >= win.since
    ),
    'started', (
      select count(*)::int
        from public.audit_events ae, win
       where ae.action = 'session_started'
         and ae.created_at >= win.since
    ),
    'pendingMarks', (
      select count(*)::int
        from public.session_answers sa
       where sa.mark_status = 'pending'
    )
  );
$$;

revoke execute on function public.integrity_snapshot(int) from public, anon, authenticated;
grant execute on function public.integrity_snapshot(int) to service_role;

-- Self-hosted PostgREST cache: exactly one NOTIFY at the very end.
notify pgrst, 'reload schema';
