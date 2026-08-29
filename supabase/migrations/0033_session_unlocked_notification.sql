-- 0033 — IO-1: `session_unlocked` notification on lecturer unlock.
--
-- A flagged session is an indefinite, opaque wait for the student: the ONLY
-- path out is a lecturer decision (unlock_session), and until now the student
-- learned about it only via the 8s in-play poll (or never, if they had
-- navigated away). This migration extends the existing unlock RPC to enqueue
-- a notification through the 0022 machinery.
--
-- BASELINE: the LIVE unlock_session is the 0021_integrity_audit_fixes.sql
-- revision (NOT 0009 — 0021 R2 superseded it with the paused-time crediting
-- branch + focus_pause_count reset). The rewrite below preserves every 0021
-- behavior and adds ONLY the notification insert.
--
-- House rules honoured (0022 §4):
--   - recipient derived from ROW DATA (the session's student), never auth.uid()
--     (the RPC runs as the LECTURER);
--   - type-prefixed dedupe key with ON CONFLICT DO NOTHING — each flag→unlock
--     cycle notifies exactly once (the nonce rotates per unlock, so a genuine
--     second unlock produces a NEW dedupe key → a second notification), while
--     an accidental same-unlock double-fire stays deduped;
--   - security definer + pinned search_path; narrow payload whitelist.
--
-- Documented deviation from 0022's "WHEN OTHERS THEN NULL is banned" rule:
-- the insert is wrapped in a catch-all swallow because the notification is
-- best-effort by design — the student's in-play poll (8s) remains the
-- consistency backbone, and the unlock decision is already durably audited
-- before this point. Losing the notification must never fail (or roll back)
-- the lecturer's unlock. The ON CONFLICT clause still handles the expected
-- dedupe race; the handler only absorbs truly unexpected failures.

-- ─── 1. Enum value ──────────────────────────────────────────────────
alter type public.notification_type add value if not exists 'session_unlocked';

-- ─── 2. unlock_session rewrite (live baseline = 0021 R2) ────────────
create or replace function public.unlock_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.quiz_sessions;
  v_next_nonce uuid;
  v_quiz_title text;
begin
  if auth.uid() is null then
    return jsonb_build_object('error', 'not_authenticated');
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'lecturer'
  ) then
    return jsonb_build_object('error', 'not_lecturer');
  end if;

  -- Lock + lecturer-ownership in ONE query (0008 "never row-lock a foreign id"
  -- pattern): a guessed foreign session id is never row-locked — the join to
  -- is_lecturer_of_quiz runs before the lock is taken.
  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id
     and public.is_lecturer_of_quiz(s.quiz_id)
   for update;

  if not found then
    return jsonb_build_object('error', 'not_owner');
  end if;

  if v_session.status = 'completed' then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  -- 0021 R2 branch structure preserved verbatim: a paused unlock credits the
  -- paused duration back into started_at and clears paused_at (timer honesty);
  -- every unlock resets focus_pause_count. IO-1 adds ONLY the notification.
  if v_session.paused_at is not null then
    update public.quiz_sessions
       set status = 'active',
           started_at = started_at + (clock_timestamp() - v_session.paused_at),
           paused_at = null,
           face_fail_streak = 0,
           focus_pause_count = 0,
           verify_nonce = gen_random_uuid(),
           last_activity_at = clock_timestamp()
     where id = v_session.id
     returning verify_nonce into v_next_nonce;
  else
    update public.quiz_sessions
       set status = 'active',
           face_fail_streak = 0,
           focus_pause_count = 0,
           verify_nonce = gen_random_uuid(),
           last_activity_at = clock_timestamp()
     where id = v_session.id
     returning verify_nonce into v_next_nonce;
  end if;

  insert into public.audit_events (actor_id, subject_id, action)
  values (auth.uid(), v_session.student_id, 'unlock');

  -- IO-1: tell the student the wait is over. Recipient from ROW data (the
  -- RPC's auth.uid() is the lecturer); dedupe key carries the rotated nonce
  -- so every genuine unlock notifies once while double-fire stays deduped.
  select q.title into v_quiz_title
    from public.quizzes q
   where q.id = v_session.quiz_id;

  begin
    insert into public.notifications (recipient_id, type, payload, dedupe_key)
    values (
      v_session.student_id,
      'session_unlocked',
      jsonb_build_object(
        'session_id', v_session.id,
        'quiz_id', v_session.quiz_id,
        'quiz_title', coalesce(v_quiz_title, '')
      ),
      'session_unlocked:' || v_session.id::text || ':' || v_next_nonce::text
    )
    on conflict (recipient_id, dedupe_key) do nothing;
  exception
    when unique_violation then
      -- Dedupe race lost: another connection inserted first. Fine.
      null;
    when others then
      -- DEVIATION from 0022's WHEN OTHERS ban (documented in the header):
      -- the notification is best-effort; the unlock + audit above are the
      -- authoritative record and the 8s poll is the consistency backbone.
      -- A failure here must never fail the lecturer's unlock.
      raise warning 'unlock_session: session_unlocked notification insert failed (session %)', v_session.id;
  end;

  return jsonb_build_object('sessionStatus', 'active', 'nextNonce', v_next_nonce);
end;
$$;

revoke execute on function public.unlock_session(uuid) from public, anon;
grant execute on function public.unlock_session(uuid) to authenticated;
