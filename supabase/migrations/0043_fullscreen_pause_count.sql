-- InnoVision — Migration 0043: fullscreen_pause_count (visible accountability).
--
-- 0042 shipped 'fullscreen_exit' as a PLAIN pause (hand_loss semantics) and
-- explicitly deferred the counting question "until the honest-user
-- false-positive rate is observed" (KNOWN ABUSE note, 2026-09 red team):
-- pause freezes the exam clock and self_recover credits the full paused
-- duration, so exit→think→recover cycles are a penalty-free time source on
-- tight timers. This migration resolves the deferral WITHOUT repeating the
-- focus-loss 3-strike flag risk on an honest gesture (Escape / a window
-- snap):
--
--   - `quiz_sessions.fullscreen_pause_count int not null default 0`
--     incremented by pause_session('fullscreen_exit') — NO auto-flag.
--   - Lecturer-visible via lecturer_session_view (appended LAST —
--     CREATE OR REPLACE VIEW can only append columns; 0021 R4 rule) and the
--     results dashboard/workbook, mirroring the "Focus loss pauses" line.
--   - Reset by unlock_session + exempt_face_session (parity with
--     focus_pause_count: an unlock/exemption clears the accountability so the
--     NEXT genuine cycle starts from zero).
--
-- No notification risk: the 0022 session trigger is `after update of status`
-- with a `old.status is distinct from new.status` WHEN guard — bare counter
-- UPDATEs are silent. Repeated exit→recover cycling therefore never
-- auto-flagged; it just becomes VISIBLE for the lecturer's review decision.

-- ─── 1. Column ─────────────────────────────────────────────────────────
alter table public.quiz_sessions
  add column if not exists fullscreen_pause_count int not null default 0;

-- ─── 2. pause_session: count fullscreen_exit (no flag) ────────────────
-- BASELINE: the LIVE 0042 revision. Changes from it: the fullscreen_exit
-- branch now increments fullscreen_pause_count (the documented deferred
-- decision), and every update branch persists the counter. All 0042
-- behavior — reason validation, owner/assessment/status gates, focus_lost
-- 3-strike flagging, paused_at handling — is preserved verbatim.
create or replace function public.pause_session(
  p_session_id uuid,
  p_reason     text default 'hand_loss'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.quiz_sessions;
  v_flag boolean := false;
begin
  if auth.uid() is null then
    return jsonb_build_object('error', 'not_authenticated');
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'student'
  ) then
    return jsonb_build_object('error', 'not_student');
  end if;

  -- fullscreen_exit is counted but NEVER auto-flags (0043): Escape/window
  -- gestures are honest behavior, so the escalation is the LECTURER's call
  -- via the dashboard line — the counter only makes repeat cycling visible.
  -- (Pre-0042 it was a plain pause with no counter at all.)
  if p_reason is null or p_reason not in ('hand_loss', 'focus_lost', 'fullscreen_exit') then
    return jsonb_build_object('error', 'invalid_reason');
  end if;

  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id and s.student_id = auth.uid()
   for update;

  if not found then
    return jsonb_build_object('error', 'not_owner');
  end if;

  if v_session.mode <> 'assessment' then
    return jsonb_build_object('error', 'not_assessment');
  end if;

  if v_session.status in ('completed', 'flagged') then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  if p_reason = 'focus_lost' then
    v_session.focus_pause_count := coalesce(v_session.focus_pause_count, 0) + 1;
    v_flag := v_session.focus_pause_count >= 3;
  elsif p_reason = 'fullscreen_exit' then
    v_session.fullscreen_pause_count := coalesce(v_session.fullscreen_pause_count, 0) + 1;
  end if;

  if v_flag then
    -- R1 (0021): a flag from `paused` must NOT preserve paused_at — unlock
    -- would otherwise credit the flagged idle period as exam time.
    update public.quiz_sessions
       set status = 'flagged',
           paused_at = null,
           focus_pause_count = v_session.focus_pause_count,
           fullscreen_pause_count = v_session.fullscreen_pause_count,
           last_activity_at = clock_timestamp()
     where id = v_session.id;

    -- R3 (0021): quiz_id/session_id in metadata so lecturer_audit_view
    -- surfaces the row on the session timeline; reason now included so a
    -- future counted reason is correctly labeled.
    insert into public.audit_events (actor_id, subject_id, action, metadata)
    values (
      auth.uid(),
      auth.uid(),
      'auto_flag_focus_loss',
      jsonb_build_object(
        'focus_pause_count', v_session.focus_pause_count,
        'reason', p_reason,
        'quiz_id', v_session.quiz_id,
        'session_id', v_session.id
      )
    );
    return jsonb_build_object('sessionStatus', 'flagged');
  end if;

  if v_session.status = 'active' then
    update public.quiz_sessions
       set status = 'paused',
           paused_at = coalesce(paused_at, clock_timestamp()),
           focus_pause_count = v_session.focus_pause_count,
           fullscreen_pause_count = v_session.fullscreen_pause_count,
           last_activity_at = clock_timestamp()
     where id = v_session.id;
  else
    -- Already paused (e.g. a second blur while recovering): persist the new
    -- count without touching the timer state.
    update public.quiz_sessions
       set focus_pause_count = v_session.focus_pause_count,
           fullscreen_pause_count = v_session.fullscreen_pause_count,
           last_activity_at = clock_timestamp()
     where id = v_session.id;
  end if;

  return jsonb_build_object('sessionStatus', 'paused');
end;
$$;

revoke execute on function public.pause_session(uuid, text) from public, anon;
grant execute on function public.pause_session(uuid, text) to authenticated;

-- ─── 3. unlock_session: reset the counter (0033 baseline + one line) ───
-- BASELINE: the LIVE 0033 revision (0021 R2 branches + the IO-1
-- session_unlocked notification). The ONLY change: both branches reset
-- fullscreen_pause_count alongside focus_pause_count. The notification
-- block is carried over VERBATIM (including its documented
-- WHEN OTHERS deviation).
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
  -- every unlock resets BOTH pause counters.
  if v_session.paused_at is not null then
    update public.quiz_sessions
       set status = 'active',
           started_at = started_at + (clock_timestamp() - v_session.paused_at),
           paused_at = null,
           face_fail_streak = 0,
           focus_pause_count = 0,
           fullscreen_pause_count = 0,
           verify_nonce = gen_random_uuid(),
           last_activity_at = clock_timestamp()
     where id = v_session.id
     returning verify_nonce into v_next_nonce;
  else
    update public.quiz_sessions
       set status = 'active',
           face_fail_streak = 0,
           focus_pause_count = 0,
           fullscreen_pause_count = 0,
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
      -- DEVIATION from 0022's WHEN OTHERS ban (documented in the 0033
      -- header): the notification is best-effort; the unlock + audit above
      -- are the authoritative record and the 8s poll is the consistency
      -- backbone. A failure here must never fail the lecturer's unlock.
      raise warning 'unlock_session: session_unlocked notification insert failed (session %)', v_session.id;
  end;

  return jsonb_build_object('sessionStatus', 'active', 'nextNonce', v_next_nonce);
end;
$$;

revoke execute on function public.unlock_session(uuid) from public, anon;
grant execute on function public.unlock_session(uuid) to authenticated;

-- ─── 4. exempt_face_session: reset the counter (0024 F2 baseline) ─────
-- BASELINE: the LIVE 0024 F2 revision. ONLY change: the reset UPDATE also
-- clears fullscreen_pause_count (mirrors its focus_pause_count reset).
create or replace function public.exempt_face_session(p_session_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.quiz_sessions;
  v_next_nonce uuid;
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

  -- Lock + lecturer-ownership in ONE query (never row-lock a foreign id).
  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id
     and public.is_lecturer_of_quiz(s.quiz_id)
   for update;

  if not found then
    return jsonb_build_object('error', 'not_owner');
  end if;

  -- Bound the reason at the SQL layer too (the route's ExemptSchema caps at
  -- 500; a direct RPC caller must not bloat audit_events.metadata).
  if p_reason is null or length(p_reason) > 500 then
    return jsonb_build_object('error', 'invalid_reason');
  end if;

  if v_session.status = 'completed' then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  -- F2: reset the pause counters so an exemption clears the flag threshold —
  -- otherwise the next genuine blur instantly re-flags (mirrors 0021 R2).
  update public.quiz_sessions
     set face_exempt = true,
         status = 'active',
         face_fail_streak = 0,
         focus_pause_count = 0,
         fullscreen_pause_count = 0,
         verify_nonce = gen_random_uuid(),
         last_activity_at = clock_timestamp()
   where id = v_session.id
   returning verify_nonce into v_next_nonce;

  insert into public.audit_events (actor_id, subject_id, action, metadata)
  values (
    auth.uid(),
    v_session.student_id,
    'exempt_face',
    jsonb_build_object('reason', p_reason)
  );

  return jsonb_build_object('sessionStatus', 'active', 'nextNonce', v_next_nonce);
end;
$$;

revoke execute on function public.exempt_face_session(uuid, text) from public, anon;
grant execute on function public.exempt_face_session(uuid, text) to authenticated;

-- ─── 5. lecturer_session_view: append fullscreen_pause_count LAST ─────
-- BASELINE: the LIVE 0032 revision. CREATE OR REPLACE VIEW can only APPEND
-- columns (0021 R4): the new column goes LAST or the replace fails and the
-- whole migration aborts.
create or replace view public.lecturer_session_view
with (security_barrier = true)
as
select s.id, s.quiz_id, s.student_id, s.mode, s.status,
       s.started_at, s.submitted_at, s.last_activity_at,
       s.face_exempt, s.face_fail_streak, s.face_unavailable_at,
       s.score,
       s.focus_pause_count,
       s.attempt,
       s.fullscreen_pause_count
from public.quiz_sessions s
where public.is_lecturer_of_quiz(s.quiz_id);

grant select on public.lecturer_session_view to authenticated;
