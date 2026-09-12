-- InnoVision — Migration 0042: verify-silence auto-flag + fullscreen-exit pause.
--
-- Integrity-suite addition (post-0041). Three concerns:
--
--   1. `flag_verify_silent_sessions()` — the "client stopped sending verifies"
--      bypass. An honest client runs a face verify every 30–45s while
--      answering (cadence is 30–45s jittered, paused on hidden/feedback). A
--      tampered client that suppresses verifies keeps ANSWERING, so the server
--      sees answers flowing (last_activity_at fresh) with NO face_checks rows.
--      → active assessment sessions whose last check is >300s old while an
--      answer landed within the last 90s are flagged. 300s ≈ 7× the max
--      normal gap so diligent slow readers / feedback dwellers are never hit;
--      the 90s recency keys to session_answers.answered_at (the true
--      answering signal — last_activity_at is also touched by
--      report_session_advisory, which fires un-gated and would false-flag
--      feedback dwellers).
--   2. `pause_session` gains a 'fullscreen_exit' reason (client hardening,
--      migration 0042's Feature C): a plain pause (hand_loss semantics —
--      does NOT increment focus_pause_count) until the false-positive rate is
--      observed; the flag-branch audit metadata now carries the reason.
--   3. Orphaned-job fix: prune_expired_incident_clips() (0021) was never
--      scheduled — wire it to pg_cron here.
--
-- False-positive guards on the silence flag (review outcomes from the 2026-09
-- design critique):
--   - `face_unavailable_at IS NULL` — a sidecar outage 503s BEFORE
--     record_face_check, so zero rows land while answers keep flowing; the
--     honest client reports unavailable (set-if-null) and the session stays
--     'active'. Without the guard every outage batch-flags honest students.
--     Residual evasion (self-report unavailable, then suppress) is already
--     lecturer-visible via the face_unavailable_reported notification.
--   - Quiz-liveness predicate — mirrors record_face_check gate (4), but
--     INLINED: can_student_view_quiz checks ce.student_id = auth.uid(),
--     which is always NULL under cron, so reusing it here would silently
--     flag nothing. Same terms without the user context: quiz live, THIS
--     session's student still enrolled, class not archived.
--   - The flag fires the existing status→'flagged' notification trigger
--     (0022) and lands in lecturer_audit_view because the audit row carries
--     quiz_id/session_id in metadata (R3 lesson, 0021).

-- ═══ 1. flag_verify_silent_sessions ═════════════════════════════════════
create or replace function public.flag_verify_silent_sessions()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_flagged int := 0;
  v_row public.quiz_sessions;
  v_seconds_since_check int;
begin
  -- Recency is keyed to session_answers.answered_at (the true answering
  -- signal), NOT last_activity_at: report_session_advisory also touches
  -- last_activity_at (0021), and advisories fire while faceStatus==='ready'
  -- with NO phase gating — a slow reader dwelling on feedback who leans back
  -- (looked_away advisory) would otherwise satisfy freshness while the
  -- suspended verify cadence produces no rows. False-flag vector, R1 review.
  for v_row in
    select s.*
      from public.quiz_sessions s
     where s.status = 'active'
       and s.mode = 'assessment'
       and s.face_exempt = false
       and s.face_unavailable_at is null
       and (
         select max(sa.answered_at)
           from public.session_answers sa
          where sa.session_id = s.id
       ) > clock_timestamp() - interval '90 seconds'
       and (
         -- COALESCE with started_at: a session with ZERO face_checks rows
         -- (tampered client that suppressed verifies from the very start)
         -- has max(checked_at) = NULL, and NULL < anything is NULL — without
         -- the coalesce the headline bypass case escapes the flag entirely.
         select coalesce(max(fc.checked_at), s.started_at)
           from public.face_checks fc
          where fc.session_id = s.id
       ) < clock_timestamp() - interval '300 seconds'
       -- Pause-resume false-positive guard: self_recover/unlock write NO
       -- face_checks row, the post-resume cadence fires its first verify only
       -- 30-45s later, and a quick answer lands within seconds — a session
       -- that paused >300s (its last check predates the pause) then answered
       -- would be flagged before its honest verify. Exempt sessions paused
       -- within the silence window. NOT an evasion loop: status='paused'
       -- blocks answering entirely (answer_question status gate), so entering
       -- pause buys a cheater nothing — only genuine recover/unlock flows
       -- reach this exemption, and the focus-loss 3-strike already polices
       -- pause cycling.
       and (s.paused_at is null or s.paused_at > clock_timestamp() - interval '300 seconds')
       and exists (
         select 1
           from public.quizzes q
           join public.classes c on c.id = q.class_id
           join public.class_enrollments ce on ce.class_id = q.class_id
          where q.id = s.quiz_id
            and ce.student_id = s.student_id
            and q.status = 'live'
            and c.archived_at is null
       )
     order by s.last_activity_at desc
     limit 100
  loop
    v_seconds_since_check := extract(epoch from (
      clock_timestamp() - coalesce(
        (select max(fc.checked_at) from public.face_checks fc where fc.session_id = v_row.id),
        v_row.started_at
      )
    ))::int;

    -- The WHERE re-states EVERY freshness + exemption predicate (not just
    -- status): under READ COMMITTED a record_face_check that commits between
    -- the cursor snapshot and this UPDATE re-evaluates here, so a student
    -- whose verify just LANDED is never flagged on stale data.
    update public.quiz_sessions
       set status = 'flagged',
           paused_at = null,
           last_activity_at = clock_timestamp()
     where id = v_row.id
       and status = 'active'
       and mode = 'assessment'
       and face_exempt = false
       and face_unavailable_at is null
       and (
         select max(sa.answered_at)
           from public.session_answers sa
          where sa.session_id = quiz_sessions.id
       ) > clock_timestamp() - interval '90 seconds'
       and (
         -- COALESCE parity with the cursor predicate (zero-check sessions).
         select coalesce(max(fc.checked_at), quiz_sessions.started_at)
           from public.face_checks fc
          where fc.session_id = quiz_sessions.id
       ) < clock_timestamp() - interval '300 seconds'
       -- Pause-resume guard, cursor parity.
       and (quiz_sessions.paused_at is null
            or quiz_sessions.paused_at > clock_timestamp() - interval '300 seconds')
       -- Quiz-liveness restated too (a quiz that closed mid-scan is never
       -- flagged) — see header for why this is inlined, not can_student_view_quiz.
       and exists (
         select 1
           from public.quizzes q
           join public.classes c on c.id = q.class_id
           join public.class_enrollments ce on ce.class_id = q.class_id
          where q.id = quiz_sessions.quiz_id
            and ce.student_id = quiz_sessions.student_id
            and q.status = 'live'
            and c.archived_at is null
       );

    if found then
      v_flagged := v_flagged + 1;
      -- No actor_id (system flag; auth.uid() is null under cron) — subject_id
      -- carries the student; metadata carries quiz+session (R3: rows without
      -- them never surface on the session integrity timeline).
      insert into public.audit_events (actor_id, subject_id, action, metadata)
      values (
        null,
        v_row.student_id,
        'auto_flag_verify_silence',
        jsonb_build_object(
          'quiz_id', v_row.quiz_id,
          'session_id', v_row.id,
          'seconds_since_check', v_seconds_since_check
        )
      );
    end if;
  end loop;
  return v_flagged;
end;
$$;

revoke execute on function public.flag_verify_silent_sessions() from public, anon;
grant execute on function public.flag_verify_silent_sessions() to service_role;

-- ═══ 2. pause_session: fullscreen_exit reason + audited flag metadata ═══
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

  -- fullscreen_exit is a PLAIN pause (hand_loss semantics): the student can
  -- exit fullscreen with Escape or a window gesture without any intent to
  -- cheat, so it deliberately does NOT accumulate focus_pause_count. KNOWN
  -- ABUSE (2026-09 red team, deferred): pause freezes the exam clock and
  -- self_recover credits the full paused duration, so exit→think→recover
  -- cycles are a penalty-free time source on tight timers. Promote
  -- 'fullscreen_exit' into the counted branch below once the honest-user
  -- false-positive rate is observed (the client's 2s shared-stamp dedupe +
  -- ready-only arming already suppress the double-count).
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
  end if;

  if v_flag then
    -- R1 (0021): a flag from `paused` must NOT preserve paused_at — unlock
    -- would otherwise credit the flagged idle period as exam time.
    update public.quiz_sessions
       set status = 'flagged',
           paused_at = null,
           focus_pause_count = v_session.focus_pause_count,
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
           last_activity_at = clock_timestamp()
     where id = v_session.id;
  else
    -- Already paused (e.g. a second blur while recovering): persist the new
    -- count without touching the timer state.
    update public.quiz_sessions
       set focus_pause_count = v_session.focus_pause_count,
           last_activity_at = clock_timestamp()
     where id = v_session.id;
  end if;

  return jsonb_build_object('sessionStatus', 'paused');
end;
$$;

revoke execute on function public.pause_session(uuid, text) from public, anon;
grant execute on function public.pause_session(uuid, text) to authenticated;

-- ═══ 3. pg_cron: silence flag (every minute) + orphaned incident prune ══
-- ONE schedule per guarded do-block (0022/0030 house pattern): a plpgsql
-- EXCEPTION clause wraps its block in a subtransaction, so bundling both
-- schedules would silently ROLL BACK the first if the second raised — the
-- headline job would ship unscheduled behind a benign-looking notice.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('innovision-flag-verify-silence', '* * * * *',
    'select public.flag_verify_silent_sessions()');
exception when others then
  raise notice 'pg_cron scheduling skipped (%); schedule flag_verify_silent_sessions manually', sqlerrm;
end $$;

do $$
begin
  create extension if not exists pg_cron;
  -- Orphaned since 0021: the function existed but was never scheduled.
  perform cron.schedule('innovision-incident-prune', '23 4 * * *',
    'select public.prune_expired_incident_clips()');
exception when others then
  raise notice 'pg_cron scheduling skipped (%); schedule prune_expired_incident_clips manually', sqlerrm;
end $$;
