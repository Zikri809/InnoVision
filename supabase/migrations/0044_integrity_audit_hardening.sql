-- InnoVision — Migration 0044: integrity audit hardening (fairness + accountability).
--
-- Closes the enforcement/fairness gaps from the 2026-09-11 integrity review:
--
--   1. hand_pause_count — `pause_session('hand_loss')` was a PLAIN pause with
--      NO counter, so `POST /pause {}` → self-recover cycling farmed unbounded
--      bonus exam time INVISIBLY (strictly worse than the fullscreen_exit
--      cycling 0043 surfaced). hand_loss now increments hand_pause_count and
--      FLAGS at 3 (same escalation contract as focus_lost). The 3-strike flag
--      is student-ratified behaviour on the documented posture that a
--      gesture-assessment requires the hand in frame; a mouse-answerer whose
--      hand never entered frame cannot trip it because hand_loss pauses only
--      arm while a question is answerable AND the hand was previously seen
--      (play-client `armed` gate — the presence precondition is client-side,
--      accepted as the same browser boundary as every other pause source).
--   2. face_fail_count — LIFETIME failed face checks. `face_fail_streak`
--      resets to 0 on every pass, so the export's "Face fails" column could
--      read 0 for a student who hit 3 strikes and was unlocked while the
--      dashboard (counting face_checks rows) showed a non-zero number. The
--      streak column keeps its exact state-machine meaning; the new counter is
--      the disciplinary artifact.
--   3. Timer-farming brake — self_recover_session credits the full paused
--      duration with no cap. The credit is now capped at
--      MAX_RECOVERY_CREDIT_SECONDS (120 s) per recovery: an honest pause
--      (blur debounce 900 ms, face pause → blink recovery, network blip) is
--      ALWAYS far shorter than 2 minutes, so honest students never notice; a
--      scripted pause/recover cycle is no longer profitable (cycle overhead
--      ≥ the credited time, plus the hand counter flags at 3).
--   4. Audit attribution — `unlock` / `exempt_face` wrote metadata-less audit
--      rows, so `lecturer_audit_view` derived NULL session ids and the rows
--      routed to the never-rendered legacy bucket: a lecturer could not see
--      that a colleague had already adjudicated a flagged student. Both now
--      carry quiz_id + session_id (the 0021 R3 / 0042 pattern).
--   5. Silence-cron false-positive race — a student returning from a long
--      tab-hide runs a ~3 s catch-up capture while the cron's 60 s tick can
--      land in between ("answer fresh, check stale" → flagged BEFORE the
--      honest catch-up verify commits). The cron now skips sessions with at
--      most ONE answer AFTER their last face check: the honest returner has
--      answered ≤1 time mid-capture and is judged next tick; a suppressed-
--      verify session accumulates a second post-check answer inside the 300s
--      silence window and the count resets ONLY when a real verify commits,
--      so the grace cannot be held open by pacing answers. (Round-1 review
--      rejected an earlier 15s last_activity_at floor as permanently
--      evadable — answers touch that timestamp too.)
--   6. lecturer_session_view — append face_fail_count + hand_pause_count
--      LAST (CREATE OR REPLACE VIEW can only append columns — 0021 R4 rule).
--   7. report_session_advisory — the last_activity_at touch runs ONLY on a
--      real (unthrottled) advisory occurrence: advisory spam can no longer
--      fuzz last_activity_at freshness signals (second-order hardening; the
--      §5 answer-count grace does not depend on it, but the un-throttled
--      touch remained a latent freshness-fuzzer).
--
-- No notification risk from the new counters: the 0022 session trigger is
-- `after update of status` with an `old.status is distinct from new.status`
-- WHEN guard — bare counter UPDATEs are silent.

-- ─── 1. Columns ────────────────────────────────────────────────────────
alter table public.quiz_sessions
  add column if not exists face_fail_count int not null default 0;
alter table public.quiz_sessions
  add column if not exists hand_pause_count int not null default 0;
alter table public.quiz_sessions
  add column if not exists last_pause_reason text;

-- Backfill: face_fail_count approximated from the retained face_checks rows.
-- face_checks cascade on session delete (0009) and prune on consent revoke
-- (0039), so this is a floor, not a guarantee — acceptable for a reporting
-- counter introduced mid-life.
update public.quiz_sessions s
   set face_fail_count = (
     select count(*) from public.face_checks fc
      where fc.session_id = s.id and fc.matched = false
   )
 where s.face_fail_count = 0;

-- ─── 2. record_face_check: lifetime fail counter ───────────────────────
-- BASELINE: the LIVE 0021 R6 revision. Changes from it: the (13) update
-- adds face_fail_count = face_fail_count + 1 on the fail path (both
-- `paused` and `flagged` outcomes are fails) and leaves it untouched on the
-- pass path — the counter NEVER resets (unlock/exempt reset the streak and
-- pause counters but not this one), so the export agrees with the
-- dashboard's face_checks count even for a flag→unlock→pass session.
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
  -- into exam time. face_fail_count is the LIFETIME fail counter (0044) —
  -- the streak column resets on a pass, this one NEVER resets: the export's
  -- motivating scenario is fail→flag→unlock→PASS, and zeroing on the pass
  -- would re-open the exact "export reads 0 fails" bug the counter closes
  -- (round-1 review caught the original `when v_matched then 0` branch as
  -- self-defeating; the backfill at the top of this file owns history).
  update public.quiz_sessions
     set status = v_new_status,
         paused_at = case
           when v_new_status = 'paused' then coalesce(paused_at, clock_timestamp())
           when v_new_status in ('active', 'flagged') then null
           else paused_at
         end,
         face_fail_streak = v_new_streak,
         face_fail_count = coalesce(face_fail_count, 0)
           + case when v_matched then 0 else 1 end,
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

-- ─── 3. pause_session: count hand_loss (flag at 3) ─────────────────────
-- BASELINE: the LIVE 0043 revision. Changes from it: the hand_loss branch
-- increments hand_pause_count and flags at 3 (mirroring focus_lost), and
-- every branch persists the new counters + last_pause_reason (0044 #5
-- predicate parity — the cron reads last_activity_at freshness, and pause
-- already touches it; recording the reason is for future surface work).
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
  else
    -- hand_loss (0044): previously a plain pause — pause/recover cycling on
    -- it was an INVISIBLE time source. Counted now, flagged at 3.
    v_session.hand_pause_count := coalesce(v_session.hand_pause_count, 0) + 1;
    v_flag := v_session.hand_pause_count >= 3;
  end if;

  if v_flag then
    -- R1 (0021): a flag from `paused` must NOT preserve paused_at — unlock
    -- would otherwise credit the flagged idle period as exam time.
    update public.quiz_sessions
       set status = 'flagged',
           paused_at = null,
           focus_pause_count = v_session.focus_pause_count,
           fullscreen_pause_count = v_session.fullscreen_pause_count,
           hand_pause_count = v_session.hand_pause_count,
           last_pause_reason = p_reason,
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
           hand_pause_count = v_session.hand_pause_count,
           last_pause_reason = p_reason,
           last_activity_at = clock_timestamp()
     where id = v_session.id;
  else
    -- Already paused (e.g. a second blur while recovering): persist the new
    -- count without touching the timer state.
    update public.quiz_sessions
       set focus_pause_count = v_session.focus_pause_count,
           fullscreen_pause_count = v_session.fullscreen_pause_count,
           hand_pause_count = v_session.hand_pause_count,
           last_pause_reason = p_reason,
           last_activity_at = clock_timestamp()
     where id = v_session.id;
  end if;

  return jsonb_build_object('sessionStatus', 'paused');
end;
$$;

revoke execute on function public.pause_session(uuid, text) from public, anon;
grant execute on function public.pause_session(uuid, text) to authenticated;

-- ─── 4. self_recover_session: capped timer credit ──────────────────────
-- BASELINE: the LIVE 0019 revision. Changes from it: the credited duration
-- is capped at MAX_RECOVERY_CREDIT_SECONDS (120 s). An honest pause is
-- always far shorter (blur debounce 900 ms; face pause → blink recovery;
-- hardening exit → think → return), so honest sessions are unaffected; a
-- scripted pause/recover cycle no longer yields unbounded exam time.
create or replace function public.self_recover_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  MAX_RECOVERY_CREDIT_SECONDS constant int := 120;
  v_session public.quiz_sessions;
  v_next_nonce uuid;
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

  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id and s.student_id = auth.uid()
   for update;

  if not found then
    return jsonb_build_object('error', 'not_owner');
  end if;

  if v_session.status = 'completed' then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  if v_session.status = 'flagged' then
    return jsonb_build_object('error', 'flagged');
  end if;

  if v_session.status = 'active' then
    return jsonb_build_object('sessionStatus', 'active');
  end if;

  if v_session.paused_at is not null then
    update public.quiz_sessions
       set status = 'active',
           started_at = started_at + least(
             clock_timestamp() - v_session.paused_at,
             make_interval(secs => MAX_RECOVERY_CREDIT_SECONDS)
           ),
           paused_at = null,
           face_fail_streak = 0,
           verify_nonce = gen_random_uuid(),
           last_activity_at = clock_timestamp()
     where id = v_session.id
     returning verify_nonce into v_next_nonce;
  else
    update public.quiz_sessions
       set status = 'active',
           face_fail_streak = 0,
           verify_nonce = gen_random_uuid(),
           last_activity_at = clock_timestamp()
     where id = v_session.id
     returning verify_nonce into v_next_nonce;
  end if;

  insert into public.audit_events (actor_id, subject_id, action)
  values (auth.uid(), auth.uid(), 'self_recover');

  return jsonb_build_object(
    'sessionStatus', 'active',
    'nextNonce', v_next_nonce
  );
end;
$$;

revoke execute on function public.self_recover_session(uuid) from public, anon;
grant execute on function public.self_recover_session(uuid) to authenticated;

-- ─── 5. unlock_session: audit attribution ──────────────────────────────
-- BASELINE: the LIVE 0033 revision (0021 R2 branches + the IO-1
-- session_unlocked notification, carried through 0043's counter resets).
-- Changes from it: the audit row now carries quiz_id + session_id in
-- metadata (R3 pattern) so lecturer_audit_view routes it onto the SESSION
-- timeline — previously a metadata-less row vanished into the student-level
-- legacy bucket and a colleague could not see the adjudication.
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
           fullscreen_pause_count = 0,
           hand_pause_count = 0,
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
           hand_pause_count = 0,
           verify_nonce = gen_random_uuid(),
           last_activity_at = clock_timestamp()
     where id = v_session.id
     returning verify_nonce into v_next_nonce;
  end if;

  insert into public.audit_events (actor_id, subject_id, action, metadata)
  values (
    auth.uid(),
    v_session.student_id,
    'unlock',
    jsonb_build_object(
      'quiz_id', v_session.quiz_id,
      'session_id', v_session.id
    )
  );

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
      -- DEVIATION from 0022's WHEN OTHERS ban (documented in 0033's header):
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

-- ─── 6. exempt_face_session: audit attribution ─────────────────────────
-- BASELINE: the LIVE 0043 revision (0024 guard + counter resets). Changes
-- from it: the audit row gains quiz_id + session_id (same rationale as
-- unlock above) and both branches also reset hand_pause_count.
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

  -- Bound the reason at the SQL layer too (the route's ExemptSchema caps at
  -- 500; a direct RPC caller must not bloat audit_events.metadata).
  if p_reason is null or length(p_reason) > 500 then
    return jsonb_build_object('error', 'invalid_reason');
  end if;

  if v_session.status = 'completed' then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  -- F2 (0021): reset the pause counters so an exemption clears the flag
  -- threshold — otherwise the next genuine blur instantly re-flags. 0044
  -- adds hand_pause_count to the reset set. paused_at handling is
  -- deliberately UNCHANGED from the 0043 baseline; the 120 s recovery-credit
  -- cap in self_recover_session now bounds any stale-paused_at inflation.
  update public.quiz_sessions
     set face_exempt = true,
         status = 'active',
         face_fail_streak = 0,
         focus_pause_count = 0,
         fullscreen_pause_count = 0,
         hand_pause_count = 0,
         verify_nonce = gen_random_uuid(),
         last_activity_at = clock_timestamp()
   where id = v_session.id
   returning verify_nonce into v_next_nonce;

  insert into public.audit_events (actor_id, subject_id, action, metadata)
  values (
    auth.uid(),
    v_session.student_id,
    'exempt_face',
    jsonb_build_object(
      'reason', p_reason,
      'quiz_id', v_session.quiz_id,
      'session_id', v_session.id
    )
  );

  return jsonb_build_object('sessionStatus', 'active', 'nextNonce', v_next_nonce);
end;
$$;

revoke execute on function public.exempt_face_session(uuid, text) from public, anon;
grant execute on function public.exempt_face_session(uuid, text) to authenticated;

-- ─── 7. flag_verify_silent_sessions: return-from-hide race fix ─────────
-- BASELINE: the LIVE 0042 revision (cursor-loop syntax fixed in place).
-- Change: BOTH the cursor predicate and the guarded UPDATE gain an
-- ANSWER-COUNT grace (≤1 answer after the last face check skips the
-- session this tick). A student returning from a long tab-hide answers
-- immediately while the ~3 s catch-up capture is still in flight; the 60 s
-- cron tick could previously land inside that window ("answer fresh, check
-- stale") and flag an honest session BEFORE its catch-up verify committed.
-- The honest returner has ≤1 post-check answer mid-capture and is judged
-- next tick; a suppressed-verify session accumulates a second post-check
-- answer inside the 300s silence window and the count resets only when a
-- REAL verify commits — the grace delays detection by one answer without
-- eliminating it. (A round-1 review rejected the originally drafted 15s
-- last_activity_at floor as permanently evadable: answers touch that
-- timestamp too, so a paced bot could hold it fresh forever.)
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
       -- 0044 return-from-hide grace (answer-count form — round-1 review
       -- rejected the original 15s last_activity_at floor as permanently
       -- evadable: answers touch last_activity_at too, so a paced bot could
       -- hold it fresh forever). A tab-return catch-up verify takes a few
       -- seconds (capture + two spaced secondaries), so an honest returner
       -- has answered AT MOST once since her last check when the cron tick
       -- lands mid-capture; a session whose verification is suppressed
       -- accumulates a SECOND post-check answer within the 300s silence
       -- window. The count RESETS only when a real face_checks row commits
       -- (a verify), so a bot can pace answers but never clear the count —
       -- count <= 1 → skip this tick, judge next tick once the catch-up
       -- verify has landed; count >= 2 with 300s of silence → flag.
       and (
         select count(*) from public.session_answers sa
          where sa.session_id = s.id
            and sa.answered_at > coalesce(
              (select max(fc.checked_at) from public.face_checks fc
                where fc.session_id = s.id),
              s.started_at
            )
       ) <= 1
       -- Pause-resume guard: self_recover/unlock write NO face_checks row,
       -- the post-resume cadence fires its first verify only 30-45s later,
       -- and a quick answer lands within seconds — a session that paused
       -- >300s (its last check predates the pause) then answered would be
       -- flagged before its honest verify. Exempt sessions paused within the
       -- silence window. NOT an evasion loop: status='paused' blocks
       -- answering entirely (answer_question status gate), so entering pause
       -- buys a cheater nothing — only genuine recover/unlock flows reach
       -- this exemption, and the focus/hand 3-strike already polices pause
       -- cycling (0044).
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
       -- 0044 grace (answer-count form), cursor parity.
       and (
         select count(*) from public.session_answers sa
          where sa.session_id = quiz_sessions.id
            and sa.answered_at > coalesce(
              (select max(fc.checked_at) from public.face_checks fc
                where fc.session_id = quiz_sessions.id),
              quiz_sessions.started_at
            )
       ) <= 1
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

-- ─── 8. report_session_advisory: gate the last_activity_at touch ───────
-- BASELINE: the LIVE 0021 R5 revision. Change: the activity touch now runs
-- ONLY when the call is a REAL advisory occurrence (inside the same 55s
-- throttle as the occurrence increment). WHY (round-1 review): the advisory
-- RPC touched last_activity_at on EVERY call — a tampered client could POST
-- an advisory every ~6s (route limit is 10/min; direct PostgREST is
-- unlimited) and fuzz every freshness signal keyed on that timestamp,
-- including the silence cron's predicates. With the touch throttled,
-- refreshing activity faster than the throttle simply stops refreshing it —
-- the honest client's cadence (advisories are rare events) is unaffected,
-- and the timestamp stays an honest signal.
-- (Section renumbered 7→8 after §7 gained the answer-count grace.)
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

  -- Ownership/status gate FIRST (round-2 review): the upsert below is
  -- FK-gated only, so without this probe a foreign or completed/flagged
  -- session would insert an advisory row and return ok:true (and a bogus
  -- uuid would raise a raw FK violation) where the 0021 R5 baseline
  -- returned not_owner. The probe is the exact WHERE of the touch below.
  if not exists (
    select 1 from public.quiz_sessions s
     where s.id = p_session_id
       and s.student_id = auth.uid()
       and s.mode = 'assessment'
       and s.status in ('active', 'paused')
  ) then
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

  if found then
    -- Activity touch MOVED inside the throttle (0044): only a REAL advisory
    -- occurrence refreshes last_activity_at, so the timestamp stays an
    -- honest signal for every freshness consumer (incl. the silence cron).
    -- Direct-RPC spam now returns ok WITHOUT touching the session at all —
    -- same posture as the occurrence increment it mirrors. (found after
    -- INSERT..ON CONFLICT is true for a fresh insert or a conflict-update
    -- whose WHERE passed; the ownership probe above guarantees a fresh
    -- insert belongs to the caller's own active session.)
    update public.quiz_sessions s
       set last_activity_at = clock_timestamp()
     where s.id = p_session_id
       and s.student_id = auth.uid()
       and s.mode = 'assessment'
       and s.status in ('active', 'paused');
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.report_session_advisory(uuid, text) from public, anon;
grant execute on function public.report_session_advisory(uuid, text) to authenticated;

-- ─── 9. lecturer_session_view: append the two new counters LAST ────────
-- BASELINE: the LIVE 0043 revision. CREATE OR REPLACE VIEW can only APPEND
-- columns (0021 R4): the new columns go LAST or the replace fails and the
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
       s.fullscreen_pause_count,
       s.face_fail_count,
       s.hand_pause_count
from public.quiz_sessions s
where public.is_lecturer_of_quiz(s.quiz_id);

grant select on public.lecturer_session_view to authenticated;
