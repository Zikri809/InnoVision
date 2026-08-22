-- InnoVision — Migration 0021: Integrity-suite audit remediations.
--
-- Findings fixed (post-0020 security audit):
--   R1. pause_session: a focus-loss FLAG while already `paused` preserved the
--       stale paused_at — a later lecturer unlock converted the entire
--       flagged idle period into bonus exam time (started_at extension).
--       → paused_at is cleared on ANY transition to 'flagged'.
--   R2. focus_pause_count was never reset by unlock_session: after a lecturer
--       unlocked a focus-loss flag, the very next genuine blur re-flagged
--       instantly. → unlock resets the counter (mirrors face_fail_streak).
--   R3. The auto_flag_focus_loss audit row carried no quiz_id/session_id, so
--       lecturer_audit_view classified it "legacy" and it never appeared on
--       the session's integrity timeline. → metadata now includes both.
--   R4. Sub-threshold focus pauses (1–2) were invisible to lecturers.
--       → lecturer_session_view projects focus_pause_count.
--   R5. report_session_advisory occurrence inflation was unbounded via direct
--       PostgREST. → increments are throttled to one per 55 seconds
--       (mirrors ADVISORY_THROTTLE_MS) inside the RPC.
--   R6. A multidimensional JSON array cast to real[] passed the 1..3
--       cardinality gate and 500'd the RPC on subscript. → ndims gate.
--   R7. prune_expired_incident_clips() removed Storage objects but leaked the
--       incident_clips rows (dead playback entries forever). → rows deleted
--       alongside objects.

-- ═══ R1 + R2 + R3: pause_session ═══════════════════════════════════════
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

  if p_reason is null or p_reason not in ('hand_loss', 'focus_lost') then
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
    -- R1: a flag from `paused` must NOT preserve paused_at — unlock would
    -- otherwise credit the flagged idle period as exam time.
    update public.quiz_sessions
       set status = 'flagged',
           paused_at = null,
           focus_pause_count = v_session.focus_pause_count,
           last_activity_at = clock_timestamp()
     where id = v_session.id;

    -- R3: attribute the audit row to the quiz + session so
    -- lecturer_audit_view surfaces it on the session timeline.
    insert into public.audit_events (actor_id, subject_id, action, metadata)
    values (
      auth.uid(),
      auth.uid(),
      'auto_flag_focus_loss',
      jsonb_build_object(
        'focus_pause_count', v_session.focus_pause_count,
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

-- ═══ R2: unlock_session resets focus_pause_count ═══════════════════════
create or replace function public.unlock_session(p_session_id uuid)
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

  return jsonb_build_object('sessionStatus', 'active', 'nextNonce', v_next_nonce);
end;
$$;

revoke execute on function public.unlock_session(uuid) from public, anon;
grant execute on function public.unlock_session(uuid) to authenticated;

-- ═══ R4: lecturer_session_view projects focus_pause_count ══════════════
-- NOTE: CREATE OR REPLACE VIEW can only APPEND columns — focus_pause_count
-- goes LAST or the replace fails and the whole migration aborts.
create or replace view public.lecturer_session_view
with (security_barrier = true)
as
select s.id, s.quiz_id, s.student_id, s.mode, s.status,
       s.started_at, s.submitted_at, s.last_activity_at,
       s.face_exempt, s.face_fail_streak, s.face_unavailable_at,
       s.score,
       s.focus_pause_count
from public.quiz_sessions s
where public.is_lecturer_of_quiz(s.quiz_id);

grant select on public.lecturer_session_view to authenticated;

-- ═══ R5: advisory occurrence throttle inside the RPC ═══════════════════
create or replace function public.report_session_advisory(
  p_session_id uuid,
  p_type       text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

  if p_type not in ('second_face', 'looked_away', 'voice_activity', 'headset_active') then
    return jsonb_build_object('error', 'invalid_type');
  end if;

  -- Owner + assessment + still meaningful (active/paused).
  update public.quiz_sessions s
     set last_activity_at = clock_timestamp()
   where s.id = p_session_id
     and s.student_id = auth.uid()
     and s.mode = 'assessment'
     and s.status in ('active', 'paused');

  if not found then
    return jsonb_build_object('error', 'not_owner');
  end if;

  -- Throttle: an occurrence only counts when the previous one of the same
  -- type is older than 55s (mirrors ADVISORY_THROTTLE_MS). Direct PostgREST
  -- spam returns ok without inflating the review signal.
  insert into public.session_advisories as a (session_id, adv_type)
  values (p_session_id, p_type)
  on conflict (session_id, adv_type) do update
    set occurrences = a.occurrences + 1,
        last_seen_at = clock_timestamp()
    where a.last_seen_at < clock_timestamp() - interval '55 seconds';

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.report_session_advisory(uuid, text) from public, anon;
grant execute on function public.report_session_advisory(uuid, text) to authenticated;

-- ═══ R6: record_face_check — reject multidimensional arrays ════════════
create or replace function public.record_face_check(
  p_session_id   uuid,
  p_subject      text,
  p_similarities real[],
  p_trigger      public.face_check_trigger,
  p_nonce        uuid,
  p_frames       text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  FACE_SIMILARITY_MIN constant real := 0.5;
  v_session      public.quiz_sessions;
  v_matched      boolean;
  v_distance     float4;
  v_frame_hash   text;
  v_recent       boolean[];
  v_fails        int;
  v_new_status   public.session_status;
  v_new_streak   int;
  v_next_nonce   uuid;
  v_suspected_replay boolean := false;
  v_too_frequent boolean := false;
  v_prev_hash text;
  v_prev_checked_at timestamptz;
  v_hits int := 0;
  v_max_sim real := 0;
  v_i int;
  v_concat text := '';
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

  -- (1) Lock + ownership in one query (never row-lock a foreign id).
  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id and s.student_id = auth.uid()
   for update;

  if not found then
    return jsonb_build_object('error', 'not_owner');
  end if;

  -- (2) Consent re-check (mid-session revocation blocks verify).
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.consent_given_at is not null
  ) then
    return jsonb_build_object('error', 'consent_required');
  end if;

  -- (3) Mode gate — practice/lecturer sessions never verify.
  if v_session.mode <> 'assessment' then
    return jsonb_build_object('error', 'not_assessment');
  end if;

  -- (4) Quiz still live + student still enrolled (parity with answer_question).
  if not public.can_student_view_quiz(v_session.quiz_id) then
    return jsonb_build_object('error', 'quiz_not_live');
  end if;

  -- (5) Completed → session_not_active (score already final).
  if v_session.status = 'completed' then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  -- (6) face_exempt short-circuit: no row, no nonce rotation.
  if v_session.face_exempt then
    return jsonb_build_object(
      'matched', true,
      'distance', null,
      'sessionStatus', v_session.status,
      'nextNonce', v_session.verify_nonce,
      'faceFailStreak', v_session.face_fail_streak
    );
  end if;

  -- (7) paused/flagged → session_not_active.
  if v_session.status in ('paused', 'flagged') then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  -- (8) Enrollment required.
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.face_enrollment_status is not null
      and p.face_enrollment_status <> 'pending_review'
  ) then
    return jsonb_build_object('error', 'not_enrolled');
  end if;

  -- (8b) Typed param validation. NaN compares GREATER than every non-NaN in
  -- Postgres, so the per-element range gate is REQUIRED (mirrors 0010 §8b);
  -- the ndims gate rejects multidimensional JSON arrays whose cardinality
  -- would pass 1..3 and whose subscripting would raise an uncaught 500.
  if p_nonce is null then
    return jsonb_build_object('error', 'nonce_mismatch');
  end if;
  if p_trigger is null then
    return jsonb_build_object('error', 'invalid_trigger');
  end if;
  if p_similarities is null
     or array_ndims(p_similarities) <> 1
     or array_ndims(coalesce(p_frames, '{}'::text[])) <> 1
     or cardinality(p_similarities) not between 1 and 3
     or cardinality(coalesce(p_frames, '{}'::text[])) <> cardinality(p_similarities) then
    return jsonb_build_object('error', 'invalid_frame');
  end if;
  for v_i in 1 .. cardinality(p_similarities) loop
    if p_similarities[v_i] is null
       or p_similarities[v_i] < 0 or p_similarities[v_i] > 1 then
      return jsonb_build_object('error', 'invalid_frame');
    end if;
    if p_frames[v_i] is null or length(p_frames[v_i]) > 200000 then
      return jsonb_build_object('error', 'invalid_frame');
    end if;
  end loop;

  -- (9) Nonce check + rotate.
  if v_session.verify_nonce <> p_nonce then
    return jsonb_build_object('error', 'nonce_mismatch');
  end if;

  -- (10) Server-computed verdict — strict majority of frames ≥ threshold,
  -- against the caller's OWN subject only (1:1 by lookup upstream).
  for v_i in 1 .. cardinality(p_similarities) loop
    if p_similarities[v_i] >= FACE_SIMILARITY_MIN then
      v_hits := v_hits + 1;
    end if;
    if p_similarities[v_i] > v_max_sim then
      v_max_sim := p_similarities[v_i];
    end if;
    v_concat := v_concat || '|' || coalesce(p_frames[v_i], '');
  end loop;

  v_matched := (
    coalesce(p_subject, '') = auth.uid()::text
    and v_hits * 2 > cardinality(p_similarities)
  );
  v_distance := 1.0 - v_max_sim;
  v_frame_hash := encode(extensions.digest(v_concat, 'sha256'), 'hex');

  -- Advisory flags (single latest-row lookup, ordering pinned).
  select fc.frame_hash, fc.checked_at
    into v_prev_hash, v_prev_checked_at
    from public.face_checks fc
   where fc.session_id = v_session.id
   order by fc.checked_at desc, fc.id desc
   limit 1;
  v_suspected_replay := v_prev_hash is not null and v_frame_hash = v_prev_hash;
  v_too_frequent := v_prev_checked_at is not null
    and clock_timestamp() < v_prev_checked_at + interval '2 seconds';

  -- (11) Insert ONE check row for the whole vote.
  insert into public.face_checks
    (session_id, checked_at, matched, distance, trigger, suspected_replay, too_frequent, frame_hash)
  values
    (v_session.id, clock_timestamp(), v_matched, v_distance, p_trigger, v_suspected_replay, v_too_frequent, v_frame_hash);

  -- (12) FLAT last-5 window (ordering pinned: checked_at DESC, id DESC).
  select coalesce(array_agg(matched order by checked_at desc, id desc), '{}'::boolean[])
    into v_recent
    from (
      select matched, checked_at, id
        from public.face_checks
       where session_id = v_session.id
       order by checked_at desc, id desc
       limit 5
    ) t;

  if v_matched then
    v_new_status := 'active';
    v_new_streak := 0;
  else
    v_fails := 0;
    for i in 1..cardinality(v_recent) loop
      if not v_recent[i] then
        v_fails := v_fails + 1;
      end if;
    end loop;
    if v_fails >= 3 then
      v_new_status := 'flagged';
    else
      v_new_status := 'paused';
    end if;
    v_new_streak := v_fails;
  end if;

  -- (13) Rotate nonce + timer bookkeeping. paused_at is cleared on 'flagged'
  -- (R1 parity with pause_session) so unlock never converts flagged idle
  -- into exam time.
  update public.quiz_sessions
     set status = v_new_status,
         paused_at = case
           when v_new_status = 'paused' then coalesce(paused_at, clock_timestamp())
           when v_new_status in ('active', 'flagged') then null
           else paused_at
         end,
         face_fail_streak = v_new_streak,
         verify_nonce = gen_random_uuid(),
         last_activity_at = clock_timestamp()
   where id = v_session.id
   returning verify_nonce into v_next_nonce;

  -- (14) Return the verdict + rotated nonce.
  return jsonb_build_object(
    'matched', v_matched,
    'distance', v_distance,
    'sessionStatus', v_new_status,
    'nextNonce', v_next_nonce,
    'faceFailStreak', v_new_streak
  );
end;
$$;

revoke execute on function public.record_face_check(uuid, text, real[], public.face_check_trigger, uuid, text[])
  from public, anon;
grant execute on function public.record_face_check(uuid, text, real[], public.face_check_trigger, uuid, text[])
  to authenticated;

-- ═══ R7: prune_expired_incident_clips deletes rows too ═════════════════
create or replace function public.prune_expired_incident_clips()
returns jsonb
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  v_objects bigint;
  v_rows bigint;
begin
  select count(*) into v_objects
    from storage.objects
   where bucket_id = 'incident-footage'
     and created_at < now() - interval '30 days';
  delete from storage.objects
   where bucket_id = 'incident-footage'
     and created_at < now() - interval '30 days';
  get diagnostics v_objects = row_count;

  delete from public.incident_clips
   where recorded_to < now() - interval '30 days';
  get diagnostics v_rows = row_count;

  return jsonb_build_object('pruned_storage_objects', v_objects, 'pruned_rows', v_rows);
end;
$$;

revoke all on function public.prune_expired_incident_clips() from public, anon;
grant execute on function public.prune_expired_incident_clips() to service_role;
